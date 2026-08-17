import {
  expect,
  test as base,
  type ConsoleMessage,
  type Page,
  type Route,
} from "@playwright/test";
import { SUPPORTED_EXCHANGE_RATE_CURRENCIES } from "../../packages/shared/src/schemas/exchange-rates.js";

type BrowserDiagnostic = {
  level: "error" | "pageerror" | "warning";
  text: string;
};

const FRANKFURTER_ROUTE = /^https:\/\/api\.frankfurter\.dev\/v2\/rates(?:\?.*)?$/;
const E2E_EXCHANGE_RATE_DATE = "2026-08-17";
const E2E_FRANKFURTER_RATES = SUPPORTED_EXCHANGE_RATE_CURRENCIES.map((quote, index) => ({
  date: E2E_EXCHANGE_RATE_DATE,
  base: "USD",
  quote,
  rate: quote === "USD" ? 1 : 1 + (index + 1) / 1000,
}));

export const test = base.extend<{ pageGuards: void }>({
  pageGuards: [async ({ page }, use) => {
    const guards = await installE2EPageGuards(page);
    try {
      await use();
    } finally {
      await guards.close();
    }
  }, { auto: true }],
});

export async function installE2EPageGuards(page: Page): Promise<{ close(): Promise<void> }> {
  const diagnostics: BrowserDiagnostic[] = [];
  const fulfillFrankfurter = async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(E2E_FRANKFURTER_RATES),
    });
  };
  const recordConsoleMessage = (message: ConsoleMessage) => {
    const level = message.type();
    if (level !== "error" && level !== "warning") return;
    diagnostics.push({ level, text: message.text() });
  };
  const recordPageError = (error: Error) => {
    diagnostics.push({ level: "pageerror", text: error.stack ?? error.message });
  };

  // 每个显式 BrowserContext 都必须复用这组守卫，避免手工 page 绕过第三方隔离或浏览器诊断门禁。
  await page.route(FRANKFURTER_ROUTE, fulfillFrankfurter);
  page.on("console", recordConsoleMessage);
  page.on("pageerror", recordPageError);
  return {
    async close() {
      page.off("console", recordConsoleMessage);
      page.off("pageerror", recordPageError);
      await page.unroute(FRANKFURTER_ROUTE, fulfillFrankfurter);
      expect(diagnostics, "unexpected browser console warnings or errors").toEqual([]);
    },
  };
}

export { expect };
