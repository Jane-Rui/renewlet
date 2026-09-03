/**
 * 订阅筛选 application hook。
 *
 * 架构位置：
 * - 持有用户当前筛选条件。
 * - 调用 domain 纯函数得到标签集合和筛选结果。
 */
import { useCallback, useDeferredValue, useMemo, useState } from "react";
import { DEFAULT_LOCALE, type Locale } from "@/i18n/locales";
import { todayDateOnlyInTimeZone, type DateOnly } from "@/lib/time/date-only";
import type { Category, Subscription, SubscriptionCollectionItem, SubscriptionStatus } from "@/types/subscription";
import { moneyToNumber } from "@renewlet/shared/money";
import {
  DEFAULT_SUBSCRIPTION_ADVANCED_FILTERS,
  buildSubscriptionListFilters,
  filterSubscriptionsByListFilters,
  hasActiveSubscriptionAdvancedFilters,
  hasActiveSubscriptionFilters,
  sortSubscriptions,
  type SubscriptionAdvancedFilterState,
  type SubscriptionSortOption,
  type SubscriptionFilterState,
  type SubscriptionPaymentTypeFilter,
} from "../domain/subscription-filters";

interface UseSubscriptionFiltersOptions {
  defaultCurrency?: string;
  convert?: (amount: number | string, from: string, to: string) => number;
  locale?: Locale;
  today?: DateOnly | string;
  availableTags?: readonly string[] | undefined;
}

const IDENTITY_CONVERT = (amount: number | string) => moneyToNumber(amount);

/** 管理订阅列表筛选状态，并返回筛选后的结果。 */
export function useSubscriptionFilters(
  subscriptions: readonly SubscriptionCollectionItem[],
  {
    defaultCurrency = "CNY",
    convert = IDENTITY_CONVERT,
    locale = DEFAULT_LOCALE,
    today = todayDateOnlyInTimeZone(new Date(), "UTC"),
    availableTags = [],
  }: UseSubscriptionFiltersOptions = {},
) {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategories, setSelectedCategories] = useState<Category[]>([]);
  const [statusFilter, setStatusFilter] = useState<SubscriptionStatus | "all">("all");
  const [paymentTypeFilter, setPaymentTypeFilter] = useState<SubscriptionPaymentTypeFilter>("all");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [advancedFilters, setAdvancedFilters] = useState<SubscriptionAdvancedFilterState>(DEFAULT_SUBSCRIPTION_ADVANCED_FILTERS);
  const [sortOption, setSortOption] = useState<SubscriptionSortOption>("default");
  const deferredSearchQuery = useDeferredValue(searchQuery);

  const filters: SubscriptionFilterState = useMemo(
    () => ({ searchQuery: deferredSearchQuery, selectedCategories, statusFilter, paymentTypeFilter, selectedTags }),
    [deferredSearchQuery, paymentTypeFilter, selectedCategories, selectedTags, statusFilter],
  );
  const activeControlFilters: SubscriptionFilterState = useMemo(
    () => ({ searchQuery, selectedCategories, statusFilter, paymentTypeFilter, selectedTags }),
    [paymentTypeFilter, searchQuery, selectedCategories, selectedTags, statusFilter],
  );
  const subscriptionListFilters = useMemo(
    () => buildSubscriptionListFilters(filters, advancedFilters),
    [advancedFilters, filters],
  );
  const activeSubscriptionListFilters = useMemo(
    () => buildSubscriptionListFilters(activeControlFilters, advancedFilters),
    [activeControlFilters, advancedFilters],
  );
  const sortedSubscriptions = useMemo(
    () => sortSubscriptions(subscriptions, { sortOption, today, defaultCurrency, convert, locale }),
    [convert, defaultCurrency, locale, sortOption, subscriptions, today],
  );
  const sortSubscriptionsForDisplay = useCallback(
    <T extends SubscriptionCollectionItem>(items: readonly T[]) =>
      sortSubscriptions(items, { sortOption, today, defaultCurrency, convert, locale }),
    [convert, defaultCurrency, locale, sortOption, today],
  );
  const selectSubscriptionsForExport = useCallback(
    (items: readonly Subscription[]) =>
      sortSubscriptions(filterSubscriptionsByListFilters(items, activeSubscriptionListFilters, { today }), {
        sortOption,
        today,
        defaultCurrency,
        convert,
        locale,
      }),
    [activeSubscriptionListFilters, convert, defaultCurrency, locale, sortOption, today],
  );
  // 搜索输入立即响应，列表筛选延后到 deferred query，避免大列表每个键入帧都重排虚拟行。
  const hasActiveAdvancedFilters = hasActiveSubscriptionAdvancedFilters(advancedFilters);
  const hasActiveFilters = hasActiveSubscriptionFilters(activeControlFilters) || hasActiveAdvancedFilters;
  const hasDeferredFilters = hasActiveSubscriptionFilters(filters) || hasActiveAdvancedFilters;
  const hasCustomSort = sortOption !== "default";
  // index 的启用条件与 query key 必须来自同一份 deferred filters；否则首个字符会先发无筛选全量请求，再发真实搜索请求。
  const needsCollectionIndex = hasDeferredFilters || hasCustomSort;

  const toggleTag = (tag: string) => {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((item) => item !== tag) : [...prev, tag],
    );
  };
  const toggleCategory = (category: Category) => {
    setSelectedCategories((prev) =>
      prev.includes(category) ? prev.filter((item) => item !== category) : [...prev, category],
    );
  };
  const clearSelectedCategories = () => {
    setSelectedCategories([]);
  };

  const clearFilters = () => {
    setSearchQuery("");
    setSelectedCategories([]);
    setStatusFilter("all");
    setPaymentTypeFilter("all");
    setSelectedTags([]);
    setAdvancedFilters(DEFAULT_SUBSCRIPTION_ADVANCED_FILTERS);
  };

  return {
    searchQuery,
    setSearchQuery,
    selectedCategories,
    setSelectedCategories,
    statusFilter,
    setStatusFilter,
    paymentTypeFilter,
    setPaymentTypeFilter,
    sortOption,
    setSortOption,
    selectedTags,
    setSelectedTags,
    advancedFilters,
    setAdvancedFilters,
    allTags: availableTags,
    filteredSubscriptions: sortedSubscriptions,
    sortSubscriptionsForDisplay,
    selectSubscriptionsForExport,
    subscriptionListFilters,
    hasActiveFilters,
    hasActiveAdvancedFilters,
    hasCustomSort,
    needsCollectionIndex,
    toggleCategory,
    clearSelectedCategories,
    toggleTag,
    clearFilters,
  };
}
