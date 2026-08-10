import { importPayloadSchema, type ImportSubscription } from "@/lib/api/schemas/import-export";
import type { AiRecognizedSubscriptionDraft } from "@/lib/api/schemas/ai-recognition";
import { normalizeAIRecognitionUsefulNotes } from "@renewlet/shared/ai-recognition-notes";
import { assertDateOnly, type DateOnly } from "@/lib/time/date-only";
import type { ConfigItem, CustomConfig } from "@/types/config";
import type { AppSettings, BillingCycle, CustomCycleUnit } from "@/types/subscription";
import {
  IMPORT_MESSAGE_CODES,
  importMessage,
  makeConfigItem,
  mergeConfigItem,
  normalizeWebsite,
  stableHash,
  type PreparedImport,
} from "@/modules/import-export/domain/import-export-model";

interface AIImportContext {
  config: CustomConfig;
  settings: AppSettings;
  today: DateOnly | string;
}

interface AIImportBuildState extends AIImportContext {
  config: CustomConfig;
  warnings: string[];
  sourceIdCounts: Map<string, number>;
}

/**
 * 将 AI 识别草稿转换为标准导入预览 payload。
 *
 * AI 结果永不直接写 subscriptions；必须先落到 import preview/apply 链路，复用冲突处理、Logo 上传和服务端校验。
 */
export function buildPreparedImportFromAIDrafts(
  drafts: readonly AiRecognizedSubscriptionDraft[],
  context: AIImportContext,
): PreparedImport {
  const state: AIImportBuildState = {
    ...context,
    config: context.config,
    warnings: [],
    sourceIdCounts: new Map(),
  };
  const subscriptions = drafts.map((draft) => buildAIImportSubscription(draft, state));
  return {
    payload: importPayloadSchema.parse({
      source: "ai",
      subscriptions,
      customConfig: state.config,
    }),
    assets: [],
    warnings: state.warnings,
  };
}

function buildAIImportSubscription(draft: AiRecognizedSubscriptionDraft, state: AIImportBuildState): ImportSubscription {
  const warnings = [...draft.warnings];
  const billingCycle = normalizeBillingCycle(draft, warnings);
  const price = normalizePrice(draft.price, warnings);
  const currency = normalizeCurrency(draft.currency, state, warnings);
  const category = resolveConfigValue("category", draft.category, state) ?? "other";
  const paymentMethod = resolveConfigValue("payment", draft.paymentMethod, state);
  const autoCalculateNextBillingDate =
    billingCycle !== "one-time" &&
    draft.autoCalculateNextBillingDate === true &&
    draft.startDate !== null;
  const startDate = billingCycle === "one-time" || autoCalculateNextBillingDate
    ? requiredDate(draft.startDate)
    : optionalDate(draft.startDate);
  const nextBillingDate = requiredDate(draft.nextBillingDate);
  const websiteWarnings: string[] = [];
  const website = normalizeWebsite(draft.website?.value, websiteWarnings);
  const notes = normalizeAIRecognitionUsefulNotes(draft.notes?.value);
  warnings.push(...websiteWarnings);
  if (draft.website?.source === "suggested" && website) warnings.push(IMPORT_MESSAGE_CODES.aiWebsiteSuggested);

  pushPreparedWarnings(state, draft.name, warnings);
  return {
    name: draft.name,
    logo: null,
    price,
    currency,
    billingCycle,
    customDays: billingCycle === "custom" ? draft.customDays ?? 1 : null,
    customCycleUnit: billingCycle === "custom" ? draft.customCycleUnit ?? "day" : null,
    oneTimeTermCount: billingCycle === "one-time" && draft.oneTimeTermCount && draft.oneTimeTermUnit ? draft.oneTimeTermCount : null,
    oneTimeTermUnit: billingCycle === "one-time" && draft.oneTimeTermCount && draft.oneTimeTermUnit ? draft.oneTimeTermUnit : null,
    category,
    status: draft.status ?? "active",
    pinned: false,
    publicHidden: false,
    paymentMethod,
    startDate,
    nextBillingDate,
    autoRenew: false,
    autoCalculateNextBillingDate,
    trialEndDate: draft.status === "trial" ? optionalDate(draft.trialEndDate) : null,
    website: website ?? null,
    notes,
    tags: draft.tags,
    reminderDays: draft.reminderDays ?? state.settings.notificationReminderDays,
    repeatReminderEnabled: draft.reminderDays === -2 ? false : draft.repeatReminderEnabled ?? false,
    repeatReminderInterval: draft.repeatReminderInterval ?? "1h",
    repeatReminderWindow: draft.repeatReminderWindow ?? "72h",
    extra: {
      import: {
        source: "ai",
        sourceId: nextAISourceId(draft, state),
        confidence: draft.confidence,
      },
      ai: {
        ...(draft.website ? { websiteSource: draft.website.source } : {}),
        ...(draft.notes && notes ? { notesSource: draft.notes.source } : {}),
      },
    },
  };
}

function normalizeBillingCycle(draft: AiRecognizedSubscriptionDraft, warnings: string[]): BillingCycle {
  const billingCycle = draft.billingCycle ?? "monthly";
  if (!draft.billingCycle) warnings.push(IMPORT_MESSAGE_CODES.aiBillingCycleDefaulted);
  if (billingCycle === "custom" && (!draft.customDays || !draft.customCycleUnit)) {
    warnings.push(IMPORT_MESSAGE_CODES.aiCustomCycleDefaulted);
  }
  return billingCycle;
}

function normalizePrice(price: string | null, warnings: string[]): string {
  if (price === null) {
    warnings.push(IMPORT_MESSAGE_CODES.aiPriceDefaulted);
    return "0";
  }
  return price;
}

function normalizeCurrency(currency: string | null, state: AIImportBuildState, warnings: string[]): string {
  const value = currency?.trim().toUpperCase();
  if (!value) {
    warnings.push(IMPORT_MESSAGE_CODES.aiCurrencyDefaulted);
    return state.settings.defaultCurrency;
  }
  state.config = {
    ...state.config,
    currencies: mergeConfigItem(state.config.currencies, { ...makeConfigItem(value, value), enabled: true }),
  };
  return value;
}

function resolveConfigValue(kind: "category" | "payment", value: string | null, state: AIImportBuildState): string | null {
  const items = kind === "category" ? state.config.categories : state.config.paymentMethods;
  const fallback = items[0]?.value ?? "other";
  const text = value?.trim();
  if (!text) return kind === "category" ? fallback : null;
  const matched = findConfigItem(items, text);
  if (matched) return matched.value;
  const nextValue = `${kind === "category" ? "category" : "payment"}_${stableHash(text)}`;
  const item = makeConfigItem(nextValue, text);
  state.config = kind === "category"
    ? { ...state.config, categories: mergeConfigItem(state.config.categories, item) }
    : { ...state.config, paymentMethods: mergeConfigItem(state.config.paymentMethods, item) };
  return nextValue;
}

function findConfigItem(items: readonly ConfigItem[], text: string): ConfigItem | null {
  const normalized = configMatchKey(text);
  return items.find((item) => (
    configMatchKey(item.value) === normalized
    || configMatchKey(item.labels["zh-CN"]) === normalized
    || configMatchKey(item.labels["en-US"]) === normalized
  )) ?? null;
}

function configMatchKey(value: string): string {
  // AI 可能输出中英文、全角标点或用户自定义标签原文；匹配时只压缩“书写差异”，不翻译业务含义。
  return value.normalize("NFKC").trim().toLowerCase().replace(/[\s_\-—–/\\|&+，,、.。:：()（）[\]【】]+/g, "");
}

function requiredDate(value: DateOnly | string | null): DateOnly {
  if (value) return assertDateOnly(value);
  throw new Error("AI_RECOGNITION_DRAFT_DATE_REQUIRED");
}

function optionalDate(value: DateOnly | string | null): DateOnly | null {
  return value ? assertDateOnly(value) : null;
}

function nextAISourceId(draft: AiRecognizedSubscriptionDraft, state: AIImportBuildState): string {
  const hash = stableHash(JSON.stringify({
    name: draft.name,
    price: draft.price,
    currency: draft.currency,
    billingCycle: draft.billingCycle,
    website: draft.website?.value,
  }));
  const count = (state.sourceIdCounts.get(hash) ?? 0) + 1;
  state.sourceIdCounts.set(hash, count);
  // 同一批里模型可能识别出两个近似服务；sourceId 追加序号，保证导入幂等键不互相覆盖。
  return count === 1 ? hash : `${hash}-${count}`;
}

function pushPreparedWarnings(state: AIImportBuildState, name: string, warnings: readonly string[]): void {
  for (const warning of warnings) {
    state.warnings.push(importMessage("IMPORT_WARNING_FOR_SUBSCRIPTION", name, warning));
  }
}
