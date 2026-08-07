import { describe, expect, it } from "vitest";
import type { AiRecognizedSubscriptionDraft } from "@/lib/api/schemas/ai-recognition";
import { DEFAULT_CUSTOM_CONFIG } from "@/types/config";
import { DEFAULT_SETTINGS } from "@/types/subscription";
import { createSubscriptionFormState } from "@/types/subscription-form";
import { assertDateOnly } from "@/lib/time/date-only";
import {
  aiDraftToSubscriptionFormState,
  subscriptionFormStateToAIDraftPatch,
} from "./ai-recognition-form";

function draft(overrides: Partial<AiRecognizedSubscriptionDraft> = {}): AiRecognizedSubscriptionDraft {
  return {
    name: "DMIT",
    price: "15",
    currency: "CNY",
    billingCycle: "monthly",
    customDays: null,
    customCycleUnit: null,
    oneTimeTermCount: null,
    oneTimeTermUnit: null,
    category: "hosting_domains",
    status: "active",
    paymentMethod: "alipay",
    startDate: "2026-06-01",
    nextBillingDate: "2026-07-01",
    autoCalculateNextBillingDate: true,
    trialEndDate: null,
    website: { value: "https://www.dmit.io/", source: "suggested" },
    notes: { value: "DMIT 是提供 VPS、云服务器和网络线路服务的主机商。", source: "suggested" },
    tags: ["VPS", "Hosting"],
    reminderDays: null,
    repeatReminderEnabled: null,
    repeatReminderInterval: null,
    repeatReminderWindow: null,
    confidence: "high",
    warnings: [],
    ...overrides,
  };
}

const context = {
  config: DEFAULT_CUSTOM_CONFIG,
  settings: { ...DEFAULT_SETTINGS, defaultCurrency: "USD", notificationReminderDays: 5 },
};

describe("AI recognition form mapping", () => {
  it("maps an AI draft into the reusable subscription form state", () => {
    const formData = aiDraftToSubscriptionFormState(draft({
      price: "12.5",
      currency: null,
      billingCycle: "custom",
      customDays: 45,
      customCycleUnit: "day",
      status: "trial",
      paymentMethod: "crypto",
      autoCalculateNextBillingDate: false,
      trialEndDate: "2026-06-15",
      reminderDays: 11,
      repeatReminderEnabled: true,
      repeatReminderInterval: "6h",
      repeatReminderWindow: "48h",
    }), context);

    expect(formData).toMatchObject({
      name: "DMIT",
      price: "12.5",
      currency: "USD",
      billingCycle: "custom",
      customDays: "45",
      customCycleUnit: "day",
      category: "hosting_domains",
      status: "trial",
      paymentMethod: "crypto",
      startDate: "2026-06-01",
      nextBillingDate: "2026-07-01",
      autoRenew: false,
      autoCalculate: false,
      reminderType: "custom",
      reminderDays: "5",
      customReminderDays: "11",
      repeatReminderEnabled: true,
      repeatReminderInterval: "6h",
      repeatReminderWindow: "48h",
      website: "https://www.dmit.io/",
      notes: "DMIT 是提供 VPS、云服务器和网络线路服务的主机商。",
      tags: ["VPS", "Hosting"],
    });
  });

  it("maps one-time AI drafts to term or buyout form modes", () => {
    const term = aiDraftToSubscriptionFormState(draft({
      billingCycle: "one-time",
      oneTimeTermCount: 2,
      oneTimeTermUnit: "year",
    }), context);
    const buyout = aiDraftToSubscriptionFormState(draft({
      billingCycle: "one-time",
      oneTimeTermCount: null,
      oneTimeTermUnit: null,
    }), context);

    expect(term.oneTimeMode).toBe("term");
    expect(term.oneTimeTermCount).toBe("2");
    expect(term.oneTimeTermUnit).toBe("year");
    expect(term.reminderType).toBe("inherit");
    expect(term.reminderDays).toBe("-1");
    expect(buyout.oneTimeMode).toBe("buyout");
    expect(buyout.reminderType).toBe("disabled");
    expect(buyout.reminderDays).toBe("-2");
    expect(buyout.repeatReminderEnabled).toBe(false);
  });

  it("maps manual recurring AI drafts without start dates to an optional start-date form state", () => {
    const formData = aiDraftToSubscriptionFormState(draft({
      startDate: null,
      autoCalculateNextBillingDate: null,
    }), context);

    expect(formData.startDate).toBeUndefined();
    expect(formData.nextBillingDate).toBe("2026-07-01");
    expect(formData.autoCalculate).toBe(false);
  });

  it("maps edited subscription form state back to an AI draft patch", () => {
    const patch = subscriptionFormStateToAIDraftPatch(createSubscriptionFormState({
      name: "Netflix Premium",
      price: "66",
      currency: "USD",
      billingCycle: "annual",
      category: "Cloud lab",
      status: "active",
      paymentMethod: "Personal card",
      startDate: assertDateOnly("2026-01-01"),
      nextBillingDate: assertDateOnly("2027-01-01"),
      autoCalculate: true,
      reminderType: "preset",
      reminderDays: "14",
      website: "https://www.netflix.com/",
      notes: "Netflix 是流媒体视频点播服务。",
      tags: ["Streaming", "Streaming", "  TV  "],
      repeatReminderEnabled: true,
      repeatReminderInterval: "3h",
      repeatReminderWindow: "24h",
    }), {
      website: { value: "https://www.netflix.com/", source: "suggested" },
      notes: { value: "Netflix 是影视流媒体服务。", source: "suggested" },
      trialEndDate: null,
    });

    expect(patch).toMatchObject({
      name: "Netflix Premium",
      price: "66",
      currency: "USD",
      billingCycle: "annual",
      customDays: null,
      customCycleUnit: null,
      oneTimeTermCount: null,
      oneTimeTermUnit: null,
      category: "Cloud lab",
      status: "active",
      paymentMethod: "Personal card",
      startDate: "2026-01-01",
      nextBillingDate: "2027-01-01",
      autoCalculateNextBillingDate: true,
      trialEndDate: null,
      website: { value: "https://www.netflix.com/", source: "suggested" },
      notes: { value: "Netflix 是流媒体视频点播服务。", source: "input" },
      tags: ["Streaming", "TV"],
      reminderDays: 14,
      repeatReminderEnabled: true,
      repeatReminderInterval: "3h",
      repeatReminderWindow: "24h",
    });
  });

  it("converts empty form values to nullable AI draft fields", () => {
    const patch = subscriptionFormStateToAIDraftPatch(createSubscriptionFormState({
      name: "Unknown",
      price: "",
      currency: "",
      billingCycle: "monthly",
      category: "",
      paymentMethod: "",
      website: "   ",
      notes: "",
      reminderType: "custom",
      customReminderDays: "",
    }), {
      website: null,
      notes: null,
      trialEndDate: null,
    });

    expect(patch.price).toBeNull();
    expect(patch.currency).toBeNull();
    expect(patch.category).toBeNull();
    expect(patch.paymentMethod).toBeNull();
    expect(patch.website).toBeNull();
    expect(patch.notes).toBeNull();
    expect(patch.reminderDays).toBeNull();
  });

  it("keeps trial end dates that are not represented by subscription form fields", () => {
    const patch = subscriptionFormStateToAIDraftPatch(createSubscriptionFormState({
      name: "Trial service",
      status: "trial",
      price: "10",
      currency: "USD",
      startDate: assertDateOnly("2026-01-01"),
      nextBillingDate: assertDateOnly("2026-03-01"),
    }), {
      website: null,
      notes: null,
      trialEndDate: "2026-02-01",
    });

    expect(patch.trialEndDate).toBe("2026-02-01");
  });

  it("clears repeat reminder when the edited form disables reminders", () => {
    const patch = subscriptionFormStateToAIDraftPatch(createSubscriptionFormState({
      name: "Silent service",
      reminderType: "disabled",
      reminderDays: "-2",
      repeatReminderEnabled: true,
    }), {
      website: null,
      notes: null,
      trialEndDate: null,
    });

    expect(patch.reminderDays).toBe(-2);
    expect(patch.repeatReminderEnabled).toBe(false);
  });

  it("forces edited one-time buyouts back to disabled reminders", () => {
    const patch = subscriptionFormStateToAIDraftPatch(createSubscriptionFormState({
      name: "Lifetime app",
      billingCycle: "one-time",
      oneTimeMode: "buyout",
      reminderType: "inherit",
      reminderDays: "-1",
      repeatReminderEnabled: true,
    }), {
      website: null,
      notes: null,
      trialEndDate: null,
    });

    expect(patch.reminderDays).toBe(-2);
    expect(patch.repeatReminderEnabled).toBe(false);
  });
});
