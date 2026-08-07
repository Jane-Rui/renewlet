import { QueryClient } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { preloadRoute, routeFallbackForPathname } from "./route-resources";

const mocks = vi.hoisted(() => ({
  dashboardModuleLoads: 0,
  readProductSession: vi.fn(),
  fetchSubscriptions: vi.fn(async () => []),
  fetchSubscriptionPage: vi.fn(async (_pageParam?: string | null) => ({ subscriptions: [], nextCursor: null, total: 0 })),
  fetchSettings: vi.fn(async () => ({ defaultCurrency: "CNY" })),
}));

vi.mock("@/pages/dashboard", () => {
  mocks.dashboardModuleLoads += 1;
  return { default: () => null };
});
vi.mock("@/pages/subscriptions", () => ({ default: () => null }));
vi.mock("@/pages/calendar", () => ({ default: () => null }));
vi.mock("@/pages/statistics", () => ({ default: () => null }));
vi.mock("@/pages/settings", () => ({ default: () => null }));
vi.mock("@/pages/setup", () => ({ default: () => null }));
vi.mock("@/pages/login", () => ({ default: () => null }));
vi.mock("@/pages/privacy", () => ({ default: () => null }));
vi.mock("@/pages/terms", () => ({ default: () => null }));
vi.mock("@/pages/public-status", () => ({ default: () => null }));
vi.mock("@/pages/admin/users", () => ({ default: () => null }));
vi.mock("@/pages/forgot-password", () => ({ default: () => null }));
vi.mock("@/pages/reset-password", () => ({ default: () => null }));
vi.mock("@/pages/not-found", () => ({ default: () => null }));

vi.mock("@/services/product-session", () => ({
  readProductSession: mocks.readProductSession,
}));

vi.mock("@/hooks/use-subscriptions", () => ({
  subscriptionsListQueryOptions: () => ({
    queryKey: ["subscriptions", "list", null],
    queryFn: mocks.fetchSubscriptions,
    staleTime: 60_000,
  }),
  subscriptionsInfiniteQueryOptions: () => ({
    queryKey: ["subscriptions", "infinite"],
    initialPageParam: null,
    queryFn: ({ pageParam }: { pageParam: string | null }) => mocks.fetchSubscriptionPage(pageParam),
    getNextPageParam: () => undefined,
    staleTime: 60_000,
  }),
}));

vi.mock("@/hooks/use-settings", () => ({
  settingsQueryOptions: () => ({
    queryKey: ["settings"],
    queryFn: mocks.fetchSettings,
    staleTime: Infinity,
  }),
}));

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

describe("route resources", () => {
  beforeEach(() => {
    mocks.readProductSession.mockReset();
    mocks.fetchSubscriptions.mockClear();
    mocks.fetchSubscriptionPage.mockClear();
    mocks.fetchSettings.mockClear();
  });

  it("dedupes concurrent route preloads and prefetches route data once", async () => {
    mocks.readProductSession.mockReturnValue({
      session: { expiresAt: "2026-07-01T00:00:00.000Z" },
      user: { id: "user-1", email: "alice@example.com", name: "Alice", role: "admin", banned: false },
    });
    const queryClient = createQueryClient();

    await Promise.all([
      preloadRoute("/", queryClient),
      preloadRoute("/", queryClient),
    ]);

    expect(mocks.dashboardModuleLoads).toBe(1);
    expect(mocks.fetchSubscriptions).toHaveBeenCalledTimes(1);
    expect(mocks.fetchSettings).toHaveBeenCalledTimes(1);
  });

  it("loads the route module without prefetching private data when no session exists", async () => {
    mocks.readProductSession.mockReturnValue(null);
    const queryClient = createQueryClient();

    await preloadRoute("/statistics", queryClient);

    expect(mocks.fetchSubscriptions).not.toHaveBeenCalled();
    expect(mocks.fetchSettings).not.toHaveBeenCalled();
  });

  it("returns the route-specific skeleton from the shared registry", () => {
    render(routeFallbackForPathname("/settings"));

    expect(screen.getByTestId("settings-page-skeleton")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByTestId("dashboard-page-skeleton")).not.toBeInTheDocument();
  });
});
