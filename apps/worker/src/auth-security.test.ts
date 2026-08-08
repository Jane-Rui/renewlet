// Worker 登录人机验证测试保护站点级 secret 的 write-only 契约和 D1 缺表升级边界。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readSuccessData } from "./api-test-helpers";
import { readAuthSecurity, updateAuthSecurity } from "./auth-security";
import { resetAuthSecuritySchemaForTest } from "./auth-security-store";
import type { AuthSecuritySettingsRow, Env } from "./types";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
}));

vi.mock("./auth", () => ({
  requireAdmin: mocks.requireAdmin,
}));

describe("Cloudflare auth security admin API", () => {
  beforeEach(() => {
    mocks.requireAdmin.mockReset().mockResolvedValue({ user: { id: "usr_admin", role: "admin" } });
    resetAuthSecuritySchemaForTest();
  });

  it("reads Turnstile settings without exposing the secret", async () => {
    const env = envFixture(authSecurityRow());

    const response = await readAuthSecurity(new Request("https://renewlet.example/api/app/admin/auth-security"), env);

    expect(response.status).toBe(200);
    await expect(readSuccessData(response)).resolves.toEqual({
      turnstile: { enabled: true, siteKey: "site-key", secretConfigured: true },
    });
  });

  it("rejects enabling Turnstile without a complete configuration", async () => {
    const env = envFixture(null);

    await expect(updateAuthSecurity(jsonRequest({
      turnstile: { enabled: true, siteKey: "site-key" },
    }), env)).rejects.toMatchObject({ code: "TURNSTILE_CONFIG_INCOMPLETE" });
  });

  it("retains and clears the stored Turnstile secret through write-only updates", async () => {
    const row = authSecurityRow();
    const env = envFixture(row);

    const retained = await updateAuthSecurity(jsonRequest({
      turnstile: { enabled: true, siteKey: "site-key-2" },
    }), env);
    const retainedBody = retained.clone();
    await expect(readSuccessData(retained)).resolves.toEqual({
      turnstile: { enabled: true, siteKey: "site-key-2", secretConfigured: true },
    });
    expect(row.turnstile_secret).toBe("secret-value");
    expect(await retainedBody.text()).not.toContain("secret-value");

    const cleared = await updateAuthSecurity(jsonRequest({
      turnstile: { enabled: false, siteKey: "site-key-2", secret: "" },
    }), env);
    await expect(readSuccessData(cleared)).resolves.toEqual({
      turnstile: { enabled: false, siteKey: "site-key-2", secretConfigured: false },
    });
    expect(row.turnstile_secret).toBe("");
  });

  it("creates the D1 auth security table when saving after a missing migration", async () => {
    const env = envFixture(null, { missingTableOnFirstWrite: true });

    const response = await updateAuthSecurity(jsonRequest({
      turnstile: { enabled: true, siteKey: "site-key", secret: "secret-value" },
    }), env);

    expect(response.status).toBe(200);
    expect(env.DB.prepare).toHaveBeenCalledWith(expect.stringContaining("CREATE TABLE IF NOT EXISTS auth_security_settings"));
  });
});

function jsonRequest(body: unknown): Request {
  return new Request("https://renewlet.example/api/app/admin/auth-security", {
    method: "PUT",
    headers: {
      "accept-language": "en-US",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function authSecurityRow(overrides: Partial<AuthSecuritySettingsRow> = {}): AuthSecuritySettingsRow {
  return {
    key: "global",
    turnstile_enabled: 1,
    turnstile_site_key: "site-key",
    turnstile_secret: "secret-value",
    created_at: "2026-06-03T00:00:00.000Z",
    updated_at: "2026-06-03T00:00:00.000Z",
    ...overrides,
  };
}

function envFixture(row: AuthSecuritySettingsRow | null, options: { missingTableOnFirstWrite?: boolean } = {}): Env {
  let writeAttempts = 0;
  const prepare = vi.fn((sql: string) => ({
    bind: vi.fn((...values: unknown[]) => ({
      first: vi.fn(async () => row),
      run: vi.fn(async () => {
        if (options.missingTableOnFirstWrite && sql.includes("INSERT INTO auth_security_settings") && writeAttempts === 0) {
          writeAttempts += 1;
          throw new Error("D1_ERROR: no such table: auth_security_settings");
        }
        if (sql.includes("INSERT INTO auth_security_settings")) {
          const next = authSecurityRow({
            turnstile_enabled: Number(values[1]),
            turnstile_site_key: String(values[2]),
            turnstile_secret: String(values[3]),
            created_at: String(values[4]),
            updated_at: String(values[5]),
          });
          if (row) {
            Object.assign(row, next);
          } else {
            row = next;
          }
        }
        return {};
      }),
    })),
    run: vi.fn(async () => ({})),
  }));
  return {
    DB: { prepare } as unknown as D1Database,
    ASSETS: {} as Fetcher,
    ASSETS_BUCKET: {} as R2Bucket,
  };
}
