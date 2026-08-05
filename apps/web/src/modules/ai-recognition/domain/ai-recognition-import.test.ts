import { describe, expect, it } from "vitest";
import { DEFAULT_CUSTOM_CONFIG } from "@/types/config";
import { DEFAULT_SETTINGS } from "@/types/subscription";
import { assertDateOnly } from "@/lib/time/date-only";
import type { AiRecognizedSubscriptionDraft } from "@/lib/api/schemas/ai-recognition";
import { translate } from "@/i18n/messages";
import { IMPORT_MESSAGE_CODES } from "@/modules/import-export/domain/import-export-model";
import { formatImportMessage } from "@/modules/import-export/domain/import-message-format";
import { buildPreparedImportFromAIDrafts } from "./ai-recognition-import";

const context = {
  config: DEFAULT_CUSTOM_CONFIG,
  settings: { ...DEFAULT_SETTINGS, defaultCurrency: "USD", notificationReminderDays: 5 },
  today: assertDateOnly("2026-06-05"),
};

function draft(overrides: Partial<AiRecognizedSubscriptionDraft> = {}): AiRecognizedSubscriptionDraft {
  return {
    name: "Netflix",
    price: "9.99",
    currency: "USD",
    billingCycle: "monthly",
    customDays: null,
    customCycleUnit: null,
    oneTimeTermCount: null,
    oneTimeTermUnit: null,
    category: null,
    status: "active",
    paymentMethod: null,
    startDate: "2026-06-01",
    nextBillingDate: "2026-07-01",
    autoCalculateNextBillingDate: true,
    trialEndDate: null,
    website: { value: "https://netflix.com", source: "input" },
    notes: null,
    tags: [],
    reminderDays: null,
    repeatReminderEnabled: null,
    repeatReminderInterval: null,
    repeatReminderWindow: null,
    confidence: "high",
    warnings: [],
    ...overrides,
  };
}

describe("AI recognition import mapping", () => {
  it("turns AI drafts into the existing import payload shape", () => {
    const prepared = buildPreparedImportFromAIDrafts([draft()], context);
    const subscription = prepared.payload.subscriptions[0];

    expect(prepared.payload.source).toBe("ai");
    expect(subscription?.extra.import.source).toBe("ai");
    expect(subscription?.extra.import.confidence).toBe("high");
    expect(subscription?.website).toBe("https://netflix.com/");
    expect(subscription?.reminderDays).toBe(5);
    expect(subscription?.autoRenew).toBe(false);
    expect(prepared.assets).toEqual([]);
  });

  it("records blocking warnings when AI cannot confirm core fields", () => {
    const prepared = buildPreparedImportFromAIDrafts([
      draft({
        price: null,
        currency: null,
        billingCycle: null,
        startDate: null,
        nextBillingDate: "2026-07-01",
        autoCalculateNextBillingDate: false,
      }),
    ], context);

    const subscription = prepared.payload.subscriptions[0];
    expect(subscription?.price).toBe("0");
    expect(subscription?.currency).toBe("USD");
    expect(subscription?.billingCycle).toBe("monthly");
    expect(subscription?.startDate).toBeNull();
    expect(subscription?.nextBillingDate).toBe("2026-07-01");
    expect(subscription?.autoCalculateNextBillingDate).toBe(false);
    expect(prepared.warnings).toEqual(expect.arrayContaining([
      `IMPORT_WARNING_FOR_SUBSCRIPTION|Netflix|${IMPORT_MESSAGE_CODES.aiPriceDefaulted}`,
      `IMPORT_WARNING_FOR_SUBSCRIPTION|Netflix|${IMPORT_MESSAGE_CODES.aiCurrencyDefaulted}`,
      `IMPORT_WARNING_FOR_SUBSCRIPTION|Netflix|${IMPORT_MESSAGE_CODES.aiBillingCycleDefaulted}`,
    ]));
    expect(prepared.warnings.join("\n")).not.toContain(IMPORT_MESSAGE_CODES.aiDateDefaulted);
  });

  it("does not default missing next billing dates", () => {
    expect(() => buildPreparedImportFromAIDrafts([
      draft({
        startDate: null,
        nextBillingDate: null,
        autoCalculateNextBillingDate: false,
      }),
    ], context)).toThrow("AI_RECOGNITION_DRAFT_DATE_REQUIRED");
  });

  it("keeps useful suggested notes without adding a preview warning", () => {
    const prepared = buildPreparedImportFromAIDrafts([
      draft({
        website: { value: "spotify.com", source: "suggested" },
        notes: { value: "Spotify 是音乐和播客流媒体服务。", source: "suggested" },
      }),
    ], context);

    expect(prepared.payload.subscriptions[0]?.website).toBe("https://spotify.com/");
    expect(prepared.payload.subscriptions[0]?.notes).toBe("Spotify 是音乐和播客流媒体服务。");
    expect(prepared.payload.subscriptions[0]?.extra["ai"]).toEqual({
      websiteSource: "suggested",
      notesSource: "suggested",
    });
    expect(prepared.warnings).toEqual(expect.arrayContaining([
      `IMPORT_WARNING_FOR_SUBSCRIPTION|Netflix|${IMPORT_MESSAGE_CODES.aiWebsiteSuggested}`,
    ]));
    expect(prepared.warnings.join("\n")).not.toContain("IMPORT_WARNING_AI_NOTES_SUGGESTED");
  });

  it("drops recognition process notes from the import payload", () => {
    const prepared = buildPreparedImportFromAIDrafts([
      draft({
        notes: { value: "输入没有提供官网或更多上下文，AI 未能高置信识别该服务。", source: "suggested" },
      }),
    ], context);

    expect(prepared.payload.subscriptions[0]?.notes).toBeNull();
    expect(prepared.payload.subscriptions[0]?.extra["ai"]).toEqual({ websiteSource: "input" });
    expect(prepared.warnings.join("\n")).not.toContain("IMPORT_WARNING_AI_NOTES_SUGGESTED");
  });

  it("removes Renewlet-facing advice before importing notes", () => {
    const prepared = buildPreparedImportFromAIDrafts([
      draft({
        notes: { value: "LOCVPS 提供 VPS、云服务器和服务器托管相关服务，适合记录主机或服务器套餐订阅。", source: "suggested" },
      }),
    ], context);

    expect(prepared.payload.subscriptions[0]?.notes).toBe("LOCVPS 提供 VPS、云服务器和服务器托管服务");
    expect(prepared.payload.subscriptions[0]?.extra["ai"]).toEqual({
      websiteSource: "input",
      notesSource: "suggested",
    });
    expect(prepared.warnings.join("\n")).not.toContain("IMPORT_WARNING_AI_NOTES_SUGGESTED");
  });

  it("formats AI provider warnings into localized review text", () => {
    const formatted = formatImportMessage(
      "IMPORT_WARNING_FOR_SUBSCRIPTION|Apple|AI_WARNING_SERVICE_UNSPECIFIED",
      (key, params) => translate("zh-CN", key, params),
    );

    expect(formatted).toBe("Apple：输入没有明确具体服务，AI 已按品牌生成基础信息，请确认是否正确。");
    expect(formatted).not.toContain("AI_WARNING");
  });

  it("formats missing service description warnings into localized review text", () => {
    const formatted = formatImportMessage(
      "IMPORT_WARNING_FOR_SUBSCRIPTION|YouTube|AI_WARNING_NOTES_MISSING",
      (key, params) => translate("zh-CN", key, params),
    );

    expect(formatted).toBe("YouTube：AI 未生成服务简介，可在备注中补充。");
    expect(formatted).not.toContain("AI_WARNING");
  });

  it("matches recognized category and payment method to existing config before creating new items", () => {
    const prepared = buildPreparedImportFromAIDrafts([
      draft({
        currency: "EUR",
        category: "Streaming",
        paymentMethod: "Crypto",
      }),
    ], context);
    const subscription = prepared.payload.subscriptions[0];

    expect(subscription?.category).toBe("streaming");
    expect(subscription?.paymentMethod).toBe("crypto");
    expect(prepared.payload.customConfig?.currencies.some((item) => item.value === "EUR" && item.enabled)).toBe(true);
    expect(prepared.payload.customConfig?.categories).toHaveLength(DEFAULT_CUSTOM_CONFIG.categories.length);
    expect(prepared.payload.customConfig?.paymentMethods).toHaveLength(DEFAULT_CUSTOM_CONFIG.paymentMethods.length);
  });

  it("creates recognized category and payment method only when no existing option matches", () => {
    const prepared = buildPreparedImportFromAIDrafts([
      draft({
        category: "Streaming AI",
        paymentMethod: "Virtual Card",
      }),
    ], context);

    expect(prepared.payload.customConfig?.categories.some((item) => item.labels["zh-CN"] === "Streaming AI")).toBe(true);
    expect(prepared.payload.customConfig?.paymentMethods.some((item) => item.labels["zh-CN"] === "Virtual Card")).toBe(true);
  });
});
