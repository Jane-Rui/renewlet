import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertDateOnly } from "@/lib/time/date-only";
import type { Subscription } from "@/types/subscription";
import { useSubscriptionDetailDialog } from "./use-subscription-detail-dialog";

function subscription(id: string, name: string): Subscription {
  return {
    id,
    name,
    logo: undefined,
    price: "10",
    currency: "USD",
    billingCycle: "monthly",
    customDays: undefined,
    customCycleUnit: undefined,
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
    reminderDays: -1,
    repeatReminderEnabled: false,
    repeatReminderInterval: "1h",
    repeatReminderWindow: "72h",
  };
}

describe("useSubscriptionDetailDialog", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the selected subscription until the close animation cleanup runs", () => {
    vi.useFakeTimers();
    const first = subscription("sub_1", "First");
    const { result } = renderHook(() => useSubscriptionDetailDialog([first]));

    act(() => result.current.handleViewDetails("sub_1"));
    expect(result.current.detailDialogOpen).toBe(true);
    expect(result.current.selectedDetailSubscription?.name).toBe("First");

    act(() => result.current.handleDetailDialogOpenChange(false));
    expect(result.current.detailDialogOpen).toBe(false);
    expect(result.current.selectedDetailSubscription?.name).toBe("First");

    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current.selectedDetailSubscription).toBeNull();
  });

  it("cancels pending cleanup when another detail dialog opens", () => {
    vi.useFakeTimers();
    const first = subscription("sub_1", "First");
    const second = subscription("sub_2", "Second");
    const { result } = renderHook(() => useSubscriptionDetailDialog([first, second]));

    act(() => result.current.handleViewDetails("sub_1"));
    act(() => result.current.handleDetailDialogOpenChange(false));
    act(() => result.current.handleViewDetails("sub_2"));
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(result.current.detailDialogOpen).toBe(true);
    expect(result.current.selectedDetailSubscription?.name).toBe("Second");
  });
});
