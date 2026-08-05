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
import { subscriptionsInfiniteQueryOptions, subscriptionsListQueryOptions } from "@/hooks/use-subscriptions";
import { readProductSession, readProductSessionSnapshot } from "@/services/product-session";

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

interface NetworkInformationLike {
  saveData?: boolean | undefined;
  effectiveType?: string | undefined;
}

type IdleWindowLike = {
  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

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

async function preloadSubscriptionsList(queryClient: QueryClient) {
  await queryClient.prefetchQuery(subscriptionsListQueryOptions());
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
    preloadSubscriptionsList(queryClient),
    preloadSettings(queryClient),
  ]);
}

async function preloadSubscriptionsPageData(queryClient: QueryClient) {
  await Promise.all([
    preloadSubscriptionsInfinite(queryClient),
    preloadSubscriptionsList(queryClient),
    preloadSettings(queryClient),
  ]);
}

const primaryPrivateRoutePaths = ["/", "/subscriptions", "/calendar", "/statistics", "/settings"] as const;

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
    preloadData: preloadSubscriptionsList,
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
let lastIdlePreloadSessionKey: string | null = null;

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

function canIdlePreloadRoutes() {
  if (typeof navigator === "undefined") return false;
  const connection =
    (navigator as Navigator & { connection?: NetworkInformationLike }).connection ??
    (navigator as Navigator & { mozConnection?: NetworkInformationLike }).mozConnection ??
    (navigator as Navigator & { webkitConnection?: NetworkInformationLike }).webkitConnection;
  if (connection?.saveData) return false;
  return connection?.effectiveType !== "slow-2g" && connection?.effectiveType !== "2g";
}

function scheduleIdleTask(task: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const idleWindow = window as Window & IdleWindowLike;
  if (idleWindow.requestIdleCallback && idleWindow.cancelIdleCallback) {
    const handle = idleWindow.requestIdleCallback(task, { timeout: 2_000 });
    return () => idleWindow.cancelIdleCallback?.(handle);
  }
  const timeoutId = window.setTimeout(task, 700);
  return () => window.clearTimeout(timeoutId);
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

export function scheduleAuthenticatedRoutePreloads(queryClient: QueryClient): () => void {
  const snapshot = readProductSessionSnapshot();
  const sessionKey = snapshot ? `${snapshot.userId}:${snapshot.expiresAt}:${snapshot.verifiedAt}` : "";
  if (!sessionKey || sessionKey === lastIdlePreloadSessionKey || !canIdlePreloadRoutes()) {
    return () => undefined;
  }
  lastIdlePreloadSessionKey = sessionKey;

  return scheduleIdleTask(() => {
    // 登录后的 H5 主导航没有 hover；只在浏览器空闲且非省流量网络下预热主工作区路由。
    for (const pathname of primaryPrivateRoutePaths) {
      void preloadRoute(pathname, queryClient).catch(() => undefined);
    }
  });
}

export function useRoutePreloadPending(): boolean {
  return useSyncExternalStore(subscribeRoutePreload, routePreloadSnapshot, () => false);
}
