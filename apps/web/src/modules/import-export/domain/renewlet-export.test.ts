import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renewletExportManifestV1Schema, renewletExportV1Schema } from "@/lib/api/schemas/import-export";
import { assertDateOnly } from "@/lib/time/date-only";
import { DEFAULT_CUSTOM_CONFIG, type CustomConfig } from "@/types/config";
import { DEFAULT_SETTINGS, type RecurringCycleSubscription } from "@/types/subscription";
import { exportRenewletBackup } from "./renewlet-export";

const exportMocks = vi.hoisted(() => ({
  downloadFile: vi.fn(),
}));

vi.mock("@/shared/browser/download-file", () => ({
  downloadFile: exportMocks.downloadFile,
}));

describe("exportRenewletBackup", () => {
  beforeEach(() => {
    exportMocks.downloadFile.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("removes missing private subscription logos from data.json and audits them in manifest.json", async () => {
    const fetchPrivateAsset = vi.fn(async () => new Response("", { status: 404 }));
    vi.stubGlobal("fetch", fetchPrivateAsset);

    await exportRenewletBackup({
      subscriptions: [subscriptionFixture({ id: "sub_1", logo: "/api/app/assets/asset_missing" })],
      settings: DEFAULT_SETTINGS,
      customConfig: DEFAULT_CUSTOM_CONFIG,
      includeSecrets: false,
    });
    const { data, manifest } = await readDownloadedRenewletZip();

    expect(data.data.subscriptions[0]).not.toHaveProperty("logo");
    expect(fetchPrivateAsset).toHaveBeenCalledWith("/api/app/assets/asset_missing", { credentials: "include" });
    expect(manifest.missingAssets).toEqual([{
      assetId: "asset_missing",
      path: "/api/app/assets/asset_missing",
      reference: "subscription.logo",
      referenceId: "sub_1",
      reason: "not_found",
    }]);
  });

  it("exports custom payment method icons as ZIP assets and rewrites data.json to the asset entry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<svg />", {
      status: 200,
      headers: { "content-type": "image/svg+xml" },
    })));
    const customConfig: CustomConfig = {
      ...DEFAULT_CUSTOM_CONFIG,
      paymentMethods: [{
        id: "pm_card",
        value: "card",
        labels: { "zh-CN": "Card", "en-US": "Card" },
        icon: "/api/app/assets/asset_icon",
      }],
    };

    await exportRenewletBackup({
      subscriptions: [subscriptionFixture()],
      settings: DEFAULT_SETTINGS,
      customConfig,
      includeSecrets: false,
    });
    const { data, manifest, zip } = await readDownloadedRenewletZip();

    expect(data.data.customConfig?.paymentMethods[0]?.icon).toBe("assets/asset_icon.svg");
    expect(await zip.file("assets/asset_icon.svg")?.async("string")).toBe("<svg />");
    expect(data.data.assets).toEqual([{ id: "asset_icon", path: "assets/asset_icon.svg", mimeType: "image/svg+xml", sizeBytes: 7 }]);
    expect(manifest.missingAssets).toEqual([]);
  });
});

async function readDownloadedRenewletZip() {
  const blob = exportMocks.downloadFile.mock.calls[0]?.[0] as Blob | undefined;
  if (!blob) throw new Error("expected export download blob");
  const zip = await JSZip.loadAsync(blob);
  const dataFile = zip.file("data.json");
  const manifestFile = zip.file("manifest.json");
  if (!dataFile || !manifestFile) throw new Error("expected Renewlet ZIP data and manifest entries");
  return {
    zip,
    data: renewletExportV1Schema.parse(JSON.parse(await dataFile.async("string"))),
    manifest: renewletExportManifestV1Schema.parse(JSON.parse(await manifestFile.async("string"))),
  };
}

function subscriptionFixture(overrides: Partial<RecurringCycleSubscription> = {}): RecurringCycleSubscription {
  return {
    id: "sub_1",
    name: "GitHub",
    logo: undefined,
    price: "4",
    currency: "USD",
    billingCycle: "monthly",
    customDays: undefined,
    customCycleUnit: undefined,
    category: "productivity",
    status: "active",
    pinned: false,
    publicHidden: false,
    paymentMethod: undefined,
    startDate: assertDateOnly("2026-05-21"),
    nextBillingDate: assertDateOnly("2026-06-21"),
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
    ...overrides,
  };
}
