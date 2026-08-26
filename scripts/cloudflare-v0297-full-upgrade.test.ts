import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runBackfill } from "./backfill-cloudflare-subscription-derived-state";
import {
  prepareCalendarFeedsFor0035,
  restoreCalendarFeedsAfter0035,
} from "./cloudflare-calendar-feed-upgrade";
import type {
  D1Client,
  D1QueryResult,
  D1RowParser,
  D1Statement,
  D1Value,
} from "./cloudflare-d1-client";

// 本夹具从各已发布 migration 边界执行真实 SQL 到 0039，覆盖跳版本升级，而不是手工拼一个目标 schema。
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = resolve(repoRoot, "apps/worker/migrations");
const timestamp = "2026-08-24T00:00:00.000Z";
const backfillNow = (): Date => new Date("2026-08-24T12:00:00.000Z");
const userId = "usr_upgrade";
const subscriptionId = "sub_upgrade";

function plainRows(rows: ReadonlyArray<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map((row) => ({ ...row }));
}

function plainRow(row: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return row === undefined ? undefined : { ...row };
}

class SqliteUpgradeClient implements D1Client {
  constructor(readonly db: DatabaseSync) {}

  async query<T>(sql: string, params: readonly D1Value[], parseRow: D1RowParser<T>): Promise<T[]> {
    return this.db.prepare(sql).all(...[...params] as SQLInputValue[]).map(parseRow);
  }

  async batch(statements: readonly D1Statement[]): Promise<D1QueryResult[]> {
    if (statements.length === 0) return [];
    this.db.exec("BEGIN");
    try {
      const results = statements.map((statement): D1QueryResult => {
        this.db.prepare(statement.sql).run(...[...(statement.params ?? [])] as SQLInputValue[]);
        return { success: true, results: [] };
      });
      this.db.exec("COMMIT");
      return results;
    } catch (error: unknown) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function migrationNames(): string[] {
  return readdirSync(migrationsDir).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
}

function migrationSequence(name: string): number {
  return Number(name.slice(0, 4));
}

function d1MigrationSql(name: string): string {
  // D1 migration 期间外键始终开启；移除历史 PRAGMA 才能让本地 SQLite 复现生产的级联行为。
  return readFileSync(resolve(migrationsDir, name), "utf8")
    .replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*(?:OFF|ON)\s*;\s*$/gim, "");
}

function applyMigration(db: DatabaseSync, name: string): void {
  db.exec("BEGIN");
  try {
    db.exec(d1MigrationSql(name));
    db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(name);
    db.exec("COMMIT");
  } catch (error: unknown) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function applyMigrations(db: DatabaseSync, after: number, through: number): void {
  for (const name of migrationNames()) {
    const sequence = migrationSequence(name);
    if (sequence > after && sequence <= through) applyMigration(db, name);
  }
}

function openV0297Database(): SqliteUpgradeClient {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON; CREATE TABLE d1_migrations (name TEXT PRIMARY KEY)");
  applyMigrations(db, 0, 33);
  db.prepare(`INSERT INTO users
    (id, email, name, role, password_hash, created_at, updated_at)
    VALUES (?, ?, ?, 'admin', ?, ?, ?)`)
    .run(userId, "admin@example.com", "Admin", "hash", timestamp, timestamp);
  db.prepare(`INSERT INTO settings (user_id, settings_json, created_at, updated_at)
    VALUES (?, '{}', ?, ?)`)
    .run(userId, timestamp, timestamp);
  db.prepare(`INSERT INTO subscriptions (
    id, user_id, name, price, currency, billing_cycle, category, status, start_date, next_billing_date,
    auto_renew, auto_calculate_next_billing_date, tags_json, reminder_days, repeat_reminder_enabled,
    repeat_reminder_interval, repeat_reminder_window, cost_sharing_json, extra_json, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', '{}', ?, ?)`)
    .run(
      subscriptionId, userId, "Historical Service", "12.50", "USD", "monthly", "software", "active",
      "2026-01-24", "2026-08-27", 1, 1, JSON.stringify([" Work ", "work", "工具"]), 3, 1, "1h", "72h",
      timestamp, timestamp,
    );
  db.prepare(`INSERT INTO calendar_feeds
    (id, user_id, scope, subscription_id, token, created_at, updated_at)
    VALUES
      ('feed_all_upgrade', ?, 'all', NULL, ?, ?, ?),
      ('feed_sub_upgrade', ?, 'subscription', ?, ?, ?, ?)`)
    .run(
      userId, "a".repeat(43), timestamp, timestamp,
      userId, subscriptionId, "s".repeat(43), timestamp, timestamp,
    );
  return new SqliteUpgradeClient(db);
}

function seedUntrustedV2State(db: DatabaseSync): void {
  // 旧 v2 marker 只能证明旧流程曾结束，不能证明集合投影和调度状态正确；v3 必须从 facts 重新收敛。
  db.prepare(`INSERT INTO subscription_derived_backfills (name, completed_at)
    VALUES ('subscription-derived-state-v2', ?)`)
    .run(timestamp);
  db.prepare(`INSERT OR REPLACE INTO subscription_list_index (
    subscription_id, user_id, name, search_text_lower, category, billing_cycle, currency, status,
    next_billing_date, auto_renew, reminder_days, repeat_reminder_enabled, created_at, updated_at
  ) VALUES (?, ?, 'stale', 'stale', 'stale', 'monthly', 'USD', 'active', ?, 0, 0, 0, ?, ?)`)
    .run(subscriptionId, userId, "2026-08-27", timestamp, timestamp);
  db.prepare(`INSERT OR REPLACE INTO subscription_tags
    (user_id, subscription_id, tag_norm, tag, created_at, updated_at)
    VALUES (?, ?, 'stale', 'stale', ?, ?)`)
    .run(userId, subscriptionId, timestamp, timestamp);
  db.prepare(`UPDATE subscription_user_stats SET
    total_count = 0, trial_count = 0, active_count = 0, expired_count = 0,
    paused_count = 0, cancelled_count = 0 WHERE user_id = ?`)
    .run(userId);
  db.prepare(`INSERT OR REPLACE INTO subscription_scheduler_state (
    user_id, auto_renew_count, repeat_reminder_count, last_auto_renew_local_date,
    next_auto_renew_check_at_utc, next_daily_notification_due_at_utc,
    next_repeat_notification_due_at_utc, created_at, updated_at
  ) VALUES (?, 0, 0, '', NULL, NULL, NULL, ?, ?)`)
    .run(userId, timestamp, timestamp);
}

function assertRebuiltState(db: DatabaseSync): void {
  assert.deepEqual(plainRows(db.prepare(`SELECT subscription_id, user_id, name, search_text_lower
    FROM subscription_list_index`).all()), [{
    subscription_id: subscriptionId,
    user_id: userId,
    name: "Historical Service",
    search_text_lower: "historical service\n\n\nwork\n工具",
  }]);
  assert.deepEqual(plainRows(db.prepare("SELECT tag_norm, tag FROM subscription_tags ORDER BY tag_norm").all()), [
    { tag_norm: "work", tag: "work" },
    { tag_norm: "工具", tag: "工具" },
  ]);
  assert.deepEqual(plainRow(db.prepare(`SELECT total_count, trial_count, active_count, expired_count, paused_count, cancelled_count
    FROM subscription_user_stats WHERE user_id = ?`).get(userId)), {
    total_count: 1,
    trial_count: 0,
    active_count: 1,
    expired_count: 0,
    paused_count: 0,
    cancelled_count: 0,
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM subscription_repeat_schedule").get()?.["count"], 1);
  assert.deepEqual(plainRow(db.prepare(`SELECT auto_renew_count, repeat_reminder_count
    FROM subscription_scheduler_state WHERE user_id = ?`).get(userId)), {
    auto_renew_count: 1,
    repeat_reminder_count: 1,
  });
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM subscription_derived_backfills
    WHERE name = 'subscription-derived-state-v3'`).get()?.["count"], 1);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
}

const releasedUpgradeCases = [
  { version: "v0.2.97", migrationBoundary: 33, preservesSubscriptionFeed: true, hasV2Marker: false },
  { version: "v0.2.98", migrationBoundary: 35, preservesSubscriptionFeed: false, hasV2Marker: false },
  { version: "v0.3.0", migrationBoundary: 35, preservesSubscriptionFeed: false, hasV2Marker: false },
  { version: "v0.3.1", migrationBoundary: 36, preservesSubscriptionFeed: false, hasV2Marker: true },
  { version: "v0.3.2", migrationBoundary: 38, preservesSubscriptionFeed: false, hasV2Marker: true },
] as const;

test("a fresh database applies every migration and records v3 only after empty invariants pass", async () => {
  const client = new SqliteUpgradeClient(new DatabaseSync(":memory:"));
  try {
    client.db.exec("PRAGMA foreign_keys = ON");
    assert.deepEqual(await prepareCalendarFeedsFor0035(client), { action: "skipped", feeds: 0 });
    client.db.exec("CREATE TABLE d1_migrations (name TEXT PRIMARY KEY)");
    applyMigrations(client.db, 0, 39);
    assert.deepEqual(await restoreCalendarFeedsAfter0035(client), { action: "skipped", feeds: 0 });

    await runBackfill(client, backfillNow);
    await runBackfill(client, backfillNow);
    assert.equal(client.db.prepare(`SELECT COUNT(*) AS count FROM subscription_derived_backfills
      WHERE name = 'subscription-derived-state-v3'`).get()?.["count"], 1);
    assert.equal(client.db.prepare("SELECT COUNT(*) AS count FROM subscription_list_index").get()?.["count"], 0);
    assert.equal(client.db.prepare("SELECT COUNT(*) AS count FROM subscription_user_stats").get()?.["count"], 0);
    assert.deepEqual(client.db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    client.db.close();
  }
});

for (const upgradeCase of releasedUpgradeCases) {
  test(`${upgradeCase.version} real migration boundary converges on v3 invariants`, async () => {
    const client = openV0297Database();
    try {
      applyMigrations(client.db, 33, upgradeCase.migrationBoundary);
      if (upgradeCase.hasV2Marker) seedUntrustedV2State(client.db);

      const prepare = await prepareCalendarFeedsFor0035(client);
      assert.deepEqual(prepare, upgradeCase.preservesSubscriptionFeed
        ? { action: "backed-up", feeds: 2 }
        : { action: "skipped", feeds: 0 });

      applyMigrations(client.db, upgradeCase.migrationBoundary, 39);
      const restore = await restoreCalendarFeedsAfter0035(client);
      assert.deepEqual(restore, upgradeCase.preservesSubscriptionFeed
        ? { action: "restored", feeds: 2 }
        : { action: "skipped", feeds: 0 });
      await runBackfill(client, backfillNow);
      await runBackfill(client, backfillNow);

      assert.deepEqual(plainRows(client.db.prepare("SELECT id, token FROM calendar_feeds ORDER BY id").all()),
        upgradeCase.preservesSubscriptionFeed
          ? [
              { id: "feed_all_upgrade", token: "a".repeat(43) },
              { id: "feed_sub_upgrade", token: "s".repeat(43) },
            ]
          : [{ id: "feed_all_upgrade", token: "a".repeat(43) }]);
      assertRebuiltState(client.db);
    } finally {
      client.db.close();
    }
  });
}
