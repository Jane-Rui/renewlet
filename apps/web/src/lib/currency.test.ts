import { describe, expect, it } from "vitest";
import { formatCurrency, formatCurrencySymbolAmount, getCurrencyAmountPrefix } from "@/lib/currency";

describe("currency display", () => {
  it("keeps the narrow currency symbol and appends the ISO code for standalone amounts", () => {
    expect(formatCurrency(5, "USD", "zh-CN")).toBe("$5 USD");
    expect(formatCurrency(80, "CNY", "zh-CN")).toBe("¥80 CNY");
    expect(formatCurrency(12.5, "EUR", "en-US")).toBe("€12.5 EUR");
  });

  it("uses symbol-only amounts when a separate currency control already shows the code", () => {
    expect(getCurrencyAmountPrefix("USD", "zh-CN")).toBe("$");
    expect(formatCurrencySymbolAmount(5, "USD", "zh-CN")).toBe("$5");
  });
});
