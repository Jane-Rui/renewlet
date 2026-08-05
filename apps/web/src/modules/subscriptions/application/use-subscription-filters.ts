/**
 * 订阅筛选 application hook。
 *
 * 架构位置：
 * - 持有用户当前筛选条件。
 * - 调用 domain 纯函数得到标签集合和筛选结果。
 *
 * PERF： 订阅量很大时，可把搜索字段预先标准化成索引，避免每次输入都遍历原始字符串。
 */
import { useCallback, useDeferredValue, useMemo, useState } from "react";
import { DEFAULT_LOCALE, type Locale } from "@/i18n/locales";
import { todayDateOnlyInTimeZone } from "@/lib/time/date-only";
import type { Category, Subscription, SubscriptionStatus } from "@/types/subscription";
import { moneyToNumber } from "@renewlet/shared/money";
import {
  collectSubscriptionTags,
  DEFAULT_SUBSCRIPTION_ADVANCED_FILTERS,
  buildSubscriptionListFilters,
  filterSubscriptions,
  hasActiveSubscriptionAdvancedFilters,
  hasActiveSubscriptionControls,
  hasActiveSubscriptionFilters,
  sortSubscriptions,
  type SubscriptionAdvancedFilterState,
  type SubscriptionSortOption,
  type SubscriptionFilterState,
  type SubscriptionRenewalFilter,
} from "../domain/subscription-filters";

interface UseSubscriptionFiltersOptions {
  defaultCurrency?: string;
  convert?: (amount: number | string, from: string, to: string) => number;
  locale?: Locale;
  timeZone?: string;
}

const IDENTITY_CONVERT = (amount: number | string) => moneyToNumber(amount);

/** 管理订阅列表筛选状态，并返回筛选后的结果。 */
export function useSubscriptionFilters(
  subscriptions: readonly Subscription[],
  {
    defaultCurrency = "CNY",
    convert = IDENTITY_CONVERT,
    locale = DEFAULT_LOCALE,
    timeZone = "UTC",
  }: UseSubscriptionFiltersOptions = {},
) {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategories, setSelectedCategories] = useState<Category[]>([]);
  const [statusFilter, setStatusFilter] = useState<SubscriptionStatus | "all">("all");
  const [renewalFilter, setRenewalFilter] = useState<SubscriptionRenewalFilter>("all");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [advancedFilters, setAdvancedFilters] = useState<SubscriptionAdvancedFilterState>(DEFAULT_SUBSCRIPTION_ADVANCED_FILTERS);
  const [sortOption, setSortOption] = useState<SubscriptionSortOption>("default");
  const deferredSearchQuery = useDeferredValue(searchQuery);

  const filters: SubscriptionFilterState = useMemo(
    () => ({ searchQuery: deferredSearchQuery, selectedCategories, statusFilter, renewalFilter, selectedTags }),
    [deferredSearchQuery, renewalFilter, selectedCategories, selectedTags, statusFilter],
  );
  const activeControlFilters: SubscriptionFilterState = useMemo(
    () => ({ searchQuery, selectedCategories, statusFilter, renewalFilter, selectedTags }),
    [renewalFilter, searchQuery, selectedCategories, selectedTags, statusFilter],
  );
  const today = useMemo(() => todayDateOnlyInTimeZone(new Date(), timeZone), [timeZone]);
  const allTags = useMemo(() => collectSubscriptionTags(subscriptions), [subscriptions]);
  const subscriptionListFilters = useMemo(
    () => buildSubscriptionListFilters(filters, advancedFilters),
    [advancedFilters, filters],
  );
  const filteredSubscriptions = useMemo(
    () => filterSubscriptions(subscriptions, filters, { today }),
    [filters, subscriptions, today],
  );
  const sortedSubscriptions = useMemo(
    () => sortSubscriptions(filteredSubscriptions, { sortOption, defaultCurrency, convert, locale }),
    [convert, defaultCurrency, filteredSubscriptions, locale, sortOption],
  );
  const sortSubscriptionsForDisplay = useCallback(
    (items: readonly Subscription[]) => sortSubscriptions(items, { sortOption, defaultCurrency, convert, locale }),
    [convert, defaultCurrency, locale, sortOption],
  );
  const filterSubscriptionsForDisplay = useCallback(
    (items: readonly Subscription[]) => filterSubscriptions(items, filters, { today }),
    [filters, today],
  );
  // 搜索输入立即响应，列表筛选延后到 deferred query，避免大列表每个键入帧都重排虚拟行。
  const hasActiveAdvancedFilters = hasActiveSubscriptionAdvancedFilters(advancedFilters);
  const hasActiveFilters = hasActiveSubscriptionFilters(activeControlFilters) || hasActiveAdvancedFilters;
  const hasActiveControls = hasActiveSubscriptionControls(activeControlFilters, sortOption, advancedFilters);

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
    setRenewalFilter("all");
    setSelectedTags([]);
    setAdvancedFilters(DEFAULT_SUBSCRIPTION_ADVANCED_FILTERS);
    setSortOption("default");
  };

  return {
    searchQuery,
    setSearchQuery,
    selectedCategories,
    setSelectedCategories,
    statusFilter,
    setStatusFilter,
    renewalFilter,
    setRenewalFilter,
    sortOption,
    setSortOption,
    selectedTags,
    setSelectedTags,
    advancedFilters,
    setAdvancedFilters,
    allTags,
    filteredSubscriptions: sortedSubscriptions,
    filterSubscriptionsForDisplay,
    sortSubscriptionsForDisplay,
    subscriptionListFilters,
    hasActiveFilters,
    hasActiveAdvancedFilters,
    hasActiveControls,
    toggleCategory,
    clearSelectedCategories,
    toggleTag,
    clearFilters,
  };
}
