import { z } from "zod";
import { persistedSettingsBackupSchema } from "./settings";
import { customConfigSchema } from "./custom-config";
import {
  createApiSubscriptionSchema,
  logoReferenceSchema,
  subscriptionCreateBodySchema,
} from "./subscriptions";
import { apiSuccessResponseSchema } from "./api";
import { exchangeRateSnapshotV1Schema } from "./exchange-rates";

/**
 * 单次导入执行的订阅上限。
 *
 * 预览允许大文件做冲突分析，但真正写库限制为较小批量，避免 Cloudflare D1/PocketBase 在一次请求里承担无界写入。
 */
export const IMPORT_APPLY_SUBSCRIPTION_LIMIT = 200;
export const IMPORT_PREVIEW_SUBSCRIPTION_LIMIT = 1000;
export const IMPORT_PREVIEW_MAX_BYTES = 8 * 1024 * 1024;

export const importConflictModeSchema = z.enum(["replace", "skip"]);
export type ImportConflictMode = z.infer<typeof importConflictModeSchema>;

export const importSourceSchema = z.enum(["renewlet", "wallos", "ai"]);
export type ImportSource = z.infer<typeof importSourceSchema>;

export const importConfidenceSchema = z.enum(["high", "low"]);
export type ImportConfidence = z.infer<typeof importConfidenceSchema>;

export const importKeySchema = z.object({
  source: importSourceSchema,
  sourceId: z.string().trim().min(1).max(256),
  confidence: importConfidenceSchema.optional(),
}).strict();

const importExtraSchema = z.object({
  // import 是跨 Docker/PocketBase 与 Cloudflare/D1 的幂等键；导入 API 依赖它判断 replace/skip。
  import: importKeySchema,
}).catchall(z.unknown());

export const importSubscriptionSchema = subscriptionCreateBodySchema.safeExtend({
  extra: importExtraSchema,
}).strict();
export type ImportSubscription = z.infer<typeof importSubscriptionSchema>;

export const importPayloadSchema = z.object({
  source: importSourceSchema,
  // 导入 payload 是前端、Go route 与 Worker apply 共享契约；上限保护预览解析和冲突查询，不代表一次写库上限。
  subscriptions: z.array(importSubscriptionSchema).max(IMPORT_PREVIEW_SUBSCRIPTION_LIMIT, "IMPORT_TOO_LARGE"),
  settings: persistedSettingsBackupSchema.optional(),
  customConfig: customConfigSchema.optional(),
  exchangeRateSnapshots: z.array(exchangeRateSnapshotV1Schema).max(240).optional(),
}).strict();
export type ImportPayload = z.infer<typeof importPayloadSchema>;

export const importSkipIndexesSchema = z.array(z.number().int().nonnegative()).max(IMPORT_PREVIEW_SUBSCRIPTION_LIMIT, "IMPORT_TOO_LARGE");
export const importApplySkipIndexesSchema = z.array(z.number().int().nonnegative()).max(IMPORT_APPLY_SUBSCRIPTION_LIMIT);

export const importPreviewRequestSchema = z.object({
  payload: importPayloadSchema,
  conflictMode: importConflictModeSchema.default("skip"),
  // skipIndexes 是预览与执行共享的“单条排除”契约；服务端仍会按当前用户重新预览，不能信任前端 action。
  skipIndexes: importSkipIndexesSchema.default([]),
}).strict();
export type ImportPreviewRequest = z.infer<typeof importPreviewRequestSchema>;

export const importApplyRequestSchema = z.object({
  payload: importPayloadSchema.extend({
    // 执行阶段比预览更严格，因为 replace/create 会触发真实写库、资产引用和用户隔离校验。
    subscriptions: z.array(importSubscriptionSchema).max(IMPORT_APPLY_SUBSCRIPTION_LIMIT, "IMPORT_TOO_LARGE"),
  }),
  conflictMode: importConflictModeSchema,
  skipIndexes: importApplySkipIndexesSchema.default([]),
}).strict();
export type ImportApplyRequest = z.infer<typeof importApplyRequestSchema>;

export const importItemActionSchema = z.enum(["create", "replace", "skip", "error"]);
export type ImportItemAction = z.infer<typeof importItemActionSchema>;

export const importPreviewItemSchema = z.object({
  index: z.number().int().nonnegative(),
  name: z.string(),
  source: importSourceSchema,
  sourceId: z.string(),
  existingId: z.string().optional(),
  action: importItemActionSchema,
  warnings: z.array(z.string()),
  errors: z.array(z.string()),
}).strict();
export type ImportPreviewItem = z.infer<typeof importPreviewItemSchema>;

export const importSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  creates: z.number().int().nonnegative(),
  replaces: z.number().int().nonnegative(),
  skips: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  warnings: z.number().int().nonnegative(),
}).strict();
export type ImportSummary = z.infer<typeof importSummarySchema>;

export const importPreviewPayloadSchema = z.object({
  summary: importSummarySchema,
  items: z.array(importPreviewItemSchema),
  includesSettings: z.boolean(),
  includesCustomConfig: z.boolean(),
  includesExchangeRateSnapshots: z.boolean(),
  exchangeRateSnapshotsCount: z.number().int().nonnegative(),
}).strict();
export const importPreviewResponseSchema = apiSuccessResponseSchema(importPreviewPayloadSchema);
export type ImportPreviewResponse = z.infer<typeof importPreviewPayloadSchema>;

export const importApplyPayloadSchema = importPreviewPayloadSchema;
export const importApplyResponseSchema = apiSuccessResponseSchema(importApplyPayloadSchema);
export type ImportApplyResponse = z.infer<typeof importApplyPayloadSchema>;

const exportPrivateAssetPathSchema = z
  .string()
  .trim()
  .refine((value) => /^\/api\/app\/assets\/[A-Za-z0-9_-]+$/.test(value), "Invalid private asset path");

const exportAssetSchema = z.object({
  id: z.string(),
  path: z.string(),
  originalName: z.string().optional(),
  mimeType: z.string().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
}).strict();
export type RenewletExportAsset = z.infer<typeof exportAssetSchema>;

const exportAssetLogoPathSchema = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => /^assets\/[^/][A-Za-z0-9._/-]*$/.test(value) && !value.includes(".."), "Invalid export asset path");

const renewletExportSubscriptionSchema = createApiSubscriptionSchema(
  logoReferenceSchema.or(exportAssetLogoPathSchema),
);

export const renewletExportV1Schema = z.object({
  kind: z.literal("renewlet-export"),
  schemaVersion: z.literal(1),
  exportedAt: z.string(),
  data: z.object({
    // Export v1 保存 API 订阅形状而不是 UI 草稿形状，保证 Docker 与 Cloudflare 导出的数据可以互导。
    subscriptions: z.array(renewletExportSubscriptionSchema),
    settings: persistedSettingsBackupSchema.optional(),
    customConfig: customConfigSchema.optional(),
    // 历史汇率快照是 data.json 的恢复事实源；manifest 只做审计，不能承载报表口径。
    exchangeRateSnapshots: z.array(exchangeRateSnapshotV1Schema).max(240).optional(),
    assets: z.array(exportAssetSchema).optional(),
  }).strict(),
}).strict();
export type RenewletExportV1 = z.infer<typeof renewletExportV1Schema>;

export const renewletExportMissingAssetReferenceSchema = z.enum(["subscription.logo", "customConfig.paymentMethods.icon"]);
export type RenewletExportMissingAssetReference = z.infer<typeof renewletExportMissingAssetReferenceSchema>;

export const renewletExportMissingAssetReasonSchema = z.enum(["not_found", "file_missing", "too_large", "read_failed"]);
export type RenewletExportMissingAssetReason = z.infer<typeof renewletExportMissingAssetReasonSchema>;

export const renewletExportMissingAssetSchema = z.object({
  assetId: z.string().trim().min(1),
  path: exportPrivateAssetPathSchema,
  reference: renewletExportMissingAssetReferenceSchema,
  referenceId: z.string().trim().min(1),
  reason: renewletExportMissingAssetReasonSchema,
}).strict();
export type RenewletExportMissingAsset = z.infer<typeof renewletExportMissingAssetSchema>;

export const renewletExportManifestV1Schema = z.object({
  kind: z.literal("renewlet-export"),
  schemaVersion: z.literal(1),
  exportedAt: z.string(),
  subscriptions: z.number().int().nonnegative(),
  assets: z.number().int().nonnegative(),
  // manifest 只做 ZIP 审计；导入恢复仍以 data.json 为事实源，缺失资产不能反向驱动写库。
  missingAssets: z.array(renewletExportMissingAssetSchema),
}).strict();
export type RenewletExportManifestV1 = z.infer<typeof renewletExportManifestV1Schema>;
