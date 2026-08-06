/**
 * 仪表盘首页（/）。
 *
 * 展示内容：
 * - 汇总统计：月度支出/活跃订阅/即将续费/试用中
 * - 近期订阅卡片
 * - 支出分布图（按分类/币种换算）
 * - 即将续费列表
 *
 * 架构位置：
 * - 页面只做数据 hook 装配和布局。
 * - 首页统计由 `useDashboardStats` 生成，CRUD 弹窗状态由 `useSubscriptionCrud` 管理。
 */

import { useCallback, useMemo, useState } from "react";
import Link from '@/components/router-link';
import type { Subscription } from "@/types/subscription";
import { Header } from "@/components/header";
import { dashboardStatLayout } from "@/components/dashboard-stat-layout";
import { StatCard } from "@/components/ui/stat-card";
import { SubscriptionCard } from "@/components/subscription-card";
import { SubscriptionDetailDialog } from "@/components/subscription-detail-dialog";
import { SpendingChart } from "@/components/spending-chart";
import { UpcomingRenewals } from "@/components/upcoming-renewals";
import { DashboardPageSkeleton } from "@/components/loading-skeleton";
import { EditSubscriptionDialog } from "@/components/edit-subscription-dialog";
import { CreditCard, TrendingUp, Clock, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useReportExchangeRates } from "@/hooks/use-report-exchange-rates";
import { useSubscriptions } from "@/hooks/use-subscriptions";
import { useSettings } from "@/hooks/use-settings";
import { useCustomConfig } from "@/contexts/CustomConfigContext";
import { useDashboardStats } from "@/modules/subscriptions/application/use-dashboard-stats";
import { useSubscriptionCrud } from "@/modules/subscriptions/application/use-subscription-crud";
import { collectSubscriptionTags } from "@/modules/subscriptions/domain/subscription-filters";
import { useI18n } from "@/i18n/I18nProvider";
import { DEFAULT_NOTIFICATION_REMINDER_DAYS } from "@/types/subscription";
import { useDeferredDialogCleanup } from "@/hooks/use-deferred-dialog-cleanup";
import { todayDateOnlyInTimeZone } from "@/lib/time/date-only";
import { cn } from "@/lib/utils";

const EMPTY_SUBSCRIPTIONS: Subscription[] = [];

/** 仪表盘页面组件。 */
export default function Index() {
  const subscriptionsQuery = useSubscriptions();
  const subscriptions = subscriptionsQuery.data ?? EMPTY_SUBSCRIPTIONS;
  const settingsQuery = useSettings();
  const settings = settingsQuery.data;
  const { config } = useCustomConfig();
  const { t, formatCurrency } = useI18n();
  const exchangeRateProvider = settings?.exchangeRateProvider;
  const { convert, loading: ratesLoading } = useReportExchangeRates(exchangeRateProvider);
  const defaultCurrency = settings?.defaultCurrency ?? "CNY";
  const timeZone = settings?.timezone ?? "UTC";
  const inheritedReminderDays = settings?.notificationReminderDays ?? DEFAULT_NOTIFICATION_REMINDER_DAYS;
  const categoryByValue = useMemo(() => new Map(config.categories.map((category) => [category.value, category])), [config.categories]);
  const paymentMethodByValue = useMemo(() => new Map(config.paymentMethods.map((method) => [method.value, method])), [config.paymentMethods]);
  const availableTags = useMemo(() => collectSubscriptionTags(subscriptions), [subscriptions]);
  const today = useMemo(() => todayDateOnlyInTimeZone(new Date(), timeZone), [timeZone]);
  const [detailSubscriptionId, setDetailSubscriptionId] = useState<string | null>(null);
  const [detailDialogOpen, setDetailDialogOpen] = useState(false);
  const selectedDetailSubscription = useMemo(
    () => subscriptions.find((item) => item.id === detailSubscriptionId) ?? null,
    [detailSubscriptionId, subscriptions],
  );
  const { scheduleCleanup: scheduleDetailCleanup, cancelCleanup: cancelDetailCleanup } =
    useDeferredDialogCleanup(() => {
      // 详情弹窗关闭动画期间仍要保留内容快照，避免 Dialog/Drawer fade-out 时标题和备注闪空。
      setDetailSubscriptionId(null);
    });
  const { activeSubscriptions, totalMonthly, upcomingCount, trialCount } = useDashboardStats(
    subscriptions,
    defaultCurrency,
    convert,
    timeZone,
    inheritedReminderDays,
  );
  const {
    editingSubscription,
    editDialogOpen,
    handleAddSubscription,
    handleDeleteSubscription,
    handleEditSubscription,
    handleTogglePublicHiddenSubscription,
    handleSaveSubscription,
    handleEditDialogOpenChange,
  } = useSubscriptionCrud(subscriptions);
  const handleViewDetails = useCallback((id: string) => {
    cancelDetailCleanup();
    setDetailSubscriptionId(id);
    setDetailDialogOpen(true);
  }, [cancelDetailCleanup]);
  const handleDetailDialogOpenChange = useCallback((nextOpen: boolean) => {
    setDetailDialogOpen(nextOpen);
    if (nextOpen) {
      cancelDetailCleanup();
      return;
    }
    scheduleDetailCleanup();
  }, [cancelDetailCleanup, scheduleDetailCleanup]);
  const handleEditFromDetail = useCallback((subscription: Subscription) => {
    handleEditSubscription(subscription.id);
  }, [handleEditSubscription]);

  // 只有页面主数据还没有首屏结果时才展示骨架屏。
  // 汇率刷新期间保留已有内容，并在统计卡片副标题里提示加载状态，避免整页闪回 loading。
  if (subscriptionsQuery.isPending || settingsQuery.isPending) {
    return (
      <div className="app-page bg-background">
        <Header onAddSubscription={handleAddSubscription} availableTags={availableTags} />
        <main className="app-main mx-auto max-w-7xl">
          <DashboardPageSkeleton withPageShell={false} />
        </main>
      </div>
    );
  }

  // 仪表盘只展示最近 6 个订阅（完整列表在 /subscriptions），保持首页扫描成本低。
  const displayedSubscriptions = subscriptions.slice(0, 6);

  return (
    <div className="app-page bg-background">
      <Header onAddSubscription={handleAddSubscription} availableTags={availableTags} />

      <main className="app-main mx-auto max-w-7xl">
        {/* 统计网格 */}
        <div className={cn("mb-8", dashboardStatLayout.grid)} data-testid="dashboard-stat-grid">
          <StatCard
            data-testid="dashboard-stat-monthly-spend"
            title={t("dashboard.monthlySpend")}
            value={formatCurrency(totalMonthly, defaultCurrency)}
            subtitle={ratesLoading ? t("dashboard.ratesLoading") : t("dashboard.realTimeRates", { currency: defaultCurrency })}
            icon={<CreditCard className="h-6 w-6" />}
            variant="primary"
            density="compact"
            className={cn("animate-fade-in", dashboardStatLayout.primaryCard)}
          />
          <StatCard
            data-testid="dashboard-stat-active-subscriptions"
            title={t("dashboard.activeSubscriptions")}
            value={activeSubscriptions.length}
            subtitle={t("dashboard.totalSubscriptions", { count: subscriptions.length })}
            icon={<TrendingUp className="h-6 w-6" />}
            density="compact"
            className="animate-fade-in [animation-delay:100ms]"
          />
          <StatCard
            data-testid="dashboard-stat-upcoming-renewals"
            title={t("dashboard.upcomingRenewals")}
            value={upcomingCount}
            subtitle={t("dashboard.next7Days")}
            icon={<Clock className="h-6 w-6" />}
            variant={upcomingCount > 0 ? "warning" : "default"}
            density="compact"
            className="animate-fade-in [animation-delay:200ms]"
          />
          <StatCard
            data-testid="dashboard-stat-trials"
            title={t("dashboard.trials")}
            value={trialCount}
            subtitle={t("dashboard.trialsNeedAttention")}
            icon={<Sparkles className="h-6 w-6" />}
            variant={trialCount > 0 ? "warning" : "default"}
            density="compact"
            className={cn("animate-fade-in [animation-delay:300ms]", dashboardStatLayout.trialCard)}
          />
        </div>

        {/* 主内容网格 */}
        <div className="grid gap-8 lg:grid-cols-3">
          {/* 订阅列表 */}
          <div className="lg:col-span-2">
            <div className="mb-5 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-foreground">{t("dashboard.recentSubscriptions")}</h2>
              <Link href="/subscriptions">
                <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground">
                  {t("dashboard.viewAll", { count: subscriptions.length })}
                </Button>
              </Link>
            </div>
            <div className="grid items-stretch gap-4 sm:grid-cols-2">
              {displayedSubscriptions.map((sub, index) => (
                <div key={sub.id} className="h-full animate-fade-in" style={{ animationDelay: `${index * 50}ms` }}>
                  <SubscriptionCard
                    subscription={sub}
                    timeZone={timeZone}
                    inheritedReminderDays={inheritedReminderDays}
                    costSharingCurrencyConvert={convert}
                    categoryByValue={categoryByValue}
                    paymentMethodByValue={paymentMethodByValue}
                    onEdit={handleEditSubscription}
                    onDelete={handleDeleteSubscription}
                    onTogglePublicHidden={handleTogglePublicHiddenSubscription}
                    onViewDetails={handleViewDetails}
                  />
                </div>
              ))}
            </div>
            {subscriptions.length > 6 && (
              <div className="mt-4 text-center">
                <Link href="/subscriptions">
                  <Button variant="outline" className="border-border">
                    {t("dashboard.viewAllSubscriptions", { count: subscriptions.length })}
                  </Button>
                </Link>
              </div>
            )}
          </div>

          {/* 侧边栏 */}
          <div className="grid gap-6">
            {/* 支出图表 */}
            <div className="rounded-xl border border-border bg-card p-6 shadow-card">
              <h3 className="mb-3 text-lg font-semibold text-foreground">{t("dashboard.spendingDistribution")}</h3>
              <SpendingChart
                subscriptions={subscriptions}
                categories={config.categories}
                defaultCurrency={defaultCurrency}
                timeZone={timeZone}
                convert={convert}
              />
            </div>

            {/* 即将续费 */}
            <div className="rounded-xl border border-border bg-card p-6 shadow-card">
              <h3 className="mb-4 text-lg font-semibold text-foreground">{t("dashboard.upcomingRenewals")}</h3>
              <UpcomingRenewals
                subscriptions={subscriptions}
                timeZone={timeZone}
                notificationReminderDays={inheritedReminderDays}
              />
            </div>
          </div>
        </div>
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
        today={today}
      />
    </div>
  );
}
