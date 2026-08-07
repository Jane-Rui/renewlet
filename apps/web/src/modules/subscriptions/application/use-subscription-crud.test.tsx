// CRUD 控制器测试保护页面级快捷动作语义，避免字段级操作退回完整订阅快照 PATCH。
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { assertDateOnly } from "@/lib/time/date-only";
import type { Subscription } from "@/types/subscription";
import { useSubscriptionCrud } from "./use-subscription-crud";

const mocks = vi.hoisted(() => ({
  createMutate: vi.fn(),
  updateMutate: vi.fn(),
  patchMutate: vi.fn(),
  renewMutate: vi.fn(),
  deleteMutate: vi.fn(),
}));

vi.mock("@/hooks/use-subscriptions", () => ({
  useCreateSubscription: () => ({ mutate: mocks.createMutate }),
  useUpdateSubscription: () => ({ mutate: mocks.updateMutate }),
  usePatchSubscription: () => ({ mutate: mocks.patchMutate }),
  useRenewSubscription: () => ({ mutate: mocks.renewMutate }),
  useDeleteSubscription: () => ({ mutate: mocks.deleteMutate }),
}));

function subscription(): Subscription {
  return {
    id: "sub-1",
    name: "Codex Pro",
    logo: undefined,
    price: "20",
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
    startDate: assertDateOnly("2026-01-01"),
    nextBillingDate: assertDateOnly("2026-02-01"),
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
  };
}

describe("useSubscriptionCrud", () => {
  it("uses field-level patch mutations for card quick actions", () => {
    const { result } = renderHook(() => useSubscriptionCrud([subscription()]));

    act(() => {
      result.current.handleTogglePinnedSubscription("sub-1");
      result.current.handleTogglePublicHiddenSubscription("sub-1");
    });

    expect(mocks.patchMutate).toHaveBeenNthCalledWith(1, { id: "sub-1", patch: { pinned: true } });
    expect(mocks.patchMutate).toHaveBeenNthCalledWith(2, { id: "sub-1", patch: { publicHidden: true } });
    expect(mocks.updateMutate).not.toHaveBeenCalled();
    expect(result.current).not.toHaveProperty("setEditDialogOpen");
  });
});
