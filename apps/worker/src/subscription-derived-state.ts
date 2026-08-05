import { SUBSCRIPTION_STATUSES } from "@renewlet/shared/runtime";
import { nowIso, parseStringArray, SUBSCRIPTION_COLUMNS } from "./db";
import { refreshSubscriptionSchedulerState } from "./subscription-scheduler-state";
import type { Env, SubscriptionRow, SubscriptionUserStatsRow } from "./types";

const LIST_INDEX_INSERT_SQL = `
  INSERT OR REPLACE INTO subscription_list_index (
    subscription_id, user_id, name, website, notes, search_text_lower, category, billing_cycle, currency,
    payment_method, status, pinned, public_hidden, next_billing_date, trial_end_date, one_time_term_count,
    auto_renew, reminder_days, repeat_reminder_enabled, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const TAG_INSERT_SQL = `
  INSERT OR REPLACE INTO subscription_tags (
    user_id, subscription_id, tag_norm, tag, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?)
`;

export interface SubscriptionStats {
  total: number;
  byStatus: Record<(typeof SUBSCRIPTION_STATUSES)[number], number>;
}

interface SubscriptionSourceSnapshot {
  count: number;
  source_updated_at: string;
}

export async function refreshSubscriptionDerivedState(
  env: Env,
  userId: string,
  options: { resetAutoRenewCheck?: boolean; now?: Date } = {},
): Promise<void> {
  await refreshSubscriptionListState(env, userId);
  await refreshSubscriptionSchedulerState(env, userId, options);
}

export async function refreshSubscriptionListState(env: Env, userId: string): Promise<void> {
  if (!userId) return;
  const source = await readSubscriptionSourceSnapshot(env, userId);
  const rows = await env.DB.prepare(`
    SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions
    WHERE user_id = ?
    ORDER BY created_at DESC, id DESC
  `).bind(userId).all<SubscriptionRow>();
  const timestamp = nowIso();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM subscription_list_index WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM subscription_tags WHERE user_id = ?").bind(userId),
  ];
  const stats = emptySubscriptionStats();
  for (const row of rows.results) {
    stats.total += 1;
    if (row.status in stats.byStatus) {
      stats.byStatus[row.status as keyof typeof stats.byStatus] += 1;
    }
    const tags = normalizedTags(row);
    statements.push(env.DB.prepare(LIST_INDEX_INSERT_SQL).bind(
      row.id,
      row.user_id,
      row.name,
      row.website,
      row.notes,
      searchTextLower(row, tags.map((tag) => tag.value)),
      row.category,
      row.billing_cycle,
      row.currency,
      row.payment_method,
      row.status,
      row.pinned,
      row.public_hidden,
      row.next_billing_date,
      row.trial_end_date,
      row.one_time_term_count,
      row.auto_renew,
      row.reminder_days,
      row.repeat_reminder_enabled,
      row.created_at,
      row.updated_at,
    ));
    for (const tag of tags) {
      statements.push(env.DB.prepare(TAG_INSERT_SQL).bind(row.user_id, row.id, tag.key, tag.value, row.created_at, row.updated_at));
    }
  }
  // 订阅写入是低频路径；这里集中重建用户级派生表，换取列表、tag、统计和 Cron 热路径的稳定低读放大。
  statements.push(env.DB.prepare(`
    INSERT INTO subscription_user_stats (user_id, total_count, status_counts_json, source_updated_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      total_count = excluded.total_count,
      status_counts_json = excluded.status_counts_json,
      source_updated_at = excluded.source_updated_at,
      updated_at = excluded.updated_at
  `).bind(userId, stats.total, JSON.stringify(stats.byStatus), source.source_updated_at, timestamp, timestamp));
  await env.DB.batch(statements);
}

export async function ensureSubscriptionListStateFresh(env: Env, userId: string): Promise<void> {
  if (!userId) return;
  const source = await readSubscriptionSourceSnapshot(env, userId);
  const projection = await env.DB.prepare("SELECT COUNT(*) AS count FROM subscription_list_index WHERE user_id = ? LIMIT 1")
    .bind(userId)
    .first<{ count: number }>();
  const stats = await readSubscriptionStatsRow(env, userId);
  const baseCount = numberValue(source.count);
  const projectionCount = numberValue(projection?.count);
  // 派生表只是可删重建的缓存；数量或源版本漂移时以 subscriptions 为事实源重建，避免筛选页被旧投影误导。
  if (
    !stats ||
    baseCount !== projectionCount ||
    baseCount !== numberValue(stats.total_count) ||
    source.source_updated_at !== (stats.source_updated_at ?? "")
  ) {
    await refreshSubscriptionListState(env, userId);
  }
}

export async function getSubscriptionStats(env: Env, userId: string): Promise<SubscriptionStats> {
  // stats 也会被 Public API/Telegram 直接读取，不能假设用户一定先走过列表页刷新投影。
  await ensureSubscriptionListStateFresh(env, userId);
  const row = await readSubscriptionStatsRow(env, userId);
  if (row) return normalizeSubscriptionStats(row);
  await refreshSubscriptionListState(env, userId);
  const refreshed = await readSubscriptionStatsRow(env, userId);
  return refreshed ? normalizeSubscriptionStats(refreshed) : emptySubscriptionStats();
}

export async function getSubscriptionTotal(env: Env, userId: string): Promise<number> {
  return (await getSubscriptionStats(env, userId)).total;
}

async function readSubscriptionStatsRow(env: Env, userId: string): Promise<SubscriptionUserStatsRow | null> {
  if (!userId) return null;
  return await env.DB.prepare(`
    SELECT user_id, total_count, status_counts_json, source_updated_at, created_at, updated_at
    FROM subscription_user_stats
    WHERE user_id = ?
    LIMIT 1
  `).bind(userId).first<SubscriptionUserStatsRow>();
}

async function readSubscriptionSourceSnapshot(env: Env, userId: string): Promise<SubscriptionSourceSnapshot> {
  // count + max(updated_at) 是 D1 轻量源版本：抓同数量旧投影，同时避免每次列表都扫完整订阅行。
  const row = await env.DB.prepare(`
    SELECT COUNT(*) AS count, COALESCE(MAX(updated_at), '') AS source_updated_at
    FROM subscriptions
    WHERE user_id = ?
  `).bind(userId).first<SubscriptionSourceSnapshot>();
  return {
    count: numberValue(row?.count),
    source_updated_at: typeof row?.source_updated_at === "string" ? row.source_updated_at : "",
  };
}

function normalizeSubscriptionStats(row: SubscriptionUserStatsRow): SubscriptionStats {
  const stats = emptySubscriptionStats();
  stats.total = numberValue(row.total_count);
  try {
    const parsed = JSON.parse(row.status_counts_json) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>;
      for (const status of SUBSCRIPTION_STATUSES) {
        stats.byStatus[status] = numberValue(record[status]);
      }
    }
  } catch {
    // stats 行坏 JSON 只影响聚合展示；返回零口径并等待下一次写入重建。
  }
  return stats;
}

function emptySubscriptionStats(): SubscriptionStats {
  return {
    total: 0,
    byStatus: Object.fromEntries(SUBSCRIPTION_STATUSES.map((status) => [status, 0])) as SubscriptionStats["byStatus"],
  };
}

function normalizedTags(row: SubscriptionRow): Array<{ key: string; value: string }> {
  const tags: Array<{ key: string; value: string }> = [];
  const seen = new Set<string>();
  for (const rawTag of parseStringArray(row.tags_json)) {
    const value = rawTag.trim();
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    tags.push({ key, value });
  }
  return tags;
}

function searchTextLower(row: SubscriptionRow, tags: readonly string[]): string {
  return [row.name, row.website ?? "", row.notes ?? "", ...tags].join("\n").toLowerCase();
}

function numberValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value) || 0;
  return 0;
}
