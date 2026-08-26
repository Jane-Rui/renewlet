// 订阅筛选测试保护搜索、标签 OR 语义、有效状态和月成本排序，避免列表页重写筛选规则。
import { describe, expect, it } from "vitest";
import { assertDateOnly } from "@/lib/time/date-only";
import type { Subscription } from "@/types/subscription";
import {
  subscriptionCycleFixture,
  type SubscriptionFixtureOverrides,
} from "@/test/subscription-fixtures";
import { moneyToNumber } from "@renewlet/shared/money";
import {
  DEFAULT_SUBSCRIPTION_ADVANCED_FILTERS,
  SUBSCRIPTION_PAYMENT_METHOD_NONE_VALUE,
  buildSubscriptionListFilters,
  filterSubscriptions,
  filterSubscriptionsByListFilters,
  hasActiveSubscriptionAdvancedFilters,
  hasActiveSubscriptionControls,
  hasActiveSubscriptionFilters,
  sortSubscriptions,
  type SubscriptionFilterState,
  type SubscriptionSortOption,
} from "./subscription-filters";

type SubscriptionBaseFixture = Omit<Subscription, "billingCycle" | "customDays" | "customCycleUnit" | "oneTimeTermCount" | "oneTimeTermUnit">;
type SubscriptionOverrides = SubscriptionFixtureOverrides<Subscription>;

const convert = (amount: number | string, from: string, to: string) => {
  const value = moneyToNumber(amount);
  if (from === to) return value;
  if (from === "USD" && to === "CNY") return value * 7;
  if (from === "CNY" && to === "USD") return value / 7;
  return value;
};

function subscription(overrides: SubscriptionOverrides = {}): Subscription {
  const base: SubscriptionBaseFixture = {
    id: "sub",
    name: "Service",
    logo: undefined,
    price: "10",
    currency: "USD",
    category: "productivity",
    status: "active",
    paymentMethod: undefined,
    startDate: assertDateOnly("2026-01-01"),
    nextBillingDate: assertDateOnly("2026-02-01"),
    autoRenew: true,
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
    pinned: false,
    publicHidden: false,
  };

  return {
    ...base,
    ...overrides,
    ...subscriptionCycleFixture(overrides),
  };
}

function sortIds(subscriptions: Subscription[], sortOption: SubscriptionSortOption) {
  return sortSubscriptions(subscriptions, {
    sortOption,
    defaultCurrency: "CNY",
    convert,
    locale: "en-US",
  }).map((item) => item.id);
}

describe("subscription sorting", () => {
  it("keeps the backend order for the default sort", () => {
    const subscriptions = [
      subscription({ id: "second" }),
      subscription({ id: "first" }),
    ];

    expect(sortIds(subscriptions, "default")).toEqual(["second", "first"]);
  });

  it("keeps pinned subscriptions ahead for default and field sorting", () => {
    const subscriptions = [
      subscription({ id: "regular-expensive", price: "100" }),
      subscription({ id: "pinned-cheap", price: "10", pinned: true }),
      subscription({ id: "regular-cheap", price: "1" }),
      subscription({ id: "pinned-expensive", price: "80", pinned: true }),
    ];

    expect(sortIds(subscriptions, "default")).toEqual([
      "pinned-cheap",
      "pinned-expensive",
      "regular-expensive",
      "regular-cheap",
    ]);
    expect(sortIds(subscriptions, "price_desc")).toEqual([
      "pinned-expensive",
      "pinned-cheap",
      "regular-expensive",
      "regular-cheap",
    ]);
  });

  it("sorts by renewal date while preserving tie order", () => {
    const subscriptions = [
      subscription({ id: "later", nextBillingDate: assertDateOnly("2026-04-01") }),
      subscription({ id: "soon-1", nextBillingDate: assertDateOnly("2026-01-10") }),
      subscription({ id: "soon-2", nextBillingDate: assertDateOnly("2026-01-10") }),
    ];

    expect(sortIds(subscriptions, "renewal_asc")).toEqual(["soon-1", "soon-2", "later"]);
    expect(sortIds(subscriptions, "renewal_desc")).toEqual(["later", "soon-1", "soon-2"]);
  });

  it("sorts by monthly cost after currency conversion and cycle normalization", () => {
    const subscriptions = [
      subscription({ id: "annual-usd", price: "120", currency: "USD", billingCycle: "annual" }),
      subscription({ id: "monthly-cny", price: "80", currency: "CNY", billingCycle: "monthly" }),
      subscription({ id: "quarterly-cny", price: "180", currency: "CNY", billingCycle: "quarterly" }),
    ];

    expect(sortIds(subscriptions, "monthly_cost_desc")).toEqual([
      "monthly-cny",
      "annual-usd",
      "quarterly-cny",
    ]);
    expect(sortIds(subscriptions, "monthly_cost_asc")).toEqual([
      "quarterly-cny",
      "annual-usd",
      "monthly-cny",
    ]);
  });

  it("sorts by raw single-payment price without currency or cycle normalization", () => {
    const subscriptions = [
      subscription({ id: "annual-usd", price: "120", currency: "USD", billingCycle: "annual" }),
      subscription({ id: "monthly-cny", price: "80", currency: "CNY", billingCycle: "monthly" }),
      subscription({ id: "quarterly-cny", price: "180", currency: "CNY", billingCycle: "quarterly" }),
    ];

    expect(sortIds(subscriptions, "price_desc")).toEqual([
      "quarterly-cny",
      "annual-usd",
      "monthly-cny",
    ]);
    expect(sortIds(subscriptions, "price_asc")).toEqual([
      "monthly-cny",
      "annual-usd",
      "quarterly-cny",
    ]);
  });

  it("sorts names with a locale-aware numeric collator", () => {
    const subscriptions = [
      subscription({ id: "alpha-10", name: "Alpha 10" }),
      subscription({ id: "beta", name: "Beta" }),
      subscription({ id: "alpha-2", name: "Alpha 2" }),
    ];

    expect(sortIds(subscriptions, "name_asc")).toEqual(["alpha-2", "alpha-10", "beta"]);
    expect(sortIds(subscriptions, "name_desc")).toEqual(["beta", "alpha-10", "alpha-2"]);
  });
});

describe("subscription filter state", () => {
  const emptyFilters: SubscriptionFilterState = {
    searchQuery: "",
    selectedCategories: [],
    statusFilter: "all",
    renewalFilter: "all",
    selectedTags: [],
  };

  it("keeps sort separate from filtered-count state but includes it in clearable controls", () => {
    expect(hasActiveSubscriptionFilters(emptyFilters)).toBe(false);
    expect(hasActiveSubscriptionAdvancedFilters(DEFAULT_SUBSCRIPTION_ADVANCED_FILTERS)).toBe(false);
    expect(hasActiveSubscriptionControls(emptyFilters, "default")).toBe(false);
    expect(hasActiveSubscriptionControls(emptyFilters, "monthly_cost_desc")).toBe(true);
    expect(hasActiveSubscriptionControls(emptyFilters, "default", {
      ...DEFAULT_SUBSCRIPTION_ADVANCED_FILTERS,
      pinnedFilter: "yes",
    })).toBe(true);

    expect(hasActiveSubscriptionFilters({ ...emptyFilters, searchQuery: "cloud" })).toBe(true);
    expect(hasActiveSubscriptionFilters({ ...emptyFilters, selectedCategories: ["finance"] })).toBe(true);
  });

  it("maps basic and advanced filters to product API query filters", () => {
    expect(buildSubscriptionListFilters(emptyFilters)).toBeUndefined();
    expect(buildSubscriptionListFilters(
      {
        searchQuery: "  cursor  ",
        selectedCategories: ["productivity", "finance"],
        statusFilter: "active",
        renewalFilter: "auto",
        selectedTags: ["Team"],
      },
      {
        selectedBillingCycles: ["monthly"],
        selectedPaymentMethods: ["paypal", SUBSCRIPTION_PAYMENT_METHOD_NONE_VALUE],
        selectedCurrencies: ["USD"],
        nextBillingFrom: "2999-08-01",
        nextBillingTo: "2999-08-31",
        pinnedFilter: "yes",
        publicHiddenFilter: "no",
        reminderModeFilter: "custom",
        repeatReminderFilter: "yes",
      },
    )).toEqual({
      q: "cursor",
      category: ["productivity", "finance"],
      tag: ["Team"],
      status: "active",
      renewal: "auto",
      billingCycle: ["monthly"],
      paymentMethod: ["paypal", "__none"],
      currency: ["USD"],
      nextBillingFrom: "2999-08-01",
      nextBillingTo: "2999-08-31",
      pinned: true,
      publicHidden: false,
      reminderMode: "custom",
      repeatReminder: true,
    });
  });

  it("replays the complete collection query when selecting full DTOs for CSV export", () => {
    const matching = subscription({
      id: "matching",
      name: "Team Mail",
      paymentMethod: undefined,
      reminderDays: -2,
      repeatReminderEnabled: false,
    });
    const unrelated = subscription({
      id: "unrelated",
      name: "Team Mail Archive",
      paymentMethod: "paypal",
      publicHidden: true,
      reminderDays: 7,
      repeatReminderEnabled: true,
    });

    expect(filterSubscriptionsByListFilters([matching, unrelated], {
      q: "team mail",
      billingCycle: ["monthly"],
      paymentMethod: [SUBSCRIPTION_PAYMENT_METHOD_NONE_VALUE],
      currency: ["USD"],
      nextBillingFrom: assertDateOnly("2026-01-01"),
      nextBillingTo: assertDateOnly("2026-12-31"),
      pinned: false,
      publicHidden: false,
      reminderMode: "disabled",
      repeatReminder: false,
    }, { today: assertDateOnly("2026-01-01") }).map((item) => item.id)).toEqual(["matching"]);
  });

  it("filters multiple categories with OR semantics", () => {
    const subscriptions = [
      subscription({ id: "docs", category: "productivity" }),
      subscription({ id: "budget", category: "finance" }),
      subscription({ id: "music", category: "music" }),
    ];
    const context = { today: assertDateOnly("2026-05-18") };

    expect(filterSubscriptions(subscriptions, emptyFilters, context).map((item) => item.id)).toEqual([
      "docs",
      "budget",
      "music",
    ]);
    expect(
      filterSubscriptions(
        subscriptions,
        { ...emptyFilters, selectedCategories: ["productivity", "finance"] },
        context,
      ).map((item) => item.id),
    ).toEqual(["docs", "budget"]);
  });

  it("filters by effective expired status for legacy active subscriptions", () => {
    const subscriptions = [
      subscription({ id: "legacy-overdue", status: "active", nextBillingDate: assertDateOnly("2026-05-15") }),
      subscription({ id: "active-future", status: "active", nextBillingDate: assertDateOnly("2026-05-20") }),
      subscription({ id: "stored-expired", status: "expired", nextBillingDate: assertDateOnly("2026-05-20") }),
      subscription({ id: "paused-overdue", status: "paused", nextBillingDate: assertDateOnly("2026-05-15") }),
    ];

    const expired = filterSubscriptions(
      subscriptions,
      { ...emptyFilters, statusFilter: "expired" },
      { today: assertDateOnly("2026-05-18") },
    );
    const active = filterSubscriptions(
      subscriptions,
      { ...emptyFilters, statusFilter: "active" },
      { today: assertDateOnly("2026-05-18") },
    );

    expect(expired.map((item) => item.id)).toEqual(["legacy-overdue", "stored-expired"]);
    expect(active.map((item) => item.id)).toEqual(["active-future"]);
  });

  it("filters by renewal type without relying on color-only status", () => {
    const subscriptions = [
      subscription({ id: "auto", billingCycle: "monthly", autoRenew: true }),
      subscription({ id: "manual", billingCycle: "monthly", autoRenew: false }),
      subscription({ id: "one-time", billingCycle: "one-time", autoRenew: false }),
    ];
    const context = { today: assertDateOnly("2026-05-18") };

    expect(filterSubscriptions(subscriptions, { ...emptyFilters, renewalFilter: "auto" }, context).map((item) => item.id)).toEqual(["auto"]);
    expect(filterSubscriptions(subscriptions, { ...emptyFilters, renewalFilter: "manual" }, context).map((item) => item.id)).toEqual(["manual"]);
    expect(filterSubscriptions(subscriptions, { ...emptyFilters, renewalFilter: "one-time" }, context).map((item) => item.id)).toEqual(["one-time"]);
  });
});
