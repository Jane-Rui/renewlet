import {
  SUBSCRIPTION_PAYMENT_METHOD_NONE,
  type SubscriptionsListQuery,
} from "@renewlet/shared/schemas/subscriptions";
import { DISABLED_REMINDER_DAYS, INHERIT_REMINDER_DAYS } from "@renewlet/shared/runtime";
import {
  SUBSCRIPTION_COLUMNS,
  listSubscriptionsPage,
  parseSubscriptionCursor,
} from "./db";
import { getSubscriptionTotal } from "./subscription-derived-state";
import type { Env, SubscriptionListIndexRow, SubscriptionRow } from "./types";

const subscriptionListScanPageSize = 500;

/**
 * 订阅筛选保留 exact total：筛选时只扫轻量投影表产出总数和当前页 id，再按 id 回表取完整 DTO。
 *
 * cursor 只能影响本页起点，不能进入 total 口径；否则筛选页顶部统计会随滚动递减。
 */
export async function listSubscriptionsForQuery(
  env: Env,
  userId: string,
  query: SubscriptionsListQuery,
  today: string,
): Promise<{ rows: SubscriptionRow[]; total: number }> {
  if (!subscriptionListQueryHasFilters(query)) {
    return {
      rows: await listSubscriptionsPage(env, userId, { limit: query.limit + 1, cursor: query.cursor }),
      total: await getSubscriptionTotal(env, userId),
    };
  }
  return await collectFilteredSubscriptions(env, userId, query, today);
}

async function collectFilteredSubscriptions(env: Env, userId: string, query: SubscriptionsListQuery, today: string): Promise<{ rows: SubscriptionRow[]; total: number }> {
  const cursor = parseSubscriptionCursor(query.cursor);
  const base = subscriptionListBaseQuery(userId, query);
  let total = 0;
  const pageIds: string[] = [];
  let scanCursor: { createdAt: string; id: string } | undefined;
  // 扫描游标只用于替代 OFFSET 降低 D1 重读；业务 cursor 另行判断，确保 total 覆盖完整筛选结果。
  for (;;) {
    const candidates = await runSubscriptionFilterScan(env, base, subscriptionListScanPageSize, scanCursor);
    for (const row of candidates) {
      if (!subscriptionIndexRowMatchesPostFilters(row, query, today)) continue;
      total += 1;
      if (pageIds.length <= query.limit && subscriptionIndexRowIsAfterCursor(row, cursor)) {
        pageIds.push(row.subscription_id);
      }
    }
    if (candidates.length < subscriptionListScanPageSize) break;
    const last = candidates.at(-1);
    if (!last) break;
    scanCursor = { createdAt: last.created_at, id: last.subscription_id };
  }
  return { rows: await getSubscriptionsByIds(env, userId, pageIds), total };
}

async function runSubscriptionFilterScan(
  env: Env,
  base: { where: string; params: unknown[] },
  limit: number,
  cursor: { createdAt: string; id: string } | undefined,
): Promise<SubscriptionListIndexRow[]> {
  const cursorCondition = cursor ? "AND (idx.created_at < ? OR (idx.created_at = ? AND idx.subscription_id < ?))" : "";
  const cursorParams = cursor ? [cursor.createdAt, cursor.createdAt, cursor.id] : [];
  const result = await env.DB.prepare(`
    SELECT
      subscription_id,
      user_id,
      name,
      website,
      notes,
      search_text_lower,
      category,
      billing_cycle,
      currency,
      payment_method,
      status,
      pinned,
      public_hidden,
      next_billing_date,
      trial_end_date,
      one_time_term_count,
      auto_renew,
      reminder_days,
      repeat_reminder_enabled,
      created_at,
      updated_at
    FROM subscription_list_index AS idx
    WHERE ${base.where}
      ${cursorCondition}
    ORDER BY idx.created_at DESC, idx.subscription_id DESC
    LIMIT ?
  `).bind(...base.params, ...cursorParams, limit).all<SubscriptionListIndexRow>();
  return result.results;
}

function subscriptionListBaseQuery(
  userId: string,
  query: SubscriptionsListQuery,
): { where: string; params: unknown[] } {
  // SQL 下推只处理稳定标量和拆表 tag；模糊搜索/有效过期状态仍在 owner scoped 轻量投影里做同语义后处理。
  const conditions = ["idx.user_id = ?"];
  const params: unknown[] = [userId];
  appendSqlInCondition(conditions, params, "idx.category", query.category);
  appendSqlInCondition(conditions, params, "idx.billing_cycle", query.billingCycle);
  appendSqlInCondition(conditions, params, "idx.currency", query.currency);
  appendPaymentMethodCondition(conditions, params, query.paymentMethod);
  appendRenewalCondition(conditions, query.renewal);
  appendTagCondition(conditions, params, query.tag);
  if (query.nextBillingFrom) {
    conditions.push("idx.next_billing_date >= ?");
    params.push(query.nextBillingFrom);
  }
  if (query.nextBillingTo) {
    conditions.push("idx.next_billing_date <= ?");
    params.push(query.nextBillingTo);
  }
  if (query.pinned !== undefined) {
    conditions.push("idx.pinned = ?");
    params.push(query.pinned ? 1 : 0);
  }
  if (query.publicHidden !== undefined) {
    conditions.push("idx.public_hidden = ?");
    params.push(query.publicHidden ? 1 : 0);
  }
  appendReminderModeCondition(conditions, params, query.reminderMode);
  if (query.repeatReminder !== undefined) {
    conditions.push("idx.repeat_reminder_enabled = ?");
    params.push(query.repeatReminder ? 1 : 0);
  }
  return { where: conditions.join(" AND "), params };
}

function appendSqlInCondition(conditions: string[], params: unknown[], column: string, values: readonly string[] | undefined): void {
  if (!values?.length) return;
  conditions.push(`${column} IN (${values.map(() => "?").join(", ")})`);
  params.push(...values);
}

function appendPaymentMethodCondition(conditions: string[], params: unknown[], values: readonly string[] | undefined): void {
  if (!values?.length) return;
  const concrete = values.filter((value) => value !== SUBSCRIPTION_PAYMENT_METHOD_NONE);
  const parts: string[] = [];
  if (values.includes(SUBSCRIPTION_PAYMENT_METHOD_NONE)) parts.push("(idx.payment_method IS NULL OR idx.payment_method = '')");
  if (concrete.length > 0) {
    parts.push(`idx.payment_method IN (${concrete.map(() => "?").join(", ")})`);
    params.push(...concrete);
  }
  conditions.push(`(${parts.join(" OR ")})`);
}

function appendRenewalCondition(conditions: string[], renewal: SubscriptionsListQuery["renewal"]): void {
  switch (renewal) {
    case "auto":
      conditions.push("idx.billing_cycle != 'one-time' AND idx.auto_renew = 1");
      break;
    case "manual":
      conditions.push("idx.billing_cycle != 'one-time' AND idx.auto_renew = 0");
      break;
    case "one-time":
      conditions.push("idx.billing_cycle = 'one-time'");
      break;
  }
}

function appendTagCondition(conditions: string[], params: unknown[], values: readonly string[] | undefined): void {
  const tags = values?.filter((value) => value.trim() !== "") ?? [];
  if (tags.length === 0) return;
  // tag_norm 用来命中索引，tag 原文用来保留旧 JSON tags.includes 的大小写敏感语义。
  conditions.push(`
    EXISTS (
      SELECT 1 FROM subscription_tags AS tag
      WHERE tag.user_id = idx.user_id
        AND tag.subscription_id = idx.subscription_id
        AND (${tags.map(() => "(tag.tag_norm = ? AND tag.tag = ?)").join(" OR ")})
    )
  `);
  params.push(...tags.flatMap((tag) => [tag.trim().toLowerCase(), tag]));
}

function appendReminderModeCondition(
  conditions: string[],
  params: unknown[],
  mode: SubscriptionsListQuery["reminderMode"],
): void {
  switch (mode) {
    case "disabled":
      conditions.push("idx.reminder_days = ?");
      params.push(DISABLED_REMINDER_DAYS);
      break;
    case "inherit":
      conditions.push("idx.reminder_days = ?");
      params.push(INHERIT_REMINDER_DAYS);
      break;
    case "custom":
      conditions.push("idx.reminder_days >= 0");
      break;
  }
}

function subscriptionIndexRowMatchesPostFilters(row: SubscriptionListIndexRow, query: SubscriptionsListQuery, today: string): boolean {
  if (query.status && effectiveSubscriptionIndexStatus(row, today) !== query.status) return false;
  if (query.q && !subscriptionSearchMatches(row, query.q)) return false;
  return true;
}

function effectiveSubscriptionIndexStatus(row: SubscriptionListIndexRow, today: string): string {
  if (row.status === "expired") return "expired";
  if (row.billing_cycle === "one-time" && (row.one_time_term_count ?? 0) <= 0) return row.status;
  if ((row.status === "active" || row.status === "trial") && row.next_billing_date < today) return "expired";
  return row.status;
}

function subscriptionSearchMatches(row: SubscriptionListIndexRow, search: string): boolean {
  const query = search.trim().toLowerCase();
  if (!query) return true;
  return row.search_text_lower.includes(query);
}

function subscriptionIndexRowIsAfterCursor(row: SubscriptionListIndexRow, cursor: { createdAt: string; id: string } | null): boolean {
  if (!cursor) return true;
  return row.created_at < cursor.createdAt || (row.created_at === cursor.createdAt && row.subscription_id < cursor.id);
}

async function getSubscriptionsByIds(env: Env, userId: string, ids: readonly string[]): Promise<SubscriptionRow[]> {
  if (ids.length === 0) return [];
  const result = await env.DB.prepare(`
    SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions
    WHERE user_id = ? AND id IN (${ids.map(() => "?").join(", ")})
  `).bind(userId, ...ids).all<SubscriptionRow>();
  const byId = new Map(result.results.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}

function subscriptionListQueryHasFilters(query: SubscriptionsListQuery): boolean {
  return Boolean(
    query.q ||
    query.category?.length ||
    query.tag?.length ||
    query.billingCycle?.length ||
    query.paymentMethod?.length ||
    query.currency?.length ||
    query.status ||
    query.renewal ||
    query.nextBillingFrom ||
    query.nextBillingTo ||
    query.pinned !== undefined ||
    query.publicHidden !== undefined ||
    query.reminderMode ||
    query.repeatReminder !== undefined,
  );
}
