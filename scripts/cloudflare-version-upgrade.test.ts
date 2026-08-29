import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = resolve(repoRoot, "apps/worker/migrations");
const fixturesDir = resolve(repoRoot, "scripts/fixtures/cloudflare-upgrades");
const timestamp = "2026-08-25T00:00:00.000Z";
const backfillNow = (): Date => new Date("2026-08-25T12:00:00.000Z");
const userId = "usr_fixture";
const subscriptionId = "sub_fixture";

// 固定 commit 与双重 SHA 防止测试从当前 migration 重新伪造“旧版本数据库”。
const pinnedFixtures = [
  {
    version: "v0.2.95",
    sourceCommit: "02fec668d65ad6b03ba0321301abf05e17ba28dd",
    migrationCount: 29,
    lastMigration: "0029_media_icon_index_refresh_jobs_index_hash.sql",
    migrationSourceSha256: "99e306d2bd476fe423f0a4ea34ae4764fd38af2818b66de0e014831c356847bd",
    fixture: "v0.2.95.sql",
    fixtureSha256: "16326f2a20b6fdd15b673324807da0b743f66559736e44a2988ea5e93a32ed51",
    expectedLocalePreference: "zh-CN",
    expectsFeedBackup: true,
    seedUntrustedV2: false,
  },
  {
    version: "v0.2.96",
    sourceCommit: "d2755510203c8eaf7f8454aca22a36885c62a6cc",
    migrationCount: 32,
    lastMigration: "0032_exchange_rate_snapshots.sql",
    migrationSourceSha256: "a7ea0f1f331d94937dfff9a11395611cd2e1637cd20ed7fb4caec3f36f22227f",
    fixture: "v0.2.96.sql",
    fixtureSha256: "25b806634b9a2912cbe55a6777ce12633ca3c75f49e80f5cf5f2353990a3689d",
    expectedLocalePreference: "auto",
    expectsFeedBackup: true,
    seedUntrustedV2: false,
  },
  {
    version: "v0.3.21",
    sourceCommit: "dee5d8c8cf055583d9c45eb82a0b41e0cd13e016",
    migrationCount: 39,
    lastMigration: "0039_rebuild_subscription_collection_projections.sql",
    migrationSourceSha256: "b4142c54e90513b74a074aba0351584be20e2518e63a65a8d3e113d2edd3c2e3",
    fixture: "v0.3.21.sql",
    fixtureSha256: "52fe7d1032bcbd698f0059e2444178f87823344f825523746baa3e287c53fcc5",
    expectedLocalePreference: "en-US",
    expectsFeedBackup: false,
    seedUntrustedV2: true,
  },
] as const;

function plainRows(rows: ReadonlyArray<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map((row) => ({ ...row }));
}

function plainRow(row: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return row === undefined ? undefined : { ...row };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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

function migrationSql(name: string): string {
  return readFileSync(resolve(migrationsDir, name), "utf8")
    .replace(/^\s*PRAGMA\s+foreign_keys\s*=\s*(?:OFF|ON)\s*;\s*$/gim, "");
}

function applyMigration(db: DatabaseSync, name: string): void {
  db.exec("BEGIN");
  try {
    db.exec(migrationSql(name));
    db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(name);
    db.exec("COMMIT");
  } catch (error: unknown) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function applyPendingMigrations(db: DatabaseSync): number {
  const applied = new Set(
    db.prepare("SELECT name FROM d1_migrations").all().map((row) => String(row["name"])),
  );
  let count = 0;
  for (const name of migrationNames()) {
    if (applied.has(name)) continue;
    applyMigration(db, name);
    count += 1;
  }
  return count;
}

function openFixture(filename: string): SqliteUpgradeClient {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(resolve(fixturesDir, filename), "utf8"));
  db.exec("PRAGMA foreign_keys = ON");
  return new SqliteUpgradeClient(db);
}

function seedUntrustedV2State(db: DatabaseSync): void {
  // 旧 v2 marker 不能证明集合投影和调度状态可信；v3 必须从订阅事实重新收敛。
  db.prepare(`INSERT INTO subscription_derived_backfills (name, completed_at)
    VALUES ('subscription-derived-state-v2', ?)`).run(timestamp);
  db.prepare(`INSERT OR REPLACE INTO subscription_list_index (
    subscription_id, user_id, name, search_text_lower, category, billing_cycle, currency, status,
    next_billing_date, auto_renew, reminder_days, repeat_reminder_enabled, created_at, updated_at
  ) VALUES (?, ?, 'stale', 'stale', 'stale', 'monthly', 'USD', 'active', ?, 0, 0, 0, ?, ?)`).run(
    subscriptionId,
    userId,
    "2026-08-27",
    timestamp,
    timestamp,
  );
  db.prepare("DELETE FROM subscription_tags WHERE subscription_id = ?").run(subscriptionId);
  db.prepare(`INSERT INTO subscription_tags
    (user_id, subscription_id, tag_norm, tag, created_at, updated_at)
    VALUES (?, ?, 'stale', 'stale', ?, ?)`).run(userId, subscriptionId, timestamp, timestamp);
  db.prepare(`UPDATE subscription_user_stats SET
    total_count = 0, trial_count = 0, active_count = 0, expired_count = 0,
    paused_count = 0, cancelled_count = 0 WHERE user_id = ?`).run(userId);
  db.prepare(`INSERT OR REPLACE INTO subscription_scheduler_state (
    user_id, auto_renew_count, repeat_reminder_count, last_auto_renew_local_date,
    next_auto_renew_check_at_utc, next_daily_notification_due_at_utc,
    next_repeat_notification_due_at_utc, created_at, updated_at
  ) VALUES (?, 0, 0, '', NULL, NULL, NULL, ?, ?)`).run(userId, timestamp, timestamp);
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

function assertSettingsMigrated(db: DatabaseSync, localePreference: string): void {
  const row = db.prepare("SELECT settings_json FROM settings WHERE user_id = ?").get(userId) as { settings_json: string } | undefined;
  assert.deepEqual(JSON.parse(row?.settings_json ?? "null"), {
    localePreference,
    monthlyBudget: "2333",
  });
}

test("released D1 fixtures stay pinned to reviewed tags and source hashes", () => {
  const manifest = JSON.parse(readFileSync(resolve(fixturesDir, "manifest.json"), "utf8")) as unknown;
  const expectedManifest = {
    kind: "renewlet-cloudflare-upgrade-fixtures",
    schemaVersion: 1,
    capturedAt: timestamp,
    fixtures: pinnedFixtures.map(({
      expectedLocalePreference: _expectedLocalePreference,
      expectsFeedBackup: _expectsFeedBackup,
      seedUntrustedV2: _seedUntrustedV2,
      ...entry
    }) => entry),
  };
  assert.deepEqual(manifest, expectedManifest);
  for (const fixture of pinnedFixtures) {
    assert.equal(sha256(readFileSync(resolve(fixturesDir, fixture.fixture), "utf8")), fixture.fixtureSha256);
  }
});

test("a fresh database applies every current migration and converges on empty invariants", async () => {
  const client = new SqliteUpgradeClient(new DatabaseSync(":memory:"));
  try {
    client.db.exec(`PRAGMA foreign_keys = ON; CREATE TABLE d1_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
    )`);
    assert.deepEqual(await prepareCalendarFeedsFor0035(client), { action: "skipped", feeds: 0 });
    assert.equal(applyPendingMigrations(client.db), migrationNames().length);
    assert.deepEqual(await restoreCalendarFeedsAfter0035(client), { action: "skipped", feeds: 0 });
    await runBackfill(client, backfillNow);
    await runBackfill(client, backfillNow);
    assert.equal(applyPendingMigrations(client.db), 0);
    assert.equal(client.db.prepare("SELECT COUNT(*) AS count FROM subscription_list_index").get()?.["count"], 0);
    assert.equal(client.db.prepare("SELECT COUNT(*) AS count FROM subscription_user_stats").get()?.["count"], 0);
    assert.deepEqual(client.db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    client.db.close();
  }
});

for (const fixture of pinnedFixtures) {
  test(`${fixture.version} immutable database converges on the current contract`, async () => {
    const client = openFixture(fixture.fixture);
    try {
      if (fixture.seedUntrustedV2) seedUntrustedV2State(client.db);
      const expectedFeedAction = fixture.expectsFeedBackup
        ? { action: "backed-up", feeds: 2 }
        : { action: "skipped", feeds: 0 };
      assert.deepEqual(await prepareCalendarFeedsFor0035(client), expectedFeedAction);
      assert.ok(applyPendingMigrations(client.db) > 0);
      assert.deepEqual(
        await restoreCalendarFeedsAfter0035(client),
        fixture.expectsFeedBackup ? { action: "restored", feeds: 2 } : { action: "skipped", feeds: 0 },
      );
      await runBackfill(client, backfillNow);
      await runBackfill(client, backfillNow);

      assert.equal(applyPendingMigrations(client.db), 0);
      assert.deepEqual(plainRows(client.db.prepare("SELECT id, token FROM calendar_feeds ORDER BY id").all()), [
        { id: "feed_all_fixture", token: "a".repeat(43) },
        { id: "feed_sub_fixture", token: "s".repeat(43) },
      ]);
      assertSettingsMigrated(client.db, fixture.expectedLocalePreference);
      assertRebuiltState(client.db);
    } finally {
      client.db.close();
    }
  });
}
