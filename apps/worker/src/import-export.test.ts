// Worker 导入测试保护 preview/apply 写入契约，避免 Cloudflare D1 到写库阶段才发现订阅字段错误。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readSuccessData } from "./api-test-helpers";
import { applyImport, previewImport } from "./import-export";
import { HttpError } from "./http";
import type { Env, SubscriptionRow } from "./types";

const authUser = {
  id: "usr_import",
  email: "import@example.com",
  name: "Importer",
  role: "admin" as const,
  banned: 0,
  ban_reason: "",
  password_hash: "hash",
  reset_token_hash: null,
  reset_token_expires_at: null,
  created_at: "2026-06-05T00:00:00.000Z",
  updated_at: "2026-06-05T00:00:00.000Z",
};

const authMocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
}));

const dbMocks = vi.hoisted(() => ({
  listSubscriptions: vi.fn(),
  getSettings: vi.fn(),
  nowIso: vi.fn(),
  newId: vi.fn(),
}));

vi.mock("./auth", () => ({
  requireAuth: authMocks.requireAuth,
}));

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./db")>();
  return {
    ...actual,
    listSubscriptions: dbMocks.listSubscriptions,
    getSettings: dbMocks.getSettings,
    nowIso: dbMocks.nowIso,
    newId: dbMocks.newId,
  };
});

function envFixture() {
  // apply 用例通过捕获 bind 顺序验证 D1 写入形状；preview 失败时 batch 必须完全不被触发。
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    prepare: vi.fn((sql: string) => ({
      bind: (...values: unknown[]) => {
        statements.push({ sql, values });
        const statement = {
          run: vi.fn(async () => d1Result([], 1)),
          first: vi.fn(async <T>() => {
            if (sql.includes("SUM(CASE WHEN auto_renew")) {
              return { auto_renew_count: 0, repeat_reminder_count: 0 } as T;
            }
            return null;
          }),
          all: vi.fn(async <T>() => d1Result<T>([])),
        };
        return statement;
      },
    })),
    batch: vi.fn(async (batchStatements: D1PreparedStatement[]) => batchStatements.map(() => d1Result([], 1))),
  };
  return {
    env: { DB: db as unknown as D1Database, ASSETS: {} as Fetcher, ASSETS_BUCKET: {} as R2Bucket } as Env,
    db,
    statements,
  };
}

function d1Result<T = unknown>(results: T[] = [], changes = 0): D1Result<T> {
  return { success: true, results, meta: { changes } } as D1Result<T>;
}

function requestFor(path: string, body: unknown): Request {
  return new Request(`https://renewlet.test${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test",
      "x-renewlet-locale": "en-US",
    },
    body: JSON.stringify(body),
  });
}

function importSubscription(overrides: Record<string, unknown> = {}) {
  return {
    name: "Imported",
    logo: null,
    price: "12",
    currency: "USD",
    billingCycle: "monthly",
    customDays: null,
    customCycleUnit: null,
    category: "productivity",
    status: "active",
    pinned: false,
    publicHidden: false,
    paymentMethod: null,
    startDate: "2026-05-21",
    nextBillingDate: "2026-06-21",
    autoRenew: false,
    autoCalculateNextBillingDate: true,
    trialEndDate: null,
    website: null,
    notes: null,
    tags: [],
    reminderDays: 3,
    repeatReminderEnabled: false,
    repeatReminderInterval: "1h",
    repeatReminderWindow: "72h",
    extra: { import: { source: "wallos", sourceId: "usr:sub", confidence: "high" } },
    ...overrides,
  };
}

function importPayload(subscriptions: unknown[]) {
  return {
    payload: {
      source: "wallos",
      subscriptions,
    },
    conflictMode: "skip",
    skipIndexes: [],
  };
}

describe("Cloudflare import", () => {
  beforeEach(() => {
    authMocks.requireAuth.mockReset();
    dbMocks.listSubscriptions.mockReset();
    dbMocks.getSettings.mockReset();
    dbMocks.nowIso.mockReset();
    dbMocks.newId.mockReset();
    authMocks.requireAuth.mockResolvedValue({ user: authUser, session: { id: "ses" } });
    dbMocks.listSubscriptions.mockResolvedValue([]);
    dbMocks.getSettings.mockResolvedValue({});
    dbMocks.nowIso.mockReturnValue("2026-06-05T00:00:00.000Z");
    dbMocks.newId.mockReturnValue("sub_new");
  });

  it("reports storage-shape errors during preview before D1 writes", async () => {
    const { env } = envFixture();
    const response = await previewImport(requestFor("/api/app/import/preview", importPayload([
      importSubscription({ startDate: "2026-07-01", nextBillingDate: "2026-06-01" }),
    ])), env);
    const json = await readSuccessData<{ summary: { errors: number }; items: Array<{ action: string; errors: string[] }> }>(response);

    expect(response.status).toBe(200);
    expect(json.summary.errors).toBe(1);
    expect(json.items[0]?.action).toBe("error");
    expect(json.items[0]?.errors[0]).toBe("IMPORT_SUBSCRIPTION_INVALID:nextBillingDate");
  });

  it("does not write D1 when apply payload fails preview storage validation", async () => {
    const { env, db } = envFixture();

    await expect(applyImport(requestFor("/api/app/import/apply", importPayload([
      importSubscription({ startDate: "2026-07-01", nextBillingDate: "2026-06-01" }),
    ])), env)).rejects.toMatchObject({
      status: 400,
      code: "IMPORT_PREVIEW_FAILED",
    } satisfies Partial<HttpError>);

    expect(db.batch).not.toHaveBeenCalled();
  });

  it("applies manual recurring imports with nullable start dates", async () => {
    const { env, db, statements } = envFixture();
    const response = await applyImport(requestFor("/api/app/import/apply", importPayload([
      importSubscription({
        startDate: null,
        nextBillingDate: "2026-06-21",
        autoCalculateNextBillingDate: false,
      }),
    ])), env);

    expect(response.status).toBe(200);
    expect(db.batch).toHaveBeenCalledTimes(2);
    const insert = statements.find((statement) => statement.sql.includes("INSERT INTO subscriptions"));
    expect(insert?.values[16]).toBeNull();
    expect(insert?.values[17]).toBe("2026-06-21");
    expect(insert?.values[19]).toBe(0);
  });

  it("normalizes one-time imports before binding D1 statements", async () => {
    const { env, db, statements } = envFixture();
    const response = await applyImport(requestFor("/api/app/import/apply", importPayload([
      importSubscription({
        billingCycle: "one-time",
        customDays: 30,
        customCycleUnit: "day",
        autoCalculateNextBillingDate: true,
      }),
    ])), env);

    expect(response.status).toBe(200);
    expect(db.batch).toHaveBeenCalledTimes(2);
    const insert = statements.find((statement) => statement.sql.includes("INSERT INTO subscriptions"));
    expect(insert?.values[6]).toBe("one-time");
    expect(insert?.values[7]).toBeNull();
    expect(insert?.values[8]).toBeNull();
    expect(insert?.values[9]).toBeNull();
    expect(insert?.values[10]).toBeNull();
    expect(insert?.values[18]).toBe(0);
    expect(insert?.values[19]).toBe(0);
  });

  it("preserves one-time fixed term fields before binding D1 statements", async () => {
    const { env, db, statements } = envFixture();
    const response = await applyImport(requestFor("/api/app/import/apply", importPayload([
      importSubscription({
        billingCycle: "one-time",
        customDays: 30,
        customCycleUnit: "day",
        oneTimeTermCount: 6,
        oneTimeTermUnit: "month",
        autoCalculateNextBillingDate: true,
      }),
    ])), env);

    expect(response.status).toBe(200);
    expect(db.batch).toHaveBeenCalledTimes(2);
    const insert = statements.find((statement) => statement.sql.includes("INSERT INTO subscriptions"));
    expect(insert?.values[6]).toBe("one-time");
    expect(insert?.values[7]).toBeNull();
    expect(insert?.values[8]).toBeNull();
    expect(insert?.values[9]).toBe(6);
    expect(insert?.values[10]).toBe("month");
    expect(insert?.values[18]).toBe(0);
    expect(insert?.values[19]).toBe(0);
  });

  it("preserves disabled reminder days before binding D1 statements", async () => {
    const { env, db, statements } = envFixture();
    const response = await applyImport(requestFor("/api/app/import/apply", importPayload([
      importSubscription({
        reminderDays: -2,
      }),
    ])), env);

    expect(response.status).toBe(200);
    expect(db.batch).toHaveBeenCalledTimes(2);
    const insert = statements.find((statement) => statement.sql.includes("INSERT INTO subscriptions"));
    expect(insert?.values[24]).toBe(-2);
  });

  it("preserves cost sharing before binding D1 statements", async () => {
    const { env, db, statements } = envFixture();
    const costSharing = {
      enabled: true,
      splitMode: "custom",
      members: [
        { id: "partner", name: "Partner", customAmount: "7" },
        { id: "child", name: "Child", customAmount: "5" },
      ],
    };
    const response = await applyImport(requestFor("/api/app/import/apply", importPayload([
      importSubscription({ costSharing }),
    ])), env);

    expect(response.status).toBe(200);
    expect(db.batch).toHaveBeenCalledTimes(2);
    const insert = statements.find((statement) => statement.sql.includes("INSERT INTO subscriptions"));
    expect(insert?.sql).toContain("cost_sharing_json");
    expect(JSON.parse(insert?.values[28] as string)).toEqual(costSharing);
  });

  it("refreshes scheduler state after applying subscription imports", async () => {
    const { env, db, statements } = envFixture();
    const response = await applyImport(requestFor("/api/app/import/apply", importPayload([
      importSubscription({ autoRenew: true, repeatReminderEnabled: true }),
    ])), env);

    expect(response.status).toBe(200);
    expect(db.batch).toHaveBeenCalledTimes(2);
    expect(statements.some((statement) => statement.sql.includes("INSERT INTO subscription_scheduler_state"))).toBe(true);
  });

  it("defaults missing import autoRenew to manual renewal before binding D1 statements", async () => {
    const { env, db, statements } = envFixture();
    const subscription = { ...importSubscription() } as Record<string, unknown>;
    delete subscription["autoRenew"];
    const response = await applyImport(requestFor("/api/app/import/apply", importPayload([subscription])), env);

    expect(response.status).toBe(200);
    expect(db.batch).toHaveBeenCalledTimes(2);
    const insert = statements.find((statement) => statement.sql.includes("INSERT INTO subscriptions"));
    expect(insert?.values[18]).toBe(0);
  });

  it("skips existing import keys unless replace is selected", async () => {
    dbMocks.listSubscriptions.mockResolvedValue([
      {
        id: "sub_existing",
        user_id: "usr_import",
        name: "Imported",
        logo: null,
        price: "12",
        currency: "USD",
        billing_cycle: "monthly",
        custom_days: null,
        custom_cycle_unit: null,
        one_time_term_count: null,
        one_time_term_unit: null,
        category: "productivity",
        status: "active",
        pinned: 0,
        public_hidden: 0,
        payment_method: null,
        start_date: "2026-05-21",
        next_billing_date: "2026-06-21",
        auto_renew: 1,
        auto_calculate_next_billing_date: 1,
        trial_end_date: null,
        website: null,
        notes: null,
        tags_json: "[]",
        reminder_days: 3,
        repeat_reminder_enabled: 0,
        repeat_reminder_interval: "1h",
        repeat_reminder_window: "72h",
        extra_json: JSON.stringify({ import: { source: "wallos", sourceId: "usr:sub", confidence: "high" } }),
        created_at: "2026-06-01T00:00:00.000Z",
        updated_at: "2026-06-01T00:00:00.000Z",
      } satisfies SubscriptionRow,
    ]);
    const { env } = envFixture();

    const response = await previewImport(requestFor("/api/app/import/preview", importPayload([
      importSubscription(),
    ])), env);
    const json = await readSuccessData<{ summary: { skips: number; replaces: number }; items: Array<{ action: string; existingId?: string }> }>(response);

    expect(json.summary.skips).toBe(1);
    expect(json.summary.replaces).toBe(0);
    expect(json.items[0]).toMatchObject({ action: "skip", existingId: "sub_existing" });
  });
});
