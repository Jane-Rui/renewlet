import type { ApiCustomConfig } from "@renewlet/shared/schemas/custom-config";
import { SERVER_I18N_CATALOGS, type ServerI18nKey } from "./server-i18n-catalog";
import { serverText, type AppLocale } from "./server-i18n";

type ConfigLabels = ApiCustomConfig["categories"][number]["labels"];

function labelIdentity(labels: ConfigLabels): string {
  return JSON.stringify([labels["zh-CN"], labels["en-US"]]);
}

// 索引只收录随构建发布的分类/支付方式文案，不登记用户配置；与前端同样按双语原值识别未改名项。
const builtInLabelKeys = new Map<string, ServerI18nKey>();
for (const key of (Object.keys(SERVER_I18N_CATALOGS["en-US"]) as ServerI18nKey[]).sort()) {
  if (!key.startsWith("category.") && !key.startsWith("payment.")) continue;
  builtInLabelKeys.set(labelIdentity({
    "zh-CN": serverText("zh-CN", key),
    "en-US": serverText("en-US", key),
  }), key);
}

/** labels 存储仍是中英双字段；第三语言只翻译完全未改名的内置项，用户文本保持英文回退且不写回存储。 */
export function localizedConfigLabel(labels: ConfigLabels, locale: AppLocale): string {
  if (locale === "zh-CN") return labels["zh-CN"] || labels["en-US"];
  if (locale !== "en-US") {
    const key = builtInLabelKeys.get(labelIdentity(labels));
    if (key) return serverText(locale, key);
  }
  return labels["en-US"] || labels["zh-CN"];
}
