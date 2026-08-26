// Provider 测试保护语言真相源优先级：自动探测、远端 settings、本地预览和保存偏好必须各走各的边界。
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { I18nProvider, useI18n } from "@/i18n/I18nProvider";
import PrivateLocaleSync from "@/components/private-locale-sync";
import { getApiLocale, setApiLocale } from "@/i18n/api-locale";
import { EXPLICIT_LOCALE_PREFERENCE_KEY, type Locale } from "@/i18n/locales";

const mocks = vi.hoisted(() => ({
  settings: undefined as { locale: Locale } | undefined,
  activateLoadedLocale: vi.fn(),
  loadLocaleCatalog: vi.fn(),
  reportClientError: vi.fn(),
}));

vi.mock("@/i18n/messages", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/i18n/messages")>();
  return {
    ...actual,
    activateLoadedLocale: mocks.activateLoadedLocale,
    loadLocaleCatalog: mocks.loadLocaleCatalog,
  };
});

vi.mock("@/lib/report-client-error", () => ({
  reportClientError: mocks.reportClientError,
}));

vi.mock("@/hooks/use-settings", () => ({
  useSettings: () => ({ data: mocks.settings }),
}));

let restoreNavigator: (() => void) | null = null;

function stubNavigatorLanguages(languages: string[], language = languages[0] ?? "") {
  restoreNavigator?.();
  const original = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { languages, language },
  });
  restoreNavigator = () => {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: original,
    });
    restoreNavigator = null;
  };
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <I18nProvider>
          <PrivateLocaleSync />
          {children}
        </I18nProvider>
      </QueryClientProvider>
    );
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("I18nProvider locale sources", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.lang = "";
    setApiLocale("en-US");
    mocks.settings = undefined;
    mocks.activateLoadedLocale.mockReset();
    mocks.loadLocaleCatalog.mockReset().mockResolvedValue({});
    mocks.reportClientError.mockReset();
  });

  afterEach(() => {
    restoreNavigator?.();
  });

  it("uses browser detection without persisting an explicit preference", async () => {
    stubNavigatorLanguages(["zh-CN"]);

    const { result } = renderHook(() => useI18n(), { wrapper: createWrapper() });

    expect(result.current.locale).toBe("zh-CN");
    await waitFor(() => expect(document.documentElement.lang).toBe("zh-CN"));
    expect(getApiLocale()).toBe("zh-CN");
    expect(localStorage.getItem(EXPLICIT_LOCALE_PREFERENCE_KEY)).toBeNull();
  });

  it("lets remote settings override the automatic initial language", async () => {
    mocks.settings = { locale: "en-US" };
    stubNavigatorLanguages(["zh-CN"]);

    const { result } = renderHook(() => useI18n(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.locale).toBe("en-US"));
    expect(document.documentElement.lang).toBe("en-US");
    expect(getApiLocale()).toBe("en-US");
    expect(localStorage.getItem(EXPLICIT_LOCALE_PREFERENCE_KEY)).toBeNull();
  });

  it("keeps settings-page preview local until the language is saved", async () => {
    mocks.settings = { locale: "en-US" };
    stubNavigatorLanguages(["en-US"]);

    const { result } = renderHook(() => useI18n(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.locale).toBe("en-US"));

    act(() => {
      result.current.previewLocale("zh-CN");
    });

    await waitFor(() => expect(result.current.locale).toBe("zh-CN"));
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(getApiLocale()).toBe("en-US");
    expect(localStorage.getItem(EXPLICIT_LOCALE_PREFERENCE_KEY)).toBeNull();

    act(() => {
      result.current.commitLocale("zh-CN");
    });

    await waitFor(() => expect(getApiLocale()).toBe("zh-CN"));
    expect(localStorage.getItem(EXPLICIT_LOCALE_PREFERENCE_KEY)).toBe("zh-CN");
  });

  it("can restore the saved account locale without writing an explicit preference", async () => {
    mocks.settings = { locale: "en-US" };
    stubNavigatorLanguages(["en-US"]);

    const { result } = renderHook(() => useI18n(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.locale).toBe("en-US"));

    act(() => {
      result.current.previewLocale("zh-CN");
    });
    await waitFor(() => expect(result.current.locale).toBe("zh-CN"));
    act(() => {
      result.current.syncRemoteLocale("en-US");
    });

    await waitFor(() => expect(result.current.locale).toBe("en-US"));
    expect(getApiLocale()).toBe("en-US");
    expect(localStorage.getItem(EXPLICIT_LOCALE_PREFERENCE_KEY)).toBeNull();
  });

  it("discards a late catalog result after a newer locale intent wins", async () => {
    stubNavigatorLanguages(["en-US"]);
    const zhCatalog = deferred<Record<string, never>>();
    const enCatalog = deferred<Record<string, never>>();
    mocks.loadLocaleCatalog.mockImplementation((locale: Locale) => (
      locale === "zh-CN" ? zhCatalog.promise : enCatalog.promise
    ));
    const { result } = renderHook(() => useI18n(), { wrapper: createWrapper() });

    act(() => {
      result.current.previewLocale("zh-CN");
      result.current.commitLocale("en-US");
    });
    await act(async () => {
      enCatalog.resolve({});
      await enCatalog.promise;
    });
    expect(result.current.locale).toBe("en-US");
    expect(getApiLocale()).toBe("en-US");
    expect(localStorage.getItem(EXPLICIT_LOCALE_PREFERENCE_KEY)).toBe("en-US");

    await act(async () => {
      zhCatalog.resolve({});
      await zhCatalog.promise;
    });
    expect(result.current.locale).toBe("en-US");
    expect(mocks.activateLoadedLocale).toHaveBeenCalledTimes(1);
    expect(mocks.activateLoadedLocale).toHaveBeenCalledWith("en-US", {});
  });

  it("allows an explicit retry after catalog loading fails", async () => {
    stubNavigatorLanguages(["en-US"]);
    mocks.loadLocaleCatalog
      .mockRejectedValueOnce(new Error("catalog unavailable"))
      .mockResolvedValueOnce({});
    const { result } = renderHook(() => useI18n(), { wrapper: createWrapper() });

    act(() => result.current.commitLocale("zh-CN"));
    await waitFor(() => expect(mocks.reportClientError).toHaveBeenCalledTimes(1));
    expect(result.current.locale).toBe("en-US");

    act(() => result.current.commitLocale("zh-CN"));
    await waitFor(() => expect(result.current.locale).toBe("zh-CN"));
    expect(mocks.loadLocaleCatalog).toHaveBeenCalledTimes(2);
    expect(getApiLocale()).toBe("zh-CN");
  });
});
