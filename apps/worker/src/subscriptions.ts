/**
 * Cloudflare 订阅 handler 是 shared schema 与 D1 row 之间的写入收敛层。
 *
 * Worker 没有 PocketBase hook，因此 create/update/import/renew 都必须在这里复用同一套字段归一和 owner 过滤。
 */
import {
  subscriptionCreateBodySchema,
  subscriptionPayloadSchema,
  subscriptionRenewBodySchema,
  type SubscriptionRenewBody,
  subscriptionsListPayloadSchema,
  subscriptionsListQuerySchema,
  subscriptionUpdateBodySchema,
} from "@renewlet/shared/schemas/subscriptions";
import { boolToInt, getSettings, getSubscription, newId, nowIso, parseJsonObject, parseStringArray, parseSubscriptionCursor, SUBSCRIPTION_COLUMNS, subscriptionCursor, toApiSubscription } from "./db";
import { listSubscriptionsForQuery } from "./subscription-list-filters";
import { advanceSubscriptionRenewal, dateOnlyInZone } from "./subscription-renewal";
import type { SubscriptionRenewalResult } from "@renewlet/shared/subscription-renewal";
import { refreshSubscriptionDerivedState } from "./subscription-derived-state";
import { HttpError, ok, readJson, requestLocale, successJson } from "./http";
import { serverText } from "./server-i18n";
import { requireAuth } from "./auth";
import type { Env, SubscriptionRow } from "./types";
import { z } from "zod";
import type { ApiAppSettings } from "@renewlet/shared/schemas/settings";
import { nextCostSharingCollectionReminderDate } from "@renewlet/shared/cost-sharing";

const subscriptionStorageBodySchema = subscriptionCreateBodySchema.refine((body) => body.startDate === null || body.nextBillingDate >= body.startDate, {
  path: ["nextBillingDate"],
  message: "NEXT_BILLING_DATE_BEFORE_START_DATE",
});

/** 读取当前用户订阅页；cursor 只决定分页位置，权限始终来自 Worker session。 */
export async function readSubscriptions(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env);
  const url = new URL(request.url);
  const parsed = subscriptionsListQuerySchema.parse({
    limit: url.searchParams.get("limit") ?? undefined,
    cursor: url.searchParams.get("cursor") ?? undefined,
    q: url.searchParams.get("q") ?? undefined,
    category: repeatedSearchParam(url.searchParams, "category"),
    tag: repeatedSearchParam(url.searchParams, "tag"),
    billingCycle: repeatedSearchParam(url.searchParams, "billingCycle"),
    paymentMethod: repeatedSearchParam(url.searchParams, "paymentMethod"),
    currency: repeatedSearchParam(url.searchParams, "currency"),
    status: url.searchParams.get("status") ?? undefined,
    renewal: url.searchParams.get("renewal") ?? undefined,
    nextBillingFrom: url.searchParams.get("nextBillingFrom") ?? undefined,
    nextBillingTo: url.searchParams.get("nextBillingTo") ?? undefined,
    pinned: url.searchParams.get("pinned") ?? undefined,
    publicHidden: url.searchParams.get("publicHidden") ?? undefined,
    reminderMode: url.searchParams.get("reminderMode") ?? undefined,
    repeatReminder: url.searchParams.get("repeatReminder") ?? undefined,
  });
  if (parsed.cursor && !parseSubscriptionCursor(parsed.cursor)) {
    throw new HttpError(400, serverText(requestLocale(request), "common.invalidRequestParameters"), "INVALID_CURSOR");
  }
  const today = parsed.status ? dateOnlyInZone(new Date(), (await getSettings(env, auth.user.id)).timezone) : "";
  const page = await listSubscriptionsForQuery(env, auth.user.id, parsed, today);
  const pageRows = page.rows.slice(0, parsed.limit);
  const nextCursor = page.rows.length > parsed.limit ? subscriptionCursor(pageRows[pageRows.length - 1]!) : null;
  return successJson(subscriptionsListPayloadSchema.parse({
    subscriptions: pageRows.map(toApiSubscription),
    nextCursor,
    total: page.total,
  }));
}

function repeatedSearchParam(params: URLSearchParams, name: string): string[] | undefined {
  const values = params.getAll(name);
  return values.length > 0 ? values : undefined;
}

/** 新建订阅走 shared create schema，确保 D1 写入边界与 Go/PocketBase API 保持同形。 */
export async function createSubscription(request: Request, env: Env): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  const body = parseSubscriptionBodyForStorage(await readJson(request, subscriptionCreateBodySchema, locale), locale);
  const timestamp = nowIso();
  const settings = await getSettings(env, auth.user.id);
  const row = toSubscriptionRow(newId("sub"), auth.user.id, body, timestamp, timestamp, { settings });
  await env.DB.prepare(`
    INSERT INTO subscriptions (
      id, user_id, name, logo, price, currency, billing_cycle, custom_days, custom_cycle_unit, one_time_term_count, one_time_term_unit,
      category, status, pinned, public_hidden, payment_method,
      start_date, next_billing_date, auto_renew, auto_calculate_next_billing_date, trial_end_date, website, notes, tags_json,
      reminder_days, repeat_reminder_enabled, repeat_reminder_interval, repeat_reminder_window, cost_sharing_json,
      cost_sharing_collection_reminder_enabled, cost_sharing_next_collection_reminder_date, extra_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(...subscriptionRowValues(row)).run();
  await refreshSubscriptionDerivedState(env, auth.user.id, { resetAutoRenewCheck: true });
  return successJson(subscriptionPayloadSchema.parse({ subscription: toApiSubscription(row) }), { status: 201 });
}

/** 更新订阅先合并为完整 create body，再转换为 D1 row，模拟 PocketBase hook 的最终规范化效果。 */
export async function updateSubscription(request: Request, env: Env, id: string): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  const existing = await getSubscription(env, auth.user.id, id);
  if (!existing) throw new HttpError(404, serverText(locale, "subscription.notFound"));
  const patch = await readJson(request, subscriptionUpdateBodySchema, locale);
  const timestamp = nowIso();
  const settings = await getSettings(env, auth.user.id);
  // Worker 没有 PocketBase hook 可二次归一；切换计费类型时先清理互斥字段，再合并 patch 走同一套 create schema。
  const mergedBody = parseSubscriptionBodyForStorage(mergeSubscriptionPatchForStorage(toBody(existing), stripUndefined(patch)), locale);
  const merged = toSubscriptionRow(existing.id, auth.user.id, mergedBody, existing.created_at, timestamp, { settings });
  await env.DB.prepare(`
    UPDATE subscriptions SET
      name = ?, logo = ?, price = ?, currency = ?, billing_cycle = ?, custom_days = ?, custom_cycle_unit = ?,
      one_time_term_count = ?, one_time_term_unit = ?, category = ?, status = ?,
      pinned = ?, public_hidden = ?, payment_method = ?, start_date = ?, next_billing_date = ?, auto_renew = ?, auto_calculate_next_billing_date = ?,
      trial_end_date = ?, website = ?, notes = ?, tags_json = ?, reminder_days = ?, repeat_reminder_enabled = ?,
      repeat_reminder_interval = ?, repeat_reminder_window = ?, cost_sharing_json = ?,
      cost_sharing_collection_reminder_enabled = ?, cost_sharing_next_collection_reminder_date = ?, extra_json = ?, updated_at = ?
    WHERE user_id = ? AND id = ?
  `).bind(
    merged.name,
    merged.logo,
    merged.price,
    merged.currency,
    merged.billing_cycle,
    merged.custom_days,
    merged.custom_cycle_unit,
    merged.one_time_term_count,
    merged.one_time_term_unit,
    merged.category,
    merged.status,
    merged.pinned,
    merged.public_hidden,
    merged.payment_method,
    merged.start_date,
    merged.next_billing_date,
    merged.auto_renew,
    merged.auto_calculate_next_billing_date,
    merged.trial_end_date,
    merged.website,
    merged.notes,
    merged.tags_json,
    merged.reminder_days,
    merged.repeat_reminder_enabled,
    merged.repeat_reminder_interval,
    merged.repeat_reminder_window,
    merged.cost_sharing_json,
    merged.cost_sharing_collection_reminder_enabled,
    merged.cost_sharing_next_collection_reminder_date,
    merged.extra_json,
    timestamp,
    auth.user.id,
    id,
  ).run();
  await refreshSubscriptionDerivedState(env, auth.user.id, { resetAutoRenewCheck: true });
  return successJson(subscriptionPayloadSchema.parse({ subscription: toApiSubscription(merged) }));
}

export async function deleteSubscription(request: Request, env: Env, id: string): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  const result = await env.DB.prepare("DELETE FROM subscriptions WHERE user_id = ? AND id = ?").bind(auth.user.id, id).run();
  if ((result.meta.changes ?? 0) === 0) throw new HttpError(404, serverText(locale, "subscription.notFound"));
  await refreshSubscriptionDerivedState(env, auth.user.id, { resetAutoRenewCheck: true });
  return ok();
}

/** 手动续订只允许当前 owner 的手动周期订阅；id 与 user_id 同查，避免通过续订错误枚举他人数据。 */
export async function renewSubscription(request: Request, env: Env, id: string): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  const body = await readJson(request, subscriptionRenewBodySchema, locale);
  const existing = await getSubscription(env, auth.user.id, id);
  if (!existing) throw new HttpError(404, serverText(locale, "subscription.notFound"), "NOT_FOUND");

  const settings = await getSettings(env, auth.user.id);
  const today = dateOnlyInZone(new Date(), settings.timezone);
  const result = advanceSubscriptionRenewal(existing, today, "manual");
  if (!result) throw new HttpError(400, serverText(locale, "common.invalidPayload"), "SUBSCRIPTION_RENEW_NOT_ALLOWED");

  const timestamp = nowIso();
  // Worker 没有 PocketBase hook；续订也必须先收敛成完整写入 body，才能重新执行 costSharing/date 镜像规则。
  const merged = renewSubscriptionRow(existing, body, result, timestamp, settings, today, locale);
  await env.DB.prepare(`
    UPDATE subscriptions SET
      price = ?, currency = ?, start_date = ?, next_billing_date = ?, auto_calculate_next_billing_date = ?,
      cost_sharing_collection_reminder_enabled = ?, cost_sharing_next_collection_reminder_date = ?, status = ?, updated_at = ?
    WHERE user_id = ? AND id = ?
  `).bind(
    merged.price,
    merged.currency,
    merged.start_date,
    merged.next_billing_date,
    merged.auto_calculate_next_billing_date,
    merged.cost_sharing_collection_reminder_enabled,
    merged.cost_sharing_next_collection_reminder_date,
    merged.status,
    timestamp,
    auth.user.id,
    id,
  ).run();
  await refreshSubscriptionDerivedState(env, auth.user.id, { resetAutoRenewCheck: true });
  return successJson(subscriptionPayloadSchema.parse({ subscription: toApiSubscription(merged) }));
}

export type SubscriptionBody = ReturnType<typeof subscriptionCreateBodySchema.parse>;

function renewSubscriptionRow(
  existing: SubscriptionRow,
  body: SubscriptionRenewBody,
  continueResult: SubscriptionRenewalResult,
  timestamp: string,
  settings: Pick<ApiAppSettings, "timezone" | "notificationReminderDays">,
  referenceDate: string,
  locale: ReturnType<typeof requestLocale>,
): SubscriptionRow {
  if (body.mode === "restart" && !body.startDate) {
    throw new HttpError(400, "INVALID_RENEW_START_DATE", "INVALID_PAYLOAD");
  }
  const existingBody = toBody(existing);
  // continue 忽略请求里的日期，restart 才写入用户选择的新日期；两者都保留其它订阅字段并重新过 shared 写入 schema。
  const mergedBody = parseSubscriptionBodyForStorage({
    ...existingBody,
    price: body.price,
    currency: body.currency,
    startDate: body.mode === "restart" ? body.startDate : existingBody.startDate,
    nextBillingDate: body.mode === "restart" ? body.nextBillingDate : continueResult.nextBillingDate,
    autoCalculateNextBillingDate: body.mode === "restart"
      ? body.autoCalculateNextBillingDate
      : existingBody.autoCalculateNextBillingDate,
    status: body.mode === "restart" && existing.status === "expired" ? "active" : continueResult.status,
  }, locale);
  return toSubscriptionRow(existing.id, existing.user_id, mergedBody, existing.created_at, timestamp, { settings, referenceDate });
}

export function normalizeSubscriptionBodyForStorage(body: unknown): SubscriptionBody {
  const parsed = subscriptionStorageBodySchema.parse(body);
  // Worker 没有 PocketBase hook；这里承接 Go 持久层同款规范化，供 create/update/import 三条写入路径共用。
  if (parsed.billingCycle === "custom") {
    return {
      ...parsed,
      customDays: parsed.customDays ?? 1,
      customCycleUnit: parsed.customCycleUnit ?? "day",
      oneTimeTermCount: null,
      oneTimeTermUnit: null,
    };
  }
  if (parsed.billingCycle === "one-time") {
    const hasTerm = parsed.oneTimeTermCount !== null && parsed.oneTimeTermCount !== undefined;
    return {
      ...parsed,
      customDays: null,
      customCycleUnit: null,
      oneTimeTermCount: hasTerm ? parsed.oneTimeTermCount : null,
      oneTimeTermUnit: hasTerm ? parsed.oneTimeTermUnit ?? "month" : null,
      autoRenew: false,
      autoCalculateNextBillingDate: false,
    };
  }
  return {
    ...parsed,
    customDays: null,
    customCycleUnit: null,
    oneTimeTermCount: null,
    oneTimeTermUnit: null,
  };
}

function parseSubscriptionBodyForStorage(body: unknown, locale: ReturnType<typeof requestLocale>): SubscriptionBody {
  try {
    return normalizeSubscriptionBodyForStorage(body);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new HttpError(400, serverText(locale, "common.invalidPayload"), "INVALID_PAYLOAD", error.flatten());
    }
    throw error;
  }
}

/** 把 D1 row 还原成 shared 写入 body，用于 PATCH 合并而不是直接拼 SQL 字段。 */
function toBody(row: SubscriptionRow): SubscriptionBody {
  // PATCH 合并要容忍历史脏 tags_json；本次 UPDATE 会经 toSubscriptionRow 收敛回合法数组 JSON。
  const tags = parseStringArray(row.tags_json);
  return {
    name: row.name,
    logo: row.logo,
    price: row.price,
    currency: row.currency,
    billingCycle: row.billing_cycle as SubscriptionBody["billingCycle"],
    customDays: row.custom_days,
    customCycleUnit: row.custom_cycle_unit,
    oneTimeTermCount: row.one_time_term_count,
    oneTimeTermUnit: row.one_time_term_unit,
    category: row.category,
    status: row.status as SubscriptionBody["status"],
    pinned: row.pinned === 1,
    publicHidden: row.public_hidden === 1,
    paymentMethod: row.payment_method,
    startDate: row.start_date,
    nextBillingDate: row.next_billing_date,
    autoRenew: row.billing_cycle === "one-time" ? false : row.auto_renew === 1,
    autoCalculateNextBillingDate: row.auto_calculate_next_billing_date === 1,
    trialEndDate: row.trial_end_date,
    website: row.website,
    notes: row.notes,
    tags,
    reminderDays: row.reminder_days,
    repeatReminderEnabled: row.repeat_reminder_enabled === 1,
    repeatReminderInterval: row.repeat_reminder_interval as SubscriptionBody["repeatReminderInterval"],
    repeatReminderWindow: row.repeat_reminder_window as SubscriptionBody["repeatReminderWindow"],
    // PATCH 合并必须带回 costSharing，否则只改备注也会把 D1 JSON 分摊信息清空。
    costSharing: Object.keys(parseJsonObject(row.cost_sharing_json ?? "{}")).length > 0 ? parseJsonObject(row.cost_sharing_json ?? "{}") as SubscriptionBody["costSharing"] : null,
    extra: parseJsonObject(row.extra_json),
  };
}

/** 将 shared 订阅 body 映射到 D1 行；所有 snake_case、null 和整数布尔都集中在这里。 */
export function toSubscriptionRow(
  id: string,
  userId: string,
  body: SubscriptionBody,
  createdAt: string,
  updatedAt: string,
  options: { settings?: Pick<ApiAppSettings, "timezone" | "notificationReminderDays">; referenceDate?: string } = {},
): SubscriptionRow {
  const costSharingMirror = collectionReminderMirror(body, options);
  return {
    id,
    user_id: userId,
    name: body.name,
    logo: body.logo ?? null,
    price: body.price,
    currency: body.currency,
    billing_cycle: body.billingCycle,
    // 非 custom 周期必须把自定义字段清空，否则后续编辑会把旧自定义周期“复活”。
    custom_days: body.billingCycle === "custom" ? body.customDays ?? 1 : null,
    custom_cycle_unit: body.billingCycle === "custom" ? body.customCycleUnit ?? "day" : null,
    // one-time 服务期是“预付权益期”契约；非 one-time 清空，避免旧买断字段被周期订阅误用于摊销。
    one_time_term_count: body.billingCycle === "one-time" ? body.oneTimeTermCount ?? null : null,
    one_time_term_unit: body.billingCycle === "one-time" ? body.oneTimeTermUnit ?? null : null,
    category: body.category,
    status: body.status,
    pinned: boolToInt(body.pinned),
    // publicHidden=false 是公开页启用后的默认展示语义；隐藏必须由用户逐条显式选择。
    public_hidden: boolToInt(body.publicHidden),
    payment_method: body.paymentMethod ?? null,
    start_date: body.startDate,
    next_billing_date: body.nextBillingDate,
    // auto_renew 与 auto_calculate_next_billing_date 是两个独立契约：前者驱动后台续订，后者只影响日期锚点计算。
    auto_renew: boolToInt(body.billingCycle === "one-time" ? false : body.autoRenew),
    // Worker 没有 PocketBase hook；one-time 不自动滚动日期，固定服务期只发到期提醒。
    auto_calculate_next_billing_date: boolToInt(body.billingCycle === "one-time" ? false : body.autoCalculateNextBillingDate),
    trial_end_date: body.trialEndDate ?? null,
    website: body.website ?? null,
    notes: body.notes ?? null,
    tags_json: JSON.stringify(body.tags ?? []),
    reminder_days: body.reminderDays,
    repeat_reminder_enabled: boolToInt(body.repeatReminderEnabled),
    repeat_reminder_interval: body.repeatReminderInterval,
    repeat_reminder_window: body.repeatReminderWindow,
    // D1 没有 JSON 类型；空对象表示未开启分摊，非空对象必须保持 shared costSharing wire shape。
    cost_sharing_json: JSON.stringify(body.costSharing ?? {}),
    // 镜像列只服务通知 cron 的 D1 索引候选；真实配置和出站响应继续以 cost_sharing_json 为准。
    cost_sharing_collection_reminder_enabled: boolToInt(costSharingMirror.enabled),
    cost_sharing_next_collection_reminder_date: costSharingMirror.nextReminderDate,
    // extra 不走 UI 展示；它给 seed/import 留稳定幂等键，编辑订阅时必须随原记录保留。
    extra_json: JSON.stringify(body.extra ?? {}),
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

export function subscriptionRowValues(row: SubscriptionRow): unknown[] {
  return [
    row.id, row.user_id, row.name, row.logo, row.price, row.currency, row.billing_cycle, row.custom_days, row.custom_cycle_unit,
    row.one_time_term_count, row.one_time_term_unit,
    row.category, row.status, row.pinned, row.public_hidden, row.payment_method, row.start_date, row.next_billing_date,
    row.auto_renew, row.auto_calculate_next_billing_date, row.trial_end_date, row.website, row.notes, row.tags_json,
    row.reminder_days, row.repeat_reminder_enabled, row.repeat_reminder_interval, row.repeat_reminder_window,
    row.cost_sharing_json, row.cost_sharing_collection_reminder_enabled, row.cost_sharing_next_collection_reminder_date,
    row.extra_json, row.created_at, row.updated_at,
  ];
}

export async function refreshCostSharingCollectionReminderMirrors(
  env: Env,
  userId: string,
  settings: Pick<ApiAppSettings, "timezone" | "notificationReminderDays">,
  referenceDate = dateOnlyInZone(new Date(), settings.timezone),
): Promise<void> {
  const rows = await env.DB.prepare(`SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions WHERE user_id = ?`)
    .bind(userId)
    .all<SubscriptionRow>();
  for (const row of rows.results) {
    const costSharingJson = parseJsonObject(row.cost_sharing_json ?? "{}");
    const costSharing = Object.keys(costSharingJson).length > 0 ? costSharingJson as SubscriptionBody["costSharing"] : null;
    const mirror = collectionReminderMirror({ ...toBody(row), costSharing }, { settings, referenceDate });
    const enabled = boolToInt(mirror.enabled);
    if (row.cost_sharing_collection_reminder_enabled === enabled && row.cost_sharing_next_collection_reminder_date === mirror.nextReminderDate) {
      continue;
    }
    // settings 的全局提醒天数/时区会影响 inherited 收款提醒；刷新只动内部索引镜像，不反写 cost_sharing_json。
    await env.DB.prepare(`
      UPDATE subscriptions
      SET cost_sharing_collection_reminder_enabled = ?, cost_sharing_next_collection_reminder_date = ?
      WHERE user_id = ? AND id = ?
    `).bind(enabled, mirror.nextReminderDate, userId, row.id).run();
  }
}

function collectionReminderMirror(
  body: Pick<SubscriptionBody,
    "costSharing" | "startDate" | "nextBillingDate" | "billingCycle" | "customDays" | "customCycleUnit" | "oneTimeTermCount" | "oneTimeTermUnit"
  >,
  options: { settings?: Pick<ApiAppSettings, "timezone" | "notificationReminderDays">; referenceDate?: string },
): { enabled: boolean; nextReminderDate: string | null } {
  const reminder = body.costSharing?.collectionReminder;
  if (!body.costSharing?.enabled || !reminder?.enabled) {
    return { enabled: false, nextReminderDate: null };
  }
  const settings = {
    timezone: options.settings?.timezone ?? "UTC",
    notificationReminderDays: options.settings?.notificationReminderDays ?? 3,
  };
  const referenceDate = options.referenceDate ?? dateOnlyInZone(new Date(), settings.timezone);
  const nextReminderDate = nextCostSharingCollectionReminderDate({
    costSharing: body.costSharing ?? undefined,
    subscriptionStartDate: body.startDate,
    nextBillingDate: body.nextBillingDate,
    billingCycle: body.billingCycle,
    customDays: body.customDays,
    customCycleUnit: body.customCycleUnit,
    oneTimeTermCount: body.oneTimeTermCount,
    oneTimeTermUnit: body.oneTimeTermUnit,
    notificationReminderDays: settings.notificationReminderDays,
    referenceDate,
  });
  // 镜像字段只服务 D1 索引候选，不能成为公共 API 事实源；真实配置仍以 cost_sharing_json 为准。
  return { enabled: Boolean(nextReminderDate), nextReminderDate };
}

function stripUndefined<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function mergeSubscriptionPatchForStorage(base: SubscriptionBody, patch: Record<string, unknown>): Record<string, unknown> {
  const normalizedPatch: Record<string, unknown> = { ...patch };
  const billingCycle = patch["billingCycle"];
  if (billingCycle === "custom") {
    normalizedPatch["oneTimeTermCount"] = null;
    normalizedPatch["oneTimeTermUnit"] = null;
  } else if (billingCycle === "one-time") {
    normalizedPatch["customDays"] = null;
    normalizedPatch["customCycleUnit"] = null;
    normalizedPatch["autoRenew"] = false;
    normalizedPatch["autoCalculateNextBillingDate"] = false;
  } else if (billingCycle) {
    normalizedPatch["customDays"] = null;
    normalizedPatch["customCycleUnit"] = null;
    normalizedPatch["oneTimeTermCount"] = null;
    normalizedPatch["oneTimeTermUnit"] = null;
  }
  return { ...base, ...normalizedPatch };
}
