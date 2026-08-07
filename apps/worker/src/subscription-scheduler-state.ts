import { getSettings, listRepeatReminderCandidateSubscriptions, nowIso, toApiSubscription } from "./db";
import type { ApiAppSettings } from "@renewlet/shared/schemas/settings";
import type { ApiSubscription } from "@renewlet/shared/schemas/subscriptions";
import { NOTIFICATION_CRON_WINDOW_MINUTES } from "./notification-jobs";
import {
  addDays,
  dateOnlyInZone,
  getLocalScheduleDecision,
  getNextLocalScheduleOccurrence,
  getNextRepeatScheduleOccurrence,
  getRepeatScheduleDecision,
  scheduleOccurrence,
  toRfc3339Seconds,
} from "./notification-schedule";
import type { Env, SubscriptionSchedulerStateRow } from "./types";

const emptySchedulerState: Omit<SubscriptionSchedulerStateRow, "user_id"> = {
  auto_renew_count: 0,
  repeat_reminder_count: 0,
  last_auto_renew_local_date: "",
  next_auto_renew_check_at_utc: null,
  next_daily_notification_due_at_utc: null,
  next_repeat_notification_due_at_utc: null,
  created_at: "",
  updated_at: "",
};

/** 读取空状态时立即补建，保证新用户也能进入 due-index，而不是依赖下一次订阅写入。 */
export async function getSubscriptionSchedulerState(env: Env, userId: string): Promise<SubscriptionSchedulerStateRow> {
  const row = await readSubscriptionSchedulerState(env, userId);
  if (row) return normalizeSchedulerState(row);
  await refreshSubscriptionSchedulerState(env, userId, { resetAutoRenewCheck: false });
  return normalizeSchedulerState(await readSubscriptionSchedulerState(env, userId) ?? { user_id: userId, ...emptySchedulerState });
}

export async function refreshSubscriptionSchedulerState(
  env: Env,
  userId: string,
  options: { resetAutoRenewCheck?: boolean; now?: Date; skipCurrentNotificationWindow?: boolean; repeatCandidates?: ApiSubscription[] } = {},
): Promise<void> {
  if (!userId) return;
  const timestamp = nowIso();
  const now = options.now ?? new Date();
  const current = options.resetAutoRenewCheck === true ? null : await readSubscriptionSchedulerState(env, userId);
  // 订阅写入会改变“今天是否已检查自动续订”的含义；重算 gate 时清空日期，让下一次 due-index 能重新判定新数据。
  const lastAutoRenewLocalDate = options.resetAutoRenewCheck === true
    ? ""
    : normalizeSchedulerState(current ?? { user_id: userId, ...emptySchedulerState }).last_auto_renew_local_date;
  const counts = await env.DB.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN auto_renew = 1 THEN 1 ELSE 0 END), 0) AS auto_renew_count,
      COALESCE(SUM(CASE WHEN repeat_reminder_enabled = 1 THEN 1 ELSE 0 END), 0) AS repeat_reminder_count
    FROM subscriptions
    WHERE user_id = ?
  `).bind(userId).first<{ auto_renew_count: number; repeat_reminder_count: number }>();
  const autoRenewCount = numberValue(counts?.auto_renew_count ?? 0);
  const repeatReminderCount = numberValue(counts?.repeat_reminder_count ?? 0);
  const settings = await getSettings(env, userId);
  // count 是候选查询 gate，next_* 是 Cron 用户枚举索引；两者同写，避免 scheduled 回退到 users 全量扫描。
  const nextAutoRenewCheck = nextAutoRenewCheckAt(now, settings.timezone, autoRenewCount, lastAutoRenewLocalDate);
  const nextDailyNotificationDue = nextDailyNotificationDueAt(now, settings.timezone, settings.notificationTimeLocal, options.skipCurrentNotificationWindow === true);
  const nextRepeatNotificationDue = repeatReminderCount > 0
    ? options.repeatCandidates
      ? nextRepeatNotificationDueForCandidates(now, settings, options.repeatCandidates)
      : await nextRepeatNotificationDueAt(env, userId, now, settings)
    : null;
  await env.DB.prepare(`
    INSERT INTO subscription_scheduler_state (
      user_id,
      auto_renew_count,
      repeat_reminder_count,
      last_auto_renew_local_date,
      next_auto_renew_check_at_utc,
      next_daily_notification_due_at_utc,
      next_repeat_notification_due_at_utc,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      auto_renew_count = excluded.auto_renew_count,
      repeat_reminder_count = excluded.repeat_reminder_count,
      last_auto_renew_local_date = excluded.last_auto_renew_local_date,
      next_auto_renew_check_at_utc = excluded.next_auto_renew_check_at_utc,
      next_daily_notification_due_at_utc = excluded.next_daily_notification_due_at_utc,
      next_repeat_notification_due_at_utc = excluded.next_repeat_notification_due_at_utc,
      updated_at = excluded.updated_at
  `).bind(
    userId,
    autoRenewCount,
    repeatReminderCount,
    lastAutoRenewLocalDate,
    nextAutoRenewCheck,
    nextDailyNotificationDue,
    nextRepeatNotificationDue,
    timestamp,
    timestamp,
  ).run();
}

export async function markAutoRenewCheckedForLocalDate(env: Env, userId: string, localDate: string): Promise<void> {
  if (!userId || !localDate) return;
  const settings = await getSettings(env, userId);
  // 自动续订按用户本地日期幂等；检查完成后推进到下一次本地零点，避免同一天每分钟重复查 due 订阅。
  const nextCheck = scheduleOccurrence(addDays(localDate, 1), "00:00", settings.timezone).scheduledInstantUtc;
  const result = await env.DB.prepare(`
    UPDATE subscription_scheduler_state
    SET last_auto_renew_local_date = ?, next_auto_renew_check_at_utc = ?, updated_at = ?
    WHERE user_id = ?
  `).bind(localDate, nextCheck, nowIso(), userId).run();
  if ((result.meta.changes ?? 0) > 0) return;
  await refreshSubscriptionSchedulerState(env, userId, { resetAutoRenewCheck: false });
  await env.DB.prepare(`
    UPDATE subscription_scheduler_state
    SET last_auto_renew_local_date = ?, next_auto_renew_check_at_utc = ?, updated_at = ?
    WHERE user_id = ?
  `).bind(localDate, nextCheck, nowIso(), userId).run();
}

export async function listAutoRenewDueUsers(env: Env, now: Date, limit: number): Promise<Array<{ user_id: string }>> {
  const result = await env.DB.prepare(`
    SELECT scheduler.user_id
    FROM subscription_scheduler_state AS scheduler
    JOIN users ON users.id = scheduler.user_id
    WHERE users.banned = 0
      AND scheduler.auto_renew_count > 0
      AND (scheduler.next_auto_renew_check_at_utc IS NULL OR scheduler.next_auto_renew_check_at_utc <= ?)
    ORDER BY scheduler.next_auto_renew_check_at_utc IS NOT NULL, scheduler.next_auto_renew_check_at_utc ASC, scheduler.user_id ASC
    LIMIT ?
  `).bind(toRfc3339Seconds(now), limit).all<{ user_id: string }>();
  return result.results;
}

export async function listNotificationDueUsers(env: Env, now: Date, limit: number, excludeUserIds: readonly string[] = []): Promise<Array<{ user_id: string }>> {
  const nowUtc = toRfc3339Seconds(now);
  const uniqueExcludeUserIds = [...new Set(excludeUserIds.map((id) => id.trim()).filter(Boolean))].sort();
  // exclude 来自本 tick 已处理集合，仍必须绑定为 SQL 参数，不能拼接到查询文本里当作可信 id。
  const excludeClause = uniqueExcludeUserIds.length > 0
    ? `AND scheduler.user_id NOT IN (${uniqueExcludeUserIds.map(() => "?").join(", ")})`
    : "";
  // daily/repeat 共用一个用户队列；单用户内仍以日常提醒优先，保持旧调度语义不因索引拆分而变成双发送。
  const result = await env.DB.prepare(`
    SELECT scheduler.user_id
    FROM subscription_scheduler_state AS scheduler
    JOIN users ON users.id = scheduler.user_id
    WHERE users.banned = 0
      AND (
        scheduler.next_daily_notification_due_at_utc IS NULL
        OR scheduler.next_daily_notification_due_at_utc <= ?
        OR (
          scheduler.repeat_reminder_count > 0
          AND (scheduler.next_repeat_notification_due_at_utc IS NULL OR scheduler.next_repeat_notification_due_at_utc <= ?)
        )
      )
      ${excludeClause}
    ORDER BY
      min(
        COALESCE(scheduler.next_daily_notification_due_at_utc, '0000-01-01T00:00:00Z'),
        COALESCE(scheduler.next_repeat_notification_due_at_utc, '9999-12-31T23:59:59Z')
      ) ASC,
      scheduler.user_id ASC
    LIMIT ?
  `).bind(nowUtc, nowUtc, ...uniqueExcludeUserIds, limit).all<{ user_id: string }>();
  return result.results;
}

async function readSubscriptionSchedulerState(env: Env, userId: string): Promise<SubscriptionSchedulerStateRow | null> {
  if (!userId) return null;
  return await env.DB.prepare(`
    SELECT
      user_id,
      auto_renew_count,
      repeat_reminder_count,
      last_auto_renew_local_date,
      next_auto_renew_check_at_utc,
      next_daily_notification_due_at_utc,
      next_repeat_notification_due_at_utc,
      created_at,
      updated_at
    FROM subscription_scheduler_state
    WHERE user_id = ?
  `).bind(userId).first<SubscriptionSchedulerStateRow>();
}

function normalizeSchedulerState(row: SubscriptionSchedulerStateRow): SubscriptionSchedulerStateRow {
  return {
    ...row,
    auto_renew_count: numberValue(row.auto_renew_count),
    repeat_reminder_count: numberValue(row.repeat_reminder_count),
    last_auto_renew_local_date: row.last_auto_renew_local_date ?? "",
    next_auto_renew_check_at_utc: row.next_auto_renew_check_at_utc ?? null,
    next_daily_notification_due_at_utc: row.next_daily_notification_due_at_utc ?? null,
    next_repeat_notification_due_at_utc: row.next_repeat_notification_due_at_utc ?? null,
  };
}

function nextAutoRenewCheckAt(now: Date, timezone: string, autoRenewCount: number, lastAutoRenewLocalDate: string): string | null {
  if (autoRenewCount <= 0) return null;
  const today = dateOnlyInZone(now, timezone);
  if (lastAutoRenewLocalDate !== today) return toRfc3339Seconds(now);
  return scheduleOccurrence(addDays(today, 1), "00:00", timezone).scheduledInstantUtc;
}

function nextDailyNotificationDueAt(now: Date, timezone: string, localTime: string, skipCurrentWindow: boolean): string {
  // 只有通知 job 已收敛时才跳过当前 2 分钟窗口；失败或 sending 状态会保留旧 due 供下一分钟重试。
  if (skipCurrentWindow) return getNextLocalScheduleOccurrence(now, timezone, localTime).scheduledInstantUtc;
  const current = getLocalScheduleDecision(now, timezone, localTime, NOTIFICATION_CRON_WINDOW_MINUTES, false);
  if (current.due) return current.scheduledInstantUtc;
  return getNextLocalScheduleOccurrence(now, timezone, localTime).scheduledInstantUtc;
}

async function nextRepeatNotificationDueAt(
  env: Env,
  userId: string,
  now: Date,
  settings: Pick<ApiAppSettings, "timezone" | "notificationTimeLocal" | "notificationReminderDays">,
): Promise<string | null> {
  const candidates = (await listRepeatReminderCandidateSubscriptions(env, userId, dateOnlyInZone(now, settings.timezone))).map(toApiSubscription);
  return nextRepeatNotificationDueForCandidates(now, settings, candidates);
}

function nextRepeatNotificationDueForCandidates(
  now: Date,
  settings: Pick<ApiAppSettings, "timezone" | "notificationTimeLocal" | "notificationReminderDays">,
  candidates: ApiSubscription[],
): string | null {
  if (candidates.length === 0) return null;
  const current = getRepeatScheduleDecision(now, settings, candidates, NOTIFICATION_CRON_WINDOW_MINUTES);
  if (current.due) return current.scheduledInstantUtc;
  return getNextRepeatScheduleOccurrence(now, settings, candidates)?.scheduledInstantUtc ?? null;
}

function numberValue(value: number | string | null): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value) || 0;
  return 0;
}
