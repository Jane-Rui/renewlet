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

describe("cost sharing collection reminder contract", () => {
  const costSharing = {
    enabled: true,
    splitMode: "equal",
    members: [{ id: "partner", name: "Partner", currency: "USD" }],
  } as const;

  it("keeps old cost sharing payloads compatible", () => {
    const parsed = subscriptionCreateBodySchema.parse({
      ...recurringBody,
      costSharing,
    });

    expect(parsed.costSharing).toEqual(costSharing);
  });

  it("accepts collection reminders with inherited or custom days", () => {
    expect(subscriptionCreateBodySchema.parse({
      ...recurringBody,
      startDate: "2026-01-01",
      costSharing: {
        ...costSharing,
        collectionReminder: { enabled: true, reminderDays: -1 },
      },
    }).costSharing?.collectionReminder).toEqual({ enabled: true, reminderDays: -1 });

    expect(subscriptionCreateBodySchema.parse({
      ...recurringBody,
      startDate: "2026-01-01",
      costSharing: {
        ...costSharing,
        collectionReminder: { enabled: true, reminderDays: 0 },
      },
    }).costSharing?.collectionReminder).toEqual({ enabled: true, reminderDays: 0 });
  });

  it("rejects the removed collection interval field", () => {
    expect(subscriptionCreateBodySchema.safeParse({
      ...recurringBody,
      startDate: "2026-01-01",
      costSharing: {
        ...costSharing,
        collectionReminder: { enabled: true, intervalMonths: 3, reminderDays: -1 },
      },
    }).success).toBe(false);
  });

  it("rejects disabled reminder sentinel for collection reminders", () => {
    expect(subscriptionCreateBodySchema.safeParse({
      ...recurringBody,
      startDate: "2026-01-01",
      costSharing: {
        ...costSharing,
        collectionReminder: { enabled: true, reminderDays: -2 },
      },
    }).success).toBe(false);
  });

  it("rejects invalid member joined dates", () => {
    expect(subscriptionCreateBodySchema.safeParse({
      ...recurringBody,
      costSharing: {
        ...costSharing,
        members: [{ id: "partner", name: "Partner", joinedDate: "2026/01/01" }],
      },
    }).success).toBe(false);
  });

  it("requires member joined dates when collection reminders are enabled without a subscription start date", () => {
    expect(subscriptionCreateBodySchema.safeParse({
      ...recurringBody,
      startDate: null,
      costSharing: {
        ...costSharing,
        collectionReminder: { enabled: true, reminderDays: -1 },
      },
    }).success).toBe(false);

    expect(subscriptionCreateBodySchema.parse({
      ...recurringBody,
      startDate: null,
      costSharing: {
        ...costSharing,
        members: [{ id: "partner", name: "Partner", joinedDate: "2026-01-01" }],
        collectionReminder: { enabled: true, reminderDays: -1 },
      },
    }).costSharing?.members[0]?.joinedDate).toBe("2026-01-01");
  });

  it("rejects enabled collection reminders when cost sharing is disabled", () => {
    expect(subscriptionCreateBodySchema.safeParse({
      ...recurringBody,
      startDate: "2026-01-01",
      costSharing: {
        ...costSharing,
        enabled: false,
        collectionReminder: { enabled: true, reminderDays: -1 },
      },
    }).success).toBe(false);
  });

  it("rejects collection reminders for one-time buyouts while accepting fixed-term one-time records", () => {
    const collectionCostSharing = {
      ...costSharing,
      collectionReminder: { enabled: true, reminderDays: -1 },
    };

    expect(subscriptionCreateBodySchema.safeParse({
      ...recurringBody,
      billingCycle: "one-time",
      startDate: "2026-01-01",
      nextBillingDate: "2026-01-01",
      autoCalculateNextBillingDate: false,
      costSharing: collectionCostSharing,
    }).success).toBe(false);

    expect(subscriptionCreateBodySchema.safeParse({
      ...recurringBody,
      billingCycle: "one-time",
      startDate: "2026-01-01",
      nextBillingDate: "2026-04-01",
      autoCalculateNextBillingDate: false,
      oneTimeTermCount: 3,
      oneTimeTermUnit: "month",
      costSharing: collectionCostSharing,
    }).success).toBe(true);
  });

  it("rejects member joined dates outside the subscription date range", () => {
    expect(subscriptionCreateBodySchema.safeParse({
      ...recurringBody,
      startDate: "2026-01-10",
      nextBillingDate: "2026-02-10",
      costSharing: {
        ...costSharing,
        members: [{ id: "partner", name: "Partner", joinedDate: "2026-01-09" }],
      },
    }).success).toBe(false);

    expect(subscriptionCreateBodySchema.safeParse({
      ...recurringBody,
      startDate: "2026-01-10",
      nextBillingDate: "2026-02-10",
      costSharing: {
        ...costSharing,
        members: [{ id: "partner", name: "Partner", joinedDate: "2026-02-11" }],
      },
    }).success).toBe(false);

    expect(subscriptionCreateBodySchema.safeParse({
      ...recurringBody,
      startDate: "2026-01-10",
      nextBillingDate: "2026-02-10",
      costSharing: {
        ...costSharing,
        members: [{ id: "partner", name: "Partner", joinedDate: "2026-01-10" }],
      },
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
