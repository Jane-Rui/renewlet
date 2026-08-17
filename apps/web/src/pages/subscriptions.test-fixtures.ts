import { appSettingsSecretStatus } from "@renewlet/shared/schemas/settings";
import type { SettingsReadModel } from "@/services/settings-service";
import { DEFAULT_SETTINGS } from "@/types/subscription";

const settings = {
  ...DEFAULT_SETTINGS,
  timezone: "Asia/Shanghai",
  defaultCurrency: "CNY",
  notificationReminderDays: 5,
  subscriptionPriceReferenceEnabled: true,
  subscriptionPriceReferenceCurrency: "USD",
};

export const DEFAULT_SUBSCRIPTIONS_PAGE_SETTINGS: SettingsReadModel = {
  settings,
  secretStatus: appSettingsSecretStatus(settings),
};
