import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, vi } from "vitest";
import { DEFAULT_CUSTOM_CONFIG, type CustomConfig } from "@/types/config";
import { DEFAULT_SETTINGS, type AppSettings } from "@/types/subscription";
import { BUILT_IN_ICON_PROVIDERS, type BuiltInIconProvider } from "@renewlet/shared/built-in-icons";
import type { BuiltInIconIndexStatus } from "@/lib/api/schemas/media";
import {
  APPEARANCE_PENDING_STORAGE_KEY,
  SETTINGS_APPEARANCE_PENDING_STORAGE_KEY,
  SETTINGS_THEME_MODE_STORAGE_KEY,
} from "@/lib/theme-storage";
import { useSettingsFormController } from "./use-settings-form-controller";

export const BASE_SETTINGS: AppSettings = {
  ...DEFAULT_SETTINGS,
  recipientEmail: "alice@example.com",
};

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
    data: undefined as BuiltInIconIndexStatus | undefined,
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
    getCurrencySymbol: () => "¥",
  }),
}));

vi.mock("@/hooks/use-subscriptions", () => ({
  useSubscriptions: () => ({
    data: [],
    isPending: false,
    status: "success",
  }),
}));

vi.mock("@/hooks/use-password-reset-availability", () => ({
  usePasswordResetAvailability: () => true,
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
  get isCloudflareRuntime() {
    return mocks.isCloudflareRuntime;
  },
}));

vi.mock("@/i18n/I18nProvider", () => {
  const messages: Record<string, string | ((params: Record<string, string | number>) => string)> = {
    "settings.saved": "设置已保存",
    "settings.savedDescription": "所有更改已同步。",
    "settings.saveFailed": "保存失败",
    "settings.saveFailedDescription": "无法保存设置，请稍后重试",
    "settings.appSettingsScope": "应用设置",
    "settings.customConfigScope": "数据配置",
    "settings.exchangeRateProviderSaveFailed": "无法保存汇率来源，请稍后重试",
    "settings.exchangeRateProviderServerOutdated": "无法保存汇率来源。服务端可能还没更新或重启，请重启后端服务后再试。",
    "settings.partialSaveFailedDescription": ({ scope }) => `以下内容未保存：${scope}。请检查后重试。`,
    "settings.calendarFeedGenerated": "日历订阅已生成",
    "settings.calendarFeedGeneratedDescription": "你可以随时回到这里复制 URL 或唤起系统日历订阅。",
    "settings.calendarFeedRegenerated": "日历订阅已重新生成",
    "settings.calendarFeedRegeneratedDescription": "旧 URL 已失效，请把新 URL 添加到你的日历应用。",
    "settings.calendarFeedCopied": "URL 已复制",
    "settings.calendarFeedCopiedDescription": "现在可以在日历应用中添加订阅日历。",
    "settings.calendarFeedCopyFailed": "复制失败",
    "settings.calendarFeedCopyFailedDescription": "当前一键复制不可用，请手动选择并复制 URL。",
    "settings.calendarFeedOpenSystemAttempted": "已尝试唤起系统日历",
    "settings.calendarFeedOpenSystemAttemptedDescription": "如果系统日历拒绝此 URL，请复制 URL 后在日历 App 中手动添加订阅。",
    "settings.calendarFeedOpenSystemFailed": "系统日历订阅打开失败",
    "settings.calendarFeedOpenSystemFailedDescription": "订阅 URL 当前没有返回可用的 ICS 内容；请复制 URL 手动添加订阅。",
    "settings.calendarFeedFailed": "日历订阅操作失败",
    "settings.calendarFeedFailedDescription": "无法生成日历订阅，请稍后重试。",
    "settings.calendarFeedRevoked": "日历订阅已撤销",
    "settings.calendarFeedRevokedDescription": "旧 URL 已失效，日历客户端后续刷新将无法再读取。",
    "settings.calendarFeedRevokeFailedDescription": "无法撤销日历订阅，请稍后重试。",
    "settings.publicStatusGenerated": "公开展示已生成",
    "settings.publicStatusGeneratedDescription": "你可以复制链接，或先按订阅逐条隐藏不想公开的项目。",
    "settings.publicStatusCopied": "URL 已复制",
    "settings.publicStatusCopiedDescription": "现在可以分享这个私密公开链接。",
    "settings.publicStatusCopyFailed": "复制失败",
    "settings.publicStatusCopyFailedDescription": "当前一键复制不可用，请手动选择并复制 URL。",
    "settings.publicStatusRegenerated": "公开展示已重新生成",
    "settings.publicStatusRegeneratedDescription": "旧 URL 已失效，请使用新的公开展示链接。",
    "settings.publicStatusRevoked": "公开展示已撤销",
    "settings.publicStatusRevokedDescription": "旧 URL 已失效，后续访问会得到 404。",
    "settings.publicStatusUpdated": "公开展示已更新",
    "settings.publicStatusPricesEnabled": "公开页会显示价格和币种。",
    "settings.publicStatusFailed": "公开展示操作失败",
    "settings.publicStatusFailedDescription": "无法生成公开展示链接，请稍后重试。",
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
    "settings.builtInIconIndexRefreshSuccess": "图标索引已更新",
    "settings.builtInIconIndexRefreshSuccessDescription": ({ source, count }) => `${source} 已更新，${count} 个图标可用于 Logo 和图标搜索。`,
    "settings.builtInIconIndexRefreshQueued": "图标索引更新已排队",
    "settings.builtInIconIndexRefreshQueuedDescription": ({ source }) => `${source} 会在后台更新；完成或失败后状态会自动停止轮询。`,
    "settings.builtInIconIndexRefreshFailed": "图标索引更新失败",
    "settings.builtInIconIndexRefreshFailedDescription": ({ source }) => `无法更新 ${source}，请稍后重试。`,
    "settings.builtInIconSourceShort.thesvg": "TheSVG",
    "settings.builtInIconSourceShort.selfhst": "selfh.st",
    "settings.builtInIconSourceShort.dashboardIcons": "Dashboard",
    "error.code.BUILT_IN_ICON_SOURCE_REQUIRED": "请至少启用一个内置图标来源",
  };

  return {
    useI18n: () => ({
      t: (key: string, params: Record<string, string | number> = {}) => {
        const message = messages[key];
        return typeof message === "function" ? message(params) : message ?? key;
      },
      setLocale: mocks.setLocale,
    }),
  };
});

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
    passwordDialogOpen: false,
    setPasswordDialogOpen: vi.fn(),
    handlePasswordDialogOpenChange: vi.fn(),
    currentPassword: "",
    setCurrentPassword: vi.fn(),
    newPassword: "",
    setNewPassword: vi.fn(),
    confirmPassword: "",
    setConfirmPassword: vi.fn(),
    isUpdatingPassword: false,
    updatePassword: vi.fn(),
  }),
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

export { mocks };

export function renderSettingsFormController() {
  return renderHook(() => useSettingsFormController());
}

export function setupSettingsFormControllerTestEnvironment() {
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
        name: "Test",
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
        ...(mocks.builtInIconIndexStatus.data ?? {}),
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
      job: {
        id: "docker-thesvg-20260611000000",
        provider: "thesvg",
        status: "succeeded",
        queuedAt: "2026-06-11T00:00:00Z",
        startedAt: "2026-06-11T00:00:00Z",
        finishedAt: "2026-06-11T00:00:00Z",
        attempts: 1,
        error: null,
        indexHash: "a".repeat(64),
      },
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
  });
}
