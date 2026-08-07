import { describe, expect, it } from "vitest";
import {
  calculateCostSharingMemberAmount,
  calculateCostSharingSummary,
  costSharingCustomAmountsAreValid,
  type CostSharing,
} from "./cost-sharing";
import { moneyToNumber } from "./money";

const equalSharing: CostSharing = {
  enabled: true,
  splitMode: "equal",
  members: [
    { id: "partner", name: "Partner" },
    { id: "child", name: "Child" },
  ],
};

describe("cost sharing calculation", () => {
  it("splits equal shares between the current payer and shared members", () => {
    const summary = calculateCostSharingSummary(equalSharing, 90);

    expect(calculateCostSharingMemberAmount(equalSharing, equalSharing.members[0]!, 90)).toBe(30);
    expect(summary).toMatchObject({
      enabled: true,
      total: 90,
      yourShare: 30,
      memberTotal: 60,
      recoverableAmount: 60,
      memberCount: 2,
    });
  });

  it("treats custom member totals below the price as partial recovery", () => {
    const customSharing: CostSharing = {
      enabled: true,
      splitMode: "custom",
      members: [
        { id: "partner", name: "Partner", currency: "CNY", customAmount: "10" },
        { id: "child", name: "Child", currency: "CNY", customAmount: "10" },
      ],
    };

    expect(costSharingCustomAmountsAreValid(customSharing)).toBe(true);
    expect(calculateCostSharingSummary(customSharing, 50, { baseCurrency: "CNY" })).toMatchObject({
      yourShare: 30,
      memberTotal: 20,
      recoverableAmount: 20,
    });
  });

  it("allows custom member totals to match the price exactly", () => {
    const customSharing: CostSharing = {
      enabled: true,
      splitMode: "custom",
      members: [
        { id: "partner", name: "Partner", currency: "CNY", customAmount: "20" },
        { id: "child", name: "Child", currency: "CNY", customAmount: "30" },
      ],
    };

    expect(calculateCostSharingSummary(customSharing, 50, { baseCurrency: "CNY" })).toMatchObject({
      yourShare: 0,
      memberTotal: 50,
      recoverableAmount: 50,
    });
  });

  it("allows custom member totals to exceed the price without creating an overage field", () => {
    const customSharing: CostSharing = {
      enabled: true,
      splitMode: "custom",
      members: [
        { id: "partner", name: "Partner", currency: "CNY", customAmount: "50" },
        { id: "child", name: "Child", currency: "CNY", customAmount: "30" },
      ],
    };

    expect(calculateCostSharingSummary(customSharing, 50, { baseCurrency: "CNY" })).toMatchObject({
      yourShare: 0,
      memberTotal: 80,
      recoverableAmount: 80,
    });
  });

  it("converts custom member currencies before comparing with the subscription price", () => {
    const customSharing: CostSharing = {
      enabled: true,
      splitMode: "custom",
      members: [
        { id: "eur", name: "EUR member", currency: "EUR", customAmount: "10" },
        { id: "usd", name: "USD member", currency: "USD", customAmount: "10" },
        { id: "gbp", name: "GBP member", currency: "GBP", customAmount: "10" },
        { id: "jpy", name: "JPY member", currency: "JPY", customAmount: "10" },
      ],
    };
    const convert = (amount: number | string, from: string, to: string) => {
      const value = moneyToNumber(amount);
      if (to !== "CNY") return value;
      const rates: Record<string, number> = {
        CNY: 1,
        EUR: 8,
        USD: 7,
        GBP: 9,
        JPY: 0.05,
      };
      return value * (rates[from] ?? 1);
    };

    expect(calculateCostSharingSummary(customSharing, 50, { baseCurrency: "CNY", convert })).toMatchObject({
      yourShare: 0,
      memberTotal: 240.5,
      recoverableAmount: 240.5,
      memberCount: 4,
    });
  });

  it("rejects missing custom amounts for shared members", () => {
    expect(costSharingCustomAmountsAreValid({
      enabled: true,
      splitMode: "custom",
      members: [
        { id: "partner", name: "Partner", currency: "USD", customAmount: "40" },
        { id: "child", name: "Child", currency: "CNY" },
      ],
    })).toBe(false);
  });
});
