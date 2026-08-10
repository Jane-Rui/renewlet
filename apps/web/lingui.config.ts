import { defineConfig } from "@lingui/conf";

// catalog domain 是人工维护的 i18n 边界；check-i18n-catalogs.mjs 和 key 生成脚本依赖同一组 domain 来防止 descriptor、PO、静态 key 漂移。
const catalogDomains = [
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
] as const;

export default defineConfig({
  locales: ["zh-CN", "en-US"],
  sourceLocale: "zh-CN",
  catalogs: catalogDomains.map((domain) => ({
    path: `src/i18n/catalogs/{locale}/${domain}`,
    include: [`src/i18n/descriptors/${domain}.ts`],
  })),
});
