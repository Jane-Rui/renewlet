// 设置页 controller 的独立集成入口，覆盖不应撑大主草稿/保存测试文件的外部能力。
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CUSTOM_CONFIG, type CustomConfig } from "@/types/config";
import { DEFAULT_SETTINGS, type AppSettings } from "@/types/subscription";
import { BUILT_IN_ICON_PROVIDERS, type BuiltInIconProvider } from "@renewlet/shared/built-in-icons";
import {
  APPEARANCE_PENDING_STORAGE_KEY,
  SETTINGS_APPEARANCE_PENDING_STORAGE_KEY,
  SETTINGS_THEME_MODE_STORAGE_KEY,
} from "@/lib/theme-storage";
import { useSettingsFormController } from "./use-settings-form-controller";

const BASE_SETTINGS: AppSettings = {
  ...DEFAULT_SETTINGS,
  recipientEmail: "alice@example.com",
};
const originalExecCommandDescriptor = Object.getOwnPropertyDescriptor(document, "execCommand");

function providerStatusFixtures(counts: Record<BuiltInIconProvider, number>) {
  return BUILT_IN_ICON_PROVIDERS.map((provider) => ({
    provider,
    current: {
      sourceRef: "embedded",
      displayVersion: "bundled",
      commitSha: null,
      commitShortSha: null,
      commitDate: null,
      releaseTag: null,
      releasePublishedAt: null,
    },
    latest: null,
    iconCount: counts[provider],
    checkedAt: null,
    refreshedAt: null,
    lastError: null,
    refreshing: false,
    updateAvailable: false,
  }));
}

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  updateSettingsMutateAsync: vi.fn(),
  refreshRates: vi.fn(),
  remoteSettings: undefined as unknown,
  customConfig: undefined as unknown,
  saveConfig: vi.fn(),
  setTheme: vi.fn(),
  clearThemeModeOverride: vi.fn(),
  theme: "dark",
  setLocale: vi.fn(),
  testConnection: vi.fn(),
  refetchNotificationHistory: vi.fn(),
  calendarFeedStatus: { data: { enabled: false, feedUrl: undefined as string | undefined }, isLoading: false },
  createCalendarFeedMutateAsync: vi.fn(),
  deleteCalendarFeedMutateAsync: vi.fn(),
  publicStatusPageStatus: { data: { enabled: false, pageUrl: undefined as string | undefined, showPrices: false }, isLoading: false },
  createPublicStatusPageMutateAsync: vi.fn(),
  updatePublicStatusPageMutateAsync: vi.fn(),
  deletePublicStatusPageMutateAsync: vi.fn(),
  publicApiTokens: { data: [], isLoading: false },
  createPublicApiTokenMutateAsync: vi.fn(),
  deletePublicApiTokenMutateAsync: vi.fn(),
  telegramBotCommands: { data: undefined as unknown, isLoading: false, refetch: vi.fn() },
  installTelegramBotCommandsMutateAsync: vi.fn(),
  installTelegramBotCommandsIsPending: false,
  deleteTelegramBotCommandsMutateAsync: vi.fn(),
  deleteTelegramBotCommandsIsPending: false,
  builtInIconIndexStatus: {
    data: {
      source: "embedded",
      hash: "embedded-hash",
      iconCount: 100,
      providerCounts: { thesvg: 40, selfhst: 30, dashboardIcons: 30 },
      checkedAt: null,
      updatedAt: null,
      refreshing: false,
      providers: [] as ReturnType<typeof providerStatusFixtures>,
    },
    isLoading: false,
    refetch: vi.fn(),
  },
  checkBuiltInIconIndexProviderMutateAsync: vi.fn(),
  checkBuiltInIconIndexProviderIsPending: false,
  refreshBuiltInIconIndexProviderMutateAsync: vi.fn(),
  refreshBuiltInIconIndexProviderIsPending: false,
  writeClipboard: vi.fn(),
  fetch: vi.fn(),
  openWindow: vi.fn(),
  isCloudflareRuntime: false,
  accountIdentity: { email: "alice@example.com" as string | null, role: "admin", banned: false },
  appStatus: { setupRequired: false, setupEnabled: true, demoMode: false, isLoading: false },
}));

function checkedIconProviders(): BuiltInIconProvider[] {
  return mocks.checkBuiltInIconIndexProviderMutateAsync.mock.calls.map((call) => call[0] as BuiltInIconProvider);
}

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({
    toast: mocks.toast,
  }),
}));

vi.mock("@/hooks/use-settings", () => ({
  useSettings: () => ({
    data: mocks.remoteSettings,
  }),
  useUpdateSettings: () => ({
    mutateAsync: mocks.updateSettingsMutateAsync,
  }),
}));

vi.mock("@/hooks/use-setup-status", () => ({
  useSetupStatus: () => mocks.appStatus,
}));

vi.mock("@/hooks/use-exchange-rates", () => ({
  useExchangeRates: () => ({
    rates: {},
    activeProvider: "floatrates",
    loading: false,
    lastUpdated: null,
    refresh: mocks.refreshRates,
    error: null,
    getCurrencySymbol: (currency: string) => currency,
  }),
}));

vi.mock("@/hooks/use-subscriptions", () => ({
  useSubscriptions: () => ({
    data: [],
    isPending: false,
    status: "success",
  }),
}));

vi.mock("@/hooks/use-calendar-feed", () => ({
  useCalendarFeedStatus: () => mocks.calendarFeedStatus,
  useCreateCalendarFeed: () => ({
    mutateAsync: mocks.createCalendarFeedMutateAsync,
    isPending: false,
  }),
  useDeleteCalendarFeed: () => ({
    mutateAsync: mocks.deleteCalendarFeedMutateAsync,
    isPending: false,
  }),
}));

vi.mock("@/hooks/use-public-status-page", () => ({
  usePublicStatusPageStatus: () => mocks.publicStatusPageStatus,
  useCreatePublicStatusPage: () => ({
    mutateAsync: mocks.createPublicStatusPageMutateAsync,
    isPending: false,
  }),
  useUpdatePublicStatusPage: () => ({
    mutateAsync: mocks.updatePublicStatusPageMutateAsync,
    isPending: false,
  }),
  useDeletePublicStatusPage: () => ({
    mutateAsync: mocks.deletePublicStatusPageMutateAsync,
    isPending: false,
  }),
}));

vi.mock("@/hooks/use-public-api-tokens", () => ({
  usePublicApiTokens: () => mocks.publicApiTokens,
  useCreatePublicApiToken: () => ({
    mutateAsync: mocks.createPublicApiTokenMutateAsync,
    isPending: false,
  }),
  useDeletePublicApiToken: () => ({
    mutateAsync: mocks.deletePublicApiTokenMutateAsync,
    isPending: false,
    variables: null,
  }),
}));

vi.mock("@/hooks/use-telegram-bot-commands", () => ({
  useTelegramBotCommands: () => mocks.telegramBotCommands,
  useInstallTelegramBotCommands: () => ({
    mutateAsync: mocks.installTelegramBotCommandsMutateAsync,
    isPending: mocks.installTelegramBotCommandsIsPending,
  }),
  useDeleteTelegramBotCommands: () => ({
    mutateAsync: mocks.deleteTelegramBotCommandsMutateAsync,
    isPending: mocks.deleteTelegramBotCommandsIsPending,
  }),
}));

vi.mock("@/lib/theme-provider", () => ({
  clearThemeModeOverride: mocks.clearThemeModeOverride,
  useTheme: () => ({
    theme: mocks.theme,
    setTheme: mocks.setTheme,
  }),
}));

vi.mock("@/contexts/CustomConfigContext", () => ({
  useCustomConfig: () => ({
    config: mocks.customConfig,
    saveConfig: mocks.saveConfig,
  }),
}));

vi.mock("@/services/runtime", () => ({
  isCloudflareRuntime: () => mocks.isCloudflareRuntime,
}));

vi.mock("@/i18n/I18nProvider", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const messages: Record<string, string | ((params: Record<string, unknown>) => string)> = {
        "settings.builtInIconIndexRefreshSuccess": "图标索引已更新",
        "settings.builtInIconIndexRefreshSuccessDescription": ({ source, count }) => `${source} 已更新，${count} 个图标可用于 Logo 和图标搜索。`,
        "settings.builtInIconIndexRefreshFailed": "图标索引更新失败",
        "settings.builtInIconIndexRefreshFailedDescription": ({ source }) => `无法更新 ${source}，请稍后重试。`,
        "settings.builtInIconSourceShort.thesvg": "TheSVG",
        "settings.builtInIconSourceShort.selfhst": "selfh.st",
        "settings.builtInIconSourceShort.dashboardIcons": "Dashboard",
        "settings.calendarFeedGenerated": "日历订阅已生成",
        "settings.calendarFeedGeneratedDescription": "你可以随时回到这里复制 URL 或唤起系统日历订阅。",
        "settings.calendarFeedCopied": "URL 已复制",
        "settings.calendarFeedCopiedDescription": "现在可以在日历应用中添加订阅日历。",
        "settings.calendarFeedOpenSystemAttempted": "已尝试唤起系统日历",
        "settings.calendarFeedOpenSystemAttemptedDescription": "如果系统日历拒绝此 URL，请复制 URL 后在日历 App 中手动添加订阅。",
        "settings.calendarFeedOpenSystemFailed": "系统日历订阅打开失败",
        "settings.calendarFeedRegenerated": "日历订阅已重新生成",
        "settings.calendarFeedRegeneratedDescription": "旧 URL 已失效，请把新 URL 添加到你的日历应用。",
        "settings.calendarFeedRevoked": "日历订阅已撤销",
        "settings.calendarFeedRevokedDescription": "旧 URL 已失效，日历客户端后续刷新将无法再读取。",
        "settings.calendarFeedFailed": "日历订阅操作失败",
        "settings.calendarFeedCopyFailed": "复制失败",
        "settings.calendarFeedFailedDescription": "请稍后重试。",
        "settings.calendarFeedCopyFailedDescription": "当前一键复制不可用，请手动选择并复制 URL。",
        "settings.calendarFeedOpenSystemFailedDescription": "无法唤起系统日历。",
        "settings.publicStatusGenerated": "公开展示已生成",
        "settings.publicStatusGeneratedDescription": "你可以复制链接，或先按订阅逐条隐藏不想公开的项目。",
        "settings.publicStatusCopied": "URL 已复制",
        "settings.publicStatusCopiedDescription": "现在可以分享这个私密公开链接。",
        "settings.publicStatusRegenerated": "公开展示已重新生成",
        "settings.publicStatusRegeneratedDescription": "旧 URL 已失效，请使用新的公开展示链接。",
        "settings.publicStatusRevoked": "公开展示已撤销",
        "settings.publicStatusRevokedDescription": "旧 URL 已失效，后续访问会得到 404。",
        "settings.publicStatusUpdated": "公开展示已更新",
        "settings.publicStatusPricesEnabled": "公开页会显示价格和币种。",
        "settings.publicStatusPricesDisabled": "公开页将隐藏金额字段。",
        "settings.publicStatusFailed": "公开展示操作失败",
        "settings.publicStatusFailedDescription": "无法生成公开展示链接，请稍后重试。",
        "settings.publicStatusCopyFailed": "复制失败",
        "settings.publicStatusCopyFailedDescription": "当前一键复制不可用，请手动选择并复制 URL。",
        "settings.publicStatusRevokeFailedDescription": "无法撤销公开展示，请稍后重试。",
        "settings.publicStatusUpdateFailedDescription": "无法更新公开展示设置，请稍后重试。",
        "settings.publicApiCreated": "API Token 已创建",
        "settings.publicApiCreatedDescription": "明文 token 只显示一次，请复制到需要调用 Public API 的客户端。",
        "settings.publicApiCreateFailed": "API Token 创建失败",
        "settings.publicApiCreateFailedDescription": "无法创建 API Token，请稍后重试。",
        "settings.publicApiTokenCopied": "Token 已复制",
        "settings.publicApiTokenCopiedDescription": "可以把它用于只读集成或自动化工具。",
        "settings.publicApiCopyFailed": "复制失败",
        "settings.publicApiCopyFailedDescription": "当前一键复制不可用，请手动选择并复制 token。",
        "settings.publicApiDeleted": "API Token 已删除",
        "settings.publicApiDeletedDescription": "旧 token 已失效，后续 Public API 请求会被拒绝。",
        "settings.publicApiDeleteFailed": "API Token 删除失败",
        "settings.publicApiDeleteFailedDescription": "无法删除 API Token，请稍后重试。",
        "settings.telegramBotCommandsConfigMissing": "请先填写并保存 Bot Token 和 Chat ID。",
        "settings.telegramBotCommandsSaveFirst": "Telegram 凭据有未保存更改，请先保存设置。",
        "settings.telegramBotCommandsHttpsRequired": "Telegram Webhook 需要 HTTPS 外部访问地址。",
        "settings.telegramBotCommandsDemoDisabled": "演示模式下不能安装外部 Telegram 命令。",
        "settings.telegramBotCommandsInstalling": "安装中...",
        "settings.telegramBotCommandsDeleting": "删除中...",
        "settings.telegramBotCommandsInstalled": "Telegram 查询命令已安装",
        "settings.telegramBotCommandsInstalledDescription": "你可以在目标 Telegram 聊天的命令菜单中查询 Renewlet 订阅摘要。",
        "settings.telegramBotCommandsInstallFailed": "Telegram 查询命令安装失败",
        "settings.telegramBotCommandsInstallFailedDescription": "无法安装 Telegram Bot 查询命令，请检查 Bot Token、Chat ID 和 HTTPS 外部访问地址。",
        "settings.telegramBotCommandsDeleted": "Telegram 查询命令已删除",
        "settings.telegramBotCommandsDeletedDescription": "Telegram 菜单命令已删除，需要时可以重新安装。",
        "settings.telegramBotCommandsDeleteFailed": "Telegram 查询命令删除失败",
        "settings.telegramBotCommandsDeleteFailedDescription": "无法删除 Telegram Bot 查询命令，请稍后重试。",
      };
      const message = messages[key] ?? key;
      return typeof message === "function" ? message(params ?? {}) : message;
    },
    setLocale: mocks.setLocale,
  }),
}));

vi.mock("./use-account-email", () => ({
  useAccountIdentity: () => mocks.accountIdentity,
}));

vi.mock("./use-notification-test", () => ({
  useNotificationTest: () => ({
    testingChannel: null,
    testConnection: mocks.testConnection,
  }),
}));

vi.mock("./use-password-change", () => ({
  usePasswordChange: () => ({
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
    error: null,
    isSubmitting: false,
    setCurrentPassword: vi.fn(),
    setNewPassword: vi.fn(),
    setConfirmPassword: vi.fn(),
    submit: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-password-reset-availability", () => ({
  usePasswordResetAvailability: () => false,
}));

vi.mock("./use-notification-history", () => ({
  useNotificationHistory: () => ({
    data: undefined,
    isLoading: false,
    isFetching: false,
    error: null,
    historyStatus: "all",
    setStatus: vi.fn(),
    loadMore: vi.fn(),
    refetch: mocks.refetchNotificationHistory,
  }),
}));

vi.mock("@/hooks/use-built-in-icon-index", () => ({
  useBuiltInIconIndexStatus: () => mocks.builtInIconIndexStatus,
  useCheckBuiltInIconIndexProvider: () => ({
    mutateAsync: mocks.checkBuiltInIconIndexProviderMutateAsync,
    isPending: mocks.checkBuiltInIconIndexProviderIsPending,
  }),
  useRefreshBuiltInIconIndexProvider: () => ({
    mutateAsync: mocks.refreshBuiltInIconIndexProviderMutateAsync,
    isPending: mocks.refreshBuiltInIconIndexProviderIsPending,
  }),
}));

describe("useSettingsFormController integrations", () => {
  beforeEach(() => {
    mocks.toast.mockReset();
    mocks.updateSettingsMutateAsync.mockReset();
    mocks.refreshRates.mockReset();
    mocks.saveConfig.mockReset();
    mocks.setTheme.mockReset();
    mocks.clearThemeModeOverride.mockReset();
    mocks.theme = "dark";
    mocks.setLocale.mockReset();
    mocks.refetchNotificationHistory.mockReset();
    mocks.createCalendarFeedMutateAsync.mockReset();
    mocks.deleteCalendarFeedMutateAsync.mockReset();
    mocks.createPublicStatusPageMutateAsync.mockReset();
    mocks.updatePublicStatusPageMutateAsync.mockReset();
    mocks.deletePublicStatusPageMutateAsync.mockReset();
    mocks.createPublicApiTokenMutateAsync.mockReset();
    mocks.deletePublicApiTokenMutateAsync.mockReset();
    mocks.telegramBotCommands.refetch.mockReset();
    mocks.installTelegramBotCommandsMutateAsync.mockReset();
    mocks.installTelegramBotCommandsIsPending = false;
    mocks.deleteTelegramBotCommandsMutateAsync.mockReset();
    mocks.deleteTelegramBotCommandsIsPending = false;
    mocks.checkBuiltInIconIndexProviderMutateAsync.mockReset();
    mocks.checkBuiltInIconIndexProviderIsPending = false;
    mocks.refreshBuiltInIconIndexProviderMutateAsync.mockReset();
    mocks.refreshBuiltInIconIndexProviderIsPending = false;
    mocks.writeClipboard.mockReset();
    mocks.fetch.mockReset();
    mocks.openWindow.mockReset();
    localStorage.removeItem(APPEARANCE_PENDING_STORAGE_KEY);
    localStorage.removeItem(SETTINGS_APPEARANCE_PENDING_STORAGE_KEY);
    localStorage.removeItem(SETTINGS_THEME_MODE_STORAGE_KEY);
    mocks.calendarFeedStatus = { data: { enabled: false, feedUrl: undefined }, isLoading: false };
    mocks.publicStatusPageStatus = { data: { enabled: false, pageUrl: undefined, showPrices: false }, isLoading: false };
    mocks.publicApiTokens = { data: [], isLoading: false };
    mocks.telegramBotCommands = { data: undefined, isLoading: false, refetch: vi.fn().mockResolvedValue(undefined) };
    mocks.builtInIconIndexStatus = {
      data: {
        source: "embedded",
        hash: "embedded-hash",
        iconCount: 100,
        providerCounts: { thesvg: 40, selfhst: 30, dashboardIcons: 30 },
        checkedAt: null,
        updatedAt: null,
        refreshing: false,
        providers: providerStatusFixtures({ thesvg: 40, selfhst: 30, dashboardIcons: 30 }),
      },
      isLoading: false,
      refetch: vi.fn(),
    };
    mocks.remoteSettings = BASE_SETTINGS;
    mocks.customConfig = DEFAULT_CUSTOM_CONFIG;
    mocks.isCloudflareRuntime = false;
    mocks.accountIdentity = { email: "alice@example.com", role: "admin", banned: false };
    mocks.appStatus = { setupRequired: false, setupEnabled: true, demoMode: false, isLoading: false };
    mocks.updateSettingsMutateAsync.mockImplementation(async (settings: AppSettings) => settings);
    mocks.saveConfig.mockImplementation(async (config: CustomConfig) => config);
    mocks.refreshRates.mockResolvedValue(undefined);
    mocks.createCalendarFeedMutateAsync.mockResolvedValue({
      enabled: true,
      createdAt: "2026-05-29T00:00:00Z",
      updatedAt: "2026-05-29T00:00:00Z",
      feedUrl: "https://example.com/calendar/renewals.ics?token=secret",
    });
    mocks.deleteCalendarFeedMutateAsync.mockResolvedValue({});
    mocks.createPublicStatusPageMutateAsync.mockResolvedValue({
      enabled: true,
      createdAt: "2026-06-07T00:00:00Z",
      updatedAt: "2026-06-07T00:00:00Z",
      pageUrl: "https://example.com/status/secret",
      showPrices: false,
    });
    mocks.updatePublicStatusPageMutateAsync.mockResolvedValue({
      enabled: true,
      createdAt: "2026-06-07T00:00:00Z",
      updatedAt: "2026-06-07T00:00:00Z",
      pageUrl: "https://example.com/status/secret",
      showPrices: true,
    });
    mocks.deletePublicStatusPageMutateAsync.mockResolvedValue({});
    mocks.createPublicApiTokenMutateAsync.mockResolvedValue({
      token: {
        id: "tok_test",
        name: "Telegram Bot",
        tokenPrefix: "rlt_test123",
        scopes: ["read"],
        createdAt: "2026-06-20T00:00:00Z",
      },
      plainToken: "rlt_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO12",
    });
    mocks.deletePublicApiTokenMutateAsync.mockResolvedValue({});
    mocks.installTelegramBotCommandsMutateAsync.mockResolvedValue({
      configComplete: true,
      installed: true,
      status: "installed",
      chatId: "123456",
      installedAt: "2026-06-20T00:00:00Z",
      lastUsedAt: null,
    });
    mocks.deleteTelegramBotCommandsMutateAsync.mockResolvedValue(undefined);
    mocks.checkBuiltInIconIndexProviderMutateAsync.mockImplementation(async (provider: BuiltInIconProvider) => ({
      status: {
        ...(mocks.builtInIconIndexStatus.data as object),
      },
      provider: providerStatusFixtures({ thesvg: 40, selfhst: 30, dashboardIcons: 30 }).find((item) => item.provider === provider),
    }));
    mocks.refreshBuiltInIconIndexProviderMutateAsync.mockResolvedValue({
      status: {
        source: "runtime",
        hash: "runtime-hash",
        iconCount: 321,
        providerCounts: { thesvg: 120, selfhst: 100, dashboardIcons: 101 },
        checkedAt: "2026-06-11T00:00:00Z",
        updatedAt: "2026-06-11T00:00:00Z",
        refreshing: false,
        providers: providerStatusFixtures({ thesvg: 120, selfhst: 100, dashboardIcons: 101 }),
      },
      provider: providerStatusFixtures({ thesvg: 120, selfhst: 100, dashboardIcons: 101 })[0],
      job: { id: "docker-thesvg-20260611000000", provider: "thesvg", status: "succeeded", queuedAt: "2026-06-11T00:00:00Z", startedAt: "2026-06-11T00:00:00Z", finishedAt: "2026-06-11T00:00:00Z", attempts: 1, error: null, indexHash: "a".repeat(64) },
    });
    mocks.writeClipboard.mockResolvedValue(undefined);
    mocks.fetch.mockResolvedValue(new Response("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n", {
      headers: { "content-type": "text/calendar; charset=utf-8" },
    }));
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: mocks.writeClipboard },
      configurable: true,
    });
    vi.stubGlobal("fetch", mocks.fetch);
    Object.defineProperty(window, "open", {
      value: mocks.openWindow,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalExecCommandDescriptor) {
      Object.defineProperty(document, "execCommand", originalExecCommandDescriptor);
    } else {
      Reflect.deleteProperty(document, "execCommand");
    }
    localStorage.clear();
  });

  it("refreshes the built-in icon index without marking settings dirty", async () => {
    const { result } = renderHook(() => useSettingsFormController());

    expect(result.current.builtInIconIndex.canManage).toBe(true);
    expect(result.current.hasUnsavedChanges).toBe(false);

    await act(async () => {
      await result.current.builtInIconIndex.refreshProvider("thesvg");
    });

    expect(mocks.refreshBuiltInIconIndexProviderMutateAsync).toHaveBeenCalledWith("thesvg");
    expect(result.current.hasUnsavedChanges).toBe(false);
    expect(mocks.updateSettingsMutateAsync).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith({
      title: "图标索引已更新",
      description: "TheSVG 已更新，120 个图标可用于 Logo 和图标搜索。",
    });
  });

  it("checks a single built-in icon provider without marking settings dirty", async () => {
    const { result } = renderHook(() => useSettingsFormController());

    await act(async () => {
      await result.current.builtInIconIndex.checkProvider("selfhst");
    });

    expect(mocks.checkBuiltInIconIndexProviderMutateAsync).toHaveBeenCalledWith("selfhst");
    expect(result.current.hasUnsavedChanges).toBe(false);
    expect(mocks.updateSettingsMutateAsync).not.toHaveBeenCalled();
  });

  it("checks all built-in icon providers from the sources dialog without marking settings dirty", async () => {
    const { result } = renderHook(() => useSettingsFormController());

    await act(async () => {
      await result.current.builtInIconIndex.checkAllProviders();
    });

    expect(checkedIconProviders()).toEqual([
      "thesvg",
      "selfhst",
      "dashboardIcons",
    ]);
    expect(result.current.hasUnsavedChanges).toBe(false);
    expect(mocks.updateSettingsMutateAsync).not.toHaveBeenCalled();
  });

  it("deduplicates dialog-level provider checks while keeping manual retry available", async () => {
    const { result } = renderHook(() => useSettingsFormController());
    let releaseFirstBatch: (() => void) | null = null;
    mocks.checkBuiltInIconIndexProviderMutateAsync.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseFirstBatch = resolve;
    }));

    let firstBatch!: Promise<void>;
    let secondBatch!: Promise<void>;
    act(() => {
      firstBatch = result.current.builtInIconIndex.checkAllProviders();
      secondBatch = result.current.builtInIconIndex.checkAllProviders();
    });

    expect(mocks.checkBuiltInIconIndexProviderMutateAsync).toHaveBeenCalledTimes(1);
    expect(mocks.checkBuiltInIconIndexProviderMutateAsync).toHaveBeenLastCalledWith("thesvg");

    await act(async () => {
      releaseFirstBatch?.();
      await firstBatch;
      await secondBatch;
    });

    expect(checkedIconProviders()).toEqual([
      "thesvg",
      "selfhst",
      "dashboardIcons",
    ]);

    await act(async () => {
      await result.current.builtInIconIndex.checkProvider("dashboardIcons");
    });

    expect(mocks.checkBuiltInIconIndexProviderMutateAsync).toHaveBeenCalledTimes(4);
    expect(mocks.checkBuiltInIconIndexProviderMutateAsync).toHaveBeenLastCalledWith("dashboardIcons");
    expect(result.current.hasUnsavedChanges).toBe(false);
  });

  it("skips dialog-level provider checks for non-admin, pending, or refreshing providers", async () => {
    mocks.accountIdentity = { email: "alice@example.com", role: "user", banned: false };
    const { result: userResult } = renderHook(() => useSettingsFormController());

    await act(async () => {
      await userResult.current.builtInIconIndex.checkAllProviders();
    });

    expect(mocks.checkBuiltInIconIndexProviderMutateAsync).not.toHaveBeenCalled();

    mocks.accountIdentity = { email: "alice@example.com", role: "admin", banned: false };
    mocks.checkBuiltInIconIndexProviderIsPending = true;
    const { result: pendingResult } = renderHook(() => useSettingsFormController());

    await act(async () => {
      await pendingResult.current.builtInIconIndex.checkAllProviders();
    });

    expect(mocks.checkBuiltInIconIndexProviderMutateAsync).not.toHaveBeenCalled();

    mocks.checkBuiltInIconIndexProviderIsPending = false;
    mocks.builtInIconIndexStatus = {
      ...mocks.builtInIconIndexStatus,
      data: {
        ...mocks.builtInIconIndexStatus.data,
        providers: providerStatusFixtures({ thesvg: 40, selfhst: 30, dashboardIcons: 30 }).map((providerStatus) => (
          providerStatus.provider === "dashboardIcons" ? { ...providerStatus, refreshing: true } : providerStatus
        )),
      },
    };
    const { result: refreshingResult } = renderHook(() => useSettingsFormController());

    await act(async () => {
      await refreshingResult.current.builtInIconIndex.checkAllProviders();
    });

    expect(checkedIconProviders()).toEqual([
      "thesvg",
      "selfhst",
    ]);
    expect(refreshingResult.current.hasUnsavedChanges).toBe(false);
  });

  it("shows a destructive toast when the built-in icon index refresh fails", async () => {
    mocks.refreshBuiltInIconIndexProviderMutateAsync.mockRejectedValue(new Error("Registry offline"));
    const { result } = renderHook(() => useSettingsFormController());

    await act(async () => {
      await result.current.builtInIconIndex.refreshProvider("thesvg");
    });

    expect(mocks.toast).toHaveBeenCalledWith({
      title: "图标索引更新失败",
      description: "Registry offline",
      variant: "destructive",
    });
    expect(result.current.hasUnsavedChanges).toBe(false);
  });

  it("saves Telegram message format through the regular settings draft", async () => {
    const { result } = renderHook(() => useSettingsFormController());

    act(() => {
      result.current.updateSetting("telegramMessageFormat", "html");
    });

    expect(result.current.hasUnsavedChanges).toBe(true);
    await act(async () => {
      await result.current.handleSaveChanges();
    });

    expect(mocks.updateSettingsMutateAsync).toHaveBeenCalledWith(expect.objectContaining({
      telegramMessageFormat: "html",
    }));
    expect(mocks.telegramBotCommands.refetch).toHaveBeenCalledTimes(1);
  });

  it("creates the calendar feed and keeps an existing URL available for copy, regenerate, and revoke", async () => {
    const { result } = renderHook(() => useSettingsFormController());

    expect(result.current.calendarFeed.data).toEqual({ enabled: false });
    expect(result.current.calendarFeed.feedUrl).toBeNull();

    await act(async () => {
      await result.current.calendarFeed.createOrRotate();
    });

    expect(mocks.createCalendarFeedMutateAsync).toHaveBeenCalledTimes(1);
    expect(mocks.toast).toHaveBeenCalledWith({
      title: "日历订阅已生成",
      description: "你可以随时回到这里复制 URL 或唤起系统日历订阅。",
    });

    mocks.calendarFeedStatus = {
      data: {
        enabled: true,
        feedUrl: "https://example.com/calendar/renewals.ics?token=secret",
      },
      isLoading: false,
    };
    const { result: enabledResult } = renderHook(() => useSettingsFormController());
    expect(enabledResult.current.calendarFeed.feedUrl).toBe("https://example.com/calendar/renewals.ics?token=secret");

    await act(async () => {
      await enabledResult.current.calendarFeed.copyUrl();
    });

    expect(mocks.writeClipboard).toHaveBeenCalledWith("https://example.com/calendar/renewals.ics?token=secret");
    expect(mocks.toast).toHaveBeenCalledWith({
      title: "URL 已复制",
      description: "现在可以在日历应用中添加订阅日历。",
    });

    await act(async () => {
      await enabledResult.current.calendarFeed.openSystem();
    });

    expect(mocks.fetch).toHaveBeenCalledWith("https://example.com/calendar/renewals.ics?token=secret", {
      cache: "no-store",
      credentials: "omit",
      headers: { Accept: "text/calendar,*/*;q=0.1" },
    });
    expect(mocks.openWindow).toHaveBeenCalledWith("webcal://example.com/calendar/renewals.ics?token=secret", "_self");
    expect(mocks.toast).toHaveBeenCalledWith({
      title: "已尝试唤起系统日历",
      description: "如果系统日历拒绝此 URL，请复制 URL 后在日历 App 中手动添加订阅。",
    });

    await act(async () => {
      await enabledResult.current.calendarFeed.regenerate();
    });

    expect(mocks.deleteCalendarFeedMutateAsync).toHaveBeenCalledTimes(1);
    expect(mocks.createCalendarFeedMutateAsync).toHaveBeenCalledTimes(2);
    expect(mocks.toast).toHaveBeenCalledWith({
      title: "日历订阅已重新生成",
      description: "旧 URL 已失效，请把新 URL 添加到你的日历应用。",
    });

    await act(async () => {
      await enabledResult.current.calendarFeed.revoke();
    });

    expect(mocks.deleteCalendarFeedMutateAsync).toHaveBeenCalledTimes(2);
    expect(mocks.toast).toHaveBeenCalledWith({
      title: "日历订阅已撤销",
      description: "旧 URL 已失效，日历客户端后续刷新将无法再读取。",
    });
  });

  it("uses localized calendar feed copy failure when clipboard helpers are unavailable", async () => {
    mocks.calendarFeedStatus = {
      data: { enabled: true, feedUrl: "https://example.com/calendar/renewals.ics?token=secret" },
      isLoading: false,
    };
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn(() => false) });
    const target = document.createElement("input");
    target.value = "https://example.com/calendar/renewals.ics?token=secret";
    document.body.append(target);
    const { result } = renderHook(() => useSettingsFormController());

    await act(async () => {
      await result.current.calendarFeed.copyUrl(target);
    });
    target.remove();

    expect(mocks.toast).toHaveBeenCalledWith({
      title: "复制失败",
      description: "当前一键复制不可用，请手动选择并复制 URL。",
      variant: "destructive",
    });
  });

  it("manages the public status page URL and price visibility", async () => {
    const { result } = renderHook(() => useSettingsFormController());

    expect(result.current.publicStatusPage.enabled).toBe(false);
    expect(result.current.publicStatusPage.pageUrl).toBeNull();

    await act(async () => {
      await result.current.publicStatusPage.createOrRotate();
    });
    expect(mocks.createPublicStatusPageMutateAsync).toHaveBeenCalledTimes(1);

    mocks.publicStatusPageStatus = {
      data: {
        enabled: true,
        pageUrl: "https://example.com/status/secret",
        showPrices: false,
      },
      isLoading: false,
    };
    const { result: enabledResult } = renderHook(() => useSettingsFormController());
    expect(enabledResult.current.publicStatusPage.pageUrl).toBe("https://example.com/status/secret");

    await act(async () => {
      await enabledResult.current.publicStatusPage.copyUrl();
    });
    expect(mocks.writeClipboard).toHaveBeenCalledWith("https://example.com/status/secret");

    await act(async () => {
      await enabledResult.current.publicStatusPage.openPage();
    });
    expect(mocks.openWindow).toHaveBeenCalledWith("https://example.com/status/secret", "_blank", "noopener,noreferrer");

    await act(async () => {
      await enabledResult.current.publicStatusPage.updateShowPrices(true);
    });
    expect(mocks.updatePublicStatusPageMutateAsync).toHaveBeenCalledWith(true);

    await act(async () => {
      await enabledResult.current.publicStatusPage.regenerate();
    });
    expect(mocks.deletePublicStatusPageMutateAsync).toHaveBeenCalledTimes(1);
    expect(mocks.createPublicStatusPageMutateAsync).toHaveBeenCalledTimes(2);

    await act(async () => {
      await enabledResult.current.publicStatusPage.revoke();
    });
    expect(mocks.deletePublicStatusPageMutateAsync).toHaveBeenCalledTimes(2);
  });

});
