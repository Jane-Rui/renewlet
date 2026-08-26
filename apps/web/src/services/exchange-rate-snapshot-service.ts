import { apiFetch } from "@/lib/api-client";
import {
  exchangeRateSnapshotPayloadSchema,
  exchangeRateSnapshotsPayloadSchema,
  type ExchangeRateSnapshotBody,
  type ExchangeRateSnapshotV1,
} from "@/lib/api/schemas/exchange-rates";
import { apiSuccessResponseSchema } from "@renewlet/shared/schemas/api";

const exchangeRateSnapshotsResponseSchema = apiSuccessResponseSchema(exchangeRateSnapshotsPayloadSchema);
const exchangeRateSnapshotResponseSchema = apiSuccessResponseSchema(exchangeRateSnapshotPayloadSchema);

export const exchangeRateSnapshotQueryKeys = {
  all: ["exchange-rate-snapshots"] as const,
};

export const exchangeRateSnapshotService = {
  async list(
    options: { from?: string; to?: string } = {},
    signal?: AbortSignal,
  ): Promise<ExchangeRateSnapshotV1[]> {
    const params = new URLSearchParams();
    if (options.from) params.set("from", options.from);
    if (options.to) params.set("to", options.to);
    const query = params.toString();
    const result = await apiFetch(
      `/api/app/exchange-rate-snapshots${query ? `?${query}` : ""}`,
      exchangeRateSnapshotsResponseSchema,
      signal ? { signal } : undefined,
    );
    return result.snapshots;
  },

  async capture(
    month: string,
    body: ExchangeRateSnapshotBody,
    signal?: AbortSignal,
  ): Promise<ExchangeRateSnapshotV1> {
    const result = await apiFetch(
      `/api/app/exchange-rate-snapshots/${encodeURIComponent(month)}`,
      exchangeRateSnapshotResponseSchema,
      {
        method: "PUT",
        body: JSON.stringify(body),
        // 快照是小型写后任务；整页跳转时允许浏览器完成传输，SPA 卸载仍由 signal 主动取消。
        keepalive: true,
        ...(signal ? { signal } : {}),
      },
    );
    return result.snapshot;
  },
};
