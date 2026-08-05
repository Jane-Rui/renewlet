/**
 * 订阅筛选领域逻辑。
 *
 * 架构位置：
 * - 页面和 hook 管理筛选/排序状态，domain 只关心“给定状态如何得到结果”。
 * - 纯函数便于后续补单测，避免搜索/标签/排序逻辑散落在列表页 JSX 中。
 */
import { DEFAULT_LOCALE, type Locale } from "@/i18n/locales";
import { toMonthlyAmount } from "@/lib/subscription-billing";
import { compareDateOnly, type DateOnly } from "@/lib/time/date-only";
import type { SubscriptionListFilters } from "@/services/subscription-service";
import type { BillingCycle, Category, Subscription, SubscriptionStatus } from "@/types/subscription";
import { compareMoney } from "@renewlet/shared/money";
import { SUBSCRIPTION_PAYMENT_METHOD_NONE } from "@renewlet/shared/schemas/subscriptions";
import { getEffectiveSubscriptionStatus } from "./subscription-status";

export interface SubscriptionFilterState {
  searchQuery: string;
  selectedCategories: Category[];
  statusFilter: SubscriptionStatus | "all";
  renewalFilter: SubscriptionRenewalFilter;
  selectedTags: string[];
}

export type SubscriptionBooleanFilter = "all" | "yes" | "no";
export type SubscriptionReminderModeFilter = "all" | "disabled" | "inherit" | "custom";

export interface SubscriptionAdvancedFilterState {
  selectedBillingCycles: BillingCycle[];
  selectedPaymentMethods: string[];
  selectedCurrencies: string[];
  nextBillingFrom: string;
  nextBillingTo: string;
  pinnedFilter: SubscriptionBooleanFilter;
  publicHiddenFilter: SubscriptionBooleanFilter;
  reminderModeFilter: SubscriptionReminderModeFilter;
  repeatReminderFilter: SubscriptionBooleanFilter;
}

export const SUBSCRIPTION_PAYMENT_METHOD_NONE_VALUE = SUBSCRIPTION_PAYMENT_METHOD_NONE;

export const DEFAULT_SUBSCRIPTION_ADVANCED_FILTERS: SubscriptionAdvancedFilterState = {
  selectedBillingCycles: [],
  selectedPaymentMethods: [],
  selectedCurrencies: [],
  nextBillingFrom: "",
  nextBillingTo: "",
  pinnedFilter: "all",
  publicHiddenFilter: "all",
  reminderModeFilter: "all",
  repeatReminderFilter: "all",
};

export interface SubscriptionFilterContext {
  today: DateOnly | string;
}

export const SUBSCRIPTION_SORT_OPTIONS = [
  "default",
  "renewal_asc",
  "renewal_desc",
  "monthly_cost_desc",
  "monthly_cost_asc",
  "price_desc",
  "price_asc",
  "name_asc",
  "name_desc",
] as const;

/** 订阅列表排序选项。 */
export type SubscriptionSortOption = (typeof SUBSCRIPTION_SORT_OPTIONS)[number];

export const SUBSCRIPTION_RENEWAL_FILTERS = ["all", "auto", "manual", "one-time"] as const;
export type SubscriptionRenewalFilter = (typeof SUBSCRIPTION_RENEWAL_FILTERS)[number];

export interface SubscriptionSortContext {
  sortOption: SubscriptionSortOption;
  defaultCurrency: string;
  convert: (amount: number | string, from: string, to: string) => number;
  locale?: Locale;
}

/** 收集订阅中出现过的所有标签。 */
export function collectSubscriptionTags(subscriptions: readonly Subscription[]): string[] {
  const tags = new Set<string>();
  for (const subscription of subscriptions) {
    for (const tag of subscription.tags ?? []) {
      tags.add(tag);
    }
  }
  return Array.from(tags);
}

/** 按搜索、分类、状态和标签筛选订阅。 */
export function filterSubscriptions(
  subscriptions: readonly Subscription[],
  filters: SubscriptionFilterState,
  { today }: SubscriptionFilterContext,
): Subscription[] {
  const query = filters.searchQuery.trim().toLowerCase();

  return subscriptions.filter((subscription) => {
    // 搜索覆盖名称、站点、备注和标签；这是用户最常用的“模糊找订阅”入口。
    if (query) {
      const matches =
        subscription.name.toLowerCase().includes(query) ||
        subscription.website?.toLowerCase().includes(query) ||
        subscription.notes?.toLowerCase().includes(query) ||
        (subscription.tags ?? []).some((tag) => tag.toLowerCase().includes(query));
      if (!matches) return false;
    }

    // 订阅本身仍是单分类，多选筛选只能用 OR：命中任一已选分类即可保留。
    if (
      filters.selectedCategories.length > 0 &&
      !filters.selectedCategories.includes(subscription.category)
    ) {
      return false;
    }

    // 状态筛选必须走“有效状态”，否则旧 active/trial 过期记录无法被“已过期”筛出，也会继续出现在“活跃/试用中”。
    if (filters.statusFilter !== "all" && getEffectiveSubscriptionStatus(subscription, today) !== filters.statusFilter) {
      return false;
    }

    if (filters.renewalFilter === "one-time" && subscription.billingCycle !== "one-time") {
      return false;
    }
    if (filters.renewalFilter === "auto" && (subscription.billingCycle === "one-time" || !subscription.autoRenew)) {
      return false;
    }
    if (filters.renewalFilter === "manual" && (subscription.billingCycle === "one-time" || subscription.autoRenew)) {
      return false;
    }

    // 标签筛选使用 OR 语义：选中任一标签即可命中，符合“快速缩小范围”的交互直觉。
    if (
      filters.selectedTags.length > 0 &&
      !filters.selectedTags.some((tag) => subscription.tags?.includes(tag))
    ) {
      return false;
    }

    return true;
  });
}

function getSortDirection(sortOption: SubscriptionSortOption): 1 | -1 {
  return sortOption.endsWith("_desc") ? -1 : 1;
}

function calculateMonthlyCost(
  subscription: Subscription,
  defaultCurrency: string,
  convert: (amount: number | string, from: string, to: string) => number,
): number {
  const amountInDefault = convert(subscription.price, subscription.currency, defaultCurrency);
  return toMonthlyAmount(
    amountInDefault,
    subscription.billingCycle,
    subscription.customDays,
    subscription.customCycleUnit,
    subscription.oneTimeTermCount,
    subscription.oneTimeTermUnit,
  );
}

function comparePinnedFirst(left: Subscription, right: Subscription): number {
  if (left.pinned === right.pinned) return 0;
  return left.pinned ? -1 : 1;
}

/** 按指定选项对订阅排序；置顶分组永远优先，相同排序值保持传入顺序，避免列表无意义跳动。 */
export function sortSubscriptions(
  subscriptions: readonly Subscription[],
  { sortOption, defaultCurrency, convert, locale = DEFAULT_LOCALE }: SubscriptionSortContext,
): Subscription[] {
  if (sortOption === "default") {
    return Array.from(subscriptions).sort((left, right) => comparePinnedFirst(left, right));
  }

  const direction = getSortDirection(sortOption);
  const collator = new Intl.Collator(locale, { sensitivity: "base", numeric: true });
  const decorated = subscriptions.map((subscription, index) => ({
    subscription,
    index,
    monthlyCost:
      sortOption === "monthly_cost_asc" || sortOption === "monthly_cost_desc"
        ? calculateMonthlyCost(subscription, defaultCurrency, convert)
        : null,
  }));

  return decorated
    .sort((left, right) => {
      const pinnedComparison = comparePinnedFirst(left.subscription, right.subscription);
      if (pinnedComparison !== 0) return pinnedComparison;

      let comparison = 0;

      switch (sortOption) {
        case "renewal_asc":
        case "renewal_desc":
          comparison = compareDateOnly(left.subscription.nextBillingDate, right.subscription.nextBillingDate);
          break;
        case "monthly_cost_asc":
        case "monthly_cost_desc":
          comparison = (left.monthlyCost ?? 0) - (right.monthlyCost ?? 0);
          break;
        case "price_asc":
        case "price_desc":
          comparison = compareMoney(left.subscription.price, right.subscription.price);
          break;
        case "name_asc":
        case "name_desc":
          comparison = collator.compare(left.subscription.name, right.subscription.name);
          break;
      }

      if (comparison === 0) return left.index - right.index;
      return comparison * direction;
    })
    .map((item) => item.subscription);
}

/** 判断当前是否存在任何筛选条件。 */
export function hasActiveSubscriptionFilters(filters: SubscriptionFilterState): boolean {
  return Boolean(
    filters.searchQuery ||
      filters.selectedCategories.length > 0 ||
      filters.statusFilter !== "all" ||
      filters.renewalFilter !== "all" ||
      filters.selectedTags.length > 0,
  );
}

export function hasActiveSubscriptionAdvancedFilters(filters: SubscriptionAdvancedFilterState): boolean {
  return Boolean(
    filters.selectedBillingCycles.length > 0 ||
      filters.selectedPaymentMethods.length > 0 ||
      filters.selectedCurrencies.length > 0 ||
      filters.nextBillingFrom ||
      filters.nextBillingTo ||
      filters.pinnedFilter !== "all" ||
      filters.publicHiddenFilter !== "all" ||
      filters.reminderModeFilter !== "all" ||
      filters.repeatReminderFilter !== "all",
  );
}

/** 判断当前筛选条控件是否偏离默认状态（包含排序）。 */
export function hasActiveSubscriptionControls(
  filters: SubscriptionFilterState,
  sortOption: SubscriptionSortOption,
  advancedFilters: SubscriptionAdvancedFilterState = DEFAULT_SUBSCRIPTION_ADVANCED_FILTERS,
): boolean {
  return hasActiveSubscriptionFilters(filters) || hasActiveSubscriptionAdvancedFilters(advancedFilters) || sortOption !== "default";
}

function booleanFilterToQuery(value: SubscriptionBooleanFilter): boolean | undefined {
  if (value === "yes") return true;
  if (value === "no") return false;
  return undefined;
}

export function buildSubscriptionListFilters(
  filters: SubscriptionFilterState,
  advancedFilters: SubscriptionAdvancedFilterState = DEFAULT_SUBSCRIPTION_ADVANCED_FILTERS,
): SubscriptionListFilters | undefined {
  const query: SubscriptionListFilters = {};
  const searchQuery = filters.searchQuery.trim();
  if (searchQuery) query.q = searchQuery;
  if (filters.selectedCategories.length > 0) query.category = filters.selectedCategories;
  if (filters.selectedTags.length > 0) query.tag = filters.selectedTags;
  if (filters.statusFilter !== "all") query.status = filters.statusFilter;
  if (filters.renewalFilter !== "all") query.renewal = filters.renewalFilter;
  if (advancedFilters.selectedBillingCycles.length > 0) query.billingCycle = advancedFilters.selectedBillingCycles;
  if (advancedFilters.selectedPaymentMethods.length > 0) query.paymentMethod = advancedFilters.selectedPaymentMethods;
  if (advancedFilters.selectedCurrencies.length > 0) query.currency = advancedFilters.selectedCurrencies;
  if (advancedFilters.nextBillingFrom) query.nextBillingFrom = advancedFilters.nextBillingFrom;
  if (advancedFilters.nextBillingTo) query.nextBillingTo = advancedFilters.nextBillingTo;
  const pinned = booleanFilterToQuery(advancedFilters.pinnedFilter);
  if (pinned !== undefined) query.pinned = pinned;
  const publicHidden = booleanFilterToQuery(advancedFilters.publicHiddenFilter);
  if (publicHidden !== undefined) query.publicHidden = publicHidden;
  if (advancedFilters.reminderModeFilter !== "all") query.reminderMode = advancedFilters.reminderModeFilter;
  const repeatReminder = booleanFilterToQuery(advancedFilters.repeatReminderFilter);
  if (repeatReminder !== undefined) query.repeatReminder = repeatReminder;
  return Object.keys(query).length > 0 ? query : undefined;
}
