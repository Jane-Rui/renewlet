// subscriptions hook 测试保护产品 API 分页契约、CRUD 写入 payload 和 query invalidation 范围。
import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertDateOnly } from "@/lib/time/date-only";
import type { ApiSubscription } from "@/lib/api/schemas/subscriptions";
import type {
  RecurringCycleSubscription,
  RepeatReminderInterval,
  RepeatReminderWindow,
  Subscription,
} from "@/types/subscription";
import {
  useCreateSubscription,
  useInfiniteSubscriptions,
  usePatchSubscription,
  useSubscriptions,
  useSubscriptionsPage,
  useUpdateSubscription,
} from "./use-subscriptions";

type RecurringSubscriptionDraft = Omit<RecurringCycleSubscription, "id">;

type SubscriptionWritePayload = {
  name: string;
  logo: string | null;
  price: string;
  currency: string;
  billingCycle: Subscription["billingCycle"];
  customDays: number | null;
  customCycleUnit: Subscription["customCycleUnit"] | null;
  oneTimeTermCount: number | null;
  oneTimeTermUnit: Subscription["oneTimeTermUnit"] | null;
  category: string;
  status: Subscription["status"];
  pinned: boolean;
  publicHidden: boolean;
  paymentMethod: string | null;
  startDate: string | null;
  nextBillingDate: string;
  autoRenew: boolean;
  autoCalculateNextBillingDate: boolean;
  trialEndDate: string | null;
  website: string | null;
  notes: string | null;
  tags: string[];
  reminderDays: number;
  repeatReminderEnabled: boolean;
  repeatReminderInterval: RepeatReminderInterval;
  repeatReminderWindow: RepeatReminderWindow;
  extra: Record<string, unknown>;
};

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  getCurrentUserId: vi.fn<() => string | null>(),
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

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function apiSubscriptionFromPayload(id: string, payload: SubscriptionWritePayload): ApiSubscription {
  return {
    id,
    name: payload.name,
    ...(payload.logo !== null ? { logo: payload.logo } : {}),
    price: payload.price,
    currency: payload.currency,
    billingCycle: payload.billingCycle,
    ...(payload.billingCycle === "custom" && payload.customDays !== null ? { customDays: payload.customDays } : {}),
    ...(payload.billingCycle === "custom" && payload.customCycleUnit !== null ? { customCycleUnit: payload.customCycleUnit } : {}),
    ...(payload.billingCycle === "one-time" && payload.oneTimeTermCount !== null ? { oneTimeTermCount: payload.oneTimeTermCount } : {}),
    ...(payload.billingCycle === "one-time" && payload.oneTimeTermUnit !== null ? { oneTimeTermUnit: payload.oneTimeTermUnit } : {}),
    category: payload.category,
    status: payload.status,
    pinned: payload.pinned,
    publicHidden: payload.publicHidden,
    ...(payload.paymentMethod !== null ? { paymentMethod: payload.paymentMethod } : {}),
    startDate: payload.startDate,
    nextBillingDate: payload.nextBillingDate,
    autoRenew: payload.autoRenew,
    autoCalculateNextBillingDate: payload.autoCalculateNextBillingDate,
    ...(payload.trialEndDate !== null ? { trialEndDate: payload.trialEndDate } : {}),
    ...(payload.website !== null ? { website: payload.website } : {}),
    ...(payload.notes !== null ? { notes: payload.notes } : {}),
    tags: payload.tags,
    reminderDays: payload.reminderDays,
    repeatReminderEnabled: payload.repeatReminderEnabled,
    repeatReminderInterval: payload.repeatReminderInterval,
    repeatReminderWindow: payload.repeatReminderWindow,
    extra: payload.extra,
  };
}

function apiSubscriptionFromDraft(id: string, draft: RecurringSubscriptionDraft): ApiSubscription {
  return apiSubscriptionFromPayload(id, {
    name: draft.name,
    logo: draft.logo ?? null,
    price: draft.price,
    currency: draft.currency,
    billingCycle: draft.billingCycle,
    customDays: draft.customDays ?? null,
    customCycleUnit: draft.customCycleUnit ?? null,
    oneTimeTermCount: draft.oneTimeTermCount ?? null,
    oneTimeTermUnit: draft.oneTimeTermUnit ?? null,
    category: draft.category,
    status: draft.status,
    pinned: draft.pinned,
    publicHidden: draft.publicHidden,
    paymentMethod: draft.paymentMethod ?? null,
    startDate: draft.startDate,
    nextBillingDate: draft.nextBillingDate,
    autoRenew: draft.autoRenew,
    autoCalculateNextBillingDate: draft.autoCalculateNextBillingDate,
    trialEndDate: draft.trialEndDate ?? null,
    website: draft.website ?? null,
    notes: draft.notes ?? null,
    tags: draft.tags,
    reminderDays: draft.reminderDays,
    repeatReminderEnabled: draft.repeatReminderEnabled,
    repeatReminderInterval: draft.repeatReminderInterval,
    repeatReminderWindow: draft.repeatReminderWindow,
    extra: draft.extra ?? {},
  });
}

function subscriptionDraft(overrides: Partial<RecurringSubscriptionDraft> = {}): RecurringSubscriptionDraft {
  return {
    name: "Aws",
    logo: "https://aws.amazon.com/favicon.ico",
    price: "15",
    currency: "USD",
    billingCycle: "monthly",
    customDays: undefined,
    customCycleUnit: undefined,
    category: "productivity",
    status: "active",
    pinned: false,
    publicHidden: false,
    paymentMethod: undefined,
    startDate: assertDateOnly("2026-05-14"),
    nextBillingDate: assertDateOnly("2026-06-14"),
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

function parseRequestBody(callIndex: number): SubscriptionWritePayload {
  const init = mocks.apiFetch.mock.calls[callIndex]?.[2] as RequestInit | undefined;
  return JSON.parse(String(init?.body)) as SubscriptionWritePayload;
}

describe("use-subscriptions mutations", () => {
  beforeEach(() => {
    mocks.apiFetch.mockReset();
    mocks.getCurrentUserId.mockReset();
    mocks.getCurrentUserId.mockReturnValue("user-1");
    mocks.apiFetch.mockImplementation(async (url: string, _schema: unknown, init?: RequestInit) => {
      const id = url.includes("/sub-1") ? "sub-1" : "sub-1";
      if (!init?.body) {
        return { subscription: apiSubscriptionFromDraft(id, subscriptionDraft()) };
      }
      const payload = JSON.parse(String(init.body)) as SubscriptionWritePayload;
      return { subscription: apiSubscriptionFromPayload(id, payload) };
    });
  });

  it("keeps tags as an empty array when creating a subscription through the product API", async () => {
    const { result } = renderHook(() => useCreateSubscription(), { wrapper: createWrapper() });
    const draft = subscriptionDraft({ tags: [] });

    await act(async () => {
      await result.current.mutateAsync(draft);
    });

    expect(mocks.apiFetch.mock.calls[0]?.[0]).toBe("/api/app/subscriptions");
    expect(mocks.apiFetch.mock.calls[0]?.[2]).toMatchObject({ method: "POST" });
    expect(parseRequestBody(0)).toMatchObject({
      name: "Aws",
      tags: [],
      repeatReminderEnabled: false,
      repeatReminderInterval: "1h",
      repeatReminderWindow: "72h",
      autoRenew: false,
    });
    expect(parseRequestBody(0)).not.toHaveProperty("user");
  });

  it("sends nullable start dates for manual recurring creates", async () => {
    const { result } = renderHook(() => useCreateSubscription(), { wrapper: createWrapper() });
    const draft = subscriptionDraft({
      startDate: null,
      nextBillingDate: assertDateOnly("2026-08-01"),
      autoCalculateNextBillingDate: false,
    });

    await act(async () => {
      await result.current.mutateAsync(draft);
    });

    expect(parseRequestBody(0)).toMatchObject({
      startDate: null,
      nextBillingDate: "2026-08-01",
      autoCalculateNextBillingDate: false,
    });
  });

  it("keeps tags as an empty array when updating a subscription through the product API", async () => {
    const { result } = renderHook(() => useUpdateSubscription(), { wrapper: createWrapper() });
    const subscription: Subscription = { id: "sub-1", ...subscriptionDraft({ tags: [] }) };

    await act(async () => {
      await result.current.mutateAsync(subscription);
    });

    expect(mocks.apiFetch.mock.calls[0]?.[0]).toBe("/api/app/subscriptions/sub-1");
    expect(mocks.apiFetch.mock.calls[0]?.[2]).toMatchObject({ method: "PATCH" });
    expect(parseRequestBody(0)).toMatchObject({
      name: "Aws",
      tags: [],
      repeatReminderEnabled: false,
      repeatReminderInterval: "1h",
      repeatReminderWindow: "72h",
    });
  });

  it("sends only quick-action fields through the patch mutation", async () => {
    mocks.apiFetch.mockResolvedValueOnce({
      subscription: apiSubscriptionFromDraft("sub-1", subscriptionDraft({ pinned: true })),
    });
    const { result } = renderHook(() => usePatchSubscription(), { wrapper: createWrapper() });

    await act(async () => {
      await result.current.mutateAsync({ id: "sub-1", patch: { pinned: true } });
    });

    const init = mocks.apiFetch.mock.calls[0]?.[2] as RequestInit | undefined;
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(mocks.apiFetch.mock.calls[0]?.[0]).toBe("/api/app/subscriptions/sub-1");
    expect(init).toMatchObject({ method: "PATCH" });
    expect(payload).toEqual({ pinned: true });
    expect(payload).not.toHaveProperty("name");
    expect(payload).not.toHaveProperty("nextBillingDate");
  });
});

describe("use-subscriptions pagination", () => {
  beforeEach(() => {
    mocks.apiFetch.mockReset();
    mocks.getCurrentUserId.mockReset();
    mocks.getCurrentUserId.mockReturnValue("user-1");
  });

  it("loads a single page through the page hook", async () => {
    const first = apiSubscriptionFromDraft("sub-1", subscriptionDraft({ name: "First" }));
    mocks.apiFetch.mockResolvedValue({ subscriptions: [first], nextCursor: "cursor-2", total: 2 });

    const { result } = renderHook(() => useSubscriptionsPage(null, 1), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.data?.subscriptions).toHaveLength(1));
    expect(mocks.apiFetch).toHaveBeenCalledWith("/api/app/subscriptions?limit=1", expect.anything());
    expect(result.current.data?.nextCursor).toBe("cursor-2");
  });

  it("merges loaded infinite pages without sharing the aggregate query cache shape", async () => {
    const first = apiSubscriptionFromDraft("sub-1", subscriptionDraft({ name: "First" }));
    const second = apiSubscriptionFromDraft("sub-2", subscriptionDraft({ name: "Second" }));
    mocks.apiFetch
      .mockResolvedValueOnce({ subscriptions: [first], nextCursor: "cursor-2", total: 2 })
      .mockResolvedValueOnce({ subscriptions: [second], nextCursor: null, total: 2 })
      .mockResolvedValueOnce({ subscriptions: [first, second], nextCursor: null, total: 2 });

    const wrapper = createWrapper();
    const infinite = renderHook(() => useInfiniteSubscriptions(), { wrapper });
    await waitFor(() => expect(infinite.result.current.subscriptions.map((item) => item.name)).toEqual(["First"]));

    await act(async () => {
      await infinite.result.current.fetchNextPage();
    });
    await waitFor(() => expect(infinite.result.current.subscriptions.map((item) => item.name)).toEqual(["First", "Second"]));

    const aggregate = renderHook(() => useSubscriptions(), { wrapper });
    await waitFor(() => expect(aggregate.result.current.data?.map((item) => item.name)).toEqual(["First", "Second"]));
    expect(Array.isArray(aggregate.result.current.data)).toBe(true);
  });

  it("caps aggregate subscription loading at five thousand records", async () => {
    const pageItems = Array.from({ length: 50 }, (_, index) => apiSubscriptionFromDraft(`sub-${index}`, subscriptionDraft({ name: `Sub ${index}` })));
    mocks.apiFetch.mockImplementation(async (_url: string) => {
      const callNumber = mocks.apiFetch.mock.calls.length;
      const page = callNumber;
      return {
        subscriptions: pageItems.map((item, index) => ({ ...item, id: `sub-${page}-${index}` })),
        nextCursor: page < 120 ? `cursor-${page + 1}` : null,
        total: 6000,
      };
    });

    const { result } = renderHook(() => useSubscriptions(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.data).toHaveLength(5000));
    expect(mocks.apiFetch).toHaveBeenCalledTimes(100);
  });
});
