import { customConfigSchema } from "@renewlet/shared/schemas/custom-config";
import {
  CLOUD_BACKUP_MAX_SNAPSHOT_BYTES,
  cloudBackupSnapshotManifestSchema,
  type CloudBackupSnapshotManifest,
} from "@renewlet/shared/schemas/cloud-backup";
import {
  renewletExportManifestV1Schema,
  renewletExportV1Schema,
  type RenewletExportAsset,
  type RenewletExportMissingAsset,
  type RenewletExportMissingAssetReason,
  type RenewletExportMissingAssetReference,
} from "@renewlet/shared/schemas/import-export";
import { getAsset, getCustomConfig, getSettings, listSubscriptions, toApiSubscription } from "./db";
import { sanitizeSettingsForCloudBackup } from "./cloud-backup-sanitize";
import { sha256Hex, snapshotId } from "./cloud-backup-remote";
import { extensionFromMime, privateAssetIdFromLogo } from "./cloud-backup-utils";
import { createStoredZip } from "./zip-store";
import type { Env } from "./types";

const textEncoder = new TextEncoder();
// 导出资产必须保持上传同一 2MiB 上限；快照 50MiB 上限只约束整包，不能让旧大对象绕过恢复上传校验。
const MAX_EXPORT_ASSET_BYTES = 2 * 1024 * 1024;

export type CloudBackupSnapshotPayload = {
  content: Uint8Array;
  id: string;
  filename: string;
  manifest: CloudBackupSnapshotManifest;
};

type ExportAsset = RenewletExportAsset & {
  content: Uint8Array;
};

type ExportAssetReadResult =
  | { ok: true; asset: ExportAsset }
  | { ok: false; reason: RenewletExportMissingAssetReason };

type ExportAssetReference = {
  assetId: string;
  path: string;
  reference: RenewletExportMissingAssetReference;
  referenceId: string;
};

type ExportAssetCollector = {
  assets: ExportAsset[];
  assetById: Map<string, ExportAsset>;
  missingAssets: RenewletExportMissingAsset[];
};

export async function buildCloudBackupSnapshotPayload(env: Env, userId: string): Promise<CloudBackupSnapshotPayload> {
  const { content, exportedAt } = await buildCloudBackupExportZip(env, userId);
  if (content.length > CLOUD_BACKUP_MAX_SNAPSHOT_BYTES) throw new Error("CLOUD_BACKUP_SNAPSHOT_TOO_LARGE");
  const id = snapshotId(exportedAt);
  const filename = `${id}.zip`;
  const manifest = cloudBackupSnapshotManifestSchema.parse({
    kind: "renewlet-cloud-backup-snapshot",
    schemaVersion: 1,
    id,
    filename,
    createdAt: exportedAt.toISOString(),
    sizeBytes: content.length,
    sha256: await sha256Hex(content),
    exportKind: "renewlet-export",
    exportSchemaVersion: 1,
  });
  return { content, id, filename, manifest };
}

export async function buildCloudBackupExportZip(env: Env, userId: string): Promise<{ content: Uint8Array; exportedAt: Date }> {
  const exportedAt = new Date();
  const collector: ExportAssetCollector = { assets: [], assetById: new Map(), missingAssets: [] };
  const subscriptions = await listSubscriptions(env, userId);
  const exportSubscriptions = [];
  for (const row of subscriptions) {
    const subscription = { ...toApiSubscription(row) };
    const assetId = privateAssetIdFromLogo(subscription.logo ?? null);
    if (assetId && subscription.logo) {
      const assetPath = await resolveExportAsset(env, userId, collector, {
        assetId,
        path: subscription.logo,
        reference: "subscription.logo",
        referenceId: subscription.id,
      });
      if (assetPath) subscription.logo = assetPath;
      else delete subscription.logo;
    }
    exportSubscriptions.push(subscription);
  }
  const customConfig = await buildExportCustomConfig(env, userId, collector);
  // 云备份使用业务恢复 allowlist 组包；sessions/MFA/passkey/tickets 和 R2 系统密钥对象都不进入 ZIP。
  const payload = renewletExportV1Schema.parse({
    kind: "renewlet-export",
    schemaVersion: 1,
    exportedAt: exportedAt.toISOString(),
    data: {
      subscriptions: exportSubscriptions,
      settings: sanitizeSettingsForCloudBackup(await getSettings(env, userId)),
      customConfig,
      ...(collector.assets.length > 0
        ? { assets: collector.assets.map(({ content: _content, ...asset }) => asset) }
        : {}),
    },
  });
  const manifest = renewletExportManifestV1Schema.parse({
    kind: payload.kind,
    schemaVersion: payload.schemaVersion,
    exportedAt: payload.exportedAt,
    subscriptions: payload.data.subscriptions.length,
    assets: collector.assets.length,
    // 缺失详情只保留业务引用和原因枚举，不能把 D1/R2 key、raw error 或对象存储路径写进备份包。
    missingAssets: collector.missingAssets,
  });
  const zipEntries = [
    ...collector.assets.map((asset) => ({ name: asset.path, data: asset.content, date: exportedAt })),
    { name: "data.json", data: textEncoder.encode(JSON.stringify(payload, null, 2)), date: exportedAt },
    { name: "manifest.json", data: textEncoder.encode(JSON.stringify(manifest, null, 2)), date: exportedAt },
  ];
  return { content: createStoredZip(zipEntries, exportedAt), exportedAt };
}

export async function verifySnapshotBytes(content: Uint8Array, manifest: CloudBackupSnapshotManifest): Promise<boolean> {
  if (manifest.kind !== "renewlet-cloud-backup-snapshot" || manifest.schemaVersion !== 1) return false;
  if (manifest.sizeBytes !== content.length) return false;
  return (await sha256Hex(content)) === manifest.sha256.toLowerCase();
}

async function buildExportCustomConfig(env: Env, userId: string, collector: ExportAssetCollector) {
  const config = customConfigSchema.parse(await getCustomConfig(env, userId));
  return {
    ...config,
    paymentMethods: await Promise.all(config.paymentMethods.map(async (paymentMethod) => {
      const assetId = privateAssetIdFromLogo(paymentMethod.icon ?? null);
      if (!assetId || !paymentMethod.icon) return paymentMethod;
      const assetPath = await resolveExportAsset(env, userId, collector, {
        assetId,
        path: paymentMethod.icon,
        reference: "customConfig.paymentMethods.icon",
        referenceId: paymentMethod.id,
      });
      if (assetPath) return { ...paymentMethod, icon: assetPath };
      const { icon: _icon, ...rest } = paymentMethod;
      return rest;
    })),
  };
}

async function resolveExportAsset(env: Env, userId: string, collector: ExportAssetCollector, reference: ExportAssetReference): Promise<string | null> {
  const existing = collector.assetById.get(reference.assetId);
  if (existing) return existing.path;
  const result = await readExportAsset(env, userId, reference.assetId);
  if (!result.ok) {
    collector.missingAssets.push({
      assetId: reference.assetId,
      path: reference.path,
      reference: reference.reference,
      referenceId: reference.referenceId,
      reason: result.reason,
    });
    return null;
  }
  collector.assetById.set(reference.assetId, result.asset);
  collector.assets.push(result.asset);
  return result.asset.path;
}

async function readExportAsset(env: Env, userId: string, assetId: string): Promise<ExportAssetReadResult> {
  try {
    // D1 asset metadata 是 owner 和 R2 key 的事实来源；R2 对象缺失只让引用进入 manifest 审计，不阻断整份快照。
    const row = await getAsset(env, userId, assetId);
    if (!row) return { ok: false, reason: "not_found" };
    const object = await env.ASSETS_BUCKET.get(row.r2_key);
    if (!object) return { ok: false, reason: "file_missing" };
    if (row.size_bytes !== null && row.size_bytes > MAX_EXPORT_ASSET_BYTES) return { ok: false, reason: "too_large" };
    const content = new Uint8Array(await object.arrayBuffer());
    if (content.length > MAX_EXPORT_ASSET_BYTES) return { ok: false, reason: "too_large" };
    const mimeType = row.mime_type ?? object.httpMetadata?.contentType ?? "application/octet-stream";
    return {
      ok: true,
      asset: {
        id: assetId,
        path: `assets/${assetId}${extensionFromMime(mimeType, row.original_name ?? "")}`,
        ...(row.original_name ? { originalName: row.original_name } : {}),
        mimeType,
        sizeBytes: content.length,
        content,
      },
    };
  } catch {
    return { ok: false, reason: "read_failed" };
  }
}
