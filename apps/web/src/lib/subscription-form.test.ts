// subscription-form 测试保护表单输入到 SubscriptionDraft 的转换边界，特别是数字、标签、URL 和 DateOnly 校验。
import { describe, expect, it } from "vitest";
import {
  getTagsValidationError,
  getSubscriptionDraftValidationError,
  isOptionalHttpUrl,
  normalizeTagsArray,
  parseMoneyInput,
  parseNonNegativeIntegerInput,
  parseTagsInput,
  toSubscriptionDraft,
} from "./subscription-form";
import { createSubscriptionFormState } from "@/types/subscription-form";
import { assertDateOnly } from "@/lib/time/date-only";

describe("subscription-form", () => {
  it("parses tags across supported separators and removes blanks", () => {
    expect(parseTagsInput("AI、工具, 生产力；\n年度;;")).toEqual(["AI", "工具", "生产力", "年度"]);
  });

  it("normalizes tag arrays with trimming and exact-text de-duplication", () => {
    expect(normalizeTagsArray([" AI ", "AI", "ai", "", "  工具  "])).toEqual(["AI", "ai", "工具"]);
  });

  it("builds an empty tags array when the tags input is blank", () => {
    const form = createSubscriptionFormState({
      name: "Aws",
      price: "15",
      currency: "USD",
      startDate: assertDateOnly("2026-05-14"),
      nextBillingDate: assertDateOnly("2026-06-14"),
      tags: [],
    });

    expect(toSubscriptionDraft(form)?.tags).toEqual([]);
  });

  it("validates the high protective tag limits", () => {
    expect(getTagsValidationError(Array.from({ length: 100 }, (_, index) => `tag-${index}`))).toBeNull();
    expect(getTagsValidationError(Array.from({ length: 101 }, (_, index) => `tag-${index}`))).toContain("100");
    expect(getTagsValidationError(["a".repeat(40)])).toBeNull();
    expect(getTagsValidationError(["a".repeat(41)])).toContain("40");
  });

  it("rejects loose numeric prefixes, Infinity, NaN and negative prices", () => {
    expect(parseMoneyInput("0")).toBe("0");
    expect(parseMoneyInput("0.00")).toBe("0");
    expect(parseMoneyInput("12.5")).toBe("12.5");
    expect(parseMoneyInput(".5")).toBe("0.5");
    expect(parseMoneyInput("12abc")).toBeNull();
    expect(parseMoneyInput("Infinity")).toBeNull();
    expect(parseMoneyInput("NaN")).toBeNull();
    expect(parseMoneyInput("-1")).toBeNull();
    expect(parseMoneyInput("1000000001")).toBeNull();
    expect(parseMoneyInput("1.0000001")).toBeNull();
    expect(parseMoneyInput("1e3")).toBeNull();
  });

  it("accepts only integer reminder/custom day inputs", () => {
    expect(parseNonNegativeIntegerInput("0")).toBe(0);
    expect(parseNonNegativeIntegerInput("3")).toBe(3);
    expect(parseNonNegativeIntegerInput("3.5")).toBeNull();
    expect(parseNonNegativeIntegerInput("3days")).toBeNull();
    expect(parseNonNegativeIntegerInput("-1")).toBeNull();
    expect(parseNonNegativeIntegerInput("3651")).toBeNull();
  });

  it("accepts only blank or HTTP(S) optional URLs", () => {
    expect(isOptionalHttpUrl("")).toBe(true);
    expect(isOptionalHttpUrl("   ")).toBe(true);
    expect(isOptionalHttpUrl(undefined)).toBe(true);
    expect(isOptionalHttpUrl("https://example.com")).toBe(true);
    expect(isOptionalHttpUrl("http://example.com/path")).toBe(true);
    expect(isOptionalHttpUrl("ftp://example.com")).toBe(false);
    expect(isOptionalHttpUrl("not a url")).toBe(false);
  });

  it("returns null draft and a clear error for invalid price", () => {
    const form = createSubscriptionFormState({
      name: "Netflix",
      price: "1abc",
      startDate: assertDateOnly("2026-01-01"),
      nextBillingDate: assertDateOnly("2026-02-01"),
    });

    expect(getSubscriptionDraftValidationError(form)).toContain("金额");
    expect(toSubscriptionDraft(form)).toBeNull();
  });

  it("builds a draft for zero-price services", () => {
    const form = createSubscriptionFormState({
      name: "Free service",
      price: "0",
      startDate: assertDateOnly("2026-01-01"),
      nextBillingDate: assertDateOnly("2026-02-01"),
    });

    expect(toSubscriptionDraft(form)).toMatchObject({ price: "0" });
  });

  it("rejects renewal dates before the start date", () => {
    const form = createSubscriptionFormState({
      name: "Backdated service",
      price: "10",
      startDate: assertDateOnly("2026-05-14"),
      nextBillingDate: assertDateOnly("2026-05-13"),
    });

    expect(getSubscriptionDraftValidationError(form)).toBe("到期日期不能早于开始日期");
    expect(toSubscriptionDraft(form)).toBeNull();
  });

  it("allows renewal dates on the same day as the start date", () => {
    const form = createSubscriptionFormState({
      name: "Same-day service",
      price: "10",
      startDate: assertDateOnly("2026-05-14"),
      nextBillingDate: assertDateOnly("2026-05-14"),
    });

    expect(getSubscriptionDraftValidationError(form)).toBeNull();
    expect(toSubscriptionDraft(form)).toMatchObject({
      startDate: "2026-05-14",
      nextBillingDate: "2026-05-14",
    });
  });

  it("builds a draft only when custom cycle and reminder values are strict integers", () => {
    const valid = createSubscriptionFormState({
      name: "Server",
      price: "19.99",
      billingCycle: "custom",
      customDays: "45",
      customCycleUnit: "year",
      reminderType: "custom",
      customReminderDays: "0",
      startDate: assertDateOnly("2026-01-01"),
      nextBillingDate: assertDateOnly("2026-02-15"),
    });

    expect(toSubscriptionDraft(valid)).toMatchObject({
      price: "19.99",
      customDays: 45,
      customCycleUnit: "year",
      reminderDays: 0,
      autoCalculateNextBillingDate: false,
    });

    expect(toSubscriptionDraft({ ...valid, customDays: "45.5" })).toBeNull();
    expect(toSubscriptionDraft({ ...valid, customReminderDays: "1day" })).toBeNull();
  });

  it("uses inherited reminders for new subscription drafts by default", () => {
    const form = createSubscriptionFormState({
      name: "Inherited Reminder",
      price: "10",
      startDate: assertDateOnly("2026-01-01"),
      nextBillingDate: assertDateOnly("2026-02-01"),
    });

    expect(form.reminderType).toBe("inherit");
    expect(toSubscriptionDraft(form)).toMatchObject({
      reminderDays: -1,
    });
  });

  it("keeps auto renewal disabled by default but preserves explicit user opt-in", () => {
    const base = createSubscriptionFormState({
      name: "Manual Renewal",
      price: "10",
      startDate: assertDateOnly("2026-01-01"),
      nextBillingDate: assertDateOnly("2026-02-01"),
    });

    expect(base.autoRenew).toBe(false);
    expect(toSubscriptionDraft(base)).toMatchObject({ autoRenew: false });
    expect(toSubscriptionDraft({ ...base, autoRenew: true })).toMatchObject({ autoRenew: true });
  });

  it("saves disabled reminders and turns off repeat reminders in drafts", () => {
    const form = createSubscriptionFormState({
      name: "Quiet Reminder",
      price: "10",
      startDate: assertDateOnly("2026-01-01"),
      nextBillingDate: assertDateOnly("2026-02-01"),
      reminderType: "disabled",
      reminderDays: "-2",
      repeatReminderEnabled: true,
    });

    expect(toSubscriptionDraft(form)).toMatchObject({
      reminderDays: -2,
      repeatReminderEnabled: false,
    });
  });

  it("preserves the auto-calculate switch in the draft", () => {
    const base = createSubscriptionFormState({
      name: "Manual renewal",
      price: "10",
      startDate: assertDateOnly("2026-01-01"),
      nextBillingDate: assertDateOnly("2026-03-15"),
    });

    expect(toSubscriptionDraft({ ...base, autoCalculate: true })?.autoCalculateNextBillingDate).toBe(true);
    expect(toSubscriptionDraft({ ...base, autoCalculate: false })?.autoCalculateNextBillingDate).toBe(false);
  });

  it("allows recurring subscriptions to omit start date when the next billing date is known", () => {
    const form = createSubscriptionFormState({
      name: "QQ Music",
      price: "18",
      startDate: undefined,
      nextBillingDate: assertDateOnly("2026-08-01"),
      autoCalculate: false,
    });

    expect(getSubscriptionDraftValidationError(form)).toBeNull();
    expect(toSubscriptionDraft(form)).toMatchObject({
      billingCycle: "monthly",
      startDate: null,
      nextBillingDate: "2026-08-01",
      autoCalculateNextBillingDate: false,
    });
  });

  it("requires start date when automatic date calculation is enabled", () => {
    const form = createSubscriptionFormState({
      name: "Auto anchor",
      price: "18",
      startDate: undefined,
      nextBillingDate: assertDateOnly("2026-08-01"),
      autoCalculate: true,
    });

    expect(getSubscriptionDraftValidationError(form)).toBe("开启自动计算时需要开始日期");
    expect(toSubscriptionDraft(form)).toBeNull();
  });

  it("saves one-time purchases without auto-calculation or custom days", () => {
    const form = createSubscriptionFormState({
      name: "Lifetime license",
      price: "199",
      billingCycle: "one-time",
      autoCalculate: true,
      customDays: "30",
      startDate: assertDateOnly("2026-05-14"),
      nextBillingDate: undefined,
      reminderType: "inherit",
      reminderDays: "-1",
      repeatReminderEnabled: true,
    });

    expect(form.oneTimeMode).toBe("buyout");
    expect(getSubscriptionDraftValidationError(form)).toBeNull();
    expect(toSubscriptionDraft(form)).toMatchObject({
      billingCycle: "one-time",
      nextBillingDate: "2026-05-14",
      customDays: undefined,
      customCycleUnit: undefined,
      oneTimeTermCount: undefined,
      oneTimeTermUnit: undefined,
      autoCalculateNextBillingDate: false,
      reminderDays: -2,
      repeatReminderEnabled: false,
    });
  });

  it("saves one-time fixed terms with an auto-calculated expiry date", () => {
    const form = createSubscriptionFormState({
      name: "Discounted membership",
      price: "120",
      billingCycle: "one-time",
      oneTimeMode: "term",
      oneTimeTermCount: "6",
      oneTimeTermUnit: "month",
      autoCalculate: true,
      startDate: assertDateOnly("2026-05-14"),
      nextBillingDate: undefined,
    });

    expect(getSubscriptionDraftValidationError(form)).toBeNull();
    expect(toSubscriptionDraft(form)).toMatchObject({
      billingCycle: "one-time",
      nextBillingDate: "2026-11-14",
      oneTimeTermCount: 6,
      oneTimeTermUnit: "month",
      autoCalculateNextBillingDate: false,
    });
  });

  it("requires a positive service duration for one-time fixed terms", () => {
    const form = createSubscriptionFormState({
      name: "Broken membership",
      price: "120",
      billingCycle: "one-time",
      oneTimeMode: "term",
      oneTimeTermCount: "0",
      startDate: assertDateOnly("2026-05-14"),
    });

    expect(getSubscriptionDraftValidationError(form)).toBe("服务时长必须是 1 到 3650 之间的整数");
    expect(toSubscriptionDraft(form)).toBeNull();
  });

  it("still requires purchase date for one-time subscriptions", () => {
    const form = createSubscriptionFormState({
      name: "Lifetime license",
      price: "199",
      billingCycle: "one-time",
      startDate: undefined,
      nextBillingDate: undefined,
    });

    expect(getSubscriptionDraftValidationError(form)).toBe("请选择购买日期");
    expect(toSubscriptionDraft(form)).toBeNull();
  });

  it("keeps repeat reminder presets in the draft", () => {
    const form = createSubscriptionFormState({
      name: "Critical SaaS",
      price: "99",
      startDate: assertDateOnly("2026-05-14"),
      nextBillingDate: assertDateOnly("2026-05-17"),
      repeatReminderEnabled: true,
      repeatReminderInterval: "3h",
      repeatReminderWindow: "full",
    });

    expect(toSubscriptionDraft(form)).toMatchObject({
      repeatReminderEnabled: true,
      repeatReminderInterval: "3h",
      repeatReminderWindow: "full",
    });
  });

  it("keeps valid custom cost sharing drafts with member currencies", () => {
    const form = createSubscriptionFormState({
      name: "Family Plan",
      price: "100",
      currency: "USD",
      startDate: assertDateOnly("2026-01-01"),
      nextBillingDate: assertDateOnly("2026-02-01"),
      costSharing: {
        enabled: true,
        splitMode: "custom",
        members: [
          { id: "partner", name: "Partner", currency: "USD", customAmount: "40" },
          { id: "child", name: "Child", currency: "CNY", customAmount: "420" },
        ],
      },
    });

    expect(getSubscriptionDraftValidationError(form)).toBeNull();
    expect(toSubscriptionDraft(form)?.costSharing).toEqual(form.costSharing);
  });

  it("allows custom cost sharing totals to differ from the subscription price", () => {
    const form = createSubscriptionFormState({
      name: "Broken Family Plan",
      price: "100",
      currency: "USD",
      startDate: assertDateOnly("2026-01-01"),
      nextBillingDate: assertDateOnly("2026-02-01"),
      costSharing: {
        enabled: true,
        splitMode: "custom",
        members: [
          { id: "partner", name: "Partner", currency: "USD", customAmount: "40" },
          { id: "child", name: "Child", currency: "USD", customAmount: "50" },
        ],
      },
    });

    expect(getSubscriptionDraftValidationError(form)).toBeNull();
    expect(toSubscriptionDraft(form)?.costSharing).toEqual(form.costSharing);
  });
});
