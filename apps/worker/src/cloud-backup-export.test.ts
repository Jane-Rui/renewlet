import { createDefaultAppSettings } from "@renewlet/shared/settings-defaults";
import type { ApiSubscription } from "@renewlet/shared/schemas/subscriptions";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildCloudBackupExportZip } from "./cloud-backup-export";
import type { AssetRow, Env } from "./types";

const dbMocks = vi.hoisted(() => ({
  getAsset: vi.fn(),
  getCustomConfig: vi.fn(),
  getSettings: vi.fn(),
  listSubscriptions: vi.fn(),
  toApiSubscription: vi.fn(),
}));

vi.mock("./db", () => ({
  getAsset: dbMocks.getAsset,
  getCustomConfig: dbMocks.getCustomConfig,
  getSettings: dbMocks.getSettings,
  listSubscriptions: dbMocks.listSubscriptions,
  toApiSubscription: dbMocks.toApiSubscription,
}));

describe("Cloudflare cloud backup export ZIP", () => {
  beforeEach(() => {
    dbMocks.getAsset.mockReset().mockResolvedValue(null);
    dbMocks.getCustomConfig.mockReset().mockResolvedValue({ categories: [], statuses: [], paymentMethods: [], currencies: [] });
    dbMocks.getSettings.mockReset().mockResolvedValue(createDefaultAppSettings());
    dbMocks.listSubscriptions.mockReset().mockResolvedValue([]);
    dbMocks.toApiSubscription.mockReset().mockImplementation((row: ApiSubscription) => row);
  });

  it("removes subscription logos when D1 metadata exists but the R2 object is missing", async () => {
    dbMocks.listSubscriptions.mockResolvedValue([subscriptionFixture({ logo: "/api/app/assets/asset_logo" })]);
    dbMocks.getAsset.mockResolvedValue(assetRow({ id: "asset_logo", r2_key: "missing/logo.svg" }));

    const { content } = await buildCloudBackupExportZip(envWithR2({}), "usr_cloud");
    const data = readStoredZipJson(content, "data.json");
    const manifest = readStoredZipJson(content, "manifest.json");

    expect(data.data.subscriptions[0]).not.toHaveProperty("logo");
    expect(manifest.missingAssets).toEqual([{
      assetId: "asset_logo",
      path: "/api/app/assets/asset_logo",
      reference: "subscription.logo",
      referenceId: "sub_1",
      reason: "file_missing",
    }]);
  });

  it("exports payment method icons and audits only missing R2 objects", async () => {
    dbMocks.getCustomConfig.mockResolvedValue({
      categories: [],
      statuses: [],
      paymentMethods: [
        { id: "pm_ok", value: "card", labels: { "zh-CN": "Card", "en-US": "Card" }, icon: "/api/app/assets/asset_icon" },
        { id: "pm_missing", value: "wallet", labels: { "zh-CN": "Wallet", "en-US": "Wallet" }, icon: "/api/app/assets/asset_missing" },
      ],
      currencies: [],
    });
    dbMocks.getAsset.mockImplementation(async (_env: Env, _userId: string, assetId: string) => (
      assetId === "asset_icon"
        ? assetRow({ id: "asset_icon", r2_key: "icons/card.svg" })
        : assetRow({ id: "asset_missing", r2_key: "icons/missing.svg" })
    ));

    const { content } = await buildCloudBackupExportZip(envWithR2({ "icons/card.svg": "<svg />" }), "usr_cloud");
    const data = readStoredZipJson(content, "data.json");
    const manifest = readStoredZipJson(content, "manifest.json");

    expect(data.data.customConfig.paymentMethods[0].icon).toBe("assets/asset_icon.svg");
    expect(data.data.customConfig.paymentMethods[1]).not.toHaveProperty("icon");
    expect(readStoredZipText(content, "assets/asset_icon.svg")).toBe("<svg />");
    expect(manifest.assets).toBe(1);
    expect(manifest.missingAssets).toEqual([{
      assetId: "asset_missing",
      path: "/api/app/assets/asset_missing",
      reference: "customConfig.paymentMethods.icon",
      referenceId: "pm_missing",
      reason: "file_missing",
    }]);
  });
});

function envWithR2(objects: Record<string, string>): Env {
  const encoder = new TextEncoder();
  return {
    ASSETS_BUCKET: {
      get: vi.fn(async (key: string) => {
        const value = objects[key];
        if (value === undefined) return null;
        const bytes = encoder.encode(value);
        return {
          arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
          httpMetadata: { contentType: "image/svg+xml" },
        } as R2ObjectBody;
      }),
    } as unknown as R2Bucket,
  } as Env;
}

function assetRow(overrides: Partial<AssetRow> = {}): AssetRow {
  return {
    id: "asset_logo",
    user_id: "usr_cloud",
    kind: "logo",
    r2_key: "assets/logo.svg",
    original_name: "logo.svg",
    mime_type: "image/svg+xml",
    size_bytes: 7,
    created_at: "2026-06-09T00:00:00.000Z",
    updated_at: "2026-06-09T00:00:00.000Z",
    ...overrides,
  };
}

function subscriptionFixture(overrides: Partial<ApiSubscription> = {}): ApiSubscription {
  return {
    id: "sub_1",
    name: "GitHub",
    logo: undefined,
    price: "4",
    currency: "USD",
    billingCycle: "monthly",
    customDays: undefined,
    customCycleUnit: undefined,
    oneTimeTermCount: undefined,
    oneTimeTermUnit: undefined,
    category: "productivity",
    status: "active",
    pinned: false,
    publicHidden: false,
    paymentMethod: undefined,
    startDate: "2026-05-21",
    nextBillingDate: "2026-06-21",
    autoRenew: false,
    autoCalculateNextBillingDate: true,
    trialEndDate: undefined,
    website: undefined,
    notes: undefined,
    tags: [],
    reminderDays: 3,
    repeatReminderEnabled: false,
    repeatReminderInterval: "1h",
    repeatReminderWindow: "72h",
    extra: {},
    createdAt: "2026-05-21T00:00:00.000Z",
    updatedAt: "2026-05-21T00:00:00.000Z",
    ...overrides,
  };
}

function readStoredZipJson(content: Uint8Array, name: string) {
  return JSON.parse(readStoredZipText(content, name));
}

function readStoredZipText(content: Uint8Array, name: string): string {
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset + 30 <= content.length) {
    const view = new DataView(content.buffer, content.byteOffset + offset, content.byteLength - offset);
    if (view.getUint32(0, true) !== 0x04034b50) break;
    const compressedSize = view.getUint32(18, true);
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const entryName = decoder.decode(content.slice(nameStart, nameStart + nameLength));
    const data = content.slice(dataStart, dataStart + compressedSize);
    if (entryName === name) return decoder.decode(data);
    offset = dataStart + compressedSize;
  }
  throw new Error(`missing ZIP entry ${name}`);
}
