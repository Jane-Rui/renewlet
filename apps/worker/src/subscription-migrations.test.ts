// D1 迁移测试必须执行真实 SQL；只读字符串无法发现同名 migration 已记账后的 schema drift。
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readSuccessData } from "./api-test-helpers";
import { SUBSCRIPTION_COLUMNS } from "./db";
import { readSubscriptions } from "./subscriptions";
import type { Env } from "./types";

const authMocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
}));

vi.mock("./auth", () => ({
  requireAuth: authMocks.requireAuth,
}));

const USER_ID = "usr_migration_owner";
const timestamp = "2026-08-10T00:00:00.000Z";

describe("Cloudflare D1 subscription migrations", () => {
  beforeEach(() => {
    authMocks.requireAuth.mockReset();
    authMocks.requireAuth.mockResolvedValue({
      user: { id: USER_ID },
      session: { id: "ses_migration" },
    });
  });

  it("rebuilds subscriptions after the old local 0034 schema was already recorded", () => {
    // 复现真实 500 根因：d1_migrations 已记账 0034，但表里还是开发期旧 days 列，没有 next due 列。
    const db = openSubscriptionMigrationDatabase();
    try {
      applyOldCostSharingCollectionReminder0034(db);
      insertCostSharingSubscription(db, {
        costSharingJson: JSON.stringify(costSharingJson({ intervalMonths: 3 })),
        billingCycle: "monthly",
      });

      applyMigration(db, "0035_rebuild_cost_sharing_collection_reminder_schema.sql");

      expect(subscriptionColumnNames(db)).toEqual(expect.arrayContaining([
        "cost_sharing_collection_reminder_enabled",
        "cost_sharing_next_collection_reminder_date",
      ]));
      expect(subscriptionColumnNames(db)).not.toContain("cost_sharing_collection_reminder_days");
      expect(db.prepare(`SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions`).all()).toHaveLength(1);
      expect(JSON.stringify(readCostSharingJson(db))).not.toContain("intervalMonths");
      expect(readScalar<number>(db, "SELECT cost_sharing_collection_reminder_enabled FROM subscriptions LIMIT 1")).toBe(1);
      expect(readScalar<string | null>(db, "SELECT cost_sharing_next_collection_reminder_date FROM subscriptions LIMIT 1")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(readIndexSql(db, "idx_subscriptions_user_cost_sharing_collection_due")).toContain(
        "cost_sharing_next_collection_reminder_date",
      );
    } finally {
      db.close();
    }
  });

  it("keeps the current 0034 schema readable after the rebuild migration", () => {
    // 0035 必须也能升级已经跑过当前 0034 的环境；它不是只服务本机坏库的一次性补丁。
    const db = openSubscriptionMigrationDatabase();
    try {
      insertCostSharingSubscription(db, {
        costSharingJson: JSON.stringify(costSharingJson({ intervalMonths: 2 })),
        billingCycle: "one-time",
        oneTimeTermCount: null,
        oneTimeTermUnit: null,
      });
      applyMigration(db, "0034_cost_sharing_collection_reminders.sql");

      applyMigration(db, "0035_rebuild_cost_sharing_collection_reminder_schema.sql");

      expect(subscriptionColumnNames(db)).toEqual(expect.arrayContaining([
        "cost_sharing_collection_reminder_enabled",
        "cost_sharing_next_collection_reminder_date",
      ]));
      expect(subscriptionColumnNames(db)).not.toContain("cost_sharing_collection_reminder_days");
      expect(db.prepare(`SELECT ${SUBSCRIPTION_COLUMNS} FROM subscriptions`).all()).toHaveLength(1);
      expect(JSON.stringify(readCostSharingJson(db))).not.toContain("intervalMonths");
      expect(readScalar<number>(db, "SELECT cost_sharing_collection_reminder_enabled FROM subscriptions LIMIT 1")).toBe(0);
      expect(readScalar<string | null>(db, "SELECT cost_sharing_next_collection_reminder_date FROM subscriptions LIMIT 1")).toBeNull();
    } finally {
      db.close();
    }
  });

  it("lets the subscription list read migrated cost sharing rows without a 500", async () => {
    // 这里走 readSubscriptions 真实出站 schema，避免只验证 SQL 列存在却漏掉 toApiSubscription strict parse。
    const db = openSubscriptionMigrationDatabase();
    try {
      applyOldCostSharingCollectionReminder0034(db);
      insertCostSharingSubscription(db, {
        costSharingJson: JSON.stringify(costSharingJson({ intervalMonths: 1 })),
        billingCycle: "monthly",
      });
      applyMigration(db, "0035_rebuild_cost_sharing_collection_reminder_schema.sql");
      applyMigration(db, "0036_subscription_derived_state_v2.sql");

      const response = await readSubscriptions(new Request("https://renewlet.test/api/app/subscriptions?limit=10"), {
        DB: new SqliteD1Database(db) as unknown as D1Database,
        ASSETS: {} as Fetcher,
        ASSETS_BUCKET: {} as R2Bucket,
      } satisfies Env);
      const body = await readSuccessData<{ subscriptions: Array<{ name: string; costSharing?: unknown }>; total: number }>(response);

      expect(response.status).toBe(200);
      expect(body.total).toBe(1);
      expect(body.subscriptions).toHaveLength(1);
      expect(body.subscriptions[0]).toMatchObject({
        name: "Netflix",
        costSharing: {
          collectionReminder: { enabled: true, reminderDays: 1 },
        },
      });
    } finally {
      db.close();
    }
  });

  it("migrates derived stats to fixed columns and creates the repeat backfill boundary", () => {
    const db = openSubscriptionMigrationDatabase();
    try {
      insertCostSharingSubscription(db, {
        costSharingJson: JSON.stringify(costSharingJson({})),
        billingCycle: "monthly",
      });
      applyMigration(db, "0034_cost_sharing_collection_reminders.sql");
      applyMigration(db, "0035_rebuild_cost_sharing_collection_reminder_schema.sql");

      applyMigration(db, "0036_subscription_derived_state_v2.sql");

      expect(tableColumnNames(db, "subscription_user_stats")).toEqual([
        "user_id",
        "total_count",
        "trial_count",
        "active_count",
        "expired_count",
        "paused_count",
        "cancelled_count",
        "created_at",
        "updated_at",
      ]);
      expect(db.prepare(`
        SELECT total_count, trial_count, active_count, expired_count, paused_count, cancelled_count
        FROM subscription_user_stats WHERE user_id = ?
      `).get(USER_ID)).toEqual({
        total_count: 1,
        trial_count: 0,
        active_count: 1,
        expired_count: 0,
        paused_count: 0,
        cancelled_count: 0,
      });
      expect(tableColumnNames(db, "subscription_repeat_schedule")).toEqual([
        "user_id",
        "subscription_id",
        "next_due_at_utc",
      ]);
      expect(readIndexSql(db, "idx_subscription_repeat_schedule_due")).toContain(
        "user_id, next_due_at_utc, subscription_id",
      );
      expect(tableColumnNames(db, "subscription_derived_backfills")).toEqual(["name", "completed_at"]);
      expect(readScalar<number>(db, "SELECT COUNT(*) FROM subscription_derived_backfills")).toBe(0);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });
});

function openSubscriptionMigrationDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  // 只建迁移和列表读取需要的最小 D1 schema；缺的列应由 migration 测出来，而不是测试 fixture 偷偷补齐。
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      banned INTEGER NOT NULL DEFAULT 0,
      ban_reason TEXT NOT NULL DEFAULT '',
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      logo TEXT,
      price TEXT NOT NULL,
      currency TEXT NOT NULL,
      billing_cycle TEXT NOT NULL,
      custom_days INTEGER,
      custom_cycle_unit TEXT,
      one_time_term_count INTEGER,
      one_time_term_unit TEXT,
      category TEXT NOT NULL,
      status TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      public_hidden INTEGER NOT NULL DEFAULT 0,
      payment_method TEXT,
      start_date TEXT,
      next_billing_date TEXT NOT NULL,
      auto_renew INTEGER NOT NULL DEFAULT 0,
      auto_calculate_next_billing_date INTEGER NOT NULL,
      trial_end_date TEXT,
      website TEXT,
      notes TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      reminder_days INTEGER NOT NULL,
      repeat_reminder_enabled INTEGER NOT NULL,
      repeat_reminder_interval TEXT NOT NULL,
      repeat_reminder_window TEXT NOT NULL,
      cost_sharing_json TEXT NOT NULL DEFAULT '{}',
      extra_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE subscription_list_index (
      subscription_id TEXT PRIMARY KEY REFERENCES subscriptions(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      website TEXT,
      notes TEXT,
      search_text_lower TEXT NOT NULL,
      category TEXT NOT NULL,
      billing_cycle TEXT NOT NULL,
      currency TEXT NOT NULL,
      payment_method TEXT,
      status TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      public_hidden INTEGER NOT NULL DEFAULT 0,
      next_billing_date TEXT NOT NULL,
      trial_end_date TEXT,
      one_time_term_count INTEGER,
      auto_renew INTEGER NOT NULL DEFAULT 0,
      reminder_days INTEGER NOT NULL DEFAULT 0,
      repeat_reminder_enabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE subscription_tags (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
      tag_norm TEXT NOT NULL,
      tag TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, subscription_id, tag_norm)
    );
    CREATE TABLE subscription_user_stats (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      total_count INTEGER NOT NULL DEFAULT 0,
      status_counts_json TEXT NOT NULL DEFAULT '{}',
      source_updated_at TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE subscription_scheduler_state (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      auto_renew_count INTEGER NOT NULL DEFAULT 0,
      repeat_reminder_count INTEGER NOT NULL DEFAULT 0,
      last_auto_renew_local_date TEXT NOT NULL DEFAULT '',
      next_auto_renew_check_at_utc TEXT,
      next_daily_notification_due_at_utc TEXT,
      next_repeat_notification_due_at_utc TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO users (id, email, name, role, password_hash, created_at, updated_at)
    VALUES ('${USER_ID}', 'owner@example.com', 'Owner', 'admin', 'hash', '${timestamp}', '${timestamp}');
  `);
  return db;
}

function applyOldCostSharingCollectionReminder0034(db: DatabaseSync): void {
  // 旧 0034 是本次线上/本地 drift 的来源：同名 migration 已应用，Wrangler 不会再执行新文件内容。
  db.exec(`
    ALTER TABLE subscriptions ADD COLUMN cost_sharing_collection_reminder_enabled INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE subscriptions ADD COLUMN cost_sharing_collection_reminder_days INTEGER NOT NULL DEFAULT -1;
    UPDATE subscriptions
    SET
      cost_sharing_collection_reminder_enabled = CASE
        WHEN json_valid(cost_sharing_json)
          AND json_extract(cost_sharing_json, '$.enabled') = 1
          AND json_extract(cost_sharing_json, '$.collectionReminder.enabled') = 1
        THEN 1
        ELSE 0
      END,
      cost_sharing_collection_reminder_days = CASE
        WHEN json_valid(cost_sharing_json)
          AND json_extract(cost_sharing_json, '$.collectionReminder.reminderDays') IS NOT NULL
        THEN json_extract(cost_sharing_json, '$.collectionReminder.reminderDays')
        ELSE -1
      END;
    CREATE INDEX IF NOT EXISTS idx_subscriptions_user_cost_sharing_collection_due
      ON subscriptions (user_id, cost_sharing_collection_reminder_enabled, next_billing_date, id);
  `);
}

function insertCostSharingSubscription(
  db: DatabaseSync,
  options: { costSharingJson: string; billingCycle: string; oneTimeTermCount?: number | null; oneTimeTermUnit?: string | null },
): void {
  db.prepare(`
    INSERT INTO subscriptions (
      id, user_id, name, logo, price, currency, billing_cycle, custom_days, custom_cycle_unit, one_time_term_count, one_time_term_unit,
      category, status, pinned, public_hidden, payment_method, start_date, next_billing_date, auto_renew, auto_calculate_next_billing_date,
      trial_end_date, website, notes, tags_json, reminder_days, repeat_reminder_enabled, repeat_reminder_interval, repeat_reminder_window,
      cost_sharing_json, extra_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "sub_migrated",
    USER_ID,
    "Netflix",
    null,
    "30",
    "USD",
    options.billingCycle,
    null,
    null,
    options.oneTimeTermCount ?? null,
    options.oneTimeTermUnit ?? null,
    "streaming",
    "active",
    0,
    0,
    null,
    "2026-08-01",
    "2026-09-01",
    0,
    0,
    null,
    null,
    null,
    "[]",
    3,
    0,
    "1h",
    "72h",
    options.costSharingJson,
    "{}",
    timestamp,
    timestamp,
  );
}

function costSharingJson(options: { intervalMonths?: number }) {
  return {
    enabled: true,
    splitMode: "equal",
    members: [
      { id: "member_1", name: "Member 1", joinedDate: "2026-08-01" },
      { id: "member_2", name: "Member 2", currency: "USD", joinedDate: "2026-08-01" },
    ],
    collectionReminder: {
      enabled: true,
      reminderDays: 1,
      ...(options.intervalMonths ? { intervalMonths: options.intervalMonths } : {}),
    },
  };
}

function applyMigration(db: DatabaseSync, name: string): void {
  db.exec(readFileSync(resolve("migrations", name), "utf8"));
}

function subscriptionColumnNames(db: DatabaseSync): string[] {
  return tableColumnNames(db, "subscriptions");
}

function tableColumnNames(db: DatabaseSync, table: string): string[] {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row["name"]));
}

function readCostSharingJson(db: DatabaseSync): unknown {
  return JSON.parse(readScalar<string>(db, "SELECT cost_sharing_json FROM subscriptions LIMIT 1"));
}

function readIndexSql(db: DatabaseSync, name: string): string {
  return readScalar<string>(db, "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?", [name]);
}

function readScalar<T>(db: DatabaseSync, sql: string, values: SQLInputValue[] = []): T {
  const row = db.prepare(sql).get(...values);
  if (!row) throw new Error(`No row for scalar query: ${sql}`);
  return Object.values(row)[0] as T;
}

class SqliteD1Database {
  constructor(private readonly db: DatabaseSync) {}

  prepare(sql: string): SqliteD1PreparedStatement {
    return new SqliteD1PreparedStatement(this.db, sql);
  }

  async batch(statements: SqliteD1PreparedStatement[]): Promise<unknown[]> {
    return statements.map((statement) => statement.runSync());
  }
}

class SqliteD1PreparedStatement {
  private values: SQLInputValue[] = [];

  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
  ) {}

  bind(...values: SQLInputValue[]): this {
    this.values = values;
    return this;
  }

  async all<T>(): Promise<{ results: T[] }> {
    // readSubscriptions 只依赖 D1 的 Promise 形状；底层同步 sqlite 让测试能直接执行真实 SQL migration。
    return { results: this.db.prepare(this.sql).all(...this.values) as T[] };
  }

  async first<T>(): Promise<T | null> {
    return this.db.prepare(this.sql).get(...this.values) as T | undefined ?? null;
  }

  async run(): Promise<{ meta: { changes: number } }> {
    return this.runSync();
  }

  runSync(): { meta: { changes: number } } {
    const result = this.db.prepare(this.sql).run(...this.values);
    return { meta: { changes: Number(result.changes) } };
  }
}
