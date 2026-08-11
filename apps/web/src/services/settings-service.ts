import { apiFetch } from "@/lib/api-client";
import {
  settingsResponseSchema,
  type ApiAppSettings,
} from "@/lib/api/schemas/settings";
import { getApiLocale } from "@/i18n/api-locale";
import { translate } from "@/i18n/messages";
import { getSystemTimeZone } from "@/lib/time/time-zone";
import { getCurrentUserId } from "@/lib/pocketbase";
import { normalizeSettingsValue } from "@renewlet/shared/settings-normalization";
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
  const defaults = { ...DEFAULT_SETTINGS, timezone: getSystemTimeZone("UTC") };
  const settings = normalizeSettingsValue(value, defaults);
  return {
    ...settings,
    webhookHeaders: clearLegacyWebhookExample(settings.webhookHeaders, WEBHOOK_HEADERS_PLACEHOLDER),
    webhookPayload: clearLegacyWebhookExample(settings.webhookPayload, WEBHOOK_PAYLOAD_PLACEHOLDER),
  };
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
