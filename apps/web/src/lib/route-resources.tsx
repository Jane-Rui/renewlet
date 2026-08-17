import { useSyncExternalStore, type ComponentType, type ReactElement } from "react";
import type { QueryClient } from "@tanstack/react-query";
import {
  AdminUsersPageSkeleton,
  CalendarPageSkeleton,
  DashboardPageSkeleton,
  DocumentRouteSkeleton,
  LightweightRouteSkeleton,
  SettingsPageSkeleton,
  StatisticsPageSkeleton,
  SubscriptionsPageSkeleton,
} from "@/components/loading-skeleton";
import { subscriptionsInfiniteQueryOptions } from "@/hooks/use-subscriptions";
import { readProductSession } from "@/services/product-session";

// 路由资源只响应 render 或链接 hover/focus/touch 意图预加载；登录后禁止空闲遍历全部私有 chunk。
// 私有数据预取还要经过产品 session 门禁，并统一写入 subscriptions infinite cache，避免保留第二份全量列表。

type RouteModule = { default: ComponentType };
type RouteLoader = () => Promise<RouteModule>;
type RouteFallbackComponent = () => ReactElement;

export type RoutePreloadMode = "none" | "intent" | "render" | "viewport";

interface RouteResource {
  path: string;
  load: RouteLoader;
  fallback: RouteFallbackComponent;
  preloadData?: (queryClient: QueryClient) => Promise<void>;
}

const loadDashboard = () => import("@/pages/dashboard");
const loadSubscriptions = () => import("@/pages/subscriptions");
const loadCalendar = () => import("@/pages/calendar");
const loadStatistics = () => import("@/pages/statistics");
const loadSettings = () => import("@/pages/settings");
const loadSetup = () => import("@/pages/setup");
const loadLogin = () => import("@/pages/login");
const loadPrivacy = () => import("@/pages/privacy");
const loadTerms = () => import("@/pages/terms");
const loadPublicStatus = () => import("@/pages/public-status");
const loadAdminUsers = () => import("@/pages/admin/users");
const loadForgotPassword = () => import("@/pages/forgot-password");
const loadResetPassword = () => import("@/pages/reset-password");
const loadNotFound = () => import("@/pages/not-found");

function DashboardRouteFallback() {
  return <DashboardPageSkeleton />;
}

function SubscriptionsRouteFallback() {
  return <SubscriptionsPageSkeleton />;
}

function CalendarRouteFallback() {
  return <CalendarPageSkeleton />;
}

function StatisticsRouteFallback() {
  return <StatisticsPageSkeleton />;
}

function SettingsRouteFallback() {
  return <SettingsPageSkeleton />;
}

function AdminUsersRouteFallback() {
  return <AdminUsersPageSkeleton />;
}

function DocumentRouteFallback() {
  return <DocumentRouteSkeleton />;
}

function LightweightRouteFallback() {
  return <LightweightRouteSkeleton />;
}

async function preloadSubscriptionsInfinite(queryClient: QueryClient) {
  await queryClient.prefetchInfiniteQuery(subscriptionsInfiniteQueryOptions());
}

async function preloadSettings(queryClient: QueryClient) {
  const { settingsQueryOptions } = await import("@/hooks/use-settings");
  await queryClient.prefetchQuery(settingsQueryOptions());
}

async function preloadSubscriptionsAndSettings(queryClient: QueryClient) {
  await Promise.all([
    preloadSubscriptionsInfinite(queryClient),
    preloadSettings(queryClient),
  ]);
}

async function preloadSubscriptionsPageData(queryClient: QueryClient) {
  await Promise.all([
    preloadSubscriptionsInfinite(queryClient),
    preloadSettings(queryClient),
  ]);
}

export const routeResources = {
  dashboard: {
    path: "/",
    load: loadDashboard,
    fallback: DashboardRouteFallback,
    preloadData: preloadSubscriptionsAndSettings,
  },
  subscriptions: {
    path: "/subscriptions",
    load: loadSubscriptions,
    fallback: SubscriptionsRouteFallback,
    preloadData: preloadSubscriptionsPageData,
  },
  calendar: {
    path: "/calendar",
    load: loadCalendar,
    fallback: CalendarRouteFallback,
    preloadData: preloadSubscriptionsInfinite,
  },
  statistics: {
    path: "/statistics",
    load: loadStatistics,
    fallback: StatisticsRouteFallback,
    preloadData: preloadSubscriptionsAndSettings,
  },
  settings: {
    path: "/settings",
    load: loadSettings,
    fallback: SettingsRouteFallback,
    preloadData: preloadSubscriptionsAndSettings,
  },
  adminUsers: {
    path: "/admin/users",
    load: loadAdminUsers,
    fallback: AdminUsersRouteFallback,
  },
  setup: {
    path: "/setup",
    load: loadSetup,
    fallback: LightweightRouteFallback,
  },
  login: {
    path: "/login",
    load: loadLogin,
    fallback: LightweightRouteFallback,
  },
  forgotPassword: {
    path: "/forgot-password",
    load: loadForgotPassword,
    fallback: LightweightRouteFallback,
  },
  resetPassword: {
    path: "/reset-password",
    load: loadResetPassword,
    fallback: LightweightRouteFallback,
  },
  privacy: {
    path: "/privacy",
    load: loadPrivacy,
    fallback: DocumentRouteFallback,
  },
  terms: {
    path: "/terms",
    load: loadTerms,
    fallback: DocumentRouteFallback,
  },
  publicStatus: {
    path: "/status",
    load: loadPublicStatus,
    fallback: LightweightRouteFallback,
  },
  notFound: {
    path: "*",
    load: loadNotFound,
    fallback: LightweightRouteFallback,
  },
} as const satisfies Record<string, RouteResource>;

const resourcesByExactPath = new Map<string, RouteResource>(
  Object.values(routeResources)
    .filter((resource) => resource.path !== "*" && resource.path !== "/status")
    .map((resource) => [resource.path, resource]),
);

const inFlightPreloads = new Map<string, Promise<void>>();
const preloadListeners = new Set<() => void>();
let routePreloadPendingCount = 0;

function routeResourceForPathname(pathname: string): RouteResource | null {
  if (pathname.startsWith("/status/")) return routeResources.publicStatus;
  return resourcesByExactPath.get(pathname) ?? null;
}

function routePreloadSnapshot() {
  return routePreloadPendingCount > 0;
}

function subscribeRoutePreload(listener: () => void) {
  preloadListeners.add(listener);
  return () => {
    preloadListeners.delete(listener);
  };
}

function emitRoutePreloadState() {
  for (const listener of preloadListeners) listener();
}

function trackPreloadPromise(promise: Promise<void>) {
  routePreloadPendingCount += 1;
  emitRoutePreloadState();
  const settle = () => {
    routePreloadPendingCount = Math.max(0, routePreloadPendingCount - 1);
    emitRoutePreloadState();
  };
  promise.then(settle, settle);
}

function canPrefetchPrivateData() {
  return Boolean(readProductSession());
}

export function lazyRouteLoader(key: keyof typeof routeResources): RouteLoader {
  return routeResources[key].load;
}

export function routeFallbackForPathname(pathname: string): ReactElement {
  const Fallback = routeResourceForPathname(pathname)?.fallback ?? LightweightRouteFallback;
  return <Fallback />;
}

export function preloadRoute(pathname: string, queryClient?: QueryClient | null): Promise<void> {
  const resource = routeResourceForPathname(pathname);
  if (!resource) return Promise.resolve();

  const existing = inFlightPreloads.get(resource.path);
  if (existing) return existing;

  // 同一路由的 chunk 与数据预取共享 in-flight promise，快速 hover/focus 切换不会制造重复网络请求。
  const preload = Promise.all([
    resource.load(),
    queryClient && resource.preloadData && canPrefetchPrivateData()
      ? resource.preloadData(queryClient)
      : Promise.resolve(),
  ]).then(() => undefined);

  inFlightPreloads.set(resource.path, preload);
  trackPreloadPromise(preload);
  const clearInFlight = () => {
    if (inFlightPreloads.get(resource.path) === preload) {
      inFlightPreloads.delete(resource.path);
    }
  };
  preload.then(clearInFlight, clearInFlight);
  return preload;
}

export function useRoutePreloadPending(): boolean {
  return useSyncExternalStore(subscribeRoutePreload, routePreloadSnapshot, () => false);
}
