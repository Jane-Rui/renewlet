import { expect, type Page } from "@playwright/test";

export type ProductSubscriptionSeed = {
  name: string;
  price: string;
  currency?: string;
  billingCycle?: "monthly" | "yearly";
  category?: string;
  status?: "active" | "trial" | "expired" | "paused" | "cancelled";
  paymentMethod?: string | null;
  startDate: string | null;
  nextBillingDate: string;
  autoRenew?: boolean;
  autoCalculateNextBillingDate?: boolean;
  reminderDays?: number;
  tags?: string[];
};

export async function createProductSubscriptionSeed(page: Page, seed: ProductSubscriptionSeed) {
  const result = await page.evaluate(async (payload) => {
    const csrfToken = document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("renewlet_csrf="))
      ?.slice("renewlet_csrf=".length);
    if (!csrfToken) throw new Error("Missing Renewlet CSRF cookie");

    // E2E seed 走真实产品 API：HttpOnly session 随 cookie 发送，CSRF header 证明请求来自同站页面上下文。
    const response = await window.fetch("/api/app/subscriptions", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-Renewlet-CSRF": decodeURIComponent(csrfToken),
      },
      body: JSON.stringify({
        name: payload.name,
        logo: null,
        price: payload.price,
        currency: payload.currency ?? "CNY",
        billingCycle: payload.billingCycle ?? "monthly",
        customDays: null,
        customCycleUnit: null,
        oneTimeTermCount: null,
        oneTimeTermUnit: null,
        category: payload.category ?? "productivity",
        status: payload.status ?? "active",
        paymentMethod: payload.paymentMethod ?? null,
        startDate: payload.startDate,
        nextBillingDate: payload.nextBillingDate,
        autoRenew: payload.autoRenew ?? false,
        autoCalculateNextBillingDate: payload.autoCalculateNextBillingDate ?? false,
        pinned: false,
        publicHidden: false,
        trialEndDate: null,
        website: null,
        notes: null,
        tags: payload.tags ?? [],
        reminderDays: payload.reminderDays ?? 3,
        repeatReminderEnabled: false,
        repeatReminderInterval: "1h",
        repeatReminderWindow: "72h",
        costSharing: null,
        extra: {},
      }),
    });

    return {
      body: await response.text(),
      ok: response.ok,
      status: response.status,
    };
  }, seed);

  expect(result.ok, `create subscription seed ${seed.name}: ${result.status} ${result.body}`).toBe(true);
}
