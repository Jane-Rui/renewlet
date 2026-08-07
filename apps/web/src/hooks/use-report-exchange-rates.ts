import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ExchangeRateProvider,
  ExchangeRateSnapshotBody,
  ExchangeRateSnapshotV1,
} from "@/lib/api/schemas/exchange-rates";
import { exchangeRateSnapshotService } from "@/services/exchange-rate-snapshot-service";
import {
  DEFAULT_EXCHANGE_RATE_PROVIDER,
  type ExchangeRateStore,
  defaultExchangeRateStore,
} from "./exchange-rate-store";
import { createUseExchangeRates } from "./use-exchange-rates";
import { moneyToNumber } from "@renewlet/shared/money";

export type ReportExchangeRateBasisStatus = {
  month: string;
  locked: boolean;
  sourceDate: string | null;
  capturedAt: string | null;
};

type CurrentReportSnapshotState = {
  month: string;
  snapshot: ExchangeRateSnapshotV1 | null;
  loaded: boolean;
};

function isSnapshotProvider(value: string): value is ExchangeRateProvider {
  return value === "frankfurter" || value === "floatrates" || value === "exchange-api";
}

function currentReportMonthUTC(): string {
  return new Date().toISOString().slice(0, 7);
}

function exchangeRateSnapshotSignature(
  snapshot: Pick<ExchangeRateSnapshotBody, "rates" | "requestedProvider" | "provider" | "sourceDate" | "warning"> | null,
): string {
  if (snapshot === null) return "";
  return JSON.stringify({
    rates: snapshot.rates,
    requestedProvider: snapshot.requestedProvider,
    provider: snapshot.provider,
    sourceDate: snapshot.sourceDate,
    warning: snapshot.warning ?? null,
  });
}

function snapshotCapturedDate(snapshot: ExchangeRateSnapshotV1 | null): Date | null {
  if (!snapshot) return null;
  const capturedAt = new Date(snapshot.capturedAt);
  return Number.isNaN(capturedAt.getTime()) ? null : capturedAt;
}

export function createUseReportExchangeRates(store: ExchangeRateStore) {
  const useExchangeRates = createUseExchangeRates(store);

  return function useReportExchangeRates(preferredProvider: ExchangeRateProvider = DEFAULT_EXCHANGE_RATE_PROVIDER) {
    const live = useExchangeRates(preferredProvider);
    const [snapshotState, setSnapshotState] = useState<CurrentReportSnapshotState>({
      month: "",
      snapshot: null,
      loaded: false,
    });
    const [captureError, setCaptureError] = useState<unknown>(null);
    const loadedMonthRef = useRef<string | null>(null);
    const capturedSignatureRef = useRef<string>("");
    const month = currentReportMonthUTC();
    const snapshotLoaded = snapshotState.month === month && snapshotState.loaded;
    const currentSnapshot = snapshotLoaded ? snapshotState.snapshot : null;

    useEffect(() => {
      let cancelled = false;
      loadedMonthRef.current = month;
      capturedSignatureRef.current = "";
      // 先读当前月快照再决定 capture；loaded 和 snapshot 必须原子更新，避免短暂 null 被误判成未锁定。
      setSnapshotState({ month, snapshot: null, loaded: false });
      void exchangeRateSnapshotService.list({ from: month, to: month })
        .then((snapshots) => {
          if (!cancelled && loadedMonthRef.current === month) {
            setSnapshotState({ month, snapshot: snapshots[0] ?? null, loaded: true });
          }
        })
        .catch(() => {
          if (!cancelled && loadedMonthRef.current === month) {
            setSnapshotState({ month, snapshot: null, loaded: true });
          }
        });
      return () => {
        cancelled = true;
      };
    }, [month]);

    useEffect(() => {
      if (!snapshotLoaded || live.loading || !isSnapshotProvider(live.activeProvider) || !live.sourceDate) return;
      const snapshotBody = {
        base: "USD" as const,
        rates: live.rates,
        requestedProvider: preferredProvider,
        provider: live.activeProvider,
        sourceDate: live.sourceDate,
        ...(live.warning ? { warning: live.warning } : {}),
      };
      const signature = exchangeRateSnapshotSignature(snapshotBody);
      if (capturedSignatureRef.current === signature || exchangeRateSnapshotSignature(currentSnapshot) === signature) return;
      capturedSignatureRef.current = signature;
      // 当前月快照是报表口径缓存，不是实时汇率请求的成功条件；capture 失败只降级为未锁定状态。
      void exchangeRateSnapshotService.capture(month, snapshotBody)
        .then((snapshot) => {
          setSnapshotState({ month, snapshot, loaded: true });
          setCaptureError(null);
        })
        .catch((error) => {
          capturedSignatureRef.current = "";
          setCaptureError(error);
          console.warn("Failed to capture report exchange-rate snapshot:", error);
        });
    }, [currentSnapshot, live.activeProvider, live.loading, live.rates, live.sourceDate, live.warning, month, preferredProvider, snapshotLoaded]);

    const reportBasisStatus = useMemo<ReportExchangeRateBasisStatus>(() => ({
      month,
      locked: currentSnapshot !== null,
      sourceDate: currentSnapshot?.sourceDate ?? null,
      capturedAt: currentSnapshot?.capturedAt ?? null,
    }), [currentSnapshot, month]);
    // 报表消费者必须优先使用已锁定快照；实时 rates 只在当前月还没有快照时作为临时口径。
    const basisRates = currentSnapshot?.rates ?? live.rates;
    const convert = useCallback((
      amount: number | string,
      fromCurrency: string,
      toCurrency: string,
    ): number => {
      const numericAmount = moneyToNumber(amount);
      if (fromCurrency === toCurrency) return numericAmount;
      const fromRate = basisRates[fromCurrency] || 1;
      const toRate = basisRates[toCurrency] || 1;
      return (numericAmount / fromRate) * toRate;
    }, [basisRates]);

    return {
      ...live,
      rates: basisRates,
      activeProvider: currentSnapshot?.provider ?? live.activeProvider,
      sourceDate: currentSnapshot?.sourceDate ?? live.sourceDate,
      lastUpdated: snapshotCapturedDate(currentSnapshot) ?? live.lastUpdated,
      loading: currentSnapshot ? false : live.loading,
      convert,
      reportBasisStatus,
      reportBasisCaptureError: captureError,
    };
  };
}

export const useReportExchangeRates = createUseReportExchangeRates(defaultExchangeRateStore);
