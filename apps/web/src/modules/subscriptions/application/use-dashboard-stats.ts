/**
 * 首页统计 application hook。
 *
 * 该 hook 只负责把 React 依赖包装到 domain 模型外层。汇率转换函数来自
 * `useExchangeRates`，因此 memo 依赖必须包含 `convert` 和 defaultCurrency。
 */
import { useMemo } from "react";
import type { Subscription } from "@/types/subscription";
import { buildDashboardStats } from "../domain/dashboard-stats";

/** 首页统计模型 hook。 */
export function useDashboardStats(
  subscriptions: readonly Subscription[],
  defaultCurrency: string,
  convert: (amount: number | string, from: string, to: string) => number,
  timeZone: string,
  notificationReminderDays: number,
) {
  return useMemo(
    () => buildDashboardStats({ subscriptions, defaultCurrency, convert, timeZone, notificationReminderDays }),
    [convert, defaultCurrency, notificationReminderDays, subscriptions, timeZone],
  );
}
