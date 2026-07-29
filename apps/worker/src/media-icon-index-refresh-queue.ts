import {
  buildBuiltInIconProviderIndex,
  canonicalBuiltInIconSearchIndexJson,
  createBuiltInIconSearchIndex,
  type BuiltInIconRegistryFetcher,
} from "@renewlet/shared/built-in-icon-index-builder";
import { BUILT_IN_ICON_PROVIDERS, type BuiltInIconProvider } from "@renewlet/shared/built-in-icons";
import { mediaResolverConfig } from "@renewlet/shared/media-resolver-config";
import type { Env } from "./types";
import {
  checkLatestProviderVersion,
  clearBuiltInIconResolverCache,
  gzipText,
  providerFailureMessage,
  providerPinnedCdnBase,
  recordProviderSearchRefreshSuccess,
  recordRefreshJobFailure,
  sha256HexText,
} from "./media-icon-index";
import { markRefreshJobRunning } from "./media-icon-index-refresh-jobs";
import { sendUpstreamRequest, UpstreamRequestError } from "./upstream-http";
import {
  createUpstreamHTTPError,
  providerMessageFromResponse,
  UpstreamOperationError,
  upstreamProviderResponseFromFetchResponse,
} from "./upstream-response";

const MEDIA_ICON_INDEX_R2_PREFIX = "system/media-icon-index";
const REGISTRY_FETCH_TIMEOUT_MS = 15_000;
const REGISTRY_JSON_LIMIT_BYTES = 16 * 1024 * 1024;

interface BuiltInIconIndexRefreshQueueMessage {
  jobId: string;
  provider: BuiltInIconProvider;
  requestedAt: string;
}

class RetryableBuiltInIconRefreshError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RetryableBuiltInIconRefreshError";
  }
}

export async function consumeBuiltInIconIndexRefreshQueue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    let delivery: "ack" | "retry" = "ack";
    try {
      const body = parseRefreshQueueMessage(message.body);
      delivery = await processRefreshQueueMessage(env, body);
    } catch (error) {
      delivery = transientRefreshError(error) ? "retry" : "ack";
    }
    if (delivery === "retry") {
      retryMessage(message);
    } else {
      ackMessage(message);
    }
  }
}

async function processRefreshQueueMessage(env: Env, message: BuiltInIconIndexRefreshQueueMessage): Promise<"ack" | "retry"> {
  let runningJob;
  try {
    runningJob = await markRefreshJobRunning(env, message.jobId, message.provider);
  } catch {
    return "retry";
  }
  if (!runningJob) return "ack";

  try {
    const providerIndex = await buildProviderSearchIndex(env, message.provider);
    const searchR2Key = `${MEDIA_ICON_INDEX_R2_PREFIX}/${message.provider}/${providerIndex.searchHash}.search.json.gz`;
    try {
      await env.ASSETS_BUCKET.put(searchR2Key, providerIndex.searchBytes, {
        httpMetadata: { contentType: "application/gzip" },
      });
      await recordProviderSearchRefreshSuccess(env, {
        jobId: message.jobId,
        provider: message.provider,
        version: providerIndex.version,
        etag: providerIndex.etag,
        searchR2Key,
        searchHash: providerIndex.searchHash,
        iconCount: providerIndex.iconCount,
      });
      clearBuiltInIconResolverCache();
      return "ack";
    } catch (error) {
      throw new RetryableBuiltInIconRefreshError(providerFailureMessage(error), { cause: error });
    }
  } catch (error) {
    const messageText = providerFailureMessage(error);
    try {
      await recordRefreshJobFailure(env, message.jobId, message.provider, messageText, null);
    } catch {
      return "retry";
    }
    return transientRefreshError(error) ? "retry" : "ack";
  }
}

async function buildProviderSearchIndex(env: Env, provider: BuiltInIconProvider): Promise<{
  version: Awaited<ReturnType<typeof checkLatestProviderVersion>>["version"];
  etag: string;
  searchBytes: Uint8Array;
  searchHash: string;
  iconCount: number;
}> {
  const { version, etag } = await checkLatestProviderVersion(env, provider);
  if (!version.commitSha) throw new Error("latest provider commit is unavailable");
  const providerIcons = await buildBuiltInIconProviderIndex(mediaResolverConfig, provider, registryFetcher(env), {
    provider,
    cdnBase: providerPinnedCdnBase(provider, version.commitSha),
  });
  const searchIndexJson = canonicalBuiltInIconSearchIndexJson(createBuiltInIconSearchIndex(providerIcons));
  const searchHash = await sha256HexText(searchIndexJson);
  return {
    version,
    etag,
    searchBytes: await gzipText(searchIndexJson),
    searchHash,
    iconCount: providerIcons.length,
  };
}

function registryFetcher(env: Env): BuiltInIconRegistryFetcher {
  return async (url, label) => {
    const response = await sendUpstreamRequest(url, {
      headers: {
        accept: "application/json",
        "user-agent": `Renewlet/${env.RENEWLET_VERSION?.trim() || "cloudflare"}`,
      },
    }, {
      provider: label,
      timeoutMs: REGISTRY_FETCH_TIMEOUT_MS,
    });
    if (!response.ok) throw await registryHTTPError(response, label);
    return JSON.parse(await readResponseTextUpToLimit(response, label, REGISTRY_JSON_LIMIT_BYTES));
  };
}

async function registryHTTPError(response: Response, label: string): Promise<Error> {
  const providerResponse = await upstreamProviderResponseFromFetchResponse(response);
  const providerMessage = providerMessageFromResponse(providerResponse);
  return createUpstreamHTTPError({
    provider: label,
    response,
    providerResponse,
    providerMessage: providerMessage || `${label} HTTP ${response.status}`,
  });
}

function parseRefreshQueueMessage(value: unknown): BuiltInIconIndexRefreshQueueMessage {
  if (!isRecord(value)) throw new Error("invalid built-in icon refresh queue message");
  const provider = typeof value["provider"] === "string" ? parseBuiltInIconProvider(value["provider"]) : null;
  const jobId = typeof value["jobId"] === "string" ? value["jobId"].trim() : "";
  const requestedAt = typeof value["requestedAt"] === "string" ? value["requestedAt"].trim() : "";
  if (!provider || !jobId || !requestedAt) throw new Error("invalid built-in icon refresh queue message");
  return { jobId, provider, requestedAt };
}

function transientRefreshError(error: unknown, seen = new WeakSet<object>()): boolean {
  if (!error || typeof error !== "object") return false;
  if (seen.has(error)) return false;
  seen.add(error);
  if (error instanceof RetryableBuiltInIconRefreshError) return true;
  if (error instanceof UpstreamRequestError) return error.timedOut;
  if (error instanceof UpstreamOperationError && error.status !== undefined) {
    return error.status === 429 || error.status >= 500;
  }
  const cause = "cause" in error ? (error as { cause?: unknown }).cause : undefined;
  if (cause && transientRefreshError(cause, seen)) return true;
  const errors = "errors" in error ? (error as { errors?: unknown }).errors : undefined;
  return Array.isArray(errors) && errors.some((item) => transientRefreshError(item, seen));
}

async function readResponseTextUpToLimit(response: Response, label: string, limitBytes: number): Promise<string> {
  const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declaredLength) && declaredLength > limitBytes) {
    throw new Error(`${label} response too large`);
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limitBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`${label} response too large`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function ackMessage(message: Message<unknown>): void {
  message.ack();
}

function retryMessage(message: Message<unknown>): void {
  message.retry();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseBuiltInIconProvider(value: string): BuiltInIconProvider | null {
  return BUILT_IN_ICON_PROVIDERS.includes(value as BuiltInIconProvider) ? value as BuiltInIconProvider : null;
}
