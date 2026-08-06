import { z } from "zod";
import {
  BUILT_IN_ICON_PROVIDERS,
  hasEnabledBuiltInIconSource,
  type BuiltInIconSourceSettings,
  type BuiltInIconSourceSettingsPatch,
} from "../built-in-icons";
import {
  APP_STORE_STOREFRONTS,
  normalizeAppStoreStorefronts,
  type OnlineIconSourceSettings,
  type OnlineIconSourceSettingsPatch,
} from "../online-icon-sources";
import {
  NOTIFICATION_CHANNELS,
  MAX_REMINDER_DAYS,
  SUPPORTED_LOCALES,
  THEME_MODES,
  THEME_VARIANTS,
  isValidLocalTime,
  isValidTimeZone,
  normalizeExchangeRateProvider,
  type LocalTime,
} from "../runtime";
import { aiRecognitionSettingsSchema } from "./ai-recognition";
import { apiSuccessResponseSchema } from "./api";
import { exchangeRateProviderSchema } from "./exchange-rates";
import { moneyStringSchema } from "../money";

const hhmmSchema = z.string().refine(isValidLocalTime, "时间格式必须为 HH:mm").transform((value) => value as LocalTime);

const optionalHttpsUrlSchema = z.string().trim().max(2048).refine((value) => {
  if (!value) return true;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}, "必须为空或 https:// URL");

// 端口只做跨运行面的通用合法性校验；Cloudflare 的 25 限制在 Worker 发送边界处理。
const optionalSmtpPortSchema = z.string().trim().max(5).refine((value) => {
  if (!value) return true;
  const port = Number.parseInt(value, 10);
  return Number.isInteger(port) && port > 0 && port <= 65_535 && String(port) === value;
}, "SMTP 端口无效");

const timezoneSchema = z.string().trim().min(1).max(80).refine(isValidTimeZone, "时区无效");
const globalReminderDaysSchema = z.number().int().nonnegative().max(MAX_REMINDER_DAYS);
export const publicStatusCurrencySchema = z.union([
  z.literal("inherit"),
  z.string().trim().regex(/^[A-Z]{3}$/),
]);
export const subscriptionPriceReferenceCurrencySchema = z.union([
  z.literal("default"),
  z.string().trim().regex(/^[A-Z]{3}$/),
]);
// Telegram 菜单命令描述不支持富文本；这个枚举只控制 sendMessage 正文，默认值在 shared defaults 固定为 plain。
export const telegramMessageFormatSchema = z.enum(["plain", "html"]);
export const dingtalkMessageTypeSchema = z.enum(["markdown", "text"]);
export const DINGTALK_TITLE_TEMPLATE_MAX_LENGTH = 500;
export const DINGTALK_CONTENT_TEMPLATE_MAX_LENGTH = 20_000;
const dingtalkTemplateSchema = (maxLength: number) => z.string().refine(
  (value) => Array.from(value).length <= maxLength,
  `最多 ${maxLength} 字符`,
);

const builtInIconSourceSettingSchema = z.object({
  enabled: z.boolean(),
  variantsEnabled: z.boolean(),
}).strict();
// PATCH 允许局部更新 provider 开关，但最终 settings 必须仍至少保留一个可用来源。
const builtInIconSourceSettingPatchSchema = builtInIconSourceSettingSchema.partial().strict();
// storefronts 不是关闭语义；关闭 App Store 来源只能写 enabled=false，空数组必须在写入边界失败。
const appStoreStorefrontsSchema = z.array(z.enum(APP_STORE_STOREFRONTS))
  .min(1)
  .max(APP_STORE_STOREFRONTS.length)
  .refine((value) => new Set(value).size === value.length, "App Store 地区不能重复")
  .transform((value) => normalizeAppStoreStorefronts(value));
const onlineIconSourceSettingSchema = z.object({
  enabled: z.boolean(),
  storefronts: appStoreStorefrontsSchema,
}).strict();
const onlineIconSourceSettingPatchSchema = onlineIconSourceSettingSchema.partial().strict();

export const builtInIconProviderSchema = z.enum(BUILT_IN_ICON_PROVIDERS);

export const builtInIconSourcesSchema = z.object({
  thesvg: builtInIconSourceSettingSchema,
  selfhst: builtInIconSourceSettingSchema,
  dashboardIcons: builtInIconSourceSettingSchema,
}).strict().refine(
  (value) => hasEnabledBuiltInIconSource(value satisfies BuiltInIconSourceSettings),
  "至少启用一个内置图标来源",
);

export const onlineIconSourcesSchema = z.object({
  appStore: onlineIconSourceSettingSchema,
}).strict();

const appSettingsShape = {
  adminUsername: z.string().trim().min(1).max(80),
  themeMode: z.enum(THEME_MODES),
  themeVariant: z.enum(THEME_VARIANTS),
  themeCustomColor: z.object({
    h: z.number().min(0).max(360),
    s: z.number().min(0).max(100),
    l: z.number().min(0).max(100),
  }),
  locale: z.enum(SUPPORTED_LOCALES),
  showExpired: z.boolean(),
  defaultCurrency: z.string().trim().regex(/^[A-Z]{3}$/),
  publicStatusCurrency: publicStatusCurrencySchema,
  subscriptionPriceReferenceEnabled: z.boolean(),
  subscriptionPriceReferenceCurrency: subscriptionPriceReferenceCurrencySchema,
  exchangeRateProvider: z.preprocess(normalizeExchangeRateProvider, exchangeRateProviderSchema),
  builtInIconSources: builtInIconSourcesSchema,
  onlineIconSources: onlineIconSourcesSchema,
  monthlyBudget: moneyStringSchema,
  timezone: timezoneSchema,
  notificationTimeLocal: hhmmSchema,
  notificationReminderDays: globalReminderDaysSchema,
  enabledChannels: z.array(z.enum(NOTIFICATION_CHANNELS)),
  testPhone: z.string().trim().max(80),
  telegramBotToken: z.string().trim().max(256),
  telegramChatId: z.string().trim().max(128),
  telegramMessageFormat: telegramMessageFormatSchema,
  notifyxApiKey: z.string().trim().max(256),
  // 所有用户可配置回调地址都收敛到 https，避免通知渠道成为明文或内网探测入口。
  webhookUrl: optionalHttpsUrlSchema,
  webhookMethod: z.enum(["GET", "POST"]),
  webhookHeaders: z.string().max(20_000),
  webhookPayload: z.string().max(100_000),
  dingtalkWebhookUrl: optionalHttpsUrlSchema,
  dingtalkSecret: z.string().trim().max(512),
  dingtalkKeyword: z.string().trim().max(100),
  dingtalkMessageType: dingtalkMessageTypeSchema,
  dingtalkTitleTemplate: dingtalkTemplateSchema(DINGTALK_TITLE_TEMPLATE_MAX_LENGTH),
  dingtalkContentTemplate: dingtalkTemplateSchema(DINGTALK_CONTENT_TEMPLATE_MAX_LENGTH),
  wechatWebhookUrl: optionalHttpsUrlSchema,
  wechatMessageType: z.enum(["text", "markdown"]),
  wechatAddModeTag: z.boolean(),
  wechatAtPhones: z.string().trim().max(1000),
  wechatAtAll: z.boolean(),
  smtpHost: z.string().trim().max(255),
  smtpPort: optionalSmtpPortSchema,
  smtpSecure: z.boolean(),
  smtpUser: z.string().trim().max(256),
  smtpPassword: z.string().trim().max(512),
  smtpFrom: z.string().trim().max(320),
  smtpReplyTo: z.string().trim().max(320),
  notifyMultipleAddresses: z.boolean(),
  // 多收件人用逗号分隔，和设置页文本框一致；这里是最终格式边界。
  recipientEmail: z.string().trim().max(2000).refine((value) => {
    if (!value) return true;
    return value.split(",").map((item) => item.trim()).filter(Boolean).every((item) => z.email().safeParse(item).success);
  }, "收件人邮箱格式无效"),
  barkServerUrl: optionalHttpsUrlSchema,
  barkDeviceKey: z.string().trim().max(256),
  barkSilentPush: z.boolean(),
  serverchanSendKey: z.string().trim().max(256),
  discordWebhookUrl: optionalHttpsUrlSchema,
  discordBotUsername: z.string().trim().max(80),
  discordBotAvatarUrl: optionalHttpsUrlSchema,
  pushplusToken: z.string().trim().max(256),
  aiRecognition: aiRecognitionSettingsSchema,
};

const builtInIconSourcesPatchSchema = z.object({
  thesvg: builtInIconSourceSettingPatchSchema,
  selfhst: builtInIconSourceSettingPatchSchema,
  dashboardIcons: builtInIconSourceSettingPatchSchema,
}).partial().strict();
export type ApiBuiltInIconSourceSettingsPatch = BuiltInIconSourceSettingsPatch;
const onlineIconSourcesPatchSchema = z.object({
  appStore: onlineIconSourceSettingPatchSchema,
}).partial().strict();
export type ApiOnlineIconSourceSettings = OnlineIconSourceSettings;
export type ApiOnlineIconSourceSettingsPatch = OnlineIconSourceSettingsPatch;

/**
 * 设置读取响应的完整形状。
 *
 * D1 读取历史 settings_json 时可用默认值补齐，但写入后的出站数据必须通过此 schema，
 * 否则通知、图标候选和前端设置页会在不同运行面出现漂移。
 */
export const appSettingsSchema = z.object(appSettingsShape).strict();

export const settingsPayloadSchema = z.object({
  settings: appSettingsSchema,
}).strict();
export const settingsResponseSchema = apiSuccessResponseSchema(settingsPayloadSchema);

/**
 * 设置 PATCH 请求允许局部字段，但不允许未知字段。
 *
 * builtInIconSources/onlineIconSources 额外允许按来源局部更新，最终完整设置仍由 appSettingsSchema 兜底。
 */
export const settingsUpdateBodySchema = z.object({
  ...appSettingsShape,
  builtInIconSources: builtInIconSourcesPatchSchema,
  onlineIconSources: onlineIconSourcesPatchSchema,
}).partial().strict();
export type ApiAppSettings = z.infer<typeof appSettingsSchema>;
export type SettingsResponse = z.infer<typeof settingsPayloadSchema>;
