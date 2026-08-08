// 系统版本 schema 测试保护 Docker 可执行更新与 Cloudflare 只读部署升级这两条前端能力分流。
import { describe, expect, it } from "vitest";
import { appStatusResponseSchema, systemVersionResponseSchema } from "./app";

const success = <T>(data: T) => ({ ok: true, data });

const baseVersionResponse = {
  currentVersion: "1.0.0",
  latestVersion: "1.1.0",
  hasUpdate: true,
  checkSucceeded: true,
  deployment: "docker",
  updateMode: "in-app-binary",
  updateSupported: true,
  releaseInfo: null,
  cached: false,
  build: {
    version: "1.0.0",
    commit: "abc",
    buildTime: "2026-05-26T00:00:00Z",
    buildType: "release",
  },
};

describe("system app schemas", () => {
  it("accepts app status Turnstile public config without secret metadata", () => {
    const parsed = appStatusResponseSchema.parse(success({
      setupRequired: false,
      setupEnabled: true,
      demoMode: false,
      turnstile: { enabled: true, siteKey: "site-key" },
    })).data;

    expect(parsed.turnstile).toEqual({ enabled: true, siteKey: "site-key" });
    expect(appStatusResponseSchema.safeParse(success({
      setupRequired: false,
      setupEnabled: true,
      demoMode: false,
      turnstile: { enabled: true, siteKey: "site-key", secretConfigured: true },
    })).success).toBe(false);
  });

  it("accepts the Docker in-app update capability response", () => {
    expect(systemVersionResponseSchema.parse(success(baseVersionResponse)).data.updateMode).toBe("in-app-binary");
    expect(systemVersionResponseSchema.safeParse(baseVersionResponse).success).toBe(false);
  });

  it("accepts Cloudflare deploy-only version responses", () => {
    const parsed = systemVersionResponseSchema.parse(success({
      ...baseVersionResponse,
      deployment: "cloudflare",
      updateMode: "cloudflare-deploy",
      updateSupported: false,
      unsupportedReason: "Cloudflare deployments do not support in-app updates.",
      build: {
        ...baseVersionResponse.build,
        buildType: "cloudflare",
      },
    })).data;

    expect(parsed.deployment).toBe("cloudflare");
    expect(parsed.updateSupported).toBe(false);
  });

  it("accepts release info with an empty assets array", () => {
    const parsed = systemVersionResponseSchema.parse(success({
      ...baseVersionResponse,
      releaseInfo: {
        tagName: "v1.1.0",
        version: "1.1.0",
        name: "Renewlet 1.1.0",
        body: "",
        publishedAt: "2026-05-26T00:00:00Z",
        htmlUrl: "https://github.com/zhiyingzzhou/renewlet/releases/tag/v1.1.0",
        assets: [],
      },
    })).data;

    expect(parsed.releaseInfo?.assets).toEqual([]);
  });

  it("rejects release info with null assets", () => {
    const result = systemVersionResponseSchema.safeParse(success({
      ...baseVersionResponse,
      releaseInfo: {
        tagName: "v1.1.0",
        version: "1.1.0",
        name: "Renewlet 1.1.0",
        body: "",
        publishedAt: "2026-05-26T00:00:00Z",
        htmlUrl: "https://github.com/zhiyingzzhou/renewlet/releases/tag/v1.1.0",
        assets: null,
      },
    }));

    expect(result.success).toBe(false);
  });

  it("rejects the old runtime field after the deployment contract switch", () => {
    const result = systemVersionResponseSchema.safeParse(success({
      ...baseVersionResponse,
      runtime: "docker",
    }));

    expect(result.success).toBe(false);
  });
});
