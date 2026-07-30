import { describe, expect, it } from "vitest";
import {
  exchangeRateProviderSchema,
  floatRatesResponseSchema,
  frankfurterRatesResponseSchema,
} from "./exchange-rates";

describe("exchange-rate schemas", () => {
  it("accepts Frankfurter as a supported provider", () => {
    expect(exchangeRateProviderSchema.parse("frankfurter")).toBe("frankfurter");
    expect(exchangeRateProviderSchema.parse("floatrates")).toBe("floatrates");
    expect(exchangeRateProviderSchema.parse("exchange-api")).toBe("exchange-api");
  });

  it("parses Frankfurter v2 USD rows", () => {
    const parsed = frankfurterRatesResponseSchema.parse([
      { date: "2026-07-30", base: "USD", quote: "CNY", rate: 6.7636 },
      { date: "2026-07-30", base: "USD", quote: "EUR", rate: 0.87693 },
    ]);

    expect(parsed[0]?.quote).toBe("CNY");
    expect(parsed[0]?.rate).toBe(6.7636);
  });

  it("converts FloatRates numeric strings to numbers", () => {
    const parsed = floatRatesResponseSchema.parse({
      cny: {
        alphaCode: "CNY",
        rate: "6.76054176",
        inverseRate: "0.147916",
        date: "Thu, 30 Jul 2026 07:55:15 GMT",
      },
    });

    expect(parsed["cny"]?.rate).toBe(6.76054176);
    expect(parsed["cny"]?.inverseRate).toBe(0.147916);
  });

  it("rejects unsafe FloatRates numeric strings", () => {
    for (const rate of ["", "0", "-1", "NaN", "Infinity", "1,234", "oops"]) {
      expect(floatRatesResponseSchema.safeParse({
        cny: {
          alphaCode: "CNY",
          rate,
          date: "Thu, 30 Jul 2026 07:55:15 GMT",
        },
      }).success).toBe(false);
    }
  });
});
