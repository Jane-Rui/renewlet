import { customConfigPayloadSchema } from "@renewlet/shared/schemas/custom-config";
import { settingsPayloadSchema, settingsUpdateBodySchema } from "@renewlet/shared/schemas/settings";
import { ensureSettings, getCustomConfig, getTelegramBotBinding, mergeSettingsPatch, putCustomConfig, putSettings } from "./db";
import { HttpError, readJson, requestLocale, successJson } from "./http";
import { requireAuth } from "./auth";
import { serverText } from "./server-i18n";
import { refreshSubscriptionSchedulerState } from "./subscription-scheduler-state";
import { refreshCostSharingCollectionReminderMirrors } from "./subscriptions";
import type { Env } from "./types";

/**
 * readSettings 返回当前用户的完整应用设置。
 *
 * Cloudflare 运行面按用户隔离 D1 setting 行；前端收到的是已合并默认值后的完整契约，不需要知道存储层是否缺省。
 */
export async function readSettings(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env);
  return successJson(settingsPayloadSchema.parse({ settings: await ensureSettings(env, auth.user.id, requestLocale(request)) }));
}

/**
 * updateSettings 执行设置 PATCH 并返回规范化后的完整设置。
 *
 * Worker 必须复用 shared schema 作为事实来源，保证 Cloudflare/D1 与 Go/PocketBase 在字段默认值和内置图标来源上不漂移。
 */
export async function updateSettings(request: Request, env: Env): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  const patch = await readJson(request, settingsUpdateBodySchema, locale);
  const current = await ensureSettings(env, auth.user.id, locale);
  // PATCH 语义由“当前设置 + 局部字段”合成，最终仍过完整 schema，防止删除隐式默认项。
  const next = mergeSettingsPatch(current, patch);
  await rejectInstalledTelegramBotSettingsChange(env, auth.user.id, current, next, locale);
  const settings = await putSettings(env, auth.user.id, next);
  await refreshCostSharingCollectionReminderMirrors(env, auth.user.id, settings);
  await refreshSubscriptionSchedulerState(env, auth.user.id, { resetAutoRenewCheck: false });
  return successJson(settingsPayloadSchema.parse({ settings }));
}

/**
 * readCustomConfig 读取当前用户的自定义配置。
 *
 * 自定义配置允许用户持久化标签/分类等业务文本，因此只做形状校验与用户隔离，不把内容转成产品内置文案。
 */
export async function readCustomConfig(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env);
  const config = await getCustomConfig(env, auth.user.id);
  return successJson(customConfigPayloadSchema.parse({ config }));
}

/**
 * updateCustomConfig 写入当前用户的自定义配置。
 *
 * 请求体和响应都通过同一个 shared schema，避免 Cloudflare 版接受 Docker 版不会保存的数据形状。
 */
export async function updateCustomConfig(request: Request, env: Env): Promise<Response> {
  const locale = requestLocale(request);
  const auth = await requireAuth(request, env);
  const body = await readJson(request, customConfigPayloadSchema, locale);
  const config = await putCustomConfig(env, auth.user.id, body.config);
  return successJson(customConfigPayloadSchema.parse({ config }));
}

async function rejectInstalledTelegramBotSettingsChange(
  env: Env,
  userId: string,
  current: Awaited<ReturnType<typeof ensureSettings>>,
  next: Awaited<ReturnType<typeof ensureSettings>>,
  locale: ReturnType<typeof requestLocale>,
): Promise<void> {
  if (current.telegramBotToken.trim() === next.telegramBotToken.trim() && current.telegramChatId.trim() === next.telegramChatId.trim()) return;
  const binding = await getTelegramBotBinding(env, userId);
  if (!binding || binding.status !== "installed") return;
  // 已安装命令时 Telegram 远端仍持有 webhook；必须先删除命令，才能改 Bot Token 或 Chat ID。
  throw new HttpError(400, serverText(locale, "common.invalidRequestParameters"), "TELEGRAM_BOT_COMMANDS_INSTALLED");
}
