// Worker settings 测试保护首次账号语言初始化；请求 locale 只允许影响缺失 settings 行。
import { createDefaultAppSettings } from "@renewlet/shared/settings-defaults";
import type { ApiAppSettings } from "@renewlet/shared/schemas/settings";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readSuccessData } from "./api-test-helpers";
import { ensureSettings, normalizeSettingsJson } from "./db";
import { readSettings, updateSettings } from "./settings";
import type { Env } from "./types";

const USER_ID = "usr_settings";

const authMocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
}));

vi.mock("./auth", () => ({
  requireAuth: authMocks.requireAuth,
}));

interface SettingsTestState {
  rows: Map<string, string>;
  inserts: string[];
}

function d1Result<T = unknown>(results: T[]): D1Result<T> {
  return { results, success: true, meta: {} as D1Meta } as D1Result<T>;
}

function createEnv(initialSettings?: ApiAppSettings): { env: Env; state: SettingsTestState } {
  const state: SettingsTestState = {
    rows: new Map(initialSettings ? [[USER_ID, JSON.stringify(initialSettings)]] : []),
    inserts: [],
  };
  return {
    env: {
      DB: new SettingsTestDB(state) as unknown as D1Database,
      ASSETS: {} as Fetcher,
      ASSETS_BUCKET: {} as R2Bucket,
    },
    state,
  };
}

class SettingsTestDB {
  constructor(private readonly state: SettingsTestState) {}

  prepare(sql: string) {
    return new SettingsTestStatement(this.state, sql);
  }
}

class SettingsTestStatement {
  private values: unknown[] = [];

  constructor(
    private readonly state: SettingsTestState,
    private readonly sql: string,
  ) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async first<T>(): Promise<T | null> {
    if (this.sql.includes("SELECT settings_json FROM settings")) {
      const [userId] = this.values as [string];
      const settingsJson = this.state.rows.get(userId);
      return settingsJson ? { settings_json: settingsJson } as T : null;
    }
    if (this.sql.includes("FROM subscription_scheduler_state")) {
      return null;
    }
    if (this.sql.includes("SUM(CASE WHEN auto_renew")) {
      return { auto_renew_count: 0, repeat_reminder_count: 0 } as T;
    }
    return null;
  }

  async run(): Promise<D1Result> {
    if (this.sql.includes("INSERT INTO settings")) {
      const [userId, settingsJson] = this.values as [string, string, string, string];
      if (this.sql.includes("DO NOTHING")) {
        if (!this.state.rows.has(userId)) {
          this.state.rows.set(userId, settingsJson);
          this.state.inserts.push(userId);
        }
      } else {
        this.state.rows.set(userId, settingsJson);
      }
      return d1Result([]);
    }
    if (this.sql.includes("INSERT INTO subscription_scheduler_state")) {
      return d1Result([]);
    }
    throw new Error(`unexpected settings query: ${this.sql}`);
  }
}

function settingsRequest(method: string, locale: string, body?: unknown): Request {
  const unsafe = !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
  const init: RequestInit = {
    method,
    headers: {
      cookie: "renewlet_session=session-token; renewlet_csrf=csrf-token",
      "content-type": "application/json",
      "x-renewlet-locale": locale,
      ...(unsafe ? { origin: "https://renewlet.example", "x-renewlet-csrf": "csrf-token" } : {}),
    },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return new Request("https://renewlet.example/api/app/settings", init);
}

describe("Cloudflare settings initialization", () => {
  beforeEach(() => {
    authMocks.requireAuth.mockReset().mockResolvedValue({
      user: { id: USER_ID },
      session: { id: "ses" },
    });
  });

  it("creates missing settings with the request locale", async () => {
    const { env, state } = createEnv();

    const settings = await ensureSettings(env, USER_ID, "zh-CN");

    expect(settings.locale).toBe("zh-CN");
    expect(JSON.parse(state.rows.get(USER_ID) ?? "{}")).toMatchObject({ locale: "zh-CN" });
  });

  it("does not overwrite an existing settings locale", async () => {
    const existing = createDefaultAppSettings({ locale: "en-US" });
    const { env, state } = createEnv(existing);

    const settings = await ensureSettings(env, USER_ID, "zh-CN");

    expect(settings.locale).toBe("en-US");
    expect(state.inserts).toEqual([]);
    expect(JSON.parse(state.rows.get(USER_ID) ?? "{}")).toMatchObject({ locale: "en-US" });
  });

  it("defaults Telegram message format to plain and recovers invalid stored values", async () => {
    expect(createDefaultAppSettings().telegramMessageFormat).toBe("plain");
    const existing = {
      ...createDefaultAppSettings({ locale: "en-US" }),
      monthlyBudget: "2333",
      telegramMessageFormat: "markdown",
    };
    const state: SettingsTestState = {
      rows: new Map([[USER_ID, JSON.stringify(existing)]]),
      inserts: [],
    };
    const env = {
      DB: new SettingsTestDB(state) as unknown as D1Database,
      ASSETS: {} as Fetcher,
      ASSETS_BUCKET: {} as R2Bucket,
    } as Env;

    const settings = await ensureSettings(env, USER_ID, "zh-CN");

    expect(settings.telegramMessageFormat).toBe("plain");
    expect(settings.monthlyBudget).toBe("2333");
  });

  it("adds subscription price reference defaults when reading old settings JSON", () => {
    const settings = normalizeSettingsJson(JSON.stringify({
      defaultCurrency: "USD",
      monthlyBudget: "2333",
    }));

    expect(settings.defaultCurrency).toBe("USD");
    expect(settings.monthlyBudget).toBe("2333");
    expect(settings.subscriptionPriceReferenceEnabled).toBe(false);
    expect(settings.subscriptionPriceReferenceCurrency).toBe("default");
  });

  it("recovers invalid stored subscription price reference currency without dropping other settings", async () => {
    const existing = {
      ...createDefaultAppSettings({ locale: "en-US" }),
      monthlyBudget: "2333",
      subscriptionPriceReferenceEnabled: true,
      subscriptionPriceReferenceCurrency: "usd",
    };
    const state: SettingsTestState = {
      rows: new Map([[USER_ID, JSON.stringify(existing)]]),
      inserts: [],
    };
    const env = {
      DB: new SettingsTestDB(state) as unknown as D1Database,
      ASSETS: {} as Fetcher,
      ASSETS_BUCKET: {} as R2Bucket,
    } as Env;

    const settings = await ensureSettings(env, USER_ID, "zh-CN");

    expect(settings.subscriptionPriceReferenceEnabled).toBe(true);
    expect(settings.subscriptionPriceReferenceCurrency).toBe("default");
    expect(settings.monthlyBudget).toBe("2333");
  });

  it("recovers invalid stored DingTalk template fields without dropping other settings", async () => {
    const existing = {
      ...createDefaultAppSettings({ locale: "en-US" }),
      monthlyBudget: "2333",
      dingtalkTitleTemplate: "x".repeat(501),
      dingtalkContentTemplate: 42,
    };
    const state: SettingsTestState = {
      rows: new Map([[USER_ID, JSON.stringify(existing)]]),
      inserts: [],
    };
    const env = {
      DB: new SettingsTestDB(state) as unknown as D1Database,
      ASSETS: {} as Fetcher,
      ASSETS_BUCKET: {} as R2Bucket,
    } as Env;

    const settings = await ensureSettings(env, USER_ID, "zh-CN");

    expect(settings.dingtalkTitleTemplate).toBe("");
    expect(settings.dingtalkContentTemplate).toBe("");
    expect(settings.monthlyBudget).toBe("2333");
  });

  it("readSettings ensures a settings row from the request locale", async () => {
    const { env, state } = createEnv();

    const response = await readSettings(settingsRequest("GET", "zh-CN"), env);

    expect(response.status).toBe(200);
    await expect(readSuccessData(response)).resolves.toMatchObject({ settings: { locale: "zh-CN" } });
    expect(JSON.parse(state.rows.get(USER_ID) ?? "{}")).toMatchObject({ locale: "zh-CN" });
  });

  it("updateSettings uses the request locale when creating the first row", async () => {
    const { env, state } = createEnv();

    const response = await updateSettings(settingsRequest("PUT", "zh-CN", { monthlyBudget: "2333" }), env);

    expect(response.status).toBe(200);
    await expect(readSuccessData(response)).resolves.toMatchObject({ settings: { locale: "zh-CN", monthlyBudget: "2333" } });
    expect(JSON.parse(state.rows.get(USER_ID) ?? "{}")).toMatchObject({ locale: "zh-CN", monthlyBudget: "2333" });
  });

  it("does not create settings when the PATCH payload is invalid", async () => {
    const { env, state } = createEnv();

    await expect(updateSettings(settingsRequest("PUT", "zh-CN", { locale: "fr-FR" }), env))
      .rejects.toMatchObject({ status: 400, code: "INVALID_PAYLOAD" });

    expect(state.rows.has(USER_ID)).toBe(false);
  });

  it("rejects invalid subscription price reference currency on write", async () => {
    const { env } = createEnv(createDefaultAppSettings({ locale: "en-US" }));

    await expect(updateSettings(settingsRequest("PUT", "zh-CN", {
      subscriptionPriceReferenceEnabled: true,
      subscriptionPriceReferenceCurrency: "usd",
    }), env)).rejects.toMatchObject({ status: 400, code: "INVALID_PAYLOAD" });
  });

  it("accepts only supported Telegram message formats on write", async () => {
    const { env, state } = createEnv(createDefaultAppSettings({ locale: "en-US" }));

    const response = await updateSettings(settingsRequest("PUT", "en-US", { telegramMessageFormat: "html" }), env);
    expect(response.status).toBe(200);
    await expect(readSuccessData(response)).resolves.toMatchObject({ settings: { telegramMessageFormat: "html" } });

    await expect(updateSettings(settingsRequest("PUT", "en-US", { telegramMessageFormat: "markdown" }), env))
      .rejects.toMatchObject({ status: 400, code: "INVALID_PAYLOAD" });
    expect(JSON.parse(state.rows.get(USER_ID) ?? "{}")).toMatchObject({ telegramMessageFormat: "html" });
  });

  it("merges online icon source settings without dropping defaults", async () => {
    const { env, state } = createEnv(createDefaultAppSettings({ locale: "en-US" }));

    const response = await updateSettings(settingsRequest("PUT", "en-US", {
      onlineIconSources: {
        appStore: { enabled: false },
      },
    }), env);

    expect(response.status).toBe(200);
    await expect(readSuccessData(response)).resolves.toMatchObject({
      settings: {
        onlineIconSources: {
          appStore: { enabled: false, storefronts: ["us"] },
        },
      },
    });
    expect(JSON.parse(state.rows.get(USER_ID) ?? "{}")).toMatchObject({
      onlineIconSources: {
        appStore: { enabled: false, storefronts: ["us"] },
      },
    });
    await expect(updateSettings(settingsRequest("PUT", "en-US", {
      onlineIconSources: {
        appStore: { storefronts: ["cn"] },
      },
    }), env)).resolves.toMatchObject({ status: 200 });
    expect(JSON.parse(state.rows.get(USER_ID) ?? "{}")).toMatchObject({
      onlineIconSources: {
        appStore: { enabled: false, storefronts: ["cn"] },
      },
    });

    await expect(updateSettings(settingsRequest("PUT", "en-US", {
      onlineIconSources: {
        googlePlay: { enabled: true },
      },
    }), env)).rejects.toMatchObject({ status: 400, code: "INVALID_PAYLOAD" });
    await expect(updateSettings(settingsRequest("PUT", "en-US", {
      onlineIconSources: {
        appStore: { storefronts: [] },
      },
    }), env)).rejects.toMatchObject({ status: 400, code: "INVALID_PAYLOAD" });
    await expect(updateSettings(settingsRequest("PUT", "en-US", {
      onlineIconSources: {
        appStore: { storefronts: ["us", "us"] },
      },
    }), env)).rejects.toMatchObject({ status: 400, code: "INVALID_PAYLOAD" });
    await expect(updateSettings(settingsRequest("PUT", "en-US", {
      onlineIconSources: {
        appStore: { storefronts: ["jp"] },
      },
    }), env)).rejects.toMatchObject({ status: 400, code: "INVALID_PAYLOAD" });
  });

  it("rejects overly long DingTalk templates on write", async () => {
    const { env } = createEnv(createDefaultAppSettings({ locale: "en-US" }));

    await expect(updateSettings(settingsRequest("PUT", "en-US", { dingtalkTitleTemplate: "x".repeat(501) }), env))
      .rejects.toMatchObject({ status: 400, code: "INVALID_PAYLOAD" });
    await expect(updateSettings(settingsRequest("PUT", "en-US", { dingtalkContentTemplate: "x".repeat(20_001) }), env))
      .rejects.toMatchObject({ status: 400, code: "INVALID_PAYLOAD" });
  });
});
