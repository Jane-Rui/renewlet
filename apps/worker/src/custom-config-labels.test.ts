import { describe, expect, it } from "vitest";
import fixtures from "../../../packages/shared/src/contract-fixtures/config-label-locales.json";
import { aiRecognitionConfigContext } from "./ai-recognition-normalize";
import { localizedConfigLabel } from "./custom-config-labels";
import { SERVER_I18N_LOCALES } from "./server-i18n-catalog";

describe("config label locale contract", () => {
  it.each(fixtures)("preserves $name across UI and server locales", ({ labels, expected }) => {
    const stored = JSON.stringify(labels);
    for (const locale of SERVER_I18N_LOCALES) {
      expect(localizedConfigLabel(labels, locale)).toBe(expected[locale]);
      const item = { id: "item", value: "developer_tools", labels };
      const config = { categories: [item], paymentMethods: [item], statuses: [], currencies: [] };
      const context = aiRecognitionConfigContext(config, locale);
      expect(context.categories[0]?.label).toBe(expected[locale]);
      expect(context.paymentMethods[0]?.label).toBe(expected[locale]);
      expect(context.categories[0]?.zhCN).toBe(labels["zh-CN"]);
      expect(context.categories[0]?.enUS).toBe(labels["en-US"]);
      expect(JSON.stringify(item.labels)).toBe(stored);
    }
  });
});
