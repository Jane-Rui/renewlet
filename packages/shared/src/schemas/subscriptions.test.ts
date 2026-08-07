import { describe, expect, it } from "vitest";
import {
  SUBSCRIPTION_PAYMENT_METHOD_NONE,
  apiSubscriptionSchema,
  subscriptionCreateBodySchema,
  subscriptionsListQuerySchema,
} from "./subscriptions";

const recurringBody = {
  name: "QQ Music",
  logo: null,
  price: "15",
  currency: "CNY",
  billingCycle: "monthly",
  customDays: null,
  customCycleUnit: null,
  category: "entertainment",
  status: "active",
  pinned: false,
  publicHidden: false,
  paymentMethod: null,
  startDate: null,
  nextBillingDate: "2026-07-01",
  autoRenew: false,
  autoCalculateNextBillingDate: false,
  trialEndDate: null,
  website: null,
  notes: null,
  tags: [],
  reminderDays: -1,
  repeatReminderEnabled: false,
  repeatReminderInterval: "1h",
  repeatReminderWindow: "72h",
};

const recurringResponse = {
  id: "sub_qq_music",
  name: recurringBody.name,
  price: recurringBody.price,
  currency: recurringBody.currency,
  billingCycle: recurringBody.billingCycle,
  category: recurringBody.category,
  status: recurringBody.status,
  pinned: recurringBody.pinned,
  publicHidden: recurringBody.publicHidden,
  startDate: recurringBody.startDate,
  nextBillingDate: recurringBody.nextBillingDate,
  autoRenew: recurringBody.autoRenew,
  autoCalculateNextBillingDate: recurringBody.autoCalculateNextBillingDate,
  tags: recurringBody.tags,
  reminderDays: recurringBody.reminderDays,
  repeatReminderEnabled: recurringBody.repeatReminderEnabled,
  repeatReminderInterval: recurringBody.repeatReminderInterval,
  repeatReminderWindow: recurringBody.repeatReminderWindow,
};

describe("subscription start date contract", () => {
  it("accepts recurring subscriptions without a known start date", () => {
    expect(subscriptionCreateBodySchema.parse(recurringBody).startDate).toBeNull();
    expect(apiSubscriptionSchema.parse(recurringResponse).startDate).toBeNull();
  });

  it("rejects non date-only response renewal and trial dates", () => {
    expect(apiSubscriptionSchema.safeParse({
      ...recurringResponse,
      nextBillingDate: "2026-07-01T00:00:00Z",
    }).success).toBe(false);

    expect(apiSubscriptionSchema.safeParse({
      ...recurringResponse,
      trialEndDate: "2026/07/01",
    }).success).toBe(false);
  });

  it("requires start date when automatic billing date calculation is enabled", () => {
    expect(subscriptionCreateBodySchema.safeParse({
      ...recurringBody,
      autoCalculateNextBillingDate: true,
    }).success).toBe(false);
  });

  it("keeps one-time subscriptions tied to a real purchase or service start date", () => {
    expect(subscriptionCreateBodySchema.safeParse({
      ...recurringBody,
      billingCycle: "one-time",
      autoCalculateNextBillingDate: false,
    }).success).toBe(false);

    expect(subscriptionCreateBodySchema.safeParse({
      ...recurringBody,
      billingCycle: "one-time",
      startDate: "2026-06-01",
      autoCalculateNextBillingDate: false,
    }).success).toBe(true);
  });
});

describe("subscriptions list query contract", () => {
  it("accepts repeated custom filter values and strict boolean query strings", () => {
    const query = subscriptionsListQuerySchema.parse({
      limit: "25",
      q: " cloud ",
      category: ["productivity", "developer_tools"],
      tag: ["AI"],
      billingCycle: ["monthly", "annual"],
      paymentMethod: [SUBSCRIPTION_PAYMENT_METHOD_NONE, "paypal"],
      currency: ["USD", "CNY"],
      status: "active",
      renewal: "auto",
      nextBillingFrom: "2026-07-01",
      nextBillingTo: "2026-12-31",
      pinned: "false",
      publicHidden: "1",
      reminderMode: "custom",
      repeatReminder: "true",
    });

    expect(query).toMatchObject({
      limit: 25,
      q: "cloud",
      pinned: false,
      publicHidden: true,
      repeatReminder: true,
    });
  });

  it("rejects invalid custom filter query values", () => {
    expect(subscriptionsListQuerySchema.safeParse({ pinned: "nope" }).success).toBe(false);
    expect(subscriptionsListQuerySchema.safeParse({ currency: ["usd"] }).success).toBe(false);
    expect(subscriptionsListQuerySchema.safeParse({ billingCycle: ["forever"] }).success).toBe(false);
    expect(subscriptionsListQuerySchema.safeParse({
      nextBillingFrom: "2026-12-31",
      nextBillingTo: "2026-01-01",
    }).success).toBe(false);
  });
});
