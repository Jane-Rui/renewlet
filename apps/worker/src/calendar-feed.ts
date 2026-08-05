/**
 * Cloudflare 日历 Feed handler 管理可撤销的公开 ICS bearer URL。
 *
 * D1 token 是公开读取的唯一凭据；ICS 只导出下一次 date-only 全日事件，不复制续订算法或暴露登录态。
 */
import {
  calendarFeedCreateRequestSchema,
  calendarFeedCreatePayloadSchema,
  calendarFeedStatusPayloadSchema,
} from "@renewlet/shared/schemas/calendar-feed";
import { buildRenewalCalendarIcs } from "@renewlet/shared/ics";
import { buildRenewalCalendarEvent, type RenewalCalendarEvent, type RenewalCalendarSubscription } from "@renewlet/shared/calendar-events";
import { effectiveReminderDays, isDisabledReminderDays, isValidDateOnly, type BillingCycle } from "@renewlet/shared/runtime";
import { customConfigSchema, type ApiCustomConfig } from "@renewlet/shared/schemas/custom-config";
import type { ApiAppSettings } from "@renewlet/shared/schemas/settings";
import { getCustomConfig, getSettings, getSubscription, listSubscriptions, newId, nowIso } from "./db";
import { randomToken } from "./crypto";
import { requireAuth } from "./auth";
import { HttpError, ok, readJson, requestLocale, successJson } from "./http";
import { serverFormat, serverText } from "./server-i18n";
import { calendarFeedBuiltInCategoryLabelKey, calendarFeedBuiltInPaymentMethodLabelKey } from "./calendar-feed-built-in-labels";
import { requestOrigin } from "./request-origin";
import type { CalendarFeedRow, Env, SubscriptionRow } from "./types";

type CalendarFeedScope = CalendarFeedRow["scope"];
type CalendarCustomCycleUnit = "day" | "week" | "month" | "year";
type CalendarFixedBillingCycle = Exclude<BillingCycle, "custom">;

interface CalendarSubscription extends RenewalCalendarSubscription {
  status: string;
  customDays?: number | undefined;
  customCycleUnit?: string | undefined;
  reminderDays: number;
}

interface CalendarFeedLabelResolver {
  categoryLabel(value: string): string;
  paymentMethodLabel(value: string | undefined): string | undefined;
}

type CalendarFeedBuiltInLabelKeyResolver = (value: string) => Parameters<typeof serverText>[1] | undefined;

/** 读取全局续费日历 feed 状态；只返回 URL 展示态，不把 token 拆成独立字段。 */
export async function readCalendarFeed(request: Request, env: Env): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  await ensureCalendarFeedSchema(env, locale);
  const row = await getCalendarFeed(env, auth.user.id, "all", null);
  return successJson(calendarFeedStatusPayloadSchema.parse({ calendarFeed: calendarFeedStatus(row, request) }));
}

/** 创建或复用全局 feed；请求体必须为空对象，token 始终由服务端生成。 */
export async function createCalendarFeed(request: Request, env: Env): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  await readJson(request, calendarFeedCreateRequestSchema, locale);
  await ensureCalendarFeedSchema(env, locale);
  const existing = await getCalendarFeed(env, auth.user.id, "all", null);
  const row = existing ?? await insertCalendarFeed(env, {
    scope: "all",
    subscriptionId: null,
    userId: auth.user.id,
  });
  return successJson(calendarFeedCreatePayloadSchema.parse({
    calendarFeed: {
      ...calendarFeedStatus(row, request),
      enabled: true,
    },
  }));
}

export async function deleteCalendarFeed(request: Request, env: Env): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  await ensureCalendarFeedSchema(env, locale);
  await env.DB.prepare("DELETE FROM calendar_feeds WHERE user_id = ? AND scope = 'all'").bind(auth.user.id).run();
  return ok();
}

export async function readSubscriptionCalendarFeed(request: Request, env: Env, subscriptionId: string): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  await ensureCalendarFeedSchema(env, locale);
  const subscription = await getSubscription(env, auth.user.id, subscriptionId);
  if (!subscription) throw new HttpError(404, serverText(locale, "subscription.notFound"), "NOT_FOUND");
  if (isOneTimeBuyout(toCalendarSubscription(subscription))) throw new HttpError(404, serverText(locale, "subscription.notFound"), "NOT_FOUND");
  const row = await getCalendarFeed(env, auth.user.id, "subscription", subscriptionId);
  return successJson(calendarFeedStatusPayloadSchema.parse({ calendarFeed: calendarFeedStatus(row, request) }));
}

/** 创建单订阅 feed 前先确认订阅属于当前用户，避免用 feed URL 探测他人订阅 ID。 */
export async function createSubscriptionCalendarFeed(request: Request, env: Env, subscriptionId: string): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  await readJson(request, calendarFeedCreateRequestSchema, locale);
  await ensureCalendarFeedSchema(env, locale);
  const subscription = await getSubscription(env, auth.user.id, subscriptionId);
  if (!subscription) throw new HttpError(404, serverText(locale, "subscription.notFound"), "NOT_FOUND");
  if (isOneTimeBuyout(toCalendarSubscription(subscription))) throw new HttpError(404, serverText(locale, "subscription.notFound"), "NOT_FOUND");
  const existing = await getCalendarFeed(env, auth.user.id, "subscription", subscriptionId);
  const row = existing ?? await insertCalendarFeed(env, {
    scope: "subscription",
    subscriptionId,
    userId: auth.user.id,
  });
  return successJson(calendarFeedCreatePayloadSchema.parse({
    calendarFeed: {
      ...calendarFeedStatus(row, request),
      enabled: true,
    },
  }));
}

export async function deleteSubscriptionCalendarFeed(request: Request, env: Env, subscriptionId: string): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  await ensureCalendarFeedSchema(env, locale);
  const subscription = await getSubscription(env, auth.user.id, subscriptionId);
  if (!subscription) throw new HttpError(404, serverText(locale, "subscription.notFound"), "NOT_FOUND");
  await env.DB.prepare("DELETE FROM calendar_feeds WHERE user_id = ? AND scope = 'subscription' AND subscription_id = ?")
    .bind(auth.user.id, subscriptionId)
    .run();
  return ok();
}

export async function downloadSubscriptionCalendarIcs(request: Request, env: Env, subscriptionId: string): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  const subscription = await getSubscription(env, auth.user.id, subscriptionId);
  if (!subscription) throw new HttpError(404, serverText(locale, "subscription.notFound"), "NOT_FOUND");
  const calendarSubscription = toCalendarSubscription(subscription);
  if (isOneTimeBuyout(calendarSubscription)) throw new HttpError(404, serverText(locale, "subscription.notFound"), "NOT_FOUND");
  const settings = await getSettings(env, auth.user.id);
  const labels = await newCalendarFeedLabelResolver(env, auth.user.id, settings.locale);
  // 登录态下载是一次性 .ics 文件，不写 SOURCE/TTL，避免外部日历把它误当成可刷新的订阅 feed。
  const ics = buildRenewalCalendarIcs({
    name: serverFormat(settings.locale, "calendarFeed.subscriptionCalendarName", { name: calendarSubscription.name }),
    generatedAt: new Date(),
    events: subscriptionCalendarEvents(calendarSubscription, settings, labels),
  });
  return new Response(ics, {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `attachment; filename="renewlet-${safeCalendarFeedFilename(calendarSubscription.id)}.ics"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function calendarFeedIcs(request: Request, env: Env): Promise<Response> {
  const locale = requestLocale(request);
  const token = new URL(request.url).searchParams.get("token")?.trim() ?? "";
  if (!token) throw new HttpError(404, serverText(locale, "calendarFeed.notFound"), "NOT_FOUND");
  let row: CalendarFeedRow | null;
  try {
    row = await env.DB.prepare(`
      SELECT id, user_id, scope, subscription_id, token, created_at, updated_at
      FROM calendar_feeds
      WHERE token = ?
      LIMIT 1
    `).bind(token).first<CalendarFeedRow>();
  } catch (error) {
    if (isUnreadableCalendarFeedTable(error)) {
      // 公开 feed 是 bearer URL，不承担迁移动作；漏迁移、旧表和无效 token 一样不给出表结构线索。
      throw new HttpError(404, serverText(locale, "calendarFeed.notFound"), "NOT_FOUND");
    }
    throw error;
  }
  if (!row) {
    // 公开 feed 是 bearer URL；缺失、撤销和猜测 token 都返回同一个 404，避免泄漏有效性。
    throw new HttpError(404, serverText(locale, "calendarFeed.notFound"), "NOT_FOUND");
  }

  const settings = await getSettings(env, row.user_id);
  const feedUrl = calendarFeedUrl(request, row.token);
  const rendered = await renderCalendarFeed(env, request, row, settings, feedUrl);
  return new Response(rendered.ics, {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `inline; filename="${rendered.filename}"`,
      "cache-control": "private, max-age=300",
      "x-content-type-options": "nosniff",
    },
  });
}

/** 渲染公开 ICS 内容；scope 决定导出全局续费列表还是单个订阅的一次全日事件。 */
async function renderCalendarFeed(
  env: Env,
  request: Request,
  row: CalendarFeedRow,
  settings: ApiAppSettings,
  feedUrl: string,
): Promise<{ filename: string; ics: string }> {
  const labels = await newCalendarFeedLabelResolver(env, row.user_id, settings.locale);
  if (row.scope === "subscription") {
    const subscriptionId = row.subscription_id ?? "";
    const subscription = subscriptionId ? await getSubscription(env, row.user_id, subscriptionId) : null;
    if (!subscription) throw new HttpError(404, serverText(requestLocale(request), "calendarFeed.notFound"), "NOT_FOUND");
    const calendarSubscription = toCalendarSubscription(subscription);
    return {
      filename: "renewlet-subscription.ics",
      ics: buildRenewalCalendarIcs({
        name: serverFormat(settings.locale, "calendarFeed.subscriptionCalendarName", { name: calendarSubscription.name }),
        sourceUrl: feedUrl,
        generatedAt: new Date(),
        events: subscriptionCalendarEvents(calendarSubscription, settings, labels),
      }),
    };
  }

  const subscriptions = (await listSubscriptions(env, row.user_id)).map(toCalendarSubscription);
  return {
    filename: "renewlet-renewals.ics",
    ics: buildRenewalCalendarIcs({
      name: serverText(settings.locale, "calendarFeed.calendarName"),
      sourceUrl: feedUrl,
      generatedAt: new Date(),
      events: calendarEvents(subscriptions, settings, labels),
    }),
  };
}

async function newCalendarFeedLabelResolver(
  env: Env,
  userId: string,
  locale: ApiAppSettings["locale"],
): Promise<CalendarFeedLabelResolver> {
  const empty = calendarFeedLabelResolver(new Map<string, string>(), new Map<string, string>(), locale);
  const result = customConfigSchema.safeParse(await getCustomConfig(env, userId));
  if (!result.success) return empty;
  // 公开 ICS route 没有登录态上下文；用户配置只做优先查找，缺失的内置项回 server i18n，未知自定义 value 保留原文。
  return calendarFeedLabelResolver(
    calendarFeedLabelMap(result.data.categories, locale),
    calendarFeedLabelMap(result.data.paymentMethods, locale),
    locale,
  );
}

function calendarFeedLabelResolver(
  categoryByValue: Map<string, string>,
  paymentMethodByValue: Map<string, string>,
  locale: ApiAppSettings["locale"],
): CalendarFeedLabelResolver {
  return {
    categoryLabel: (value) => calendarFeedResolvedLabel(categoryByValue, calendarFeedBuiltInCategoryLabelKey, locale, value),
    paymentMethodLabel: (value) => value ? calendarFeedResolvedLabel(paymentMethodByValue, calendarFeedBuiltInPaymentMethodLabelKey, locale, value) : value,
  };
}

function calendarFeedResolvedLabel(
  customLabels: Map<string, string>,
  builtInLabelKey: CalendarFeedBuiltInLabelKeyResolver,
  locale: ApiAppSettings["locale"],
  value: string,
): string {
  const customLabel = customLabels.get(value);
  if (customLabel) return customLabel;
  const key = builtInLabelKey(value);
  return key ? serverText(locale, key) : value;
}

function calendarFeedLabelMap(items: ApiCustomConfig["categories"], locale: ApiAppSettings["locale"]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const item of items) {
    const label = calendarFeedLocalizedConfigLabel(item.labels, locale);
    if (label) labels.set(item.value, label);
  }
  return labels;
}

function calendarFeedLocalizedConfigLabel(
  labels: ApiCustomConfig["categories"][number]["labels"],
  locale: ApiAppSettings["locale"],
): string | undefined {
  if (locale === "en-US") return labels["en-US"] || labels["zh-CN"] || undefined;
  return labels["zh-CN"] || labels["en-US"] || undefined;
}

async function ensureCalendarFeedSchema(env: Env, locale: ReturnType<typeof requestLocale>): Promise<void> {
  try {
    const columns = await calendarFeedColumns(env);
    if (columns.length === 0) {
      await createCalendarFeedTable(env);
    } else if (!columns.includes("scope") || !columns.includes("token")) {
      await recreateCalendarFeedSchema(env);
    }
    await createCalendarFeedIndexes(env);
  } catch {
    throw new HttpError(500, serverText(locale, "calendarFeed.migrationRequired"), "MIGRATION_REQUIRED");
  }
}

async function calendarFeedColumns(env: Env): Promise<string[]> {
  const result = await env.DB.prepare("PRAGMA table_info(calendar_feeds)").all<{ name: string }>();
  return result.results.map((row) => row.name);
}

async function createCalendarFeedTable(env: Env): Promise<void> {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS calendar_feeds (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      scope TEXT NOT NULL CHECK (scope IN ('all', 'subscription')),
      subscription_id TEXT REFERENCES subscriptions(id) ON DELETE CASCADE,
      token TEXT NOT NULL UNIQUE CHECK (length(token) = 43),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (scope = 'all' AND subscription_id IS NULL)
        OR (scope = 'subscription' AND subscription_id IS NOT NULL)
      )
    )
  `).run();
}

async function recreateCalendarFeedSchema(env: Env): Promise<void> {
  // hash-only 旧表无法恢复明文订阅 URL；彻底切换时直接丢弃旧 feed，用户可在登录后重新生成。
  await env.DB.prepare("ALTER TABLE calendar_feeds RENAME TO calendar_feeds_legacy").run();
  await createCalendarFeedTable(env);
  await env.DB.prepare("DROP TABLE calendar_feeds_legacy").run();
}

async function createCalendarFeedIndexes(env: Env): Promise<void> {
  await env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_feeds_user_all_unique ON calendar_feeds (user_id) WHERE scope = 'all'").run();
  await env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_feeds_token ON calendar_feeds (token)").run();
  await env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_feeds_user_subscription_unique ON calendar_feeds (user_id, subscription_id) WHERE scope = 'subscription'").run();
}

async function insertCalendarFeed(env: Env, input: {
  scope: CalendarFeedScope;
  subscriptionId: string | null;
  userId: string;
}): Promise<CalendarFeedRow> {
  const token = randomToken();
  const timestamp = nowIso();
  const row: CalendarFeedRow = {
    id: newId("cal"),
    user_id: input.userId,
    scope: input.scope,
    subscription_id: input.subscriptionId,
    token,
    created_at: timestamp,
    updated_at: timestamp,
  };
  // ICS 订阅客户端无法携带 Renewlet 登录态；token 是用户可复制/重置的私有订阅地址，不再做一次性隐藏。
  await env.DB.prepare(`
    INSERT INTO calendar_feeds (id, user_id, scope, subscription_id, token, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(row.id, row.user_id, row.scope, row.subscription_id, row.token, row.created_at, row.updated_at).run();
  return row;
}

async function getCalendarFeed(
  env: Env,
  userId: string,
  scope: CalendarFeedScope,
  subscriptionId: string | null,
): Promise<CalendarFeedRow | null> {
  if (scope === "all") {
    return await env.DB.prepare(`
      SELECT id, user_id, scope, subscription_id, token, created_at, updated_at
      FROM calendar_feeds
      WHERE user_id = ? AND scope = 'all'
      LIMIT 1
    `).bind(userId).first<CalendarFeedRow>();
  }
  return await env.DB.prepare(`
    SELECT id, user_id, scope, subscription_id, token, created_at, updated_at
    FROM calendar_feeds
    WHERE user_id = ? AND scope = 'subscription' AND subscription_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).bind(userId, subscriptionId).first<CalendarFeedRow>();
}

function isUnreadableCalendarFeedTable(error: unknown): boolean {
  return error instanceof Error && /(no such table:\s*calendar_feeds|no such column:\s*(id|scope|subscription_id|token))/i.test(error.message);
}

function calendarFeedStatus(row: CalendarFeedRow | null, request: Request) {
  return row ? {
    enabled: true,
    createdAt: row.created_at,
    feedUrl: calendarFeedUrl(request, row.token),
    updatedAt: row.updated_at,
  } : { enabled: false };
}

function calendarFeedUrl(request: Request, token: string): string {
  return `${requestOrigin(request)}/calendar/renewals.ics?token=${encodeURIComponent(token)}`;
}

function calendarEvents(
  subscriptions: CalendarSubscription[],
  settings: ApiAppSettings,
  labels: CalendarFeedLabelResolver,
): RenewalCalendarEvent[] {
  const today = dateOnlyInZone(new Date(), settings.timezone);
  return subscriptions
    .filter((subscription) => (
      !isOneTimeBuyout(subscription)
      && (subscription.status === "active" || subscription.status === "trial")
      && isValidDateOnly(subscription.nextBillingDate)
      && subscription.nextBillingDate >= today
    ))
    .map((subscription) => calendarEvent(subscription, settings, labels));
}

function subscriptionCalendarEvents(
  subscription: CalendarSubscription,
  settings: ApiAppSettings,
  labels: CalendarFeedLabelResolver,
): RenewalCalendarEvent[] {
  if (isOneTimeBuyout(subscription)) return [];
  return isValidDateOnly(subscription.nextBillingDate) ? [calendarEvent(subscription, settings, labels)] : [];
}

function isOneTimeBuyout(subscription: CalendarSubscription): boolean {
  return subscription.billingCycle === "one-time" && !subscription.oneTimeTermCount;
}

function calendarEvent(
  subscription: CalendarSubscription,
  settings: ApiAppSettings,
  labels: CalendarFeedLabelResolver,
): RenewalCalendarEvent {
  const locale = settings.locale;
  const reminderDays = isDisabledReminderDays(subscription.reminderDays)
    ? undefined
    : effectiveReminderDays(subscription.reminderDays, settings.notificationReminderDays);
  return buildRenewalCalendarEvent({
    subscription,
    labels: {
      amount: formatAmount(subscription.price),
      billingCycle: billingCycleLabel(subscription, locale),
      category: labels.categoryLabel(subscription.category),
      paymentMethod: labels.paymentMethodLabel(subscription.paymentMethod),
    },
    // “不提醒”不隐藏日历事件，只让 ICS 省略 VALARM，外部日历仍能展示账期。
    reminderDays,
    text: {
      amount: ({ amount, currency }) => serverFormat(locale, "calendarFeed.description.amount", { amount, currency }),
      billingCycle: (cycle) => serverFormat(locale, "calendarFeed.description.billingCycle", { cycle }),
      category: (category) => serverFormat(locale, "calendarFeed.description.category", { category }),
      paymentMethod: (paymentMethod) => serverFormat(locale, "calendarFeed.description.paymentMethod", { paymentMethod }),
      notes: (notes) => serverFormat(locale, "calendarFeed.description.notes", { notes }),
    },
  });
}

function billingCycleLabel(subscription: CalendarSubscription, locale: ApiAppSettings["locale"]): string {
  if (subscription.billingCycle === "custom") {
    const unit = isCustomCycleUnit(subscription.customCycleUnit) ? subscription.customCycleUnit : "day";
    const unitKey = `calendarFeed.customCycleUnit.${unit}` as const;
    const unitLabel = serverText(locale, unitKey);
    return serverFormat(locale, "calendarFeed.billingCycle.customValue", {
      count: subscription.customDays ?? 1,
      unit: unitLabel === unitKey ? unit : unitLabel,
    });
  }
  const cycle = subscription.billingCycle;
  if (!isFixedBillingCycle(cycle)) return cycle;
  const key = `calendarFeed.billingCycle.${cycle}` as const;
  const label = serverText(locale, key);
  return label === key ? cycle : label;
}

function isFixedBillingCycle(value: string): value is CalendarFixedBillingCycle {
  return value === "weekly" ||
    value === "monthly" ||
    value === "quarterly" ||
    value === "semi-annual" ||
    value === "annual" ||
    value === "one-time";
}

function isCustomCycleUnit(value: unknown): value is CalendarCustomCycleUnit {
  return value === "day" || value === "week" || value === "month" || value === "year";
}

function toCalendarSubscription(row: SubscriptionRow): CalendarSubscription {
  // ICS 不是订阅 JSON API 出站边界；这里保留坏 date-only 供事件过滤，避免一条历史脏数据打断整个日历。
  return {
    id: row.id,
    name: row.name,
    price: row.price,
    currency: row.currency,
    billingCycle: row.billing_cycle,
    oneTimeTermCount: row.one_time_term_count ?? undefined,
    category: row.category,
    paymentMethod: row.payment_method ?? undefined,
    nextBillingDate: row.next_billing_date,
    website: row.website ?? undefined,
    notes: row.notes ?? undefined,
    status: row.status,
    customDays: row.custom_days ?? undefined,
    customCycleUnit: row.custom_cycle_unit ?? undefined,
    reminderDays: row.reminder_days,
  };
}

function dateOnlyInZone(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  return `${part(parts, "year")}-${part(parts, "month")}-${part(parts, "day")}`;
}

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((item) => item.type === type)?.value ?? "00";
}

function formatAmount(amount: string): string {
  return amount;
}

function safeCalendarFeedFilename(value: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9_-]/g, "");
  return normalized || "subscription";
}
