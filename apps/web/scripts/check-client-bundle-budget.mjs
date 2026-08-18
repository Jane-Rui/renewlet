#!/usr/bin/env node

/**
 * 客户端压缩包体守卫。
 * 初始入口按 manifest 静态依赖闭包计费，lazy route 与 vendor 分开限额，避免总量正常时隐藏单路由退化。
 */
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// gzip/brotli 都是硬门，避免只优化一种发布压缩格式后把另一种回归隐藏在总构建成功里。

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = join(workspaceRoot, "dist");
const manifestPath = join(distRoot, ".vite/manifest.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

const budgets = {
  // 首次真实构建基线上浮 5% 后固化；调整数字必须附新的构建证据，不能为通过 CI 随意抬高。
  initial: { gzip: 556075, brotli: 468559 },
  lazyRoute: { gzip: 73240, brotli: 60088 },
  vendor: { gzip: 112455, brotli: 93798 },
};

const compressedSizeCache = new Map();
function compressedSizes(file) {
  // 同一 chunk 可能同时属于入口闭包和最大项候选；缓存压缩结果避免构建门禁重复做最高质量 Brotli。
  const cached = compressedSizeCache.get(file);
  if (cached) return cached;
  const content = readFileSync(join(distRoot, file));
  const sizes = {
    gzip: gzipSync(content, { level: 9 }).byteLength,
    brotli: brotliCompressSync(content, {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
    }).byteLength,
  };
  compressedSizeCache.set(file, sizes);
  return sizes;
}

function collectStaticImports(key, files = new Set()) {
  // 首屏预算只递归 manifest.imports；dynamicImports 属于 lazy route，必须留在独立预算中暴露退化。
  const entry = manifest[key];
  if (!entry || !entry.file.endsWith(".js") || files.has(entry.file)) return files;
  files.add(entry.file);
  for (const importedKey of entry.imports ?? []) collectStaticImports(importedKey, files);
  return files;
}

function sumCompressed(files) {
  const total = { gzip: 0, brotli: 0 };
  for (const file of files) {
    const sizes = compressedSizes(file);
    total.gzip += sizes.gzip;
    total.brotli += sizes.brotli;
  }
  return total;
}

function largestEntry(entries, label) {
  if (entries.length === 0) throw new Error(`Client bundle manifest has no ${label} chunks`);
  return entries
    .map(([key, entry]) => ({ key, file: entry.file, ...compressedSizes(entry.file) }))
    .sort((left, right) => right.gzip - left.gzip || right.brotli - left.brotli)[0];
}

function assertBudget(label, actual, budget) {
  const exceeded = ["gzip", "brotli"].filter((format) => actual[format] > budget[format]);
  console.log(`${label}: gzip=${actual.gzip} B, brotli=${actual.brotli} B`);
  if (exceeded.length > 0) {
    throw new Error(
      `${label} exceeds ${exceeded.join("/")} budget ` +
        `(limits: gzip=${budget.gzip} B, brotli=${budget.brotli} B)`,
    );
  }
}

const manifestEntries = Object.entries(manifest);
const appEntry = manifestEntries.find(([, entry]) => entry.isEntry && entry.file.endsWith(".js"));
if (!appEntry) throw new Error("Client bundle manifest has no JavaScript application entry");

const initialFiles = collectStaticImports(appEntry[0]);
const initial = sumCompressed(initialFiles);
const largestLazyRoute = largestEntry(
  manifestEntries.filter(
    ([key, entry]) =>
      entry.isDynamicEntry &&
      entry.file.endsWith(".js") &&
      /(?:^|\/)src\/pages\//.test(key),
  ),
  "lazy route",
);
const largestVendor = largestEntry(
  manifestEntries.filter(
    ([key, entry]) =>
      entry.file.endsWith(".js") &&
      (/(?:^|[-_/])vendor(?:[-_.]|$)/.test(entry.file) || /vendor/.test(entry.name ?? key)),
  ),
  "vendor",
);

console.log(`initial files: ${[...initialFiles].sort().join(", ")}`);
assertBudget("initial", initial, budgets.initial);
assertBudget(`largest lazy route (${largestLazyRoute.file})`, largestLazyRoute, budgets.lazyRoute);
assertBudget(`largest vendor (${largestVendor.file})`, largestVendor, budgets.vendor);
