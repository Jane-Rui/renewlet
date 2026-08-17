import type { ReportExchangeRateBasisStatus } from "@/hooks/use-report-exchange-rates";
import type { CalendarFeedStatus } from "@/lib/api/schemas/calendar-feed";
import type { ExchangeRateCoverageWarning, ExchangeRateProvider, ExchangeRates } from "@/lib/api/schemas/exchange-rates";
import type { SettingsSecretKey, SettingsSecretStatus } from "@/lib/api/schemas/settings";
import type { RawErrorResponseDetails } from "@/lib/raw-error-response";
import type { ClipboardCopyTarget } from "@/shared/browser/clipboard";
import type { ConfigItem, CustomConfig } from "@/types/config";
import type { AppSettings, NotificationChannel, Subscription } from "@/types/subscription";
import type { CustomThemeColor, ThemeMode, ThemeVariant } from "@/types/theme";
import type { SettingsAuthSecurityController } from "./use-auth-security-settings-controller";
import type { SettingsBuiltInIconIndexController } from "./use-built-in-icon-index-controller";
import type { NotificationHistoryResponse, NotificationHistoryStatusFilter } from "./use-notification-history";
import type { PasswordChangeController } from "./use-password-change";
import type { SettingsPublicApiController } from "./use-public-api-settings-controller";
import type { SettingsPublicStatusPageController } from "./use-public-status-page-settings-controller";
import type { SettingsTelegramBotCommandsController } from "./use-telegram-bot-commands-controller";

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
  secretStatus: SettingsSecretStatus;
  clearSecret: (key: SettingsSecretKey) => void;
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
  reportBasisStatus: ReportExchangeRateBasisStatus;
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
  authSecurity: SettingsAuthSecurityController;
  password: PasswordChangeController;
  passwordResetEnabled: boolean;
  externalIntegrationsDisabled: boolean;
  sensitiveAccountActionsDisabled: boolean;
  sensitiveAccountActionsDemoDisabled: boolean;
}
