// SettingsScreen 测试夹具集中托管，避免页面主体测试和目录状态机测试再次长成单文件门禁问题。
import { useState } from "react";
import { act, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";
import { vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DEFAULT_CUSTOM_CONFIG, type CustomConfig } from "@/types/config";
import { canonicalizeMoneyString } from "@renewlet/shared/money";
import type {
  ExchangeRateCoverageWarning,
  ExchangeRates,
  ExchangeRateSource,
} from "@/lib/api/schemas/exchange-rates";
import type { ReportExchangeRateBasisStatus } from "@/hooks/use-report-exchange-rates";
import type { BuiltInIconIndexStatus } from "@/lib/api/schemas/media";
import { DEFAULT_SETTINGS, type AppSettings, type NotificationChannel } from "@/types/subscription";
import type { ThemeMode } from "@/types/theme";
import { BUILT_IN_ICON_PROVIDERS, type BuiltInIconProvider } from "@renewlet/shared/built-in-icons";
import { SettingsScreen } from "./settings-screen";
import { NotificationChannelConfigPanel } from "./notification-channel-config-panel";
import type { UploadedAssetsManagerController } from "../application/use-uploaded-assets-manager";
import type { SettingsAuthSecurityController } from "../application/use-auth-security-settings-controller";
import type { SettingsTelegramBotCommandsController } from "../application/use-telegram-bot-commands-controller";

const mocks = vi.hoisted(() => ({
  useSettingsFormController: vi.fn(),
  useCloudBackupController: vi.fn(),
  useUploadedAssetsManager: vi.fn(),
}));

export { mocks };

export const SETTINGS_SECTION_IDS = [
  "settings-account",
  "settings-access-security",
  "settings-appearance",
  "settings-display",
  "settings-icon-sources",
  "settings-uploaded-icons",
  "settings-ai-recognition",
  "settings-budget",
  "settings-data-config",
  "settings-cloud-backup",
  "settings-exchange",
  "settings-calendar-feed",
  "settings-public-status",
  "settings-public-api",
  "settings-timezone",
  "settings-notifications",
] as const;

export const TEST_MOBILE_ANCHOR_LINE_PX = 208;
export const TEST_ACTIVE_SECTION_TOP_PX = TEST_MOBILE_ANCHOR_LINE_PX - 24;
export const TEST_NEXT_SECTION_TOP_PX = TEST_MOBILE_ANCHOR_LINE_PX + 160;

export function StatefulEmailNotificationPanel({ initialPort = "" }: { initialPort?: string }) {
  const [settings, setSettings] = useState({
    ...DEFAULT_SETTINGS,
    enabledChannels: ["email" as const],
    smtpHost: "smtp.example.com",
    smtpPort: initialPort,
    recipientEmail: "alice@example.com",
  });

  return (
    <NotificationChannelConfigPanel
      channel="email"
      settings={settings}
      enabled
      updateSetting={(key, value) => setSettings((previous) => ({ ...previous, [key]: value }))}
      testingChannel={null}
      onTest={vi.fn()}
    />
  );
}

export function useStatefulMonthlyBudgetController(initialBudget = "10000") {
  const [monthlyBudgetInput, setMonthlyBudgetInput] = useState(String(initialBudget));
  const [monthlyBudget, setMonthlyBudget] = useState(String(initialBudget));
  const [monthlyBudgetError, setMonthlyBudgetError] = useState<string | null>(null);

  return {
    ...createControllerState({
      settings: { monthlyBudget },
      hasUnsavedChanges: monthlyBudgetInput !== String(monthlyBudget) || Boolean(monthlyBudgetError),
    }),
    monthlyBudgetInput,
    monthlyBudgetError,
    handleMonthlyBudgetInputChange: (value: string) => {
      setMonthlyBudgetInput(value);
      if (!value.trim()) {
        setMonthlyBudgetError("预算金额无效");
        return;
      }
      const parsed = canonicalizeMoneyString(value);
      if (parsed === null) {
        setMonthlyBudgetError("预算金额无效");
        return;
      }
      setMonthlyBudgetError(null);
      setMonthlyBudget(parsed);
    },
  };
}

function iconProviderVersion(provider: BuiltInIconProvider) {
  const commitSha = provider === "thesvg"
    ? "aaa111122223333444455556666777788889999"
    : provider === "selfhst"
      ? "bbb111122223333444455556666777788889999"
      : "ccc111122223333444455556666777788889999";
  return {
    sourceRef: commitSha,
    displayVersion: commitSha.slice(0, 7),
    commitSha,
    commitShortSha: commitSha.slice(0, 7),
    commitDate: "2026-06-11T00:00:00.000Z",
    releaseTag: null,
    releasePublishedAt: null,
  };
}

type TestSettingsSectionId = typeof SETTINGS_SECTION_IDS[number];

export function setElementRect(element: Element | null, top: number, height = 160) {
  if (!element) throw new Error("Expected element to exist");
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      bottom: top + height,
      height,
      left: 0,
      right: 960,
      top,
      width: 960,
      x: 0,
      y: top,
      toJSON: () => ({}),
    } satisfies DOMRect),
  });
}

export function setRootMetrics({
  top = 0,
  scrollTop = 0,
  clientHeight = 800,
  scrollHeight = 2400,
}: {
  top?: number;
  scrollTop?: number;
  clientHeight?: number;
  scrollHeight?: number;
} = {}) {
  const root = document.getElementById("root");
  if (!root) throw new Error("Expected #root test scroll container");
  setElementRect(root, top, clientHeight);
  Object.defineProperty(root, "scrollTop", { configurable: true, value: scrollTop, writable: true });
  Object.defineProperty(root, "clientHeight", { configurable: true, value: clientHeight });
  Object.defineProperty(root, "scrollHeight", { configurable: true, value: scrollHeight });
  return root;
}

export function setSettingsSectionTops(tops: Partial<Record<string, number>>) {
  for (const [id, top] of Object.entries(tops)) {
    if (top !== undefined) setElementRect(document.getElementById(id), top);
  }
}

function setSettingsSectionScrollMargins() {
  for (const id of SETTINGS_SECTION_IDS) {
    const element = document.getElementById(id);
    if (element instanceof HTMLElement) {
      element.style.scrollMarginTop = `${TEST_MOBILE_ANCHOR_LINE_PX}px`;
    }
  }
}

export function dispatchRootScroll(root: HTMLElement) {
  act(() => {
    root.dispatchEvent(new Event("scroll"));
  });
}

export function setSectionAnchorGeometry(
  activeId: TestSettingsSectionId,
  options: {
    activeTop?: number;
    nextTop?: number;
    rootMetrics?: Parameters<typeof setRootMetrics>[0];
  } = {},
) {
  const root = setRootMetrics(options.rootMetrics);
  const activeIndex = SETTINGS_SECTION_IDS.indexOf(activeId);
  const activeTop = options.activeTop ?? TEST_ACTIVE_SECTION_TOP_PX;
  const nextTop = options.nextTop ?? TEST_NEXT_SECTION_TOP_PX;
  setSettingsSectionScrollMargins();

  SETTINGS_SECTION_IDS.forEach((id, index) => {
    const top = index < activeIndex
      ? activeTop - (activeIndex - index) * 240
      : activeTop + Math.max(index - activeIndex, 0) * (nextTop - activeTop);
    setElementRect(document.getElementById(id), top);
  });

  return root;
}

vi.mock("@/components/header", () => ({
  Header: () => <header data-testid="header" />,
}));

vi.mock("@/modules/custom-config/presentation/config-manager-dialog", () => ({
  ConfigManagerDialog: ({
    title,
    items,
    maxItems = 20,
    readOnly = false,
    toggleMode = false,
  }: {
    title: string;
    items: unknown[];
    maxItems?: number;
    readOnly?: boolean;
    toggleMode?: boolean;
  }) => (
    <section aria-label={title}>
      {!readOnly && !toggleMode && items.length < maxItems ? (
        <button type="button">添加选项</button>
      ) : null}
    </section>
  ),
}));

vi.mock("@/components/theme-selector", () => ({
  ThemeSelector: ({ mode }: { mode: ThemeMode }) => <div data-testid="theme-selector-mode">{mode}</div>,
}));

vi.mock("@/components/ui/searchable-select", () => ({
  SearchableSelect: ({
    value,
    onValueChange,
    options,
    disabled = false,
    "aria-label": ariaLabel,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    options: Array<{ value: string; label: string }>;
    disabled?: boolean;
    "aria-label"?: string;
  }) => {
    const selected = options.find((option) => option.value === value);
    const next = options.find((option) => option.value !== value);
    return (
      <button
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        data-testid="searchable-select"
        disabled={disabled}
        onClick={() => {
          if (next) onValueChange(next.value);
        }}
      >
        {selected?.label ?? value}
      </button>
    );
  },
}));

vi.mock("@/components/ui/time-picker", () => ({
  TimePicker: () => null,
}));

vi.mock("../application/use-settings-form-controller", () => ({
  useSettingsFormController: mocks.useSettingsFormController,
}));

vi.mock("../application/use-cloud-backup-controller", () => ({
  useCloudBackupController: mocks.useCloudBackupController,
}));

vi.mock("../application/use-uploaded-assets-manager", () => ({
  useUploadedAssetsManager: mocks.useUploadedAssetsManager,
}));

export function createUploadedAssetsManagerState(
  overrides: Partial<UploadedAssetsManagerController> = {},
): UploadedAssetsManagerController {
  const refresh = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const loadMore = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const emptyKind = {
    assets: [],
    error: null,
    hasLoaded: true,
    hasMore: false,
    isLoading: false,
    isLoadingMore: false,
    refresh,
    loadMore,
  };
  return {
    logo: emptyKind,
    icon: emptyKind,
    deleteError: null,
    deletingAssetId: null,
    deleteAsset: vi.fn<UploadedAssetsManagerController["deleteAsset"]>().mockResolvedValue(true),
    ...overrides,
  };
}

export function createCloudBackupControllerState() {
  const fn = vi.fn();
  const defaultPolicy = {
    scheduleEnabled: false,
    scheduleFrequency: "daily" as const,
    scheduleTime: "03:00",
    scheduleWeekday: "monday" as const,
    retention: 7,
  };
  const defaultStatus = {
    lastBackupAt: null,
    lastStatus: "idle" as const,
    lastError: null,
    updatedAt: null,
  };
  return {
    config: {
      provider: "webdav" as const,
      credentialSet: false,
      credentialSetByProvider: { webdav: false, s3: false },
      policyByProvider: { webdav: defaultPolicy, s3: defaultPolicy },
      statusByProvider: { webdav: defaultStatus, s3: defaultStatus },
      updatedAt: null,
    },
    snapshots: [],
    form: {
      provider: "webdav" as const,
      webdavUrl: "",
      webdavUsername: "",
      webdavPassword: "",
      webdavPath: "renewlet",
      s3Endpoint: "",
      s3Region: "",
      s3Bucket: "",
      s3Prefix: "renewlet",
      s3AccessKeyId: "",
      s3SecretAccessKey: "",
      scheduleEnabled: false,
      scheduleFrequency: "daily" as const,
      scheduleTime: "03:00",
      scheduleWeekday: "monday" as const,
      retention: "7",
    },
    credentialSet: false,
    canCreateSnapshot: false,
    isLoading: false,
    isSaving: false,
    isTesting: false,
    isCreating: false,
    isDownloading: false,
    isDeleting: false,
    isRefreshingSnapshots: false,
    restoringSnapshotKey: null,
    deletingSnapshotKey: null,
    hasUnsavedChanges: false,
    snapshotsErrorMessage: null,
    cloudBackupErrorDetails: null,
    cloudBackupErrorDetailsOpen: false,
    setCloudBackupErrorDetailsOpen: fn,
    openSnapshotsErrorDetails: fn,
    updateForm: fn,
    saveConfig: fn,
    testConfig: fn,
    createSnapshot: fn,
    restoreSnapshot: fn,
    deleteSnapshot: fn,
    refreshSnapshots: fn,
  };
}

export function createControllerState(overrides: {
  settings?: Partial<AppSettings>;
  effectiveThemeMode?: ThemeMode;
  canManageUsers?: boolean;
  canAccessPocketBaseAdmin?: boolean;
  testingChannel?: NotificationChannel | null;
  isSavingSettings?: boolean;
  hasUnsavedChanges?: boolean;
  calendarFeed?: {
    enabled?: boolean;
    feedUrl?: string | null;
  };
  builtInIconIndex?: {
    canManage?: boolean;
    status?: BuiltInIconIndexStatus;
    isLoading?: boolean;
    checkingProviders?: BuiltInIconProvider[];
    refreshingProvider?: BuiltInIconProvider | null;
    checkAllProviders?: () => Promise<void>;
    checkProvider?: (provider: BuiltInIconProvider) => Promise<void>;
    refreshProvider?: (provider: BuiltInIconProvider) => Promise<void>;
  };
  publicStatusPage?: {
    enabled?: boolean;
    pageUrl?: string | null;
    showPrices?: boolean;
    visibleCount?: number;
    hiddenCount?: number;
  };
  publicApi?: {
    tokens?: Array<{
      id: string;
      name: string;
      tokenPrefix: string;
      scopes: ["read"];
      createdAt: string;
      lastUsedAt?: string | null;
    }>;
    createdPlainToken?: string | null;
  };
  authSecurity?: Partial<SettingsAuthSecurityController>;
  telegramBotCommands?: Partial<SettingsTelegramBotCommandsController>;
  rates?: ExchangeRates;
  activeRateProvider?: ExchangeRateSource;
  ratesWarning?: ExchangeRateCoverageWarning | null;
  reportBasisStatus?: ReportExchangeRateBasisStatus;
  externalIntegrationsDisabled?: boolean;
  sensitiveAccountActionsDisabled?: boolean;
  sensitiveAccountActionsDemoDisabled?: boolean;
  customConfig?: CustomConfig;
} = {}) {
  const fn = vi.fn();
  const checkAllProviders = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const checkProvider = vi.fn<(provider: BuiltInIconProvider) => Promise<void>>().mockResolvedValue(undefined);
  const refreshProvider = vi.fn<(provider: BuiltInIconProvider) => Promise<void>>().mockResolvedValue(undefined);
  const currencySymbols: Record<string, string> = {
    CNY: "¥",
    EUR: "€",
    GBP: "£",
    USD: "$",
  };

  return {
    settings: {
      ...DEFAULT_SETTINGS,
      enabledChannels: ["email"],
      smtpHost: "smtp.example.com",
      smtpPort: "587",
      smtpSecure: false,
      smtpUser: "smtp-user",
      smtpPassword: "smtp-password",
      smtpFrom: "Renewlet <noreply@example.com>",
      smtpReplyTo: "support@example.com",
      recipientEmail: "alice@example.com",
      ...overrides.settings,
    },
    effectiveThemeMode: overrides.effectiveThemeMode ?? overrides.settings?.themeMode ?? DEFAULT_SETTINGS.themeMode,
    accountEmail: "alice@example.com",
    canManageUsers: overrides.canManageUsers ?? true,
    canAccessPocketBaseAdmin: overrides.canAccessPocketBaseAdmin ?? true,
    customConfig: overrides.customConfig ?? DEFAULT_CUSTOM_CONFIG,
    subscriptionsQuery: { data: [] },
    categoryUsageCount: new Map(),
    rates: overrides.rates ?? {},
    activeRateProvider: overrides.activeRateProvider ?? "frankfurter",
    ratesLoading: false,
    lastUpdated: null,
    ratesError: null,
    ratesErrorDetails: null,
    ratesWarning: overrides.ratesWarning ?? null,
    reportBasisStatus: overrides.reportBasisStatus ?? {
      month: "2026-08",
      locked: true,
      sourceDate: "2026-08-01",
      capturedAt: "2026-08-06T00:00:00.000Z",
    },
    getCurrencySymbol: (currency: string) => currencySymbols[currency] ?? currency,
    updateCategories: fn,
    updateStatuses: fn,
    updatePaymentMethods: fn,
    updateSetting: fn,
    monthlyBudgetInput: String(overrides.settings?.monthlyBudget ?? DEFAULT_SETTINGS.monthlyBudget),
    monthlyBudgetError: null,
    handleMonthlyBudgetInputChange: fn,
    toggleChannel: fn,
    handleRefreshRates: fn,
    handleUpdateCurrencies: fn,
    hasUnsavedChanges: overrides.hasUnsavedChanges ?? false,
    handleSaveChanges: fn,
    handleDiscardChanges: fn,
    handleDefaultCurrencyChange: fn,
    handleExchangeRateProviderChange: fn,
    handleThemeModeChange: fn,
    handleThemeVariantChange: fn,
    handleThemeCustomColorChange: fn,
    testingChannel: overrides.testingChannel ?? null,
    handleTestConnection: fn,
    isSavingSettings: overrides.isSavingSettings ?? false,
    notificationHistory: {
      data: undefined,
      isLoading: false,
      isFetching: false,
      error: null,
      historyStatus: "all",
      setStatus: fn,
      loadMore: fn,
      refetch: fn,
    },
    calendarFeed: {
      data: { enabled: overrides.calendarFeed?.enabled ?? false },
      feedUrl: overrides.calendarFeed?.feedUrl ?? null,
      isLoading: false,
      isCreating: false,
      isDeleting: false,
      createOrRotate: fn,
      copyUrl: fn,
      openSystem: fn,
      regenerate: fn,
      revoke: fn,
    },
    builtInIconIndex: {
      canManage: overrides.builtInIconIndex?.canManage ?? true,
      status: overrides.builtInIconIndex?.status ?? {
        source: "embedded",
        hash: "embedded-hash",
        iconCount: 10249,
        providerCounts: { thesvg: 6047, selfhst: 2346, dashboardIcons: 1856 },
        checkedAt: null,
        updatedAt: null,
        refreshing: false,
        providers: BUILT_IN_ICON_PROVIDERS.map((provider) => ({
          provider,
          current: iconProviderVersion(provider),
          latest: null,
          iconCount: provider === "thesvg" ? 6047 : provider === "selfhst" ? 2346 : 1856,
          checkedAt: null,
          refreshedAt: null,
          lastError: null,
          refreshing: false,
          updateAvailable: false,
        })),
      },
      isLoading: overrides.builtInIconIndex?.isLoading ?? false,
      checkingProviders: overrides.builtInIconIndex?.checkingProviders ?? [],
      refreshingProvider: overrides.builtInIconIndex?.refreshingProvider ?? null,
      errorDetails: null,
      errorDetailsOpen: false,
      setErrorDetailsOpen: fn,
      checkAllProviders: overrides.builtInIconIndex?.checkAllProviders ?? checkAllProviders,
      checkProvider: overrides.builtInIconIndex?.checkProvider ?? checkProvider,
      refreshProvider: overrides.builtInIconIndex?.refreshProvider ?? refreshProvider,
    },
    publicStatusPage: {
      enabled: overrides.publicStatusPage?.enabled ?? false,
      pageUrl: overrides.publicStatusPage?.pageUrl ?? null,
      showPrices: overrides.publicStatusPage?.showPrices ?? false,
      visibleCount: overrides.publicStatusPage?.visibleCount ?? 0,
      hiddenCount: overrides.publicStatusPage?.hiddenCount ?? 0,
      isLoading: false,
      isCreating: false,
      isDeleting: false,
      isUpdating: false,
      createOrRotate: fn,
      copyUrl: fn,
      openPage: fn,
      regenerate: fn,
      revoke: fn,
      updateShowPrices: fn,
    },
    publicApi: {
      tokens: overrides.publicApi?.tokens ?? [],
      createdPlainToken: overrides.publicApi?.createdPlainToken ?? null,
      isLoading: false,
      isCreating: false,
      deletingTokenId: null,
      createToken: fn,
      copyPlainToken: fn,
      dismissPlainToken: fn,
      deleteToken: fn,
    },
    telegramBotCommands: {
      data: undefined,
      isLoading: false,
      isInstalling: false,
      isDeleting: false,
      installDisabledReason: "请先填写并保存 Bot Token 和 Chat ID。",
      deleteDisabledReason: "请先填写并保存 Bot Token 和 Chat ID。",
      install: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      deleteCommands: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      refetch: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      ...overrides.telegramBotCommands,
    },
    authSecurity: {
      canManage: true,
      disabled: false,
      isLoading: false,
      isSaving: false,
      isClearingSecret: false,
      secretConfigured: false,
      hasChanges: false,
      draft: { enabled: false, siteKey: "", secret: "" },
      setEnabled: fn,
      setSiteKey: fn,
      setSecret: fn,
      discard: fn,
      save: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      clearSecret: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
      ...overrides.authSecurity,
    },
    password: {
      passwordDialogOpen: false,
      setPasswordDialogOpen: fn,
      handlePasswordDialogOpenChange: fn,
      currentPassword: "",
      setCurrentPassword: fn,
      newPassword: "",
      setNewPassword: fn,
      confirmPassword: "",
      setConfirmPassword: fn,
      isUpdatingPassword: false,
      updatePassword: fn,
    },
    passwordResetEnabled: true,
    externalIntegrationsDisabled: overrides.externalIntegrationsDisabled ?? false,
    sensitiveAccountActionsDisabled: overrides.sensitiveAccountActionsDisabled ?? false,
    sensitiveAccountActionsDemoDisabled: overrides.sensitiveAccountActionsDemoDisabled ?? false,
  };
}

function RouteProbe() {
  const location = useLocation();
  return <div data-testid="route-path">{location.pathname}</div>;
}

export function renderSettingsScreen(initialEntries = ["/settings"]) {
  mocks.useCloudBackupController.mockReturnValue(createCloudBackupControllerState());
  if (mocks.useUploadedAssetsManager.getMockImplementation() === undefined) {
    mocks.useUploadedAssetsManager.mockReturnValue(createUploadedAssetsManagerState());
  }
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <div id="root">
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={initialEntries}>
          <TooltipProvider delayDuration={0}>
            <SettingsScreen />
          </TooltipProvider>
          <RouteProbe />
        </MemoryRouter>
      </QueryClientProvider>
    </div>,
  );
}
