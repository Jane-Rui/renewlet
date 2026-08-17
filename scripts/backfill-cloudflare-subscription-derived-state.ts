#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { normalizeSettingsJson, toApiSubscription } from "../apps/worker/src/db";
import {
  addDays,
  dateOnlyInZone,
  getLocalScheduleDecision,
  getNextLocalScheduleOccurrence,
  getNextRepeatScheduleOccurrence,
  getRepeatScheduleDecision,
  scheduleOccurrence,
  toRfc3339Seconds,
} from "../apps/worker/src/notification-schedule";

// 0036 只完成 SQL 可表达的固定计数回填；本脚本复用 Worker 日期/时区规则补齐逐订阅 repeat schedule。
// marker 只能在全量分页回填、逐行 schedule 复算和 aggregate 不变量全部通过后写入，失败可安全重跑。

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const backfillName = "subscription-derived-state-v2";
const pageSize = 200;
const writeBatchSize = 50;
const notificationWindowMinutes = 2;

interface Options {
  configPath?: string;
  target: "local" | "remote";
}

interface D1Query {
  sql: string;
  params?: unknown[];
}

interface D1QueryResult {
  success: true;
  results: unknown[];
}

type D1RowParser<T> = (value: unknown) => T;

interface D1Client {
  query<T>(sql: string, params: unknown[], parseRow: D1RowParser<T>): Promise<T[]>;
  batch(queries: D1Query[]): Promise<D1QueryResult[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function parseD1QueryResults(payload: unknown, expectedCount: number, source: string): D1QueryResult[] {
  const entries: unknown[] = isUnknownArray(payload) ? payload : [payload];
  if (entries.length !== expectedCount) {
    throw new Error(`${source} returned an unexpected result count`);
  }
  return entries.map((entry) => {
    if (!isRecord(entry) || entry["success"] !== true || !isUnknownArray(entry["results"])) {
      throw new Error(`${source} returned an unsuccessful result`);
    }
    return {
      success: true,
      results: entry["results"],
    };
  });
}

function cloudflareErrorDetail(payload: unknown, fallback: string): string {
  if (!isRecord(payload) || !isUnknownArray(payload["errors"])) return fallback;
  const messages = payload["errors"].flatMap((entry) => (
    isRecord(entry) && typeof entry["message"] === "string" ? [entry["message"]] : []
  ));
  return messages.join("; ") || fallback;
}

function requireLast<T>(rows: readonly T[], context: string): T {
  const last = rows.at(-1);
  if (last === undefined) throw new Error(`${context} unexpectedly returned an empty page`);
  return last;
}

const customCycleUnitSchema = z.enum(["day", "week", "month", "year"]);
const subscriptionBackfillRowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  name: z.string(),
  logo: z.string().nullable(),
  price: z.string(),
  currency: z.string(),
  billing_cycle: z.string(),
  custom_days: z.number().nullable(),
  custom_cycle_unit: customCycleUnitSchema.nullable(),
  one_time_term_count: z.number().nullable(),
  one_time_term_unit: customCycleUnitSchema.nullable(),
  category: z.string(),
  status: z.string(),
  pinned: z.number(),
  public_hidden: z.number(),
  payment_method: z.string().nullable(),
  start_date: z.string().nullable(),
  next_billing_date: z.string(),
  auto_renew: z.number(),
  auto_calculate_next_billing_date: z.number(),
  trial_end_date: z.string().nullable(),
  website: z.string().nullable(),
  notes: z.string().nullable(),
  tags_json: z.string(),
  reminder_days: z.number(),
  repeat_reminder_enabled: z.number(),
  repeat_reminder_interval: z.string(),
  repeat_reminder_window: z.string(),
  cost_sharing_json: z.string().default("{}"),
  cost_sharing_collection_reminder_enabled: z.number(),
  cost_sharing_next_collection_reminder_date: z.string().nullable(),
  extra_json: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  settings_json: z.string().nullable(),
}).passthrough();
type SubscriptionBackfillRow = z.infer<typeof subscriptionBackfillRowSchema>;

const subscriptionScheduleVerificationRowSchema = subscriptionBackfillRowSchema.extend({
  stored_next_due_at_utc: z.string().nullable(),
});
type SubscriptionScheduleVerificationRow = z.infer<typeof subscriptionScheduleVerificationRowSchema>;

const schedulerBackfillRowSchema = z.object({
  user_id: z.string(),
  settings_json: z.string().nullable(),
  auto_renew_count: z.union([z.number(), z.string()]),
  repeat_reminder_count: z.union([z.number(), z.string()]),
  last_auto_renew_local_date: z.string().nullable(),
  next_repeat_notification_due_at_utc: z.string().nullable(),
}).passthrough();
type SchedulerBackfillRow = z.infer<typeof schedulerBackfillRowSchema>;

const countRowSchema = z.object({ count: z.union([z.number(), z.string()]) }).passthrough();
const backfillMarkerRowSchema = z.object({ name: z.string() }).passthrough();

function parseArgs(argv: string[]): Options {
  let target: Options["target"] | undefined;
  let configPath: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--local" || argument === "--remote") {
      const nextTarget: Options["target"] = argument === "--local" ? "local" : "remote";
      if (target) throw new Error("Specify exactly one D1 target: --local or --remote");
      target = nextTarget;
      continue;
    }
    if (argument === "--config") {
      const value = argv[index + 1];
      if (!value) throw new Error("--config requires a path");
      configPath = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (!target) throw new Error("Derived-state backfill requires an explicit --local or --remote target");
  return configPath === undefined ? { target } : { target, configPath };
}

function stripJsoncComments(input: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input.charAt(index);
    const next = input.charAt(index + 1);
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }
    if (character === "/" && next === "/") {
      while (index < input.length && input.charAt(index) !== "\n") index += 1;
      output += "\n";
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (index < input.length && !(input.charAt(index) === "*" && input.charAt(index + 1) === "/")) index += 1;
      index += 1;
      continue;
    }
    output += character;
  }
  return output;
}

function resolveDatabaseId(options: Options): string {
  const environmentId = process.env["D1_DATABASE_ID"]?.trim();
  if (environmentId) return environmentId;
  const configPath = resolve(repoRoot, options.configPath ?? "wrangler.jsonc");
  const config: unknown = JSON.parse(stripJsoncComments(readFileSync(configPath, "utf8")));
  const bindings = isRecord(config) && isUnknownArray(config["d1_databases"])
    ? config["d1_databases"]
    : [];
  let databaseId = "";
  for (const binding of bindings) {
    if (!isRecord(binding) || binding["binding"] !== "DB" || typeof binding["database_id"] !== "string") continue;
    databaseId = binding["database_id"].trim();
    break;
  }
  if (!databaseId || databaseId === "00000000-0000-0000-0000-000000000000") {
    throw new Error("D1_DATABASE_ID or a generated Wrangler config with the DB binding is required");
  }
  return databaseId;
}

class D1RemoteClient implements D1Client {
  constructor(
    private readonly accountId: string,
    private readonly databaseId: string,
    private readonly apiToken: string,
  ) {}

  async query<T>(sql: string, params: unknown[], parseRow: D1RowParser<T>): Promise<T[]> {
    const [result] = await this.batch([{ sql, params }]);
    return (result?.results ?? []).map(parseRow);
  }

  async batch(queries: D1Query[]): Promise<D1QueryResult[]> {
    if (queries.length === 0) return [];
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.accountId)}/d1/database/${encodeURIComponent(this.databaseId)}/query`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(queries.length === 1 ? queries[0] : queries),
      },
    );
    const payload: unknown = await response.json();
    if (!response.ok || !isRecord(payload) || payload["success"] !== true || payload["result"] === undefined) {
      throw new Error(`Cloudflare D1 query failed: ${cloudflareErrorDetail(payload, response.statusText)}`);
    }
    // Cloudflare API 是远端不可信边界；只有 envelope 和逐语句结果都通过结构检查后才交给泛型调用方。
    return parseD1QueryResults(payload["result"], queries.length, "Cloudflare D1 query");
  }
}

function sqliteLiteral(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  throw new Error(`Unsupported local D1 parameter type: ${typeof value}`);
}

function bindLocalParameters(sql: string, params: unknown[]): string {
  // 本地 Wrangler 不支持 params；扫描器必须跳过字符串与 SQL 注释里的问号，不能做全局 replace。
  let output = "";
  let parameterIndex = 0;
  let quote: "'" | '"' | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql.charAt(index);
    const next = sql.charAt(index + 1);
    if (lineComment) {
      output += character;
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      output += character;
      if (character === "*" && next === "/") {
        output += next;
        index += 1;
        blockComment = false;
      }
      continue;
    }
    if (quote) {
      output += character;
      if (character === quote) {
        if (next === quote) {
          output += next;
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (character === "-" && next === "-") {
      output += character + next;
      index += 1;
      lineComment = true;
      continue;
    }
    if (character === "/" && next === "*") {
      output += character + next;
      index += 1;
      blockComment = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      output += character;
      continue;
    }
    if (character === "?") {
      if (parameterIndex >= params.length) throw new Error("Local D1 query has fewer parameters than placeholders");
      output += sqliteLiteral(params[parameterIndex]);
      parameterIndex += 1;
      continue;
    }
    output += character;
  }
  if (parameterIndex !== params.length) throw new Error("Local D1 query has more parameters than placeholders");
  return output;
}

function parseWranglerResults(stdout: string, expectedCount: number): D1QueryResult[] {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new Error("Local D1 query returned invalid Wrangler JSON");
  }
  return parseD1QueryResults(payload, expectedCount, "Local D1 query");
}

class D1LocalClient implements D1Client {
  constructor(private readonly configPath?: string) {}

  async query<T>(sql: string, params: unknown[], parseRow: D1RowParser<T>): Promise<T[]> {
    const [result] = await this.batch([{ sql, params }]);
    return (result?.results ?? []).map(parseRow);
  }

  async batch(queries: D1Query[]): Promise<D1QueryResult[]> {
    if (queries.length === 0) return [];
    // Wrangler local 没有参数绑定入口；只在进程参数边界做类型化 SQLite literal 编码，绝不经 shell 或输出账本 SQL。
    const command = queries
      .map((query) => bindLocalParameters(query.sql, query.params ?? []).replace(/;\s*$/, ""))
      .join(";\n");
    const args = ["exec", "wrangler", "d1", "execute", "DB", "--local", "--command", command, "--json"];
    if (this.configPath) args.push("--config", this.configPath);
    const stdout = await new Promise<string>((resolvePromise, reject) => {
      const child = spawn("pnpm", args, {
        cwd: repoRoot,
        env: { ...process.env, CI: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      // Wrangler stdout 只承载 JSON；固定 UTF-8 后不让 Buffer 或未收窄类型穿过解析边界。
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { output += chunk; });
      child.stderr.resume();
      child.on("error", () => reject(new Error("Unable to start Wrangler for local D1 backfill")));
      child.on("close", (status: number | null) => {
        if (status === 0) resolvePromise(output);
        else reject(new Error("Local D1 query failed"));
      });
    });
    return parseWranglerResults(stdout, queries.length);
  }
}

function nextRepeatDue(row: SubscriptionBackfillRow, now: Date): string | null {
  if (row.repeat_reminder_enabled !== 1) return null;
  const settings = normalizeSettingsJson(row.settings_json ?? "{}");
  const subscription = toApiSubscription(row);
  const current = getRepeatScheduleDecision(now, settings, [subscription], notificationWindowMinutes);
  if (current.due) return current.scheduledInstantUtc;
  return getNextRepeatScheduleOccurrence(now, settings, [subscription])?.scheduledInstantUtc ?? null;
}

async function writeStatements(client: D1Client, statements: D1Query[]): Promise<void> {
  for (let offset = 0; offset < statements.length; offset += writeBatchSize) {
    await client.batch(statements.slice(offset, offset + writeBatchSize));
  }
}

async function assertBackfilledSchedules(client: D1Client, now: Date): Promise<number> {
  let cursorUserId = "";
  let cursorSubscriptionId = "";
  let expectedCount = 0;
  for (;;) {
    const rows = await client.query(`
      SELECT subscriptions.*, settings.settings_json,
             repeat_schedule.next_due_at_utc AS stored_next_due_at_utc
      FROM subscriptions
      LEFT JOIN settings ON settings.user_id = subscriptions.user_id
      LEFT JOIN subscription_repeat_schedule AS repeat_schedule
        ON repeat_schedule.user_id = subscriptions.user_id
       AND repeat_schedule.subscription_id = subscriptions.id
      WHERE subscriptions.user_id > ?
         OR (subscriptions.user_id = ? AND subscriptions.id > ?)
      ORDER BY subscriptions.user_id, subscriptions.id
      LIMIT ?
    `, [cursorUserId, cursorUserId, cursorSubscriptionId, pageSize], (value): SubscriptionScheduleVerificationRow => (
      subscriptionScheduleVerificationRowSchema.parse(value)
    ));
    if (rows.length === 0) break;
    for (const row of rows) {
      const expected = nextRepeatDue(row, now);
      if (expected) expectedCount += 1;
      if ((row.stored_next_due_at_utc ?? null) !== expected) {
        throw new Error("subscription_repeat_schedule value invariant failed");
      }
    }
    const last = requireLast(rows, "Repeat schedule verification");
    cursorUserId = last.user_id;
    cursorSubscriptionId = last.id;
    if (rows.length < pageSize) break;
  }
  const [orphaned] = await client.query(`
    SELECT COUNT(*) AS count
    FROM subscription_repeat_schedule AS repeat_schedule
    LEFT JOIN subscriptions ON subscriptions.id = repeat_schedule.subscription_id
    WHERE subscriptions.id IS NULL OR subscriptions.user_id != repeat_schedule.user_id
  `, [], countRowSchema.parse);
  if (Number(orphaned?.count ?? 0) !== 0) {
    throw new Error("subscription_repeat_schedule owner invariant failed");
  }
  return expectedCount;
}

async function assertDerivedInvariants(client: D1Client, expectedScheduleCount?: number): Promise<void> {
  const [statsMismatch] = await client.query(`
    SELECT COUNT(*) AS count
    FROM users
    LEFT JOIN subscription_user_stats AS stats ON stats.user_id = users.id
    WHERE stats.user_id IS NULL
       OR stats.total_count != (SELECT COUNT(*) FROM subscriptions WHERE user_id = users.id)
       OR stats.trial_count != (SELECT COUNT(*) FROM subscriptions WHERE user_id = users.id AND status = 'trial')
       OR stats.active_count != (SELECT COUNT(*) FROM subscriptions WHERE user_id = users.id AND status = 'active')
       OR stats.expired_count != (SELECT COUNT(*) FROM subscriptions WHERE user_id = users.id AND status = 'expired')
       OR stats.paused_count != (SELECT COUNT(*) FROM subscriptions WHERE user_id = users.id AND status = 'paused')
       OR stats.cancelled_count != (SELECT COUNT(*) FROM subscriptions WHERE user_id = users.id AND status = 'cancelled')
       OR stats.total_count != stats.trial_count + stats.active_count + stats.expired_count + stats.paused_count + stats.cancelled_count
  `, [], countRowSchema.parse);
  if (Number(statsMismatch?.count ?? 0) !== 0) throw new Error("subscription_user_stats invariant failed");

  const [schedulerMismatch] = await client.query(`
    SELECT COUNT(*) AS count
    FROM users
    LEFT JOIN subscription_scheduler_state AS scheduler ON scheduler.user_id = users.id
    WHERE scheduler.user_id IS NULL
    OR scheduler.auto_renew_count != (
      SELECT COUNT(*) FROM subscriptions WHERE user_id = scheduler.user_id AND auto_renew = 1
    ) OR scheduler.repeat_reminder_count != (
      SELECT COUNT(*) FROM subscriptions WHERE user_id = scheduler.user_id AND repeat_reminder_enabled = 1
    ) OR COALESCE(scheduler.next_repeat_notification_due_at_utc, '') != COALESCE((
      SELECT next_due_at_utc FROM subscription_repeat_schedule
      WHERE user_id = scheduler.user_id ORDER BY next_due_at_utc, subscription_id LIMIT 1
    ), '')
  `, [], countRowSchema.parse);
  if (Number(schedulerMismatch?.count ?? 0) !== 0) throw new Error("subscription_scheduler_state invariant failed");

  if (expectedScheduleCount !== undefined) {
    const [scheduleCount] = await client.query(
      "SELECT COUNT(*) AS count FROM subscription_repeat_schedule",
      [],
      countRowSchema.parse,
    );
    if (Number(scheduleCount?.count ?? 0) !== expectedScheduleCount) {
      throw new Error(`subscription_repeat_schedule count mismatch: expected ${expectedScheduleCount}`);
    }
  }
}

function nextAutoRenewCheckAt(now: Date, timezone: string, autoRenewCount: number, lastAutoRenewLocalDate: string): string | null {
  if (autoRenewCount <= 0) return null;
  const today = dateOnlyInZone(now, timezone);
  if (lastAutoRenewLocalDate !== today) return toRfc3339Seconds(now);
  return scheduleOccurrence(addDays(today, 1), "00:00", timezone).scheduledInstantUtc;
}

function nextDailyNotificationDueAt(now: Date, timezone: string, localTime: string): string {
  const current = getLocalScheduleDecision(now, timezone, localTime, notificationWindowMinutes, false);
  if (current.due) return current.scheduledInstantUtc;
  return getNextLocalScheduleOccurrence(now, timezone, localTime).scheduledInstantUtc;
}

async function upsertSchedulerRows(client: D1Client, now: Date): Promise<void> {
  let cursorUserId = "";
  for (;;) {
    const rows = await client.query(`
      SELECT
        users.id AS user_id,
        settings.settings_json,
        COALESCE(scheduler.last_auto_renew_local_date, '') AS last_auto_renew_local_date,
        (SELECT COUNT(*) FROM subscriptions WHERE user_id = users.id AND auto_renew = 1) AS auto_renew_count,
        (SELECT COUNT(*) FROM subscriptions WHERE user_id = users.id AND repeat_reminder_enabled = 1) AS repeat_reminder_count,
        (SELECT next_due_at_utc FROM subscription_repeat_schedule
         WHERE user_id = users.id ORDER BY next_due_at_utc, subscription_id LIMIT 1) AS next_repeat_notification_due_at_utc
      FROM users
      LEFT JOIN settings ON settings.user_id = users.id
      LEFT JOIN subscription_scheduler_state AS scheduler ON scheduler.user_id = users.id
      WHERE users.id > ?
      ORDER BY users.id
      LIMIT ?
    `, [cursorUserId, pageSize], (value): SchedulerBackfillRow => schedulerBackfillRowSchema.parse(value));
    if (rows.length === 0) return;

    const statements = rows.map((row): D1Query => {
      const settings = normalizeSettingsJson(row.settings_json ?? "{}");
      const autoRenewCount = Number(row.auto_renew_count) || 0;
      const repeatReminderCount = Number(row.repeat_reminder_count) || 0;
      const lastAutoRenewLocalDate = row.last_auto_renew_local_date ?? "";
      const timestamp = toRfc3339Seconds(now);
      return {
        sql: `INSERT INTO subscription_scheduler_state (
                user_id, auto_renew_count, repeat_reminder_count, last_auto_renew_local_date,
                next_auto_renew_check_at_utc, next_daily_notification_due_at_utc,
                next_repeat_notification_due_at_utc, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(user_id) DO UPDATE SET
                auto_renew_count = excluded.auto_renew_count,
                repeat_reminder_count = excluded.repeat_reminder_count,
                last_auto_renew_local_date = excluded.last_auto_renew_local_date,
                next_auto_renew_check_at_utc = excluded.next_auto_renew_check_at_utc,
                next_daily_notification_due_at_utc = excluded.next_daily_notification_due_at_utc,
                next_repeat_notification_due_at_utc = excluded.next_repeat_notification_due_at_utc,
                updated_at = excluded.updated_at`,
        params: [
          row.user_id,
          autoRenewCount,
          repeatReminderCount,
          lastAutoRenewLocalDate,
          nextAutoRenewCheckAt(now, settings.timezone, autoRenewCount, lastAutoRenewLocalDate),
          nextDailyNotificationDueAt(now, settings.timezone, settings.notificationTimeLocal),
          row.next_repeat_notification_due_at_utc,
          timestamp,
          timestamp,
        ],
      };
    });
    await writeStatements(client, statements);
    cursorUserId = requireLast(rows, "Scheduler backfill").user_id;
    if (rows.length < pageSize) return;
  }
}

async function runBackfill(client: D1Client): Promise<void> {
  const marker = await client.query(
    "SELECT name FROM subscription_derived_backfills WHERE name = ? LIMIT 1",
    [backfillName],
    backfillMarkerRowSchema.parse,
  );
  if (marker.length > 0) {
    await assertDerivedInvariants(client);
    console.log("Cloudflare subscription derived-state backfill already complete; invariants passed.");
    return;
  }

  // 整轮固定同一 now，保证写入与复算校验跨分页时不会因分钟窗口滚动产生假不一致。
  const now = new Date();
  let cursorUserId = "";
  let cursorSubscriptionId = "";
  let processed = 0;
  let expectedScheduleCount = 0;
  for (;;) {
    // 所有游标和写入值都保留为结构化 params；remote 绑定、local 类型化编码，两条路径都不记录账本 SQL。
    const rows = await client.query(`
      SELECT subscriptions.*, settings.settings_json
      FROM subscriptions
      LEFT JOIN settings ON settings.user_id = subscriptions.user_id
      WHERE subscriptions.user_id > ?
         OR (subscriptions.user_id = ? AND subscriptions.id > ?)
      ORDER BY subscriptions.user_id, subscriptions.id
      LIMIT ?
    `, [cursorUserId, cursorUserId, cursorSubscriptionId, pageSize], (value): SubscriptionBackfillRow => (
      subscriptionBackfillRowSchema.parse(value)
    ));
    if (rows.length === 0) break;

    const statements: D1Query[] = [];
    for (const row of rows) {
      const dueAt = nextRepeatDue(row, now);
      if (dueAt) {
        expectedScheduleCount += 1;
        statements.push({
          sql: `INSERT INTO subscription_repeat_schedule (user_id, subscription_id, next_due_at_utc)
                VALUES (?, ?, ?)
                ON CONFLICT(user_id, subscription_id) DO UPDATE SET next_due_at_utc = excluded.next_due_at_utc`,
          params: [row.user_id, row.id, dueAt],
        });
      } else {
        statements.push({
          sql: "DELETE FROM subscription_repeat_schedule WHERE user_id = ? AND subscription_id = ?",
          params: [row.user_id, row.id],
        });
      }
    }
    await writeStatements(client, statements);
    processed += rows.length;
    const last = requireLast(rows, "Subscription schedule backfill");
    cursorUserId = last.user_id;
    cursorSubscriptionId = last.id;
    if (rows.length < pageSize) break;
  }

  await upsertSchedulerRows(client, now);

  const verifiedScheduleCount = await assertBackfilledSchedules(client, now);
  if (verifiedScheduleCount !== expectedScheduleCount) {
    throw new Error(`subscription_repeat_schedule verification mismatch: expected ${expectedScheduleCount}, verified ${verifiedScheduleCount}`);
  }
  await assertDerivedInvariants(client, verifiedScheduleCount);
  const timestamp = now.toISOString();
  // completion marker 是最后一次独立提交；前面的任一步失败都不会把未验证状态伪装成已完成。
  await client.batch([{
    sql: "INSERT INTO subscription_derived_backfills (name, completed_at) VALUES (?, ?)",
    params: [backfillName, timestamp],
  }]);
  console.log(`Cloudflare subscription derived-state backfill complete: subscriptions=${processed}, schedules=${expectedScheduleCount}`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.target === "local") {
    await runBackfill(new D1LocalClient(options.configPath));
    return;
  }
  const apiToken = process.env["CLOUDFLARE_API_TOKEN"]?.trim();
  const accountId = process.env["CLOUDFLARE_ACCOUNT_ID"]?.trim();
  if (!apiToken || !accountId) throw new Error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required");
  const client = new D1RemoteClient(accountId, resolveDatabaseId(options), apiToken);
  await runBackfill(client);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
