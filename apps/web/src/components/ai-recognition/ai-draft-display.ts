import type { MessageKey } from "@/i18n/messages";
import type { Locale } from "@/i18n/locales";
import type { AiRecognizedSubscriptionDraft } from "@/lib/api/schemas/ai-recognition";
import { hasAIDraftBlockingIssues } from "@/modules/ai-recognition/domain/ai-draft-preflight";
import type { BillingCycle, CustomCycleUnit, SubscriptionStatus } from "@/types/subscription";
import { moneyToNumber } from "@renewlet/shared/money";

export const BILLING_CYCLE_LABEL_KEYS: Record<BillingCycle, MessageKey> = {
  weekly: "cycle.weekly",
  monthly: "cycle.monthly",
  quarterly: "cycle.quarterly",
  "semi-annual": "cycle.semiAnnual",
  annual: "cycle.annual",
  custom: "cycle.custom",
  "one-time": "cycle.oneTime",
};
export const STATUS_LABEL_KEYS: Record<SubscriptionStatus, MessageKey> = {
  trial: "status.trial",
  active: "status.active",
  expired: "status.expired",
  paused: "status.paused",
  cancelled: "status.cancelled",
};
export const CUSTOM_CYCLE_UNIT_LABEL_KEYS: Record<CustomCycleUnit, MessageKey> = {
  day: "subscription.customCycleUnit.day",
  week: "subscription.customCycleUnit.week",
  month: "subscription.customCycleUnit.month",
  year: "subscription.customCycleUnit.year",
};

// AI 草稿是否可进入导入预览由领域层统一判断，避免展示层和导入层各自维护一套阻塞口径。
export function draftHasMissingCore(draft: AiRecognizedSubscriptionDraft): boolean {
  return hasAIDraftBlockingIssues(draft);
}

// 搜索只拼接 AI 可编辑草稿字段，不纳入诊断或上游 raw response，避免调试数据进入普通 UI 状态。
export function buildDraftSearchText(draft: AiRecognizedSubscriptionDraft): string {
  return [
    draft.name,
    draft.category,
    draft.paymentMethod,
    draft.website?.value,
    draft.notes?.value,
    ...draft.tags,
  ].filter(Boolean).join(" ").toLowerCase();
}

// AI provider 可能返回前端 Intl 尚不支持的币种代码；展示失败时保留原值，避免误改导入 payload。
export function formatDraftPrice(draft: AiRecognizedSubscriptionDraft, locale: Locale, unknownLabel: string): string {
  if (draft.price === null || !draft.currency) return unknownLabel;
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: draft.currency,
      maximumFractionDigits: 2,
    }).format(moneyToNumber(draft.price));
  } catch {
    return `${draft.price} ${draft.currency}`;
  }
}
