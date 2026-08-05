import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { THEME_MODE_OVERRIDE_STORAGE_KEY } from "@/lib/theme-provider";
import { AppearanceSync } from "./appearance-sync";

const mocks = vi.hoisted(() => ({
  settings: {
    themeMode: "dark",
    themeVariant: "emerald",
    themeCustomColor: { h: 160, s: 84, l: 39 },
  },
  sessionData: {
    session: { expiresAt: "2026-07-01T00:00:00.000Z" },
    user: { id: "user-1", email: "alice@example.com", name: "Alice", role: "admin", banned: false },
  },
  setTheme: vi.fn(),
  applyThemeVariant: vi.fn(),
}));

vi.mock("@/hooks/use-settings", () => ({
  useSettings: () => ({ data: mocks.settings }),
}));

vi.mock("@/lib/auth-client", () => ({
  authClient: {
    useSession: () => ({ data: mocks.sessionData }),
  },
}));

vi.mock("@/lib/theme-provider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/theme-provider")>();
  return {
    ...actual,
    useTheme: () => ({ theme: "light", setTheme: mocks.setTheme }),
  };
});

vi.mock("@/lib/theme-variant", () => ({
  applyThemeVariant: mocks.applyThemeVariant,
}));

function renderAppearanceSync() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  render(
    <QueryClientProvider client={client}>
      <AppearanceSync />
    </QueryClientProvider>,
  );
}

describe("AppearanceSync theme mode precedence", () => {
  beforeEach(() => {
    mocks.setTheme.mockReset();
    mocks.applyThemeVariant.mockReset();
    mocks.settings = {
      themeMode: "dark",
      themeVariant: "emerald",
      themeCustomColor: { h: 160, s: 84, l: 39 },
    };
  });

  it("does not let remote theme mode overwrite a local device override", () => {
    // 本地设备覆盖优先于远端 settings，防止登录后立即打断用户在当前设备上的主题选择。
    localStorage.setItem(THEME_MODE_OVERRIDE_STORAGE_KEY, "1");

    renderAppearanceSync();

    expect(mocks.setTheme).not.toHaveBeenCalled();
    expect(mocks.applyThemeVariant).toHaveBeenCalledWith("emerald", { h: 160, s: 84, l: 39 });
  });

  it("uses remote theme mode when no local device override exists", () => {
    // 没有本地覆盖时才同步账号设置，保证跨设备主题仍能恢复。
    renderAppearanceSync();

    expect(mocks.setTheme).toHaveBeenCalledWith("dark", { localOverride: false });
    expect(mocks.applyThemeVariant).toHaveBeenCalledWith("emerald", { h: 160, s: 84, l: 39 });
  });
});
