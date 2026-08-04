import { apiFetch } from "@/lib/api-client";
import {
  DINGTALK_CONTENT_TEMPLATE_MAX_LENGTH,
  DINGTALK_TITLE_TEMPLATE_MAX_LENGTH,
  settingsResponseSchema,
  settingsUpdateBodySchema,
  type ApiAppSettings,
} from "@/lib/api/schemas/settings";
import { getApiLocale } from "@/i18n/api-locale";
import { translate } from "@/i18n/messages";
import { getSystemTimeZone } from "@/lib/time/time-zone";
import { getCurrentUserId } from "@/lib/pocketbase";
import { cleanBuiltInIconSourceSettingsPatch, mergeBuiltInIconSourceSettings } from "@renewlet/shared/built-in-icons";
import { cleanOnlineIconSourceSettingsPatch, mergeOnlineIconSourceSettings } from "@renewlet/shared/online-icon-sources";
import {
  DEFAULT_SETTINGS,
  WEBHOOK_HEADERS_PLACEHOLDER,
  WEBHOOK_PAYLOAD_PLACEHOLDER,
  type AppSettings,
} from "@/types/subscription";

function clearLegacyWebhookExample(value: string, legacyExample: string) {
  return value.trim() === legacyExample ? "" : value;
}

/**
 * 将远端 settings JSON 收敛为前端完整设置。
 *
 * 该函数同时服务产品 API 返回值和历史 settings JSON；不要在页面里绕过它直接消费远端值。
 */
export function normalizeSettings(value: unknown): AppSettings {
  const parsed = settingsUpdateBodySchema.safeParse(normalizeStoredSettingsPatch(value));
  const defaults = { ...DEFAULT_SETTINGS, timezone: getSystemTimeZone("UTC") };
  if (!parsed.success) return defaults;
  // settingsUpdateBodySchema 是 partial；历史设置缺 notificationReminderDays 等字段时只补默认值，不改订阅显式提醒天数。
  const patch = Object.fromEntries(
    Object.entries(parsed.data).filter(([, item]) => item !== undefined),
  ) as Partial<AppSettings>;
  const settings: AppSettings = {
    ...defaults,
    ...patch,
    aiRecognition: {
      ...defaults.aiRecognition,
      ...patch.aiRecognition,
    },
    builtInIconSources: mergeBuiltInIconSourceSettings(defaults.builtInIconSources, cleanBuiltInIconSourceSettingsPatch(patch.builtInIconSources)),
    onlineIconSources: mergeOnlineIconSourceSettings(defaults.onlineIconSources, cleanOnlineIconSourceSettingsPatch(patch.onlineIconSources)),
  };
  return {
    ...settings,
    webhookHeaders: clearLegacyWebhookExample(settings.webhookHeaders, WEBHOOK_HEADERS_PLACEHOLDER),
    webhookPayload: clearLegacyWebhookExample(settings.webhookPayload, WEBHOOK_PAYLOAD_PLACEHOLDER),
  };
}

function normalizeStoredSettingsPatch(value: unknown): unknown {
  if (!isRecord(value)) return value;
  // 写入边界会拒绝非法格式；这里仅修复历史/手改 settings JSON，避免单个坏字段拖垮整份设置。
  const telegramMessageFormat = value["telegramMessageFormat"];
  const dingtalkMessageType = value["dingtalkMessageType"];
  const dingtalkTitleTemplate = value["dingtalkTitleTemplate"];
  const dingtalkContentTemplate = value["dingtalkContentTemplate"];
  return {
    ...value,
    ...(
      telegramMessageFormat === undefined || telegramMessageFormat === "plain" || telegramMessageFormat === "html"
        ? {}
        : { telegramMessageFormat: "plain" }
    ),
    ...(
      dingtalkMessageType === undefined || dingtalkMessageType === "markdown" || dingtalkMessageType === "text"
        ? {}
        : { dingtalkMessageType: "markdown" }
    ),
    ...(
      typeof dingtalkTitleTemplate === "string" && codePointLength(dingtalkTitleTemplate) <= DINGTALK_TITLE_TEMPLATE_MAX_LENGTH
        ? {}
        : { dingtalkTitleTemplate: "" }
    ),
    ...(
      typeof dingtalkContentTemplate === "string" && codePointLength(dingtalkContentTemplate) <= DINGTALK_CONTENT_TEMPLATE_MAX_LENGTH
        ? {}
        : { dingtalkContentTemplate: "" }
    ),
  };
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 设置服务统一调用 Renewlet 产品 API；Docker 端也不能回退到 PocketBase collection REST。 */
export const settingsService = {
  async get(): Promise<AppSettings> {
    const userId = getCurrentUserId();
    if (!userId) return DEFAULT_SETTINGS;
    const data = await apiFetch("/api/app/settings", settingsResponseSchema);
    return normalizeSettings(data.settings);
  },

  async update(current: AppSettings, patch: Partial<AppSettings>): Promise<AppSettings> {
    const userId = getCurrentUserId();
    if (!userId) throw new Error(translate(getApiLocale(), "auth.loginRequired"));
    const next = normalizeSettings({ ...current, ...patch });
    // Docker 与 Cloudflare 都只接受 shared ApiAppSettings；前端历史占位符先在 normalize 阶段被剥掉。
    const data = await apiFetch("/api/app/settings", settingsResponseSchema, {
      method: "PUT",
      body: JSON.stringify(next satisfies ApiAppSettings),
    });
    return normalizeSettings(data.settings);
  },
};
