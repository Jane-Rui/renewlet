/**
 * 设置页 application controller。
 *
 * 架构位置：
 * - presentation 只渲染 `SettingsScreen`，所有副作用都在这里收敛。
 * - domain 只提供纯规则（分类使用计数、货币启用策略），避免框架依赖进入业务规则。
 *
 * 关键依赖：
 * - React Query hooks：读取/保存 settings、subscriptions、自定义配置。
 * - 本地 ThemeProvider + theme-storage：处理“立即预览但稍后保存”的外观状态。
 * - toast/api hooks：把网络错误转成用户可理解的反馈。
 *
 * 状态流转：
 * ```
 * 远端 settings -> 首次初始化本地表单
 *              -> 若本地外观有 pending，则外观字段以 localStorage 为准
 * 用户编辑表单 -> draft state
 *              -> 保存更改 -> API -> React Query 缓存 + saved snapshot
 * ```
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clearThemeModeOverride, useTheme } from "@/lib/theme-provider";
import { useCustomConfig } from "@/contexts/CustomConfigContext";
import { useExchangeRates } from "@/hooks/use-exchange-rates";
import { useSettings, useUpdateSettings } from "@/hooks/use-settings";
import { useSubscriptions } from "@/hooks/use-subscriptions";
import { usePasswordResetAvailability } from "@/hooks/use-password-reset-availability";
import { useSetupStatus } from "@/hooks/use-setup-status";
import { useCalendarFeedStatus, useCreateCalendarFeed, useDeleteCalendarFeed } from "@/hooks/use-calendar-feed";
import { useToast } from "@/hooks/use-toast";
import { getDisplayErrorMessage } from "@/lib/display-error";
import type { RawErrorResponseDetails } from "@/lib/raw-error-response";
import { applyThemeVariant } from "@/lib/theme-variant";
import { openValidatedWebcalUrl } from "@/shared/browser/calendar-links";
import { copyTextToClipboard, type ClipboardCopyTarget } from "@/shared/browser/clipboard";
import {
  clearSettingsAppearanceDraftFromStorage,
  writeAppearancePendingToStorage,
  writeCustomThemeColorToStorage,
  writeSettingsThemeModeToStorage,
  writeThemeVariantToStorage,
} from "@/lib/theme-storage";
import type {
  ExchangeRateCoverageWarning,
  ExchangeRateProvider,
  ExchangeRates,
} from "@/lib/api/schemas/exchange-rates";
import type { CalendarFeedStatus } from "@/lib/api/schemas/calendar-feed";
import { DEFAULT_SETTINGS, type AppSettings, type NotificationChannel, type Subscription } from "@/types/subscription";
import { normalizePaymentMethods, type ConfigItem, type CustomConfig } from "@/types/config";
import type { CustomThemeColor, ThemeMode, ThemeVariant } from "@/types/theme";
import { parseNonNegativeFiniteNumberInput } from "@/lib/subscription-form";
import { normalizeCustomConfig } from "@/modules/custom-config/domain/normalize-custom-config";
import { isCloudflareRuntime } from "@/services/runtime";
import { countSubscriptionsByCategory } from "../domain/category-usage";
import { enforceCurrencyConfigPolicy } from "../domain/currency-config-policy";
import { useAccountIdentity } from "./use-account-email";
import { useNotificationTest } from "./use-notification-test";
import { usePasswordChange, type PasswordChangeController } from "./use-password-change";
import {
  areJsonSnapshotsEqual,
  createDraftSettingsFromRemote,
  createSavedSettingsBaseline,
  EXTERNAL_INTEGRATION_SETTING_KEYS,
  getExchangeRateProviderSaveErrorMessage,
} from "./settings-form-controller-utils";
import {
  usePublicStatusPageSettingsController,
  type SettingsPublicStatusPageController,
} from "./use-public-status-page-settings-controller";
import {
  usePublicApiSettingsController,
  type SettingsPublicApiController,
} from "./use-public-api-settings-controller";
import {
  useTelegramBotCommandsController,
  type SettingsTelegramBotCommandsController,
} from "./use-telegram-bot-commands-controller";
import {
  useSettingsBuiltInIconIndexController,
  type SettingsBuiltInIconIndexController,
} from "./use-built-in-icon-index-controller";
import {
  useNotificationHistory,
  type NotificationHistoryResponse,
  type NotificationHistoryStatusFilter,
} from "./use-notification-history";
import { useI18n } from "@/i18n/I18nProvider";

type UpdateSetting = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;

interface SettingsSubscriptionsQuery {
  data: Subscription[] | undefined;
  isPending: boolean;
  status: "pending" | "error" | "success";
}

interface SettingsNotificationHistoryController {
  data: NotificationHistoryResponse | undefined;
  isLoading: boolean;
  isFetching: boolean;
  error: unknown;
  historyStatus: NotificationHistoryStatusFilter;
  setStatus: (status: NotificationHistoryStatusFilter) => void;
  loadMore: () => void;
  refetch: () => void | Promise<unknown>;
}

interface SettingsCalendarFeedController {
  data: CalendarFeedStatus | undefined;
  feedUrl: string | null;
  isLoading: boolean;
  isCreating: boolean;
  isDeleting: boolean;
  createOrRotate: () => Promise<void>;
  copyUrl: (target?: ClipboardCopyTarget | null) => Promise<void>;
  openSystem: () => Promise<void>;
  regenerate: () => Promise<void>;
  revoke: () => Promise<void>;
}

export interface SettingsFormController {
  settings: AppSettings;
  effectiveThemeMode: ThemeMode;
  accountEmail: string | null;
  canManageUsers: boolean;
  canAccessPocketBaseAdmin: boolean;
  customConfig: CustomConfig;
  subscriptionsQuery: SettingsSubscriptionsQuery;
  categoryUsageCount: Map<string, number>;
  rates: ExchangeRates;
  activeRateProvider: ExchangeRateProvider | "builtin";
  ratesLoading: boolean;
  lastUpdated: Date | null;
  ratesError: string | null;
  ratesErrorDetails: RawErrorResponseDetails | null;
  ratesWarning: ExchangeRateCoverageWarning | null;
  getCurrencySymbol: (currency: string) => string;
  updateCategories: (items: ConfigItem[]) => void;
  updateStatuses: (items: ConfigItem[]) => void;
  updatePaymentMethods: (items: ConfigItem[]) => void;
  updateCurrencies: (items: ConfigItem[]) => void;
  updateSetting: UpdateSetting;
  monthlyBudgetInput: string;
  monthlyBudgetError: string | null;
  handleMonthlyBudgetInputChange: (rawValue: string) => void;
  toggleChannel: (channel: NotificationChannel) => void;
  handleRefreshRates: () => Promise<void>;
  handleUpdateCurrencies: (items: ConfigItem[]) => void;
  hasUnsavedChanges: boolean;
  handleSaveChanges: () => Promise<void>;
  handleDiscardChanges: () => void;
  isSavingSettings: boolean;
  handleDefaultCurrencyChange: (value: string) => void;
  handleExchangeRateProviderChange: (value: ExchangeRateProvider) => void;
  handleThemeModeChange: (value: ThemeMode) => void;
  handleThemeVariantChange: (value: ThemeVariant) => void;
  handleThemeCustomColorChange: (value: CustomThemeColor) => void;
  testingChannel: NotificationChannel | null;
  handleTestConnection: (channel: NotificationChannel) => void | Promise<void>;
  notificationTestErrorDetails: RawErrorResponseDetails | null;
  notificationTestErrorDetailsOpen: boolean;
  setNotificationTestErrorDetailsOpen: (open: boolean) => void;
  notificationHistory: SettingsNotificationHistoryController;
  calendarFeed: SettingsCalendarFeedController;
  builtInIconIndex: SettingsBuiltInIconIndexController;
  publicStatusPage: SettingsPublicStatusPageController;
  publicApi: SettingsPublicApiController;
  telegramBotCommands: SettingsTelegramBotCommandsController;
  password: PasswordChangeController;
  passwordResetEnabled: boolean;
  externalIntegrationsDisabled: boolean;
  sensitiveAccountActionsDisabled: boolean;
  sensitiveAccountActionsDemoDisabled: boolean;
}

/**
 * 集中协调 Settings 页的远端状态、本地编辑态和跨模块用例。
 *
 * 注意： Settings 页只有这一处写入口。新增设置字段时，要同时检查：
 * settings schema、默认值、API merge 策略，以及是否应该纳入统一保存草稿。
 */
export function useSettingsFormController(): SettingsFormController {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [savedSettings, setSavedSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [customConfig, setCustomConfig] = useState<CustomConfig>(() => normalizeCustomConfig(null));
  const [savedCustomConfig, setSavedCustomConfig] = useState<CustomConfig>(() => normalizeCustomConfig(null));
  const [hasInitializedCustomConfig, setHasInitializedCustomConfig] = useState(false);
  const [monthlyBudgetInput, setMonthlyBudgetInput] = useState(String(DEFAULT_SETTINGS.monthlyBudget));
  const [monthlyBudgetError, setMonthlyBudgetError] = useState<string | null>(null);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const accountIdentity = useAccountIdentity();
  const accountEmail = accountIdentity.email;
  const canManageUsers = accountIdentity.role === "admin" && !accountIdentity.banned;
  const { data: remoteSettings } = useSettings();
  const subscriptionsQuery = useSubscriptions();
  const updateSettings = useUpdateSettings();
  const { theme, setTheme } = useTheme();
  const { config: persistedCustomConfig, saveConfig } = useCustomConfig();
  const {
    rates,
    activeProvider: activeRateProvider,
    loading: ratesLoading,
    lastUpdated,
    refresh: refreshRates,
    error: ratesError,
    errorDetails: ratesErrorDetails,
    warning: ratesWarning,
    getCurrencySymbol,
  } = useExchangeRates(savedSettings.exchangeRateProvider);
  const { toast } = useToast();
  const { t, setLocale } = useI18n();
  const appStatus = useSetupStatus();
  const externalIntegrationsDisabled = appStatus.isLoading || appStatus.demoMode;
  // demo 模式同时禁用外部集成和账号安全写操作；这里拆成两个语义，避免后续把密码/MFA/Passkey 误归到外部集成策略里。
  const sensitiveAccountActionsDisabled = appStatus.isLoading || appStatus.demoMode;
  const sensitiveAccountActionsDemoDisabled = appStatus.demoMode;
  const password = usePasswordChange();
  const passwordResetEnabled = usePasswordResetAvailability();
  const notificationTest = useNotificationTest(settings);
  const notificationHistory = useNotificationHistory();
  const calendarFeedStatus = useCalendarFeedStatus();
  const createCalendarFeed = useCreateCalendarFeed();
  const deleteCalendarFeed = useDeleteCalendarFeed();
  const canRefreshBuiltInIconIndex = accountIdentity.role === "admin";
  const builtInIconIndex = useSettingsBuiltInIconIndexController(canRefreshBuiltInIconIndex);
  const { refetch: refetchNotificationHistory } = notificationHistory;
  const hasInitializedFromRemoteRef = useRef(false);
  const hasResolvedDefaultRecipientEmailRef = useRef(false);
  const settingsDirtyRef = useRef(false);
  const customConfigDirtyRef = useRef(false);

  const categoryUsageCount = useMemo(
    () => countSubscriptionsByCategory(subscriptionsQuery.data ?? []),
    [subscriptionsQuery.data],
  );
  const publicStatusPage = usePublicStatusPageSettingsController(subscriptionsQuery.data);
  const publicApi = usePublicApiSettingsController();
  const telegramBotCommands = useTelegramBotCommandsController({
    settings,
    savedSettings,
    externalIntegrationsDisabled,
  });
  const { refetch: refetchTelegramBotCommands } = telegramBotCommands;

  const monthlyBudgetInputDirty = monthlyBudgetInput !== String(settings.monthlyBudget);
  const settingsDirty = useMemo(
    () => !areJsonSnapshotsEqual(settings, savedSettings),
    [settings, savedSettings],
  );
  const settingsInputDirty = settingsDirty || monthlyBudgetInputDirty;
  const customConfigDirty = useMemo(
    () => !areJsonSnapshotsEqual(customConfig, savedCustomConfig),
    [customConfig, savedCustomConfig],
  );
  const hasUnsavedChanges = settingsInputDirty || customConfigDirty;
  const effectiveThemeMode: ThemeMode = theme;

  useEffect(() => {
    // effect 读取 ref 而不是把 draft 放入依赖，是为了在远端刷新时判断“当前是否仍可安全覆盖本地草稿”。
    settingsDirtyRef.current = settingsInputDirty;
  }, [settingsInputDirty]);

  useEffect(() => {
    // 自定义配置可能由独立 Provider 防抖保存回流；dirty ref 防止回流覆盖用户正在编辑的草稿。
    customConfigDirtyRef.current = customConfigDirty;
  }, [customConfigDirty]);

  useEffect(() => {
    if (!remoteSettings) return;
    // 收件人邮箱默认值必须和远端 settings 同步在同一条 effect 里生成，避免 Cloudflare session 先恢复时被下一轮远端草稿覆盖。
    const shouldDefaultRecipientEmail = !externalIntegrationsDisabled && !hasResolvedDefaultRecipientEmailRef.current;
    const nextDraft = createDraftSettingsFromRemote(
      remoteSettings,
      shouldDefaultRecipientEmail ? accountEmail : null,
      shouldDefaultRecipientEmail,
    );
    const nextSavedSettings = createSavedSettingsBaseline(remoteSettings, nextDraft);
    const hasResolvedRecipientEmail = Boolean(nextDraft.recipientEmail.trim());
    if (!hasInitializedFromRemoteRef.current) {
      setSavedSettings(nextSavedSettings);
      setSettings(nextDraft);
      setMonthlyBudgetInput(String(nextDraft.monthlyBudget));
      if (hasResolvedRecipientEmail) hasResolvedDefaultRecipientEmailRef.current = true;
      hasInitializedFromRemoteRef.current = true;
      return;
    }

    // 只有本地草稿未脏时才用远端刷新覆盖，避免 React Query 背景刷新吞掉用户未保存编辑。
    if (!settingsDirtyRef.current) {
      setSavedSettings(nextSavedSettings);
      setSettings(nextDraft);
      setMonthlyBudgetInput(String(nextDraft.monthlyBudget));
      if (hasResolvedRecipientEmail) hasResolvedDefaultRecipientEmailRef.current = true;
    } else if (remoteSettings.recipientEmail.trim()) {
      hasResolvedDefaultRecipientEmailRef.current = true;
    }
  }, [accountEmail, externalIntegrationsDisabled, remoteSettings]);

  useEffect(() => {
    const normalized = normalizeCustomConfig(persistedCustomConfig);
    if (!hasInitializedCustomConfig) {
      setSavedCustomConfig(normalized);
      setCustomConfig(normalized);
      setHasInitializedCustomConfig(true);
      return;
    }

    if (!customConfigDirtyRef.current) {
      // Provider 的防抖保存会回流远端配置；未脏时同步，脏时让用户继续编辑当前草稿。
      setSavedCustomConfig(normalized);
      setCustomConfig(normalized);
    }
  }, [hasInitializedCustomConfig, persistedCustomConfig]);

  const updateSetting = useCallback(<K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    // Demo 置灰只是体验层；controller 也阻止本地草稿改动外部集成字段，真正安全边界仍在后端 route/hook。
    if (externalIntegrationsDisabled && EXTERNAL_INTEGRATION_SETTING_KEYS.has(key)) return;
    setSettings((prev) => ({ ...prev, [key]: value }));
  }, [externalIntegrationsDisabled]);

  const handleMonthlyBudgetInputChange = useCallback(
    (rawValue: string) => {
      setMonthlyBudgetInput(rawValue);
      if (rawValue.trim() === "") {
        setMonthlyBudgetError(t("settings.budgetInvalid"));
        return;
      }

      const parsed = parseNonNegativeFiniteNumberInput(rawValue);
      if (parsed === null) {
        setMonthlyBudgetError(t("settings.budgetInvalid"));
        return;
      }

      setMonthlyBudgetError(null);
      updateSetting("monthlyBudget", parsed);
    },
    [t, updateSetting],
  );

  const toggleChannel = useCallback((channel: NotificationChannel) => {
    if (externalIntegrationsDisabled) return;
    setSettings((prev) => ({
      ...prev,
      enabledChannels: prev.enabledChannels.includes(channel)
        ? prev.enabledChannels.filter((c) => c !== channel)
        : [...prev.enabledChannels, channel],
    }));
  }, [externalIntegrationsDisabled]);

  const updateCategories = useCallback((items: ConfigItem[]) => {
    setCustomConfig((prev) => ({ ...prev, categories: items }));
  }, []);

  const updateStatuses = useCallback((items: ConfigItem[]) => {
    setCustomConfig((prev) => ({ ...prev, statuses: items }));
  }, []);

  const updatePaymentMethods = useCallback((items: ConfigItem[]) => {
    setCustomConfig((prev) => ({ ...prev, paymentMethods: normalizePaymentMethods(items) }));
  }, []);

  const updateCurrencies = useCallback((items: ConfigItem[]) => {
    setCustomConfig((prev) => ({ ...prev, currencies: items }));
  }, []);

  const handleRefreshRates = useCallback(async () => {
    await refreshRates(savedSettings.exchangeRateProvider);
    toast({
      title: t("settings.ratesUpdated"),
      description: t("settings.ratesUpdatedDescription"),
    });
  }, [refreshRates, savedSettings.exchangeRateProvider, t, toast]);

  const handleUpdateCurrencies = useCallback(
    (items: ConfigItem[]) => {
      // 货币开关会影响新增订阅下拉和全站统计口径，因此策略放在 domain 层统一约束。
      const result = enforceCurrencyConfigPolicy(items, settings.defaultCurrency);
      if (result.ok) {
        updateCurrencies(result.items);
        return;
      }

      toast({
        title: result.reason === "none-enabled"
          ? t("settings.currencyPolicy.noneTitle")
          : t("settings.currencyPolicy.defaultTitle"),
        description: result.reason === "none-enabled"
          ? t("settings.currencyPolicy.noneDescription")
          : t("settings.currencyPolicy.defaultDescription", { currency: settings.defaultCurrency }),
        variant: "destructive",
      });

      if (result.items) updateCurrencies(result.items);
    },
    [settings.defaultCurrency, t, toast, updateCurrencies],
  );

  const syncSavedPreviewState = useCallback(
    (nextSettings: AppSettings, options: { syncAppearance: boolean; rememberLocalePreference?: boolean }) => {
      if (options.syncAppearance) {
        clearThemeModeOverride();
        setTheme(nextSettings.themeMode, { localOverride: false });
        applyThemeVariant(nextSettings.themeVariant, nextSettings.themeCustomColor);
        writeThemeVariantToStorage(nextSettings.themeVariant);
        writeCustomThemeColorToStorage(nextSettings.themeCustomColor);
        clearSettingsAppearanceDraftFromStorage();
      }
      setLocale(nextSettings.locale, {
        persist: false,
        markAsSaved: true,
        ...(options.rememberLocalePreference ? { rememberPreference: true } : {}),
      });
    },
    [setLocale, setTheme],
  );

  const handleSaveChanges = useCallback(async () => {
    if (isSavingSettings || !hasUnsavedChanges) return;
    if (monthlyBudgetError) {
      toast({
        title: t("settings.saveFailed"),
        description: monthlyBudgetError,
        variant: "destructive",
      });
      return;
    }

    setIsSavingSettings(true);
    const shouldSaveSettings = settingsDirty;
    const shouldSaveCustomConfig = customConfigDirty;
    const providerChanged = settings.exchangeRateProvider !== savedSettings.exchangeRateProvider;
    const localeChanged = settings.locale !== savedSettings.locale;
    const appearanceChanged = settings.themeMode !== savedSettings.themeMode
      || settings.themeVariant !== savedSettings.themeVariant
      || !areJsonSnapshotsEqual(settings.themeCustomColor, savedSettings.themeCustomColor);

    try {
      const settingsPromise: Promise<AppSettings | null> = shouldSaveSettings
        ? updateSettings.mutateAsync(settings)
        : Promise.resolve(null);
      const customConfigPromise: Promise<CustomConfig | null> = shouldSaveCustomConfig
        ? saveConfig(customConfig)
        : Promise.resolve(null);
      // settings 与 custom config 是两个持久化边界；allSettled 能保留部分成功结果并给出精确失败范围。
      // 不能用 Promise.all，否则其中一个失败会掩盖另一个已经成功的事实，导致 saved snapshot 与远端不一致。
      const [settingsResult, customConfigResult] = await Promise.allSettled([
        settingsPromise,
        customConfigPromise,
      ] as const);

      const failedScopes: string[] = [];
      let firstError: unknown = null;

      if (settingsResult.status === "fulfilled" && settingsResult.value) {
        const saved = settingsResult.value;
        setSavedSettings(saved);
        setSettings(saved);
        setMonthlyBudgetInput(String(saved.monthlyBudget));
        setMonthlyBudgetError(null);
        syncSavedPreviewState(saved, { syncAppearance: appearanceChanged, rememberLocalePreference: localeChanged });
        void refetchNotificationHistory();
        // Bot 命令安装状态读取的是已保存凭据；保存 token/chat 后要主动刷新，不能等低频 query 自然过期。
        void refetchTelegramBotCommands();
        if (providerChanged) {
          try {
            // 汇率刷新必须使用服务端已接受的 provider；草稿值可能因后端旧版本或保存失败没有真正生效。
            await refreshRates(saved.exchangeRateProvider);
          } catch (e) {
            console.warn("Failed to refresh exchange rates after saving settings:", e);
          }
        }
      } else if (settingsResult.status === "rejected") {
        failedScopes.push(t("settings.appSettingsScope"));
        firstError = settingsResult.reason;
      }

      if (customConfigResult.status === "fulfilled" && customConfigResult.value) {
        const savedConfig = customConfigResult.value;
        setSavedCustomConfig(savedConfig);
        setCustomConfig(savedConfig);
      } else if (customConfigResult.status === "rejected") {
        failedScopes.push(t("settings.customConfigScope"));
        firstError ??= customConfigResult.reason;
      }

      if (failedScopes.length === 0) {
        const committedSettings = settingsResult.status === "fulfilled" && settingsResult.value
          ? settingsResult.value
          : settings;
        setMonthlyBudgetInput(String(committedSettings.monthlyBudget));
        setMonthlyBudgetError(null);
        toast({
          title: t("settings.saved"),
          description: t("settings.savedDescription"),
        });
        return;
      }

      const fallbackDescription = providerChanged && firstError
        ? getExchangeRateProviderSaveErrorMessage(firstError, t)
        : getDisplayErrorMessage(firstError, t("settings.saveFailedDescription"));
      toast({
        title: t("settings.saveFailed"),
        description: failedScopes.length > 1
          ? t("settings.partialSaveFailedDescription", { scope: failedScopes.join(", ") })
          : fallbackDescription,
        variant: "destructive",
      });
    } finally {
      setIsSavingSettings(false);
    }
  }, [
    customConfig,
    customConfigDirty,
    hasUnsavedChanges,
    isSavingSettings,
    monthlyBudgetError,
    refetchNotificationHistory,
    refreshRates,
    saveConfig,
    savedSettings.exchangeRateProvider,
    savedSettings.locale,
    savedSettings.themeCustomColor,
    savedSettings.themeMode,
    savedSettings.themeVariant,
    settings,
    settingsDirty,
    syncSavedPreviewState,
    t,
    refetchTelegramBotCommands,
    toast,
    updateSettings,
  ]);

  const handleDiscardChanges = useCallback(() => {
    setSettings(savedSettings);
    setMonthlyBudgetInput(String(savedSettings.monthlyBudget));
    setCustomConfig(savedCustomConfig);
    setMonthlyBudgetError(null);
    syncSavedPreviewState(savedSettings, { syncAppearance: true });
  }, [savedCustomConfig, savedSettings, syncSavedPreviewState]);

  const handleDefaultCurrencyChange = useCallback(
    (value: string) => {
      updateSetting("defaultCurrency", value);
    },
    [updateSetting],
  );

  const handleExchangeRateProviderChange = useCallback(
    (value: ExchangeRateProvider) => {
      updateSetting("exchangeRateProvider", value);
    },
    [updateSetting],
  );

  const handleCreateCalendarFeed = useCallback(async () => {
    try {
      // Feed URL 是低权限 bearer secret；创建成功后由 React Query 缓存接住新 token，避免用户复制旧地址。
      await createCalendarFeed.mutateAsync();
      toast({
        title: t("settings.calendarFeedGenerated"),
        description: t("settings.calendarFeedGeneratedDescription"),
      });
    } catch (error) {
      toast({
        title: t("settings.calendarFeedFailed"),
        description: getDisplayErrorMessage(error, t("settings.calendarFeedFailedDescription")),
        variant: "destructive",
      });
    }
  }, [createCalendarFeed, t, toast]);

  const handleCopyCalendarFeedUrl = useCallback(async (target?: ClipboardCopyTarget | null) => {
    const feedUrl = calendarFeedStatus.data?.feedUrl;
    if (!feedUrl) return;
    // 复制只读当前缓存中的 URL；不在点击时重新请求，避免系统剪贴板动作和网络竞态叠加。
    const copyResult = await copyTextToClipboard(feedUrl, { target });
    if (copyResult.ok) {
      toast({
        title: t("settings.calendarFeedCopied"),
        description: t("settings.calendarFeedCopiedDescription"),
      });
      return;
    }
    toast({
      title: t("settings.calendarFeedCopyFailed"),
      description: t("settings.calendarFeedCopyFailedDescription"),
      variant: "destructive",
    });
  }, [calendarFeedStatus.data?.feedUrl, t, toast]);

  const handleOpenCalendarFeedSystem = useCallback(async () => {
    const feedUrl = calendarFeedStatus.data?.feedUrl;
    if (!feedUrl) return;
    try {
      await openValidatedWebcalUrl(feedUrl);
      toast({
        title: t("settings.calendarFeedOpenSystemAttempted"),
        description: t("settings.calendarFeedOpenSystemAttemptedDescription"),
      });
    } catch (error) {
      toast({
        title: t("settings.calendarFeedOpenSystemFailed"),
        description: getDisplayErrorMessage(error, t("settings.calendarFeedOpenSystemFailedDescription")),
        variant: "destructive",
      });
    }
  }, [calendarFeedStatus.data?.feedUrl, t, toast]);

  const handleRevokeCalendarFeed = useCallback(async () => {
    try {
      // 撤销必须立即清远端 token；前端缓存只负责让 UI 及时显示 disabled，不作为安全边界。
      await deleteCalendarFeed.mutateAsync();
      toast({
        title: t("settings.calendarFeedRevoked"),
        description: t("settings.calendarFeedRevokedDescription"),
      });
    } catch (error) {
      toast({
        title: t("settings.calendarFeedFailed"),
        description: getDisplayErrorMessage(error, t("settings.calendarFeedRevokeFailedDescription")),
        variant: "destructive",
      });
    }
  }, [deleteCalendarFeed, t, toast]);

  const handleRegenerateCalendarFeed = useCallback(async () => {
    try {
      // 轮换使用“先撤销后创建”，确保旧 URL 在服务端失效后才展示新 URL。
      await deleteCalendarFeed.mutateAsync();
      await createCalendarFeed.mutateAsync();
      toast({
        title: t("settings.calendarFeedRegenerated"),
        description: t("settings.calendarFeedRegeneratedDescription"),
      });
    } catch (error) {
      toast({
        title: t("settings.calendarFeedFailed"),
        description: getDisplayErrorMessage(error, t("settings.calendarFeedFailedDescription")),
        variant: "destructive",
      });
    }
  }, [createCalendarFeed, deleteCalendarFeed, t, toast]);

  const handleThemeModeChange = useCallback(
    (value: ThemeMode) => {
      updateSetting("themeMode", value);
      setTheme(value);
      writeSettingsThemeModeToStorage(value);
      writeAppearancePendingToStorage(true);
    },
    [setTheme, updateSetting],
  );

  const handleThemeVariantChange = useCallback(
    (value: ThemeVariant) => {
      // 主题风格先写 DOM 再等待统一保存；这是为了让 Settings 页像控制面板一样即时反馈。
      setSettings((prev) => ({
        ...prev,
        themeMode: effectiveThemeMode,
        themeVariant: value,
      }));
      writeSettingsThemeModeToStorage(effectiveThemeMode);
      applyThemeVariant(value, settings.themeCustomColor);
      writeThemeVariantToStorage(value);
      writeAppearancePendingToStorage(true);
    },
    [effectiveThemeMode, settings.themeCustomColor],
  );

  const handleThemeCustomColorChange = useCallback(
    (value: CustomThemeColor) => {
      // 自定义色只有在 custom 主题下才需要立即覆写 CSS 变量，其他主题仅保存候选值。
      setSettings((prev) => ({
        ...prev,
        themeMode: effectiveThemeMode,
        themeCustomColor: value,
      }));
      writeSettingsThemeModeToStorage(effectiveThemeMode);
      writeCustomThemeColorToStorage(value);
      writeAppearancePendingToStorage(true);

      if (settings.themeVariant === "custom") {
        applyThemeVariant("custom", value);
      }
    },
    [effectiveThemeMode, settings.themeVariant],
  );

  const handleTestConnection = useCallback(
    (channel: NotificationChannel) => {
      if (externalIntegrationsDisabled) return;
      return notificationTest.testConnection(channel);
    },
    [externalIntegrationsDisabled, notificationTest],
  );

  return {
    settings,
    effectiveThemeMode,
    accountEmail,
    canManageUsers,
    canAccessPocketBaseAdmin: canManageUsers && !isCloudflareRuntime,
    customConfig,
    subscriptionsQuery,
    categoryUsageCount,
    rates,
    activeRateProvider,
    ratesLoading,
    lastUpdated,
    ratesError,
    ratesErrorDetails,
    ratesWarning,
    getCurrencySymbol,
    updateCategories,
    updateStatuses,
    updatePaymentMethods,
    updateCurrencies,
    updateSetting,
    monthlyBudgetInput,
    monthlyBudgetError,
    handleMonthlyBudgetInputChange,
    toggleChannel,
    handleRefreshRates,
    handleUpdateCurrencies,
    hasUnsavedChanges,
    handleSaveChanges,
    handleDiscardChanges,
    isSavingSettings,
    handleDefaultCurrencyChange,
    handleExchangeRateProviderChange,
    handleThemeModeChange,
    handleThemeVariantChange,
    handleThemeCustomColorChange,
    testingChannel: notificationTest.testingChannel,
    handleTestConnection,
    notificationTestErrorDetails: notificationTest.errorDetails,
    notificationTestErrorDetailsOpen: notificationTest.errorDetailsOpen,
    setNotificationTestErrorDetailsOpen: notificationTest.setErrorDetailsOpen,
    notificationHistory,
    calendarFeed: {
      data: calendarFeedStatus.data,
      feedUrl: calendarFeedStatus.data?.feedUrl ?? null,
      isLoading: calendarFeedStatus.isLoading,
      isCreating: createCalendarFeed.isPending,
      isDeleting: deleteCalendarFeed.isPending,
      createOrRotate: handleCreateCalendarFeed,
      copyUrl: handleCopyCalendarFeedUrl,
      openSystem: handleOpenCalendarFeedSystem,
      regenerate: handleRegenerateCalendarFeed,
      revoke: handleRevokeCalendarFeed,
    },
    builtInIconIndex,
    publicStatusPage,
    publicApi,
    telegramBotCommands,
    password,
    passwordResetEnabled,
    externalIntegrationsDisabled,
    sensitiveAccountActionsDisabled,
    sensitiveAccountActionsDemoDisabled,
  };
}
