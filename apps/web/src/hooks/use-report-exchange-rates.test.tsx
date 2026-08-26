import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExchangeRateSnapshotBody, ExchangeRateSnapshotV1 } from "@/lib/api/schemas/exchange-rates";
import type { ExchangeRateStore } from "./exchange-rate-store";
import { createUseReportExchangeRates } from "./use-report-exchange-rates";

const serviceMocks = vi.hoisted(() => ({
  list: vi.fn<(_range: { from?: string; to?: string }, _signal?: AbortSignal) => Promise<ExchangeRateSnapshotV1[]>>(),
  capture: vi.fn<(_month: string, _body: ExchangeRateSnapshotBody, _signal?: AbortSignal) => Promise<ExchangeRateSnapshotV1>>(),
}));

vi.mock("@/services/exchange-rate-snapshot-service", () => ({
  exchangeRateSnapshotService: serviceMocks,
}));

const currentMonth = "2026-08";

function remoteStore(overrides: Partial<Awaited<ReturnType<ExchangeRateStore["loadRemoteSnapshot"]>>> = {}): ExchangeRateStore {
  return {
    readCachedSnapshot: () => null,
    loadRemoteSnapshot: vi.fn().mockResolvedValue({
      rates: { USD: 1, CNY: 7 },
      baseRate: "USD",
      activeProvider: "frankfurter",
      warning: null,
      sourceDate: "2026-08-01",
      lastUpdated: new Date("2026-08-06T00:00:00.000Z"),
      ...overrides,
    }),
  };
}

describe("useReportExchangeRates", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-08-06T12:00:00.000Z"));
    serviceMocks.list.mockResolvedValue([]);
    serviceMocks.capture.mockImplementation(async (_month, body) => ({
      schemaVersion: 1,
      month: currentMonth,
      ...body,
      capturedAt: "2026-08-06T12:00:00.000Z",
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    serviceMocks.list.mockReset();
    serviceMocks.capture.mockReset();
  });

  it("captures the current report month after a trusted provider succeeds", async () => {
    const useReportExchangeRates = createUseReportExchangeRates(remoteStore());

    const { result } = renderHook(() => useReportExchangeRates("frankfurter"));

    await waitFor(() => expect(serviceMocks.capture).toHaveBeenCalledTimes(1));
    expect(serviceMocks.list).toHaveBeenCalledWith(
      { from: currentMonth, to: currentMonth },
      expect.any(AbortSignal),
    );
    expect(serviceMocks.capture).toHaveBeenCalledWith(currentMonth, {
      base: "USD",
      rates: { USD: 1, CNY: 7 },
      requestedProvider: "frankfurter",
      provider: "frankfurter",
      sourceDate: "2026-08-01",
    }, expect.any(AbortSignal));
    expect(result.current.reportBasisStatus).toEqual({
      month: currentMonth,
      locked: true,
      sourceDate: "2026-08-01",
      capturedAt: "2026-08-06T12:00:00.000Z",
    });
  });

  it("uses an existing locked snapshot as the report converter without writing it again", async () => {
    serviceMocks.list.mockResolvedValue([{
      schemaVersion: 1,
      month: currentMonth,
      base: "USD",
      rates: { USD: 1, CNY: 6 },
      requestedProvider: "frankfurter",
      provider: "frankfurter",
      sourceDate: "2026-08-01",
      capturedAt: "2026-08-06T00:00:00.000Z",
    }]);
    const useReportExchangeRates = createUseReportExchangeRates(remoteStore({
      rates: { USD: 1, CNY: 6 },
      sourceDate: "2026-08-01",
    }));

    const { result } = renderHook(() => useReportExchangeRates("frankfurter"));

    await waitFor(() => expect(result.current.reportBasisStatus.locked).toBe(true));
    expect(result.current.convert("6", "CNY", "USD")).toBe(1);
    expect(serviceMocks.capture).not.toHaveBeenCalled();
  });

  it("does not persist builtin fallback rates as a report snapshot", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store: ExchangeRateStore = {
      readCachedSnapshot: () => null,
      loadRemoteSnapshot: vi.fn().mockRejectedValue(new Error("network down")),
    };
    const useReportExchangeRates = createUseReportExchangeRates(store);

    const { result } = renderHook(() => useReportExchangeRates("frankfurter"));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.activeProvider).toBe("builtin");
    expect(serviceMocks.capture).not.toHaveBeenCalled();
  });
});
