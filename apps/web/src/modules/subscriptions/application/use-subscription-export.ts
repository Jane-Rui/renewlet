/**
 * 订阅导出 application hook。
 *
 * 架构位置：
 * - domain 生成导出内容。
 * - shared/browser 封装下载副作用。
 *
 * 注意： 这里接收的是“已经筛选后的订阅列表”，因此导出结果跟当前页面视图一致。
 */
import { useMemo } from "react";
import type { Locale } from "@/i18n/locales";
import { localizedLabel } from "@/i18n/locales";
import { todayDateOnlyInTimeZone } from "@/lib/time/date-only";
import { downloadFile } from "@/shared/browser/download-file";
import type { CustomConfig } from "@/types/config";
import type { AppSettings, Subscription } from "@/types/subscription";
import { exportRenewletBackup } from "@/modules/import-export/domain/renewlet-export";
import { exchangeRateSnapshotService } from "@/services/exchange-rate-snapshot-service";
import { buildSubscriptionsCsv } from "../domain/subscription-export";
import type { CostSharingCurrencyConverter } from "@renewlet/shared/cost-sharing";

async function loadExchangeRateSnapshotsForExport() {
  try {
    return await exchangeRateSnapshotService.list();
  } catch (error) {
    // 汇率快照是报表口径增强，不能因为读取失败阻断订阅/设置这份基础可恢复导出。
    console.warn("Failed to include exchange-rate snapshots in Renewlet export:", error);
    return [];
  }
}

/** 订阅导出控制器。 */
export function useSubscriptionExport(
  subscriptions: readonly Subscription[],
  backupSubscriptions: readonly Subscription[],
  config: CustomConfig,
  settings: AppSettings,
  locale: Locale,
  timeZone = "UTC",
  costSharingCurrencyConvert?: CostSharingCurrencyConverter | undefined,
) {
  const categoryLabelByValue = useMemo(
    () => new Map(config.categories.map((category) => [category.value, localizedLabel(category.labels, locale)])),
    [config.categories, locale],
  );
  const statusLabelByValue = useMemo(
    () => new Map(config.statuses.map((status) => [status.value, localizedLabel(status.labels, locale)])),
    [config.statuses, locale],
  );

  const exportToJSON = () => {
    void (async () => {
      const exchangeRateSnapshots = await loadExchangeRateSnapshotsForExport();
      await exportRenewletBackup({ subscriptions: backupSubscriptions, settings, customConfig: config, includeSecrets: false, exchangeRateSnapshots });
    })();
  };

  const exportToJSONWithSecrets = () => {
    void (async () => {
      const exchangeRateSnapshots = await loadExchangeRateSnapshotsForExport();
      await exportRenewletBackup({ subscriptions: backupSubscriptions, settings, customConfig: config, includeSecrets: true, exchangeRateSnapshots });
    })();
  };

  const exportToCSV = () => {
    const today = todayDateOnlyInTimeZone(new Date(), timeZone);
    const csvContent = buildSubscriptionsCsv(subscriptions, {
      categoryLabelByValue,
      statusLabelByValue,
      locale,
      today,
      costSharingCalculation: { convert: costSharingCurrencyConvert },
    });
    const blob = new Blob(["\uFEFF" + csvContent], { type: "text/csv;charset=utf-8" });
    downloadFile(blob, "subscriptions.csv");
  };

  return { exportToJSON, exportToJSONWithSecrets, exportToCSV };
}
