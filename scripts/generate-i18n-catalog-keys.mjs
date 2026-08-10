/**
 * 前端静态 catalog key 生成器。
 *
 * 触发时机：Lingui extract 后手动运行；CI 通过 i18n check 验证生成物未漂移。
 * 输入：各 domain 的 `.po` catalog；副作用：重写 `apps/web/src/i18n/catalog-keys.ts`。
 *
 * 业务意图：非 React 同步逻辑只能消费可枚举 key，避免手写字符串绕过 Lingui catalog。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatter } from "@lingui/format-po";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const catalogDir = path.join(rootDir, "apps/web/src/i18n/catalogs");
const catalogKeysPath = path.join(rootDir, "apps/web/src/i18n/catalog-keys.ts");
const sourceLocale = "zh-CN";
const domains = [
  "common",
  "legal",
  "custom-config",
  "subscription",
  "auth",
  "settings",
  "settings-access-security",
  "public-status",
  "notification",
  "labels",
  "admin",
  "error",
];
const poFormatter = formatter({ origins: false });

function readCatalogFile(domain) {
  const filePath = path.join(catalogDir, sourceLocale, `${domain}.po`);
  const source = fs.readFileSync(filePath, "utf8");
  const parsed = poFormatter.parse(source, {
    locale: sourceLocale,
    sourceLocale,
    filename: filePath,
  });
  return Object.keys(parsed);
}

const keys = [...new Set(domains.flatMap(readCatalogFile))].sort();
const source = [
  "// 由 scripts/generate-i18n-catalog-keys.mjs 生成；MessageKey 是前端静态翻译 helper 的唯一 key union。",
  "export const MESSAGE_KEYS = [",
  ...keys.map((key) => `  ${JSON.stringify(key)},`),
  "] as const;",
  "",
  "export type MessageKey = (typeof MESSAGE_KEYS)[number];",
  "",
].join("\n");

fs.writeFileSync(catalogKeysPath, source);
console.log(`generated ${path.relative(rootDir, catalogKeysPath)} (${keys.length} keys).`);
