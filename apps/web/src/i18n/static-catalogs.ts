import { setupI18n, type I18n, type Messages } from "@lingui/core";
import { SUPPORTED_LOCALES, type Locale } from "@/i18n/locales";
import type { MessageKey } from "@/i18n/catalog-keys";

import { messages as zhCNAdminMessages } from "@/i18n/catalogs/zh-CN/admin.po";
import { messages as zhCNAuthMessages } from "@/i18n/catalogs/zh-CN/auth.po";
import { messages as zhCNCommonMessages } from "@/i18n/catalogs/zh-CN/common.po";
import { messages as zhCNCustomConfigMessages } from "@/i18n/catalogs/zh-CN/custom-config.po";
import { messages as zhCNErrorMessages } from "@/i18n/catalogs/zh-CN/error.po";
import { messages as zhCNLabelsMessages } from "@/i18n/catalogs/zh-CN/labels.po";
import { messages as zhCNLegalMessages } from "@/i18n/catalogs/zh-CN/legal.po";
import { messages as zhCNNotificationMessages } from "@/i18n/catalogs/zh-CN/notification.po";
import { messages as zhCNPublicStatusMessages } from "@/i18n/catalogs/zh-CN/public-status.po";
import { messages as zhCNSettingsAccessSecurityMessages } from "@/i18n/catalogs/zh-CN/settings-access-security.po";
import { messages as zhCNSettingsMessages } from "@/i18n/catalogs/zh-CN/settings.po";
import { messages as zhCNSubscriptionMessages } from "@/i18n/catalogs/zh-CN/subscription.po";
import { messages as enUSAdminMessages } from "@/i18n/catalogs/en-US/admin.po";
import { messages as enUSAuthMessages } from "@/i18n/catalogs/en-US/auth.po";
import { messages as enUSCommonMessages } from "@/i18n/catalogs/en-US/common.po";
import { messages as enUSCustomConfigMessages } from "@/i18n/catalogs/en-US/custom-config.po";
import { messages as enUSErrorMessages } from "@/i18n/catalogs/en-US/error.po";
import { messages as enUSLabelsMessages } from "@/i18n/catalogs/en-US/labels.po";
import { messages as enUSLegalMessages } from "@/i18n/catalogs/en-US/legal.po";
import { messages as enUSNotificationMessages } from "@/i18n/catalogs/en-US/notification.po";
import { messages as enUSPublicStatusMessages } from "@/i18n/catalogs/en-US/public-status.po";
import { messages as enUSSettingsAccessSecurityMessages } from "@/i18n/catalogs/en-US/settings-access-security.po";
import { messages as enUSSettingsMessages } from "@/i18n/catalogs/en-US/settings.po";
import { messages as enUSSubscriptionMessages } from "@/i18n/catalogs/en-US/subscription.po";

/**
 * 静态 catalog 是非 React 同步逻辑的翻译入口。
 *
 * API 错误映射、service 层 fallback 和导入解析不能依赖组件树里的 LinguiProvider，
 * 因此这里用构建期 `.po` 产物创建独立实例，避免恢复手写双语 map。
 */

const zhCNMessages = {
  ...zhCNCommonMessages,
  ...zhCNLegalMessages,
  ...zhCNCustomConfigMessages,
  ...zhCNSubscriptionMessages,
  ...zhCNAuthMessages,
  ...zhCNSettingsMessages,
  ...zhCNSettingsAccessSecurityMessages,
  ...zhCNPublicStatusMessages,
  ...zhCNNotificationMessages,
  ...zhCNLabelsMessages,
  ...zhCNAdminMessages,
  ...zhCNErrorMessages,
} satisfies Messages;

const enUSMessages = {
  ...enUSCommonMessages,
  ...enUSLegalMessages,
  ...enUSCustomConfigMessages,
  ...enUSSubscriptionMessages,
  ...enUSAuthMessages,
  ...enUSSettingsMessages,
  ...enUSSettingsAccessSecurityMessages,
  ...enUSPublicStatusMessages,
  ...enUSNotificationMessages,
  ...enUSLabelsMessages,
  ...enUSAdminMessages,
  ...enUSErrorMessages,
} satisfies Messages;

export type { MessageKey } from "@/i18n/catalog-keys";
export type MessageParams = Record<string, string | number | boolean | null | undefined>;

export const STATIC_CATALOGS = {
  "zh-CN": zhCNMessages,
  "en-US": enUSMessages,
} satisfies Record<Locale, Messages>;

export function getStaticCatalog(locale: Locale): Messages {
  return STATIC_CATALOGS[locale];
}

const STATIC_I18N = Object.fromEntries(
  SUPPORTED_LOCALES.map((locale) => [
    locale,
    setupI18n({ locale, messages: { [locale]: STATIC_CATALOGS[locale] } }),
  ]),
) as Record<Locale, I18n>;

export function staticCatalogMessage(locale: Locale, key: MessageKey): string {
  return String(STATIC_CATALOGS[locale][key] ?? key);
}

/** translateStaticMessage 服务于 service/domain 这类非 React 调用点，参数格式仍由 Lingui 处理。 */
export function translateStaticMessage(locale: Locale, key: MessageKey, params: MessageParams = {}): string {
  if (!(key in STATIC_CATALOGS[locale])) return key;
  return STATIC_I18N[locale]._(key, params);
}
