import { apiFetch } from "@/lib/api-client";
import { assertDateOnly } from "@/lib/time/date-only";
import { getApiLocale } from "@/i18n/api-locale";
import { translate } from "@/i18n/messages";
import { getCurrentUserId } from "@/lib/pocketbase";
import {
  apiSubscriptionSchema,
  subscriptionsListResponseSchema,
  type SubscriptionsListQuery,
  subscriptionResponseSchema,
  subscriptionDeleteResponseSchema,
  type ApiSubscription,
  type SubscriptionRenewBody,
} from "@renewlet/shared/schemas/subscriptions";
import {
  type Subscription,
  type SubscriptionDraft,
} from "@/types/subscription";

const SUBSCRIPTION_PAGE_SIZE = 50;
const SUBSCRIPTION_AGGREGATE_LIMIT = 5000;
export type SubscriptionListFilters = Omit<SubscriptionsListQuery, "limit" | "cursor">;
type SubscriptionBaseForService = Pick<
  Subscription,
  | "id"
  | "name"
  | "logo"
  | "price"
  | "currency"
  | "category"
  | "status"
  | "paymentMethod"
  | "startDate"
  | "nextBillingDate"
  | "autoRenew"
  | "autoCalculateNextBillingDate"
  | "pinned"
  | "publicHidden"
  | "trialEndDate"
  | "website"
  | "notes"
  | "tags"
  | "reminderDays"
  | "repeatReminderEnabled"
  | "repeatReminderInterval"
  | "repeatReminderWindow"
  | "costSharing"
  | "extra"
>;

export interface SubscriptionPage {
  subscriptions: Subscription[];
  nextCursor: string | null;
  total?: number | undefined;
}

export type SubscriptionFieldPatch = Partial<Pick<Subscription, "pinned" | "publicHidden">>;

function normalizeSubscriptionPageLimit(value: number): number {
  if (!Number.isFinite(value)) return SUBSCRIPTION_PAGE_SIZE;
  return Math.max(1, Math.min(Math.trunc(value), 100));
}

function appendSubscriptionListFilters(params: URLSearchParams, filters?: SubscriptionListFilters): void {
  if (!filters) return;
  if (filters.q) params.set("q", filters.q);
  for (const value of filters.category ?? []) params.append("category", value);
  for (const value of filters.tag ?? []) params.append("tag", value);
  for (const value of filters.billingCycle ?? []) params.append("billingCycle", value);
  for (const value of filters.paymentMethod ?? []) params.append("paymentMethod", value);
  for (const value of filters.currency ?? []) params.append("currency", value);
  if (filters.status) params.set("status", filters.status);
  if (filters.renewal) params.set("renewal", filters.renewal);
  if (filters.nextBillingFrom) params.set("nextBillingFrom", filters.nextBillingFrom);
  if (filters.nextBillingTo) params.set("nextBillingTo", filters.nextBillingTo);
  if (filters.pinned !== undefined) params.set("pinned", String(filters.pinned));
  if (filters.publicHidden !== undefined) params.set("publicHidden", String(filters.publicHidden));
  if (filters.reminderMode) params.set("reminderMode", filters.reminderMode);
  if (filters.repeatReminder !== undefined) params.set("repeatReminder", String(filters.repeatReminder));
}

/**
 * 将产品 API DTO 收敛成前端 domain 对象。
 *
 * Docker 与 Cloudflare 都必须返回 shared `ApiSubscription`；前端不再承接 PocketBase record 兼容层。
 */
export function fromApiSubscription(row: ApiSubscription): Subscription {
  const parsedRow: ApiSubscription = apiSubscriptionSchema.parse(row);
  const startDate = parsedRow.startDate === null ? null : assertDateOnly(parsedRow.startDate);
  const nextBillingDate = assertDateOnly(parsedRow.nextBillingDate);
  const trialEndDate = parsedRow.trialEndDate ? assertDateOnly(parsedRow.trialEndDate) : undefined;
  const base = {
    id: parsedRow.id,
    name: parsedRow.name,
    logo: parsedRow.logo,
    price: parsedRow.price,
    currency: parsedRow.currency,
    category: parsedRow.category,
    status: parsedRow.status,
    paymentMethod: parsedRow.paymentMethod,
    startDate,
    nextBillingDate,
    autoRenew: parsedRow.billingCycle === "one-time" ? false : parsedRow.autoRenew,
    autoCalculateNextBillingDate: parsedRow.autoCalculateNextBillingDate,
    pinned: parsedRow.pinned,
    publicHidden: parsedRow.publicHidden,
    trialEndDate,
    website: parsedRow.website,
    notes: parsedRow.notes,
    tags: parsedRow.tags ?? [],
    reminderDays: parsedRow.reminderDays,
    repeatReminderEnabled: parsedRow.repeatReminderEnabled,
    repeatReminderInterval: parsedRow.repeatReminderInterval,
    repeatReminderWindow: parsedRow.repeatReminderWindow,
    costSharing: parsedRow.costSharing,
    extra: parsedRow.extra,
  } satisfies SubscriptionBaseForService;
  if (parsedRow.billingCycle === "custom") {
    // 旧 custom 记录没有单位字段；读边界统一按 day 解释，避免统计和自动推算把历史含义改成月/年。
    return {
      ...base,
      billingCycle: "custom",
      customDays: parsedRow.customDays ?? 1,
      customCycleUnit: parsedRow.customCycleUnit ?? "day",
      oneTimeTermCount: undefined,
      oneTimeTermUnit: undefined,
    };
  }
  if (parsedRow.billingCycle === "one-time") {
    return {
      ...base,
      billingCycle: "one-time",
      customDays: undefined,
      customCycleUnit: undefined,
      oneTimeTermCount: parsedRow.oneTimeTermCount,
      oneTimeTermUnit: parsedRow.oneTimeTermUnit,
    };
  }
  return {
    ...base,
    billingCycle: parsedRow.billingCycle,
    customDays: undefined,
    customCycleUnit: undefined,
    oneTimeTermCount: undefined,
    oneTimeTermUnit: undefined,
  };
}

/**
 * 生成订阅写入 payload。
 *
 * `null` 表示清空可选字段，`undefined` 表示字段缺席；这里主动使用 null，
 * 防止 PocketBase patch 和 Worker JSON merge 对可选字段产生不同语义。
 */
export function toSubscriptionWritePayload(sub: SubscriptionDraft | Subscription) {
  return {
    name: sub.name,
    logo: sub.logo ?? null,
    price: sub.price,
    currency: sub.currency,
    billingCycle: sub.billingCycle,
    // null 表示服务端应清空可选字段；undefined 会在 PocketBase/Worker 两端产生不同 patch 语义。
    customDays: sub.customDays ?? null,
    customCycleUnit: sub.customCycleUnit ?? null,
    oneTimeTermCount: sub.oneTimeTermCount ?? null,
    oneTimeTermUnit: sub.oneTimeTermUnit ?? null,
    category: sub.category,
    status: sub.status,
    paymentMethod: sub.paymentMethod ?? null,
    startDate: sub.startDate,
    nextBillingDate: sub.nextBillingDate,
    autoRenew: sub.billingCycle === "one-time" ? false : sub.autoRenew,
    autoCalculateNextBillingDate: sub.autoCalculateNextBillingDate,
    pinned: sub.pinned,
    publicHidden: sub.publicHidden,
    trialEndDate: sub.trialEndDate ?? null,
    website: sub.website ?? null,
    notes: sub.notes ?? null,
    tags: sub.tags ?? [],
    reminderDays: sub.reminderDays,
    repeatReminderEnabled: sub.repeatReminderEnabled,
    repeatReminderInterval: sub.repeatReminderInterval,
    repeatReminderWindow: sub.repeatReminderWindow,
    costSharing: sub.costSharing ?? null,
    // extra 是导入/seed 的幂等通道；编辑普通字段时必须随记录保留，避免重复导入失效。
    extra: sub.extra ?? {},
  };
}

function toSubscriptionFieldPatchPayload(patch: SubscriptionFieldPatch) {
  const payload: Record<string, boolean> = {};
  if (patch.pinned !== undefined) payload["pinned"] = patch.pinned;
  if (patch.publicHidden !== undefined) payload["publicHidden"] = patch.publicHidden;
  if (Object.keys(payload).length === 0) {
    throw new Error("SUBSCRIPTION_PATCH_EMPTY");
  }
  return payload;
}

export const subscriptionService = {
  pageSize: SUBSCRIPTION_PAGE_SIZE,

  async listPage(cursor?: string | null, limit = SUBSCRIPTION_PAGE_SIZE, filters?: SubscriptionListFilters): Promise<SubscriptionPage> {
    const userId = getCurrentUserId();
    if (!userId) return { subscriptions: [], nextCursor: null, total: 0 };
    const pageSize = normalizeSubscriptionPageLimit(limit);
    const params = new URLSearchParams({ limit: String(pageSize) });
    if (cursor) params.set("cursor", cursor);
    appendSubscriptionListFilters(params, filters);
    const data = await apiFetch(`/api/app/subscriptions?${params.toString()}`, subscriptionsListResponseSchema);
    return {
      subscriptions: data.subscriptions.map(fromApiSubscription),
      nextCursor: data.nextCursor,
      total: data.total,
    };
  },

  async list(filters?: SubscriptionListFilters): Promise<Subscription[]> {
    const out: Subscription[] = [];
    let cursor: string | null | undefined = null;
    const seenCursors = new Set<string>();
    for (;;) {
      const page = await this.listPage(cursor, SUBSCRIPTION_PAGE_SIZE, filters);
      out.push(...page.subscriptions);
      if (!page.nextCursor) return out.slice(0, SUBSCRIPTION_AGGREGATE_LIMIT);
      if (seenCursors.has(page.nextCursor)) {
        // 后端 cursor 应单调推进；重复 cursor 说明分页没有前进，必须熔断以免首页/统计页请求风暴。
        throw new Error("SUBSCRIPTION_CURSOR_REPEATED");
      }
      // 聚合列表主要给统计/导出使用；上限避免异常数据量让单页 UI 拉取变成无界循环。
      if (out.length >= SUBSCRIPTION_AGGREGATE_LIMIT) return out.slice(0, SUBSCRIPTION_AGGREGATE_LIMIT);
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  },

  async create(sub: SubscriptionDraft): Promise<Subscription> {
    const userId = getCurrentUserId();
    if (!userId) throw new Error(translate(getApiLocale(), "auth.loginRequired"));
    const payload = toSubscriptionWritePayload(sub);
    const data = await apiFetch("/api/app/subscriptions", subscriptionResponseSchema, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return fromApiSubscription(data.subscription);
  },

  async update(sub: Subscription): Promise<Subscription> {
    const payload = toSubscriptionWritePayload(sub);
    const data = await apiFetch(`/api/app/subscriptions/${sub.id}`, subscriptionResponseSchema, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
    return fromApiSubscription(data.subscription);
  },

  async patch(id: string, patch: SubscriptionFieldPatch): Promise<Subscription> {
    const payload = toSubscriptionFieldPatchPayload(patch);
    const data = await apiFetch(`/api/app/subscriptions/${id}`, subscriptionResponseSchema, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
    return fromApiSubscription(data.subscription);
  },

  async renew(id: string, payload: SubscriptionRenewBody): Promise<Subscription> {
    const data = await apiFetch(`/api/app/subscriptions/${id}/renew`, subscriptionResponseSchema, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return fromApiSubscription(data.subscription);
  },

  async delete(id: string): Promise<void> {
    await apiFetch(`/api/app/subscriptions/${id}`, subscriptionDeleteResponseSchema, { method: "DELETE" });
  },
};
