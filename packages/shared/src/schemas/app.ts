import { z } from "zod";
import { okPayloadSchema, okResponseSchema } from "./common";
import { apiSuccessResponseSchema } from "./api";
import { upstreamErrorDetailsSchema } from "./upstream";

/** healthResponseSchema 是 Docker healthcheck、Cloudflare Worker 和前端存活探测的共同最小响应。 */
export const healthPayloadSchema = z.object({
  time: z.string().min(1),
}).strict();
export const healthResponseSchema = apiSuccessResponseSchema(healthPayloadSchema);

export const turnstilePublicConfigSchema = z.object({
  enabled: z.boolean(),
  siteKey: z.string(),
}).strict();

/**
 * 认证前应用能力状态。
 *
 * app status 是登录、setup、demo 置灰和 Turnstile 人机验证能力的共同真相源；真正写入仍由后端 route/hook 校验。
 */
export const appStatusPayloadSchema = z.object({
  setupRequired: z.boolean(),
  setupEnabled: z.boolean(),
  demoMode: z.boolean(),
  // 只允许公开 siteKey；Turnstile secret 是后端 Siteverify 凭据，不能进入认证前 status 或前端缓存。
  turnstile: turnstilePublicConfigSchema,
}).strict();
export const appStatusResponseSchema = apiSuccessResponseSchema(appStatusPayloadSchema);

export const setupStatusPayloadSchema = appStatusPayloadSchema.pick({
  setupRequired: true,
  setupEnabled: true,
}).strict();
export const setupStatusResponseSchema = apiSuccessResponseSchema(setupStatusPayloadSchema);

export const setupCreateResponseSchema = okResponseSchema;

export const passwordResetStatusPayloadSchema = z.object({
  enabled: z.boolean(),
}).strict();
export const passwordResetStatusResponseSchema = apiSuccessResponseSchema(passwordResetStatusPayloadSchema);

/**
 * 系统部署形态与更新模式分开表达。
 *
 * deployment 是实际运行面；updateMode 是管理员版本弹窗该暴露的升级路径，前端不能再从 buildType 猜。
 */
export const systemDeploymentSchema = z.enum(["docker", "cloudflare", "source"]);
export const systemUpdateModeSchema = z.enum(["in-app-binary", "docker-compose", "cloudflare-deploy", "source-manual"]);

/** 构建信息由 CI ldflags 或 Wrangler vars 注入；不能用于权限判断，只用于版本弹窗展示。 */
export const systemBuildInfoSchema = z.object({
  version: z.string().min(1),
  commit: z.string(),
  buildTime: z.string(),
  buildType: z.string().min(1),
}).strict();

/** GitHub Release 资产的前端展示视图；真实下载 URL 不进入浏览器，避免绕过 checksum 校验。 */
export const systemReleaseAssetSchema = z.object({
  name: z.string().min(1),
  size: z.number().int().nonnegative(),
}).strict();

export const systemReleaseInfoSchema = z.object({
  tagName: z.string().min(1),
  version: z.string().min(1),
  name: z.string(),
  body: z.string(),
  publishedAt: z.string(),
  htmlUrl: z.string().min(1),
  assets: z.array(systemReleaseAssetSchema),
}).strict();

/** systemVersionResponseSchema 描述“检查结果”而不触发更新副作用。 */
export const systemVersionPayloadSchema = z.object({
  currentVersion: z.string().min(1),
  latestVersion: z.string().min(1),
  hasUpdate: z.boolean(),
  checkSucceeded: z.boolean(),
  deployment: systemDeploymentSchema,
  updateMode: systemUpdateModeSchema,
  updateSupported: z.boolean(),
  unsupportedReason: z.string().optional(),
  releaseInfo: systemReleaseInfoSchema.nullable(),
  cached: z.boolean(),
  warning: z.string().optional(),
  errorDetails: upstreamErrorDetailsSchema.optional(),
  build: systemBuildInfoSchema,
}).strict();
export const systemVersionResponseSchema = apiSuccessResponseSchema(systemVersionPayloadSchema);

/**
 * 页面内更新完成响应。
 *
 * 成功只表示二进制已替换并进入 restart pending；旧进程退出必须由管理员后续显式确认。
 */
export const systemUpdatePayloadSchema = z.object({
  currentVersion: z.string().min(1),
  targetVersion: z.string().min(1),
  needsRestart: z.boolean(),
  message: z.string().min(1),
}).strict();
export const systemUpdateResponseSchema = apiSuccessResponseSchema(systemUpdatePayloadSchema);

export const systemRestartResponseSchema = okResponseSchema;

export type AppStatusResponse = z.infer<typeof appStatusPayloadSchema>;
export type SetupStatusResponse = z.infer<typeof setupStatusPayloadSchema>;
export type PasswordResetStatusResponse = z.infer<typeof passwordResetStatusPayloadSchema>;
export type SystemDeployment = z.infer<typeof systemDeploymentSchema>;
export type SystemUpdateMode = z.infer<typeof systemUpdateModeSchema>;
export type SystemVersionResponse = z.infer<typeof systemVersionPayloadSchema>;
export type SystemUpdateResponse = z.infer<typeof systemUpdatePayloadSchema>;
export type SystemRestartResponse = z.infer<typeof okPayloadSchema>;
