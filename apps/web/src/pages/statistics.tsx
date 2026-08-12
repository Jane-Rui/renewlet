/**
 * 统计分析页（/statistics）。
 *
 * 功能：
 * - 月度/年度支出汇总（使用当前月报表汇率口径换算到默认币种）
 * - 预算使用情况（与 Settings 中 monthlyBudget 对齐）
 * - 分类分布 / 支付方式分布图表
 *
 * 架构位置：
 * - 统计聚合由 `useStatisticsModel` 完成。
 * - 页面只负责图表/卡片渲染和汇率刷新入口。
 *
 * 注意： 统计口径依赖订阅 domain 类型、Settings.defaultCurrency 和 USD base 月度快照；
 * 修改其中任一处都要同步首页统计、SpendingChart 和导出逻辑。
 */

import { useCallback, useMemo, useState } from 'react';
import type { Subscription } from '@/types/subscription';
import { EditSubscriptionDialog } from '@/components/edit-subscription-dialog';
import { RenewSubscriptionDialog } from '@/components/renew-subscription-dialog';
import { Header } from '@/components/header';
import { StatisticsPageSkeleton } from '@/components/loading-skeleton';
import { RechartsFrame } from '@/components/recharts-frame';
import { SubscriptionDetailDialog } from '@/components/subscription-detail-dialog';
import { StatisticsTrendChart } from '@/components/statistics-trend-chart';
import { PieChart, Pie, Cell, Tooltip as RechartsTooltip } from 'recharts';
import { CircleHelp, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useReportExchangeRates } from '@/hooks/use-report-exchange-rates';
import { moneyToNumber } from "@renewlet/shared/money";
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useSubscriptions } from '@/hooks/use-subscriptions';
import { useSettings } from '@/hooks/use-settings';
import { useCustomConfig } from '@/contexts/CustomConfigContext';
import { useStatisticsModel } from '@/modules/subscriptions/application/use-statistics-model';
import { useSubscriptionCrud } from '@/modules/subscriptions/application/use-subscription-crud';
import { collectSubscriptionTags } from '@/modules/subscriptions/domain/subscription-filters';
import { resolveSubscriptionPriceReferenceCurrency } from '@/modules/subscriptions/domain/subscription-price-reference';
import { useI18n } from '@/i18n/I18nProvider';
import { useSubscriptionDetailDialog } from '@/hooks/use-subscription-detail-dialog';
import { todayDateOnlyInTimeZone } from '@/lib/time/date-only';

/** 空订阅数组：用于在数据未加载完成时提供稳定引用，避免 useMemo 依赖抖动。 */
const EMPTY_SUBSCRIPTIONS: Subscription[] = [];
const STATISTICS_DONUT_CHART_HEIGHT = 220;

type ChartValueKind = "currency" | "number";

type ChartTooltipPayload = {
  value?: unknown;
  name?: unknown;
};

type ChartTooltipProps = {
  active: boolean;
  payload: readonly ChartTooltipPayload[];
  valueKind: ChartValueKind;
};

type StatisticsChartDatum = {
  name: string;
  value: number;
  color: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readChartTooltipProps(value: unknown, valueKind: ChartValueKind): ChartTooltipProps {
  // Recharts 传入的 tooltip payload 不属于本项目 API 契约；局部窄化能把第三方不稳定类型隔离在页面内。
  if (!isRecord(value)) return { active: false, payload: [], valueKind };
  const payload = Array.isArray(value["payload"])
    ? value["payload"].filter(isRecord)
    : [];
  return {
    active: value["active"] === true,
    payload,
    valueKind,
  };
}

interface StatBoxProps {
  /** 统计值（数值或已格式化字符串）。 */
  value: string | number;
  /** 统计标题。 */
  label: string;
  /** 可选：右下角图标。 */
  icon?: React.ReactNode;
  /** 展示风格（影响 value 的颜色）。 */
  variant?: 'default' | 'primary' | 'success' | 'warning';
  /** 可选：统计口径说明，会在标题旁显示可聚焦提示图标。 */
  description?: string;
}

/** 统计卡片（用于顶部概要数据）。 */
const StatBox = ({ value, label, icon, variant = 'default', description }: StatBoxProps) => {
  const { t } = useI18n();
  const valueColor = {
    default: 'text-foreground',
    primary: 'text-foreground',
    success: 'text-emerald-500',
    warning: 'text-amber-500',
  }[variant];

  return (
    <div className="min-w-0 rounded-xl border border-border bg-card p-5 flex flex-col items-center justify-center text-center transition-all hover:bg-card-hover hover:shadow-lg">
      <p className={cn("max-w-full break-words text-2xl sm:text-3xl font-bold", valueColor)}>{value}</p>
      <div className="mt-1 flex max-w-full items-center justify-center gap-1 text-sm text-muted-foreground">
        <span className="min-w-0 break-words">{label}</span>
        {description ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="inline-flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground/80 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                aria-label={t("statistics.explain", { label })}
              >
                <CircleHelp className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-64 text-left text-xs leading-relaxed">
              {description}
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      {icon && <div className="mt-2 text-muted-foreground/50">{icon}</div>}
    </div>
  );
};

/** 统计分析页组件。 */
const Statistics = () => {
  const subscriptionsQuery = useSubscriptions();
  const subscriptions = subscriptionsQuery.data ?? EMPTY_SUBSCRIPTIONS;
  const settingsQuery = useSettings();
  const settings = settingsQuery.data;
  const { config } = useCustomConfig();
  const monthlyBudget = settings?.monthlyBudget ?? "0";
  const monthlyBudgetAmount = moneyToNumber(monthlyBudget);
  const defaultCurrency = settings?.defaultCurrency ?? "CNY";
  const priceReferenceCurrency = settings ? resolveSubscriptionPriceReferenceCurrency(settings) : null;
  const timeZone = settings?.timezone ?? "UTC";
  const { locale, t, formatCurrency, formatDateTime, formatNumber } = useI18n();
  const [personalCostBasis, setPersonalCostBasis] = useState(false);

  const { convert, loading: ratesLoading, refresh: refreshRates, lastUpdated, error: ratesError, sourceDate: ratesSourceDate } = useReportExchangeRates(settings?.exchangeRateProvider);
  const currencyRatesReady = Boolean(ratesSourceDate) && !ratesLoading;
  const stats = useStatisticsModel(subscriptions, config, monthlyBudget, defaultCurrency, convert, timeZone, locale, personalCostBasis ? "personal" : "total");
  const {
    editingSubscription,
    editDialogOpen,
    renewingSubscription,
    renewDialogOpen,
    renewError,
    renewSubmitting,
    renewRestoreFocusRef,
    handleAddSubscription,
    handleEditSubscription,
    handleRenewSubscription,
    handleSubmitRenewSubscription,
    handleSaveSubscription,
    handleEditDialogOpenChange,
    handleRenewDialogOpenChange,
  } = useSubscriptionCrud(subscriptions);
  const availableTags = useMemo(() => collectSubscriptionTags(subscriptions), [subscriptions]);
  const today = useMemo(() => todayDateOnlyInTimeZone(new Date(), timeZone), [timeZone]);
  const {
    detailDialogOpen,
    selectedDetailSubscription,
    handleViewDetails: handleViewTrendSubscriptionDetails,
    handleDetailDialogOpenChange,
  } = useSubscriptionDetailDialog(subscriptions);
  const handleEditFromDetail = useCallback((subscription: Subscription) => {
    handleEditSubscription(subscription.id);
  }, [handleEditSubscription]);

  const CustomTooltip = ({ active, payload, valueKind }: ChartTooltipProps) => {
    const first = payload?.[0];
    if (active && first) {
      const rawValue = first.value;
      const displayValue =
        typeof rawValue === 'number'
          ? valueKind === "currency"
            ? formatCurrency(rawValue, defaultCurrency)
            : formatNumber(rawValue, { maximumFractionDigits: 2 })
          : Array.isArray(rawValue)
            ? rawValue.map((item) => String(item)).join(', ')
            : String(rawValue ?? '');
      const label = typeof first.name === "string" || typeof first.name === "number" ? first.name : "";

      return (
        <div className="bg-card border border-border rounded-lg px-3 py-2 shadow-lg">
          <p className="text-sm font-medium">{label}</p>
          <p className="text-sm text-foreground">{displayValue}</p>
        </div>
      );
    }
    return null;
  };

  const renderDonutChart = (data: readonly StatisticsChartDatum[], valueKind: ChartValueKind, chartTitle: string) => {
    const chartData = [...data];

    return (
      <div className="grid min-w-0 gap-2">
        <RechartsFrame height={STATISTICS_DONUT_CHART_HEIGHT} testId="statistics-chart-frame">
          <PieChart
            accessibilityLayer
            margin={{ top: 4, right: 4, bottom: 4, left: 4 }}
            tabIndex={0}
            title={chartTitle}
          >
            <Pie
              data={chartData}
              cx="50%"
              cy="50%"
              innerRadius="58%"
              outerRadius="90%"
              paddingAngle={2}
              cornerRadius={4}
              dataKey="value"
              rootTabIndex={-1}
              strokeWidth={0}
              // 关闭入场动画：避免 SVG 动画在部分设备上导致首次渲染卡顿
              isAnimationActive={false}
            >
              {chartData.map((entry, index) => (
                <Cell
                  key={`cell-${index}`}
                  fill={entry.color}
                  focusable={false}
                  className="transition-all duration-300 hover:opacity-80"
                />
              ))}
            </Pie>
            <RechartsTooltip
              content={(props: unknown) => <CustomTooltip {...readChartTooltipProps(props, valueKind)} />}
              isAnimationActive={false}
              offset={12}
              allowEscapeViewBox={{ x: true, y: true }}
              wrapperStyle={{ pointerEvents: "none" }}
            />
          </PieChart>
        </RechartsFrame>
        <div className="flex flex-wrap justify-center gap-x-4 gap-y-2" role="list">
          {chartData.map((entry) => (
            <div key={entry.name} className="flex min-w-0 items-center gap-1.5 text-xs" role="listitem">
              <span
                className="h-3 w-3 shrink-0 rounded-full"
                style={{ backgroundColor: entry.color }}
                aria-hidden="true"
              />
              <span className="truncate text-muted-foreground">{entry.name}</span>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderEmptyChart = () => {
    return (
      <div
        className="flex min-w-0 items-center justify-center text-muted-foreground"
        style={{ height: STATISTICS_DONUT_CHART_HEIGHT }}
      >
        {t("common.noData")}
      </div>
    );
  };

  // 汇率 hook 有内置 fallback；远端刷新中继续渲染统计内容，避免切页后因为第三方汇率慢而整页回退骨架。
  if (subscriptionsQuery.isPending || settingsQuery.isPending) {
    return (
      <div className="app-page bg-background">
        <Header onAddSubscription={handleAddSubscription} availableTags={availableTags} />
        <main className="app-main mx-auto max-w-7xl">
          <StatisticsPageSkeleton withPageShell={false} />
        </main>
      </div>
    );
  }

  return (
    <div className="app-page bg-background">
      <Header onAddSubscription={handleAddSubscription} availableTags={availableTags} />

      <main className="app-main mx-auto max-w-7xl">
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-foreground">{t("statistics.title")}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("statistics.subtitle")}
              {lastUpdated && !ratesLoading && (
                <span className="ml-2 text-xs">
                  {t("statistics.ratesUpdatedAt", { date: formatDateTime(lastUpdated, { year: "numeric", month: "2-digit", day: "2-digit" }) })}
                </span>
              )}
            </p>
          </div>
          <Button 
            variant="outline" 
            size="sm" 
            onClick={() => void refreshRates()}
            disabled={ratesLoading}
            className="w-full gap-2 sm:w-auto"
          >
            <RefreshCw className={cn("h-4 w-4", ratesLoading && "animate-spin")} />
            {t("statistics.refreshRates")}
          </Button>
        </div>

        {ratesError && (
          <div className="mb-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-600 text-sm">
            {t("statistics.ratesError", { error: ratesError })}
          </div>
        )}

        {/* 总体统计 */}
        <section className="mb-8">
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="text-lg font-semibold text-foreground">{t("statistics.overview")}</h2>
            <label className="inline-flex w-fit items-center gap-2 text-sm text-muted-foreground">
              <Switch checked={personalCostBasis} onCheckedChange={setPersonalCostBasis} aria-label={t("statistics.personalCostBasis")} />
              {t("statistics.personalCostBasis")}
            </label>
          </div>
          <div className="grid grid-cols-1 min-[380px]:grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            <StatBox
              value={stats.activeCount}
              label={t("statistics.activeSubscriptions")}
              variant="primary"
            />
            <StatBox
              value={formatCurrency(stats.totalMonthly, defaultCurrency)}
              label={t("statistics.monthlyCost", { currency: defaultCurrency })}
              variant="primary"
            />
            <StatBox
              value={formatCurrency(stats.totalAnnual, defaultCurrency)}
              label={t("statistics.annualCost", { currency: defaultCurrency })}
              variant="primary"
            />
            <StatBox
              value={formatCurrency(stats.avgMonthlyPerSub, defaultCurrency)}
              label={t("statistics.avgMonthly")}
            />
            <StatBox
              value={stats.mostExpensive ? formatCurrency(convert(stats.mostExpensive.price, stats.mostExpensive.currency, defaultCurrency), defaultCurrency) : '-'}
              label={stats.mostExpensive ? t("statistics.mostExpensiveNamed", { name: stats.mostExpensive.name }) : t("statistics.mostExpensive")}
            />
            <StatBox
              value={formatCurrency(stats.thisMonthDue, defaultCurrency)}
              label={t("statistics.thisMonthDue")}
              variant="warning"
            />
            <StatBox
              value={`${stats.budgetUsedPercent.toFixed(1)}%`}
              label={t("statistics.budgetPercent")}
              variant={stats.budgetUsedPercent > 80 ? 'warning' : 'primary'}
            />
            <StatBox
              value={formatCurrency(stats.budgetRemaining, defaultCurrency)}
              label={t("statistics.budgetRemaining")}
              variant={stats.budgetRemaining < 0 ? 'warning' : 'success'}
            />
            <StatBox
              value={stats.inactiveCount}
              label={t("statistics.inactiveSubscriptions")}
            />
            <StatBox
              value={formatCurrency(stats.monthlySavings, defaultCurrency)}
              label={t("statistics.monthlySavings")}
              variant="success"
              description={t("statistics.monthlySavingsDescription")}
            />
            <StatBox
              value={formatCurrency(stats.annualSavings, defaultCurrency)}
              label={t("statistics.annualSavings")}
              variant="success"
              description={t("statistics.annualSavingsDescription")}
            />
          </div>
        </section>

        <StatisticsTrendChart
          data={stats.trendData}
          defaultCurrency={defaultCurrency}
          onViewSubscriptionDetails={handleViewTrendSubscriptionDetails}
        />

        {/* 拆分视图 */}
        <section>
          <h2 className="text-lg font-semibold text-foreground mb-4">{t("statistics.breakdown")}</h2>
          <div className="grid min-w-0 gap-6 md:grid-cols-2">
            {/* 分类视图 */}
            <div className="min-w-0 rounded-xl border border-border bg-card p-6">
              <h3 className="text-base font-semibold text-foreground text-center mb-1">{t("statistics.categoryView")}</h3>
              <p className="text-xs text-muted-foreground text-center mb-3">{t("statistics.monthlyCostHint")}</p>
              {stats.categoryData.length > 0 ? (
                renderDonutChart(stats.categoryData, "currency", t("statistics.categoryView"))
              ) : (
                renderEmptyChart()
              )}
            </div>

            {/* 支付方式视图 */}
            <div className="min-w-0 rounded-xl border border-border bg-card p-6">
              <h3 className="text-base font-semibold text-foreground text-center mb-1">{t("statistics.paymentView")}</h3>
              <p className="text-xs text-muted-foreground text-center mb-3">{t("statistics.subscriptionCountHint")}</p>
              {stats.paymentData.length > 0 ? (
                renderDonutChart(stats.paymentData, "number", t("statistics.paymentView"))
              ) : (
                renderEmptyChart()
              )}
            </div>

            {/* 费用与预算 */}
            <div className="min-w-0 rounded-xl border border-border bg-card p-6 md:col-span-2">
              <h3 className="text-base font-semibold text-foreground text-center mb-1">{t("statistics.costBudget")}</h3>
              <p className="text-xs text-muted-foreground text-center mb-3">{t("statistics.monthlyBudgetHint", { amount: formatCurrency(monthlyBudget, defaultCurrency) })}</p>
              {renderDonutChart(stats.budgetChartData, "currency", t("statistics.costBudget"))}
              <div className="mt-4 flex flex-col justify-center gap-4 min-[380px]:flex-row min-[380px]:gap-8">
                <div className="text-center">
                  <p className="text-2xl font-bold text-foreground">{formatCurrency(Math.min(stats.totalMonthly, monthlyBudgetAmount), defaultCurrency)}</p>
                  <p className="text-xs text-muted-foreground">{t("statistics.budgetUsed")}</p>
                </div>
                <div className="text-center">
                  <p className="text-2xl font-bold text-emerald-500">{formatCurrency(Math.max(stats.budgetRemaining, 0), defaultCurrency)}</p>
                  <p className="text-xs text-muted-foreground">{t("statistics.budgetRemaining")}</p>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>

      <EditSubscriptionDialog
        subscription={editingSubscription}
        open={editDialogOpen}
        onOpenChange={handleEditDialogOpenChange}
        onSave={handleSaveSubscription}
        availableTags={availableTags}
      />
      <SubscriptionDetailDialog
        open={detailDialogOpen}
        onOpenChange={handleDetailDialogOpenChange}
        subscription={selectedDetailSubscription}
        onEditSubscription={handleEditFromDetail}
        onRenewSubscription={handleRenewSubscription}
        today={today}
        currencyConvert={convert}
        currencyRatesReady={currencyRatesReady}
        priceReferenceCurrency={priceReferenceCurrency}
      />
      <RenewSubscriptionDialog
        subscription={renewingSubscription}
        open={renewDialogOpen}
        today={today}
        submitting={renewSubmitting}
        error={renewError instanceof Error ? renewError.message : null}
        restoreFocusRef={renewRestoreFocusRef}
        onOpenChange={handleRenewDialogOpenChange}
        onSubmit={handleSubmitRenewSubscription}
      />
    </div>
  );
};

export default Statistics;
