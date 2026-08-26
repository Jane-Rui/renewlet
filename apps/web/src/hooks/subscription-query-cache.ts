import type { QueryClient } from "@tanstack/react-query";
import type { DateOnly } from "@/lib/time/date-only";
import type { SubscriptionListFilters } from "@/services/subscription-service";

const EMPTY_FILTERS: SubscriptionListFilters = {};

function queryFilters(filters?: SubscriptionListFilters): SubscriptionListFilters {
  return filters ?? EMPTY_FILTERS;
}

export const subscriptionQueryKeys = {
  all: ["subscriptions"] as const,
  collections: ["subscriptions", "collections"] as const,
  page: (filters?: SubscriptionListFilters) => ["subscriptions", "collections", "page", queryFilters(filters)] as const,
  index: (filters?: SubscriptionListFilters) => ["subscriptions", "collections", "index", queryFilters(filters)] as const,
  analytics: ["subscriptions", "collections", "analytics"] as const,
  calendar: (from: DateOnly, to: DateOnly) => ["subscriptions", "collections", "calendar", from, to] as const,
  facets: ["subscriptions", "collections", "facets"] as const,
  details: ["subscriptions", "details"] as const,
  detail: (id: string) => ["subscriptions", "details", id] as const,
};

export function invalidateSubscriptionCollections(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: subscriptionQueryKeys.collections });
}

export function removeSubscriptionDetails(queryClient: QueryClient): void {
  queryClient.removeQueries({ queryKey: subscriptionQueryKeys.details });
}

export function clearSubscriptionQueries(queryClient: QueryClient): void {
  queryClient.removeQueries({ queryKey: subscriptionQueryKeys.all });
}
