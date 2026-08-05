// Worker scheduled 入口测试保护自动续订、通知和云备份三阶段隔离，避免单阶段失败拖垮整轮 Cron。
import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "./index";
import type { Env } from "./types";

type ScheduledTask = () => Promise<unknown>;

const phaseMocks = vi.hoisted(() => ({
  renewAutoSubscriptionsForAllUsers: vi.fn<ScheduledTask>(),
  runScheduledNotifications: vi.fn<ScheduledTask>(),
  runDueCloudBackups: vi.fn<ScheduledTask>(),
}));

vi.mock("./subscription-renewal", () => ({
  renewAutoSubscriptionsForAllUsers: phaseMocks.renewAutoSubscriptionsForAllUsers,
}));

vi.mock("./notifications", () => ({
  notificationHistory: vi.fn(),
  notificationRun: vi.fn(),
  notificationTest: vi.fn(),
  runScheduledNotifications: phaseMocks.runScheduledNotifications,
}));

vi.mock("./cloud-backup", () => ({
  createCloudBackup: vi.fn(),
  deleteCloudBackup: vi.fn(),
  downloadCloudBackup: vi.fn(),
  listCloudBackups: vi.fn(),
  readCloudBackupConfig: vi.fn(),
  runDueCloudBackups: phaseMocks.runDueCloudBackups,
  testCloudBackupConfig: vi.fn(),
  updateCloudBackupConfig: vi.fn(),
}));

function envFixture(): Env {
  return {
    DB: {} as D1Database,
    ASSETS: {} as Fetcher,
    ASSETS_BUCKET: {} as R2Bucket,
  };
}

async function runScheduled(): Promise<void> {
  if (!worker.scheduled) throw new Error("Expected scheduled handler");
  await worker.scheduled({
    scheduledTime: Date.parse("2026-06-17T00:00:00.000Z"),
    cron: "* * * * *",
    noRetry: vi.fn(),
  }, envFixture(), {} as ExecutionContext);
}

async function fetchWorker(request: Request): Promise<Response> {
  if (!worker.fetch) throw new Error("Expected fetch handler");
  // Wrangler handler 的 Request 类型带 cf 元数据；单元测试只需要普通 Request 覆盖路由分派。
  return await worker.fetch(request as Parameters<NonNullable<typeof worker.fetch>>[0], envFixture(), {} as ExecutionContext);
}

describe("Cloudflare worker scheduled entrypoint", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    phaseMocks.renewAutoSubscriptionsForAllUsers.mockReset();
    phaseMocks.runScheduledNotifications.mockReset();
    phaseMocks.runDueCloudBackups.mockReset();
    phaseMocks.renewAutoSubscriptionsForAllUsers.mockResolvedValue(undefined);
    phaseMocks.runScheduledNotifications.mockResolvedValue(undefined);
    phaseMocks.runDueCloudBackups.mockResolvedValue(undefined);
  });

  it("runs scheduled phases in the required order", async () => {
    const events: string[] = [];
    phaseMocks.renewAutoSubscriptionsForAllUsers.mockImplementation(async () => {
      events.push("renew");
    });
    phaseMocks.runScheduledNotifications.mockImplementation(async () => {
      events.push("notifications");
    });
    phaseMocks.runDueCloudBackups.mockImplementation(async () => {
      events.push("backups");
    });

    await runScheduled();

    expect(events).toEqual(["renew", "notifications", "backups"]);
  });

  it("continues later scheduled phases after automatic renewal fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    phaseMocks.renewAutoSubscriptionsForAllUsers.mockRejectedValueOnce(new Error("database locked Authorization: Bearer abc.def?sendkey=SCTsecret"));

    await expect(runScheduled()).resolves.toBeUndefined();

    expect(phaseMocks.runScheduledNotifications).toHaveBeenCalledTimes(1);
    expect(phaseMocks.runDueCloudBackups).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith("scheduled_phase_failed", expect.objectContaining({
      event: "scheduled_phase_failed",
      phase: "auto_renew_subscriptions",
      error: expect.objectContaining({ name: "Error", message: expect.stringContaining("[redacted]") }),
    }));
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("abc.def");
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("SCTsecret");
  });

  it("continues cloud backups after notification scheduling fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    phaseMocks.runScheduledNotifications.mockRejectedValueOnce(new Error("notify failed SCTsecret"));

    await expect(runScheduled()).resolves.toBeUndefined();

    expect(phaseMocks.renewAutoSubscriptionsForAllUsers).toHaveBeenCalledTimes(1);
    expect(phaseMocks.runDueCloudBackups).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith("scheduled_phase_failed", expect.objectContaining({
      event: "scheduled_phase_failed",
      phase: "notifications",
      error: { name: "Error", message: "notify failed [redacted]" },
    }));
  });
});

describe("Cloudflare app CSRF origin middleware", () => {
  it("rejects unsafe /api/app requests without Origin or Referer", async () => {
    const response = await fetchWorker(new Request("https://renewlet.example/api/app/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "CSRF_ORIGIN_REQUIRED" },
    });
  });

  it("rejects unsafe /api/app requests from a different origin before handlers run", async () => {
    const response = await fetchWorker(new Request("https://renewlet.example/api/app/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: "{}",
    }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "CSRF_ORIGIN_MISMATCH" },
    });
  });
});
