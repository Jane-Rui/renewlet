/**
 * 订阅相关 React Query Hooks（前端数据层）。
 *
 * 说明：
 * - 通过 subscriptionService 读写当前用户订阅数据
 * - Docker 与 Cloudflare 都经 `/api/app/subscriptions`，并在 service 边界统一 normalize + Zod parse
 * - API 返回 date-only 字符串（YYYY-MM-DD），前端在这里统一转成品牌类型
 *
 * 注意： Date 转换只发生在 hook 边界。页面/组件内部应使用 `Subscription` domain 类型，
 * 不要直接消费 API row，避免日期处理散落。
 * 注意： `billingCycle=custom` 与 `customDays` 的判别关系在这里落入 domain union；
 * 修改该转换会影响统计折算、表单回填和通知提醒。
 */

import { useMemo } from "react";
import {
  infiniteQueryOptions,
  queryOptions,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryFunctionContext,
} from "@tanstack/react-query";
import { subscriptionService, type SubscriptionFieldPatch, type SubscriptionListFilters } from "@/services/subscription-service";
import type { Subscription, SubscriptionDraft } from "@/types/subscription";
import type { SubscriptionRenewBody } from "@renewlet/shared/schemas/subscriptions";

const SUBSCRIPTIONS_QUERY_KEY = ["subscriptions"] as const;
const SUBSCRIPTIONS_LIST_QUERY_KEY = [...SUBSCRIPTIONS_QUERY_KEY, "list"] as const;
const SUBSCRIPTIONS_INFINITE_QUERY_KEY = [...SUBSCRIPTIONS_QUERY_KEY, "infinite"] as const;
const SUBSCRIPTIONS_PAGE_QUERY_KEY = [...SUBSCRIPTIONS_QUERY_KEY, "page"] as const;
const SUBSCRIPTIONS_STALE_TIME_MS = 60_000;

interface UseSubscriptionsOptions {
  filters?: SubscriptionListFilters | undefined;
  enabled?: boolean;
}

interface UseInfiniteSubscriptionsOptions {
  enabled?: boolean;
}

export function subscriptionsListQueryOptions(filters?: SubscriptionListFilters) {
  return queryOptions({
    queryKey: [...SUBSCRIPTIONS_LIST_QUERY_KEY, filters ?? null] as const,
    queryFn: () => subscriptionService.list(filters),
    staleTime: SUBSCRIPTIONS_STALE_TIME_MS,
  });
}

export function subscriptionsInfiniteQueryOptions() {
  return infiniteQueryOptions({
    queryKey: SUBSCRIPTIONS_INFINITE_QUERY_KEY,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }: QueryFunctionContext<typeof SUBSCRIPTIONS_INFINITE_QUERY_KEY, string | null>) =>
      subscriptionService.listPage(pageParam),
    getNextPageParam: (lastPage: Awaited<ReturnType<typeof subscriptionService.listPage>>) => lastPage.nextCursor ?? undefined,
    staleTime: SUBSCRIPTIONS_STALE_TIME_MS,
  });
}

export function subscriptionsPageQueryOptions(cursor?: string | null, limit?: number) {
  return queryOptions({
    queryKey: [...SUBSCRIPTIONS_PAGE_QUERY_KEY, cursor ?? null, limit ?? subscriptionService.pageSize] as const,
    queryFn: () => subscriptionService.listPage(cursor, limit),
    staleTime: SUBSCRIPTIONS_STALE_TIME_MS,
  });
}

/** useSubscriptions 保留全量列表入口，避免统计/导出逻辑自己拼分页结果造成口径漂移。 */
export function useSubscriptions(options: UseSubscriptionsOptions = {}) {
  return useQuery({
    ...subscriptionsListQueryOptions(options.filters),
    enabled: options.enabled ?? true,
  });
}

/**
 * useInfiniteSubscriptions 读取游标分页订阅并在 hook 边界摊平成列表。
 *
 * 页面只消费 `subscriptions`，避免把 Worker/Go 的分页响应形状泄漏到筛选、虚拟列表和 CRUD 控制器。
 */
export function useInfiniteSubscriptions(options: UseInfiniteSubscriptionsOptions = {}) {
  const query = useInfiniteQuery({
    ...subscriptionsInfiniteQueryOptions(),
    enabled: options.enabled ?? true,
  });
  const subscriptions = useMemo(
    () => query.data?.pages.flatMap((page) => page.subscriptions) ?? [],
    [query.data?.pages],
  );
  return {
    ...query,
    subscriptions,
    total: query.data?.pages[0]?.total,
  };
}

/** useSubscriptionsPage 让局部视图显式绑定 cursor/limit，避免复用无限滚动缓存时读到错误页。 */
export function useSubscriptionsPage(cursor?: string | null, limit?: number) {
  return useQuery({
    ...subscriptionsPageQueryOptions(cursor, limit),
  });
}

/** invalidateSubscriptionsQueries 让列表、分页和无限滚动缓存共享同一个失效前缀。 */
export function invalidateSubscriptionsQueries(queryClient: QueryClient) {
  return queryClient.invalidateQueries({ queryKey: SUBSCRIPTIONS_QUERY_KEY });
}

/** useCreateSubscription 写入后只失效订阅缓存，由 service 层负责 Docker/Cloudflare 运行面分流。 */
export function useCreateSubscription() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (sub: SubscriptionDraft) => {
      return await subscriptionService.create(sub);
    },
    onSuccess: () => {
      // 订阅数据会驱动统计、日历和通知预览；写操作后统一让订阅列表成为失效源。
      invalidateSubscriptionsQueries(queryClient);
    },
  });
}

/** useUpdateSubscription 保存完整 domain 对象，避免编辑弹窗关心 API patch 形状。 */
export function useUpdateSubscription() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (sub: Subscription) => {
      return await subscriptionService.update(sub);
    },
    onSuccess: () => {
      invalidateSubscriptionsQueries(queryClient);
    },
  });
}

/** usePatchSubscription 表达卡片快捷操作的字段级意图，避免旧列表快照覆盖并发编辑。 */
export function usePatchSubscription() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: SubscriptionFieldPatch }) => {
      return await subscriptionService.patch(id, patch);
    },
    onSuccess: () => {
      invalidateSubscriptionsQueries(queryClient);
    },
  });
}

/** useRenewSubscription 只触发手动续订 API；成功后由统一订阅前缀刷新统计、列表和详情快照。 */
export function useRenewSubscription() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, payload }: { id: string; payload: SubscriptionRenewBody }) => {
      return await subscriptionService.renew(id, payload);
    },
    onSuccess: () => {
      invalidateSubscriptionsQueries(queryClient);
    },
  });
}

/** useDeleteSubscription 删除后统一失效订阅前缀，保证统计和日历入口不读旧列表。 */
export function useDeleteSubscription() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await subscriptionService.delete(id);
    },
    onSuccess: () => {
      invalidateSubscriptionsQueries(queryClient);
    },
  });
}
