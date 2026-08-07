// 订阅 service 测试保护产品 API DTO 进入前端 domain 前的运行时校验边界。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiSubscription } from "@/lib/api/schemas/subscriptions";
import { fromApiSubscription, subscriptionService, toSubscriptionWritePayload } from "./subscription-service";

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  getCurrentUserId: vi.fn(() => "user_1"),
}));

vi.mock("@/lib/api-client", () => ({
  apiFetch: mocks.apiFetch,
}));

vi.mock("@/lib/pocketbase", () => ({
  pb: {
    lang: "zh-CN",
    beforeSend: undefined,
  },
  getCurrentUserId: mocks.getCurrentUserId,
}));

const legacyPocketBaseRow = {
  collectionId: "subscriptions",
  collectionName: "subscriptions",
  id: "sub_legacy",
  name: "Perplexity Pro",
  logo: "https://example.com/perplexity.svg",
  price: "20",
  currency: "USD",
  billingCycle: "monthly",
  customDays: 0,
  customCycleUnit: "",
  category: "ai_tools",
  status: "active",
  pinned: false,
  publicHidden: false,
  paymentMethod: "apple_pay",
  startDate: "2026-02-03",
  nextBillingDate: "2026-05-29",
  autoCalculateNextBillingDate: false,
  trialEndDate: "",
  website: "https://www.perplexity.ai/",
  notes: "Demo data",
  tags: ["AI", "Search"],
  reminderDays: 7,
  repeatReminderEnabled: false,
  repeatReminderInterval: "1h",
  repeatReminderWindow: "72h",
  created: "2026-06-04 23:43:33.958Z",
  updated: "2026-06-04 23:43:33.958Z",
};

const apiSubscription = {
  id: "sub_api",
  name: "API Subscription",
  price: "12",
  currency: "USD",
  billingCycle: "monthly",
  category: "productivity",
  status: "active",
  pinned: false,
  publicHidden: false,
  startDate: "2026-01-01",
  nextBillingDate: "2026-02-01",
  autoRenew: false,
  autoCalculateNextBillingDate: true,
  tags: ["api"],
  reminderDays: 3,
  repeatReminderEnabled: false,
  repeatReminderInterval: "1h",
  repeatReminderWindow: "72h",
  extra: {},
} satisfies ApiSubscription;

beforeEach(() => {
  mocks.apiFetch.mockReset();
  mocks.getCurrentUserId.mockReturnValue("user_1");
});

describe("subscription service normalization", () => {
  it("rejects legacy PocketBase records at the product API boundary", () => {
    expect(() => fromApiSubscription(legacyPocketBaseRow as unknown as typeof apiSubscription)).toThrow();
  });

  it("ignores custom fields on fixed product API cycles", () => {
    const subscription = fromApiSubscription({
      ...apiSubscription,
      customDays: 45,
      customCycleUnit: "year",
    });

    expect(subscription).toMatchObject({
      billingCycle: "monthly",
      customDays: undefined,
      customCycleUnit: undefined,
      name: "API Subscription",
    });
  });

  it("defaults custom product API rows without a unit to day", () => {
    const subscription = fromApiSubscription({
      ...apiSubscription,
      billingCycle: "custom",
      customDays: 45,
    });

    expect(subscription).toMatchObject({
      billingCycle: "custom",
      customDays: 45,
      customCycleUnit: "day",
    });
  });

  it("keeps supported custom cycle units", () => {
    const subscription = fromApiSubscription({
      ...apiSubscription,
      billingCycle: "custom",
      customDays: 3,
      customCycleUnit: "year",
    });

    expect(subscription).toMatchObject({
      billingCycle: "custom",
      customDays: 3,
      customCycleUnit: "year",
    });
  });

  it("passes the current-user-payer cost sharing shape through the service boundary", () => {
    const subscription = fromApiSubscription({
      ...apiSubscription,
      price: "100",
      costSharing: {
        enabled: true,
        splitMode: "custom",
        members: [
          { id: "partner", name: "Partner", customAmount: "40" },
          { id: "child", name: "Child", customAmount: "60" },
        ],
      },
    });
    const payload = toSubscriptionWritePayload(subscription);

    expect(payload.costSharing).toEqual(subscription.costSharing);
    expect(toSubscriptionWritePayload(fromApiSubscription(apiSubscription)).costSharing).toBeNull();
  });

  it("parses and writes nullable start dates for manual recurring subscriptions", () => {
    const subscription = fromApiSubscription({
      ...apiSubscription,
      startDate: null,
      autoCalculateNextBillingDate: false,
    });
    const payload = toSubscriptionWritePayload(subscription);

    expect(subscription.startDate).toBeNull();
    expect(payload.startDate).toBeNull();
    expect(payload.autoCalculateNextBillingDate).toBe(false);
  });
});

describe("subscription service API calls", () => {
  it("lists subscriptions through the Renewlet product API", async () => {
    mocks.apiFetch.mockResolvedValue({
      subscriptions: [apiSubscription],
      nextCursor: "next",
      total: 1,
    });

    const page = await subscriptionService.listPage("cursor", 25);

    expect(mocks.apiFetch).toHaveBeenCalledWith("/api/app/subscriptions?limit=25&cursor=cursor", expect.anything());
    expect(page.subscriptions).toHaveLength(1);
    expect(page.nextCursor).toBe("next");
  });

  it("serializes custom list filters as repeated product API query params", async () => {
    mocks.apiFetch.mockResolvedValue({
      subscriptions: [],
      nextCursor: null,
      total: 0,
    });

    await subscriptionService.listPage(null, 25, {
      q: "cursor",
      category: ["developer_tools", "ai"],
      tag: ["Team"],
      billingCycle: ["monthly"],
      paymentMethod: ["paypal", "__none"],
      currency: ["USD"],
      status: "active",
      renewal: "auto",
      nextBillingFrom: "2999-08-01",
      nextBillingTo: "2999-08-31",
      pinned: true,
      publicHidden: false,
      reminderMode: "custom",
      repeatReminder: true,
    });

    expect(mocks.apiFetch).toHaveBeenCalledWith(
      "/api/app/subscriptions?limit=25&q=cursor&category=developer_tools&category=ai&tag=Team&billingCycle=monthly&paymentMethod=paypal&paymentMethod=__none&currency=USD&status=active&renewal=auto&nextBillingFrom=2999-08-01&nextBillingTo=2999-08-31&pinned=true&publicHidden=false&reminderMode=custom&repeatReminder=true",
      expect.anything(),
    );
  });

  it("stops aggregate listing when the backend repeats a subscription cursor", async () => {
    const firstPageUrl = "/api/app/subscriptions?limit=50";
    const repeatedCursorUrl = "/api/app/subscriptions?limit=50&cursor=repeat";
    mocks.apiFetch.mockImplementation(async (input: string) => {
      if (input === firstPageUrl) {
        return {
          subscriptions: [apiSubscription],
          nextCursor: "repeat",
          total: 2,
        };
      }
      if (input === repeatedCursorUrl) {
        return {
          subscriptions: [{ ...apiSubscription, id: "sub_api_2", name: "Second API Subscription" }],
          nextCursor: "repeat",
          total: 2,
        };
      }
      throw new Error(`UNEXPECTED_SUBSCRIPTION_LIST_REQUEST:${input}`);
    });

    try {
      await subscriptionService.list();
      throw new Error("Expected repeated cursor guard to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("SUBSCRIPTION_CURSOR_REPEATED");
    }

    expect(mocks.apiFetch).toHaveBeenCalledTimes(2);
    expect(mocks.apiFetch.mock.calls[0]?.[0]).toBe(firstPageUrl);
    expect(mocks.apiFetch.mock.calls[1]?.[0]).toBe(repeatedCursorUrl);
  });

  it("creates and updates subscriptions through /api/app/subscriptions", async () => {
    mocks.apiFetch.mockResolvedValue({ subscription: apiSubscription });
    const subscription = fromApiSubscription(apiSubscription);

    await subscriptionService.create(subscription);
    await subscriptionService.update(subscription);

    expect(mocks.apiFetch.mock.calls[0]?.[0]).toBe("/api/app/subscriptions");
    expect(mocks.apiFetch.mock.calls[0]?.[2]).toMatchObject({ method: "POST" });
    expect(mocks.apiFetch.mock.calls[1]?.[0]).toBe("/api/app/subscriptions/sub_api");
    expect(mocks.apiFetch.mock.calls[1]?.[2]).toMatchObject({ method: "PATCH" });
  });

  it("patches quick-action fields without sending a full subscription snapshot", async () => {
    mocks.apiFetch.mockResolvedValue({ subscription: { ...apiSubscription, pinned: true } });

    await subscriptionService.patch("sub_api", { pinned: true });

    const init = mocks.apiFetch.mock.calls[0]?.[2] as RequestInit | undefined;
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(mocks.apiFetch.mock.calls[0]?.[0]).toBe("/api/app/subscriptions/sub_api");
    expect(init).toMatchObject({ method: "PATCH" });
    expect(payload).toEqual({ pinned: true });
    expect(payload).not.toHaveProperty("name");
    expect(payload).not.toHaveProperty("nextBillingDate");
  });

  it("renews with an explicit empty JSON object and deletes through the product API", async () => {
    mocks.apiFetch.mockResolvedValueOnce({ subscription: apiSubscription }).mockResolvedValueOnce({});

    await subscriptionService.renew("sub_api");
    await subscriptionService.delete("sub_api");

    expect(mocks.apiFetch.mock.calls[0]?.[0]).toBe("/api/app/subscriptions/sub_api/renew");
    expect(mocks.apiFetch.mock.calls[0]?.[2]).toMatchObject({ method: "POST", body: "{}" });
    expect(mocks.apiFetch.mock.calls[1]?.[0]).toBe("/api/app/subscriptions/sub_api");
    expect(mocks.apiFetch.mock.calls[1]?.[2]).toMatchObject({ method: "DELETE" });
  });
});
