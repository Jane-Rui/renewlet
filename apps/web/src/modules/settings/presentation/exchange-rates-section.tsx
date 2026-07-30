/**
 * 汇率设置展示区。
 *
 * 架构位置：展示 provider、刷新状态和币种启用列表；远端拉取、缓存和 fallback 位于 useExchangeRates。
 *
 * 注意： 默认货币和启用货币会影响全站金额换算，展示层不能绕过 controller 直接修改配置。
 */
import { useState } from "react";
import { ExternalLink, RefreshCw, TrendingUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { RawErrorResponseDialog } from "@/components/raw-error-response-dialog";
import { Label } from '@/components/ui/label';
import { SearchableSelect } from '@/components/ui/searchable-select';
import type { SearchableSelectOption } from '@/components/ui/searchable-select';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/i18n/I18nProvider';
import type {
  ExchangeRateCoverageWarning,
  ExchangeRateProvider,
  ExchangeRates,
  ExchangeRateSource,
} from '@/lib/api/schemas/exchange-rates';
import type { RawErrorResponseDetails } from "@/lib/raw-error-response";
import { cn } from '@/lib/utils';
import type { CustomConfig } from '@/types/config';
import type { AppSettings } from '@/types/subscription';
import { getSettingsSectionClassName } from './settings-layout';
import {
  getDirectExchangeRateQuote,
  getExchangeRatePreviewCurrencies,
} from '../domain/exchange-rate-preview-policy';

export interface ExchangeRatesSectionProps {
  id?: string;
  className?: string;
  settings: Pick<AppSettings, 'defaultCurrency' | 'exchangeRateProvider'>;
  customConfig: Pick<CustomConfig, 'currencies'>;
  rates: ExchangeRates;
  activeRateProvider: ExchangeRateSource;
  ratesLoading: boolean;
  ratesError: string | null;
  ratesErrorDetails: RawErrorResponseDetails | null;
  ratesWarning: ExchangeRateCoverageWarning | null;
  lastUpdated: Date | null;
  defaultCurrencyOptions: SearchableSelectOption[];
  handleRefreshRates: () => void | Promise<void>;
  handleDefaultCurrencyChange: (value: string) => void;
  handleExchangeRateProviderChange: (value: ExchangeRateProvider) => void | Promise<void>;
  getCurrencySymbol: (currency: string) => string;
}

export function ExchangeRatesSection({
  id,
  className,
  settings,
  customConfig,
  rates,
  activeRateProvider,
  ratesLoading,
  ratesError,
  ratesErrorDetails,
  ratesWarning,
  lastUpdated,
  defaultCurrencyOptions,
  handleRefreshRates,
  handleDefaultCurrencyChange,
  handleExchangeRateProviderChange,
  getCurrencySymbol,
}: ExchangeRatesSectionProps) {
  const { t, formatDateTime, formatNumber } = useI18n();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const previewCurrencies = getExchangeRatePreviewCurrencies(customConfig.currencies, settings.defaultCurrency);
  const getProviderLabel = (provider: ExchangeRateSource) => {
    if (provider === "builtin") return t("settings.exchangeRateProvider.builtin");
    if (provider === "frankfurter") return t("settings.exchangeRateProvider.frankfurter");
    if (provider === "floatrates") return t("settings.exchangeRateProvider.floatrates");
    return t("settings.exchangeRateProvider.exchangeApi");
  };
  const providerLabel = getProviderLabel(activeRateProvider);
  const providerUrl = activeRateProvider === "frankfurter"
    ? "https://frankfurter.dev/"
    : activeRateProvider === "floatrates"
      ? "https://www.floatrates.com/json-feeds.html"
      : activeRateProvider === "exchange-api"
        ? "https://github.com/fawazahmed0/exchange-api#readme"
        : null;
  const warningMissingCurrencies = ratesWarning?.missingCurrencies.join(", ") ?? "";
  const warningFillSources = ratesWarning
    ? Array.from(new Set(Object.values(ratesWarning.fillSources))).map(getProviderLabel).join(", ")
    : "";

  return (
            <section id={id} className={getSettingsSectionClassName(className)}>
                <div className="flex items-center justify-between mb-6">
                  <div className="flex items-center gap-2">
                    <TrendingUp className="h-5 w-5 text-primary" />
                    <h2 className="text-lg font-semibold text-foreground">{t("settings.exchange")}</h2>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleRefreshRates}
                    disabled={ratesLoading}
                    className="gap-2"
                  >
                    <RefreshCw className={cn("h-4 w-4", ratesLoading && "animate-spin")} />
                    {ratesLoading ? t("settings.ratesUpdating") : t("settings.refreshRates")}
                  </Button>
                </div>

                {/* partial warning 已有完整汇率可用，只提示缺币补齐来源；错误详情入口只属于全失败排障。 */}
                {ratesError && (
                  <div className="mb-4 flex flex-col gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-sm text-amber-600 sm:flex-row sm:items-center sm:justify-between">
                    <span>{t("settings.ratesError", { error: ratesError })}</span>
                    {ratesErrorDetails ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="w-full border-amber-500/30 bg-transparent text-amber-700 hover:bg-amber-500/10 dark:text-amber-300 sm:w-auto"
                        onClick={() => setDetailsOpen(true)}
                      >
                        {t("rawErrorResponse.open")}
                      </Button>
	                    ) : null}
	                  </div>
	                )}

	                {!ratesError && ratesWarning && (
	                  <div className="mb-4 rounded-lg border border-amber-500/20 bg-amber-500/10 p-3 text-sm text-amber-600 dark:text-amber-300">
	                    {t("settings.ratesWarning", {
	                      currencies: warningMissingCurrencies,
	                      sources: warningFillSources,
	                    })}
	                  </div>
	                )}
    
                <div className="grid gap-6">
                  {/* 统计货币选择 */}
                  <div className="p-4 rounded-lg border border-border bg-secondary/50">
                    <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                      <div className="flex-1">
                        <Label htmlFor="defaultCurrency" className="text-base font-medium">{t("settings.defaultCurrency")}</Label>
                        <p className="text-xs text-muted-foreground mt-1">
                          {t("settings.defaultCurrencyHelp")}
                        </p>
                      </div>
                      <SearchableSelect
                        value={settings.defaultCurrency}
                        onValueChange={handleDefaultCurrencyChange}
                        options={defaultCurrencyOptions}
                        placeholder={t("settings.currencyPlaceholder")}
                        searchPlaceholder={t("settings.currencySearch")}
                        emptyMessage={t("settings.currencyEmpty")}
                        className="w-full border-border bg-secondary sm:w-[min(12.5rem,100%)]"
                        aria-label={t("settings.defaultCurrency")}
                      />
                    </div>
                  </div>

                  <div className="p-4 rounded-lg border border-border bg-secondary/50">
                    <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                      <div className="flex-1">
                        <Label htmlFor="exchangeRateProvider" className="text-base font-medium">{t("settings.exchangeRateProvider")}</Label>
                        <p className="text-xs text-muted-foreground mt-1">
                          {t("settings.exchangeRateProviderHelp")}
                        </p>
                      </div>
                      <Select
                        value={settings.exchangeRateProvider}
                        onValueChange={(value) => handleExchangeRateProviderChange(value as ExchangeRateProvider)}
                      >
                        <SelectTrigger
                          id="exchangeRateProvider"
                          className="w-full border-border bg-secondary sm:w-[min(12.5rem,100%)]"
                          aria-label={t("settings.exchangeRateProvider")}
                        >
                          <SelectValue />
                        </SelectTrigger>
	                        <SelectContent>
	                          <SelectItem value="frankfurter">{t("settings.exchangeRateProvider.frankfurter")}</SelectItem>
	                          <SelectItem value="exchange-api">{t("settings.exchangeRateProvider.exchangeApi")}</SelectItem>
	                          <SelectItem value="floatrates">{t("settings.exchangeRateProvider.floatrates")}</SelectItem>
	                        </SelectContent>
                      </Select>
                    </div>
                  </div>
    
                  {/* 汇率信息 */}
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="flex items-center justify-between text-sm p-3 rounded-lg bg-secondary/50">
                      <span className="text-muted-foreground">{t("settings.dataSource")}</span>
                      {providerUrl ? (
                        <a
                          href={providerUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 text-primary hover:underline"
                        >
	                          {providerLabel}
	                          <ExternalLink className="h-3 w-3" />
	                        </a>
	                      ) : (
	                        <span className="font-medium text-foreground">{providerLabel}</span>
	                      )}
	                      {ratesWarning ? (
	                        <span className="ml-2 text-xs text-muted-foreground">
	                          {t("settings.exchangeRatePartialDataSource", { sources: warningFillSources })}
	                        </span>
	                      ) : null}
	                    </div>
                    <div className="flex items-center justify-between text-sm p-3 rounded-lg bg-secondary/50">
                      <span className="text-muted-foreground">{t("settings.cachePolicy")}</span>
                      <span className="font-medium text-foreground">{t("settings.cachePolicyValue")}</span>
                    </div>
                    <div className="flex items-center justify-between text-sm p-3 rounded-lg bg-secondary/50 sm:col-span-2">
                      <span className="text-muted-foreground">{t("settings.lastUpdated")}</span>
                      <span className="font-medium text-foreground">
                        {lastUpdated
                          ? formatDateTime(lastUpdated, {
                              year: 'numeric',
                              month: '2-digit',
                              day: '2-digit',
                              hour: '2-digit',
                              minute: '2-digit'
                            })
                          : t("settings.notFetched")}
                      </span>
                    </div>
                  </div>
    
                  {/* 汇率预览 - 相对于统计货币 */}
                  <div className="pt-4 border-t border-border">
                    <h3 className="text-sm font-medium text-foreground mb-3">
                      {t("settings.ratesPreview", { currency: settings.defaultCurrency })}
                    </h3>
                    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                      {previewCurrencies
                        .map(currency => {
                          const directQuote = getDirectExchangeRateQuote(rates, currency.value, settings.defaultCurrency);
                          const fractionDigits = Math.abs(directQuote) >= 1 ? 2 : 4;
                          
                          return (
                            <div 
                              key={currency.value}
                              className="flex flex-col gap-1.5 p-2.5 rounded-lg bg-secondary/50"
                            >
                              <span className="text-xs font-medium text-muted-foreground">
                                1 {currency.value}
                              </span>
                              <span className="text-base font-semibold tabular-nums text-foreground">
                                ≈ {getCurrencySymbol(settings.defaultCurrency)}{formatNumber(directQuote, {
                                  minimumFractionDigits: fractionDigits,
                                  maximumFractionDigits: fractionDigits,
                                })} {settings.defaultCurrency}
                              </span>
                            </div>
                          );
                        })}
                    </div>
                  </div>
    
                  <p className="text-xs text-muted-foreground">
                    {t("settings.ratesInfo")}
                  </p>
                </div>
                <RawErrorResponseDialog
                  open={detailsOpen}
                  details={ratesErrorDetails}
                  onOpenChange={setDetailsOpen}
                  testId="exchange-rates-raw-error-response-dialog"
                />
              </section>
    
  );
}
