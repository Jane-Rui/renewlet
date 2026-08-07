// 移动端订阅 E2E 同时保护标签抽屉、tag 输入和底部操作区；这些交互依赖真实触控布局与浮层栈。
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  createSubscription,
  expectTagInputPopoverLayout,
  expectTagSuggestionListScrollable,
  openSubscriptionEditDialog,
  subscriptionCard,
  uniqueE2EName,
} from "./support/subscriptions";
import {
  expectActionNearContainerBottom,
  expectNoHorizontalOverflow,
  expectOverlayLeavesTopScrim,
  getRequiredLocatorBoundingBox,
} from "./support/layout";
import { createProductSubscriptionSeed } from "./support/product-api";

type SubscriptionCardLayoutSeed = {
  name: string;
  category: string;
  paymentMethod: string;
  startDate: string;
  nextBillingDate: string;
};

async function createSubscriptionLayoutRecord(
  page: Page,
  seed: SubscriptionCardLayoutSeed,
) {
  // 直接走产品 API 种记录，让用例只覆盖真实卡片排版；认证态仍来自 setup project。
  await createProductSubscriptionSeed(page, {
    ...seed,
    price: "20",
    currency: "USD",
    reminderDays: 7,
  });
}

async function captureSubscriptionCardLayout(card: Locator) {
  return card.evaluate((element) => {
    const query = (testId: string) => {
      const target = element.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
      if (!target) {
        throw new Error(`Missing ${testId}`);
      }
      const rect = target.getBoundingClientRect();
      return {
        left: Math.round(rect.left * 100) / 100,
        right: Math.round(rect.right * 100) / 100,
        top: Math.round(rect.top * 100) / 100,
      };
    };

    const cardRect = element.getBoundingClientRect();
    return {
      cardRight: Math.round(cardRect.right * 100) / 100,
      billingDate: query("subscription-card-meta-billing-date"),
      categoryBadge: query("subscription-card-badge-category"),
      paymentMethod: query("subscription-card-meta-payment-method"),
      renewalBadge: query("subscription-card-badge-renewal"),
      relativeBilling: query("subscription-card-meta-relative-billing"),
      startDate: query("subscription-card-meta-start-date"),
      statusBadge: query("subscription-card-badge-status"),
    };
  });
}

test("mobile subscription tag drawer and tag input layout", async ({ page }, testInfo) => {
  const plainName = uniqueE2EName(testInfo, "Mobile Plain");
  const taggedName = uniqueE2EName(testInfo, "Mobile Tagged");
  const tagName = uniqueE2EName(testInfo, "mobile-tag");
  const manyTags = [
    tagName,
    "云服务",
    "Issues",
    "Planning",
    "Testing",
    "QA",
    "E2E",
    "Browsers",
    "Automation",
    "Performance",
    "Billing",
    "Design",
    "Docs",
  ].join("、");

  await page.goto("/subscriptions");
  await expect(page.getByRole("heading", { name: "订阅列表" })).toBeVisible();

  await createSubscription(page, {
    name: plainName,
    price: "8",
    currencyLabel: "USD",
  });
  await createSubscription(page, {
    name: taggedName,
    price: "12",
    currencyLabel: "USD",
    tags: manyTags,
  });

  const mobileRenewalSortRow = page.getByTestId("mobile-renewal-sort-row");
  const mobileAdvancedTagRow = page.getByTestId("mobile-advanced-tag-row");
  await expect(mobileRenewalSortRow).toBeVisible();
  await expect(mobileAdvancedTagRow).toBeVisible();
  const mobileRenewalControl = mobileRenewalSortRow.getByRole("combobox").filter({ hasText: "所有续订" });
  const mobileSortControl = mobileRenewalSortRow.getByRole("combobox", { name: "排序" });
  const mobileAdvancedControl = mobileAdvancedTagRow.getByRole("button", { name: "更多筛选" });
  const mobileTagButton = mobileAdvancedTagRow.getByRole("button", { name: "标签" });
  await expect(page.getByTestId("mobile-selected-tags")).toHaveCount(0);
  const [mobileRenewalBox, mobileSortBox, mobileAdvancedBox, mobileTagBox] = await Promise.all([
    getRequiredLocatorBoundingBox(mobileRenewalControl, "mobile renewal filter"),
    getRequiredLocatorBoundingBox(mobileSortControl, "mobile sort filter"),
    getRequiredLocatorBoundingBox(mobileAdvancedControl, "mobile advanced filter"),
    getRequiredLocatorBoundingBox(mobileTagButton, "mobile tag filter"),
  ]);
  expect(Math.abs(mobileRenewalBox.y - mobileSortBox.y), "mobile renewal and sort controls should share a row").toBeLessThan(8);
  expect(mobileSortBox.x, "mobile sort filter should sit to the right of renewal").toBeGreaterThan(
    mobileRenewalBox.x + mobileRenewalBox.width - 1,
  );
  expect(Math.abs(mobileAdvancedBox.y - mobileTagBox.y), "mobile advanced and tag controls should share a row").toBeLessThan(8);
  expect(mobileTagBox.x, "mobile tag button should sit to the right of advanced filters").toBeGreaterThan(
    mobileAdvancedBox.x + mobileAdvancedBox.width - 1,
  );

  await mobileTagButton.click();
  const tagDrawer = page.getByRole("dialog", { name: "筛选标签" });
  await expect(tagDrawer).toBeVisible();
  await expectOverlayLeavesTopScrim(page, tagDrawer, "mobile tag filter drawer");
  await expectActionNearContainerBottom(
    tagDrawer,
    tagDrawer.getByRole("button", { name: "确定" }),
    "mobile tag filter drawer confirm",
  );
  await tagDrawer.getByPlaceholder("搜索标签...").fill(tagName);
  await tagDrawer.getByRole("button", { name: tagName }).click();
  await tagDrawer.getByRole("button", { name: "确定" }).click();
  await expect(tagDrawer).toBeHidden();
  await expect(page.getByTestId("mobile-selected-tags")).toBeVisible();
  await expect(subscriptionCard(page, taggedName)).toBeVisible();
  await expect(subscriptionCard(page, plainName)).toBeHidden();
  await expect(subscriptionCard(page, taggedName)).toBeInViewport();

  await mobileAdvancedTagRow.getByRole("button", { name: "标签(1)" }).click();
  await expect(tagDrawer).toBeVisible();
  await tagDrawer.getByRole("button", { name: "清空标签" }).click();
  await expect(tagDrawer).toBeHidden();
  await expect(page.getByTestId("mobile-selected-tags")).toHaveCount(0);
  await expect(subscriptionCard(page, plainName)).toBeVisible();

  const plainEditDialog = await openSubscriptionEditDialog(page, plainName);
  await plainEditDialog.getByLabel("标签", { exact: true }).click();
  await expectTagSuggestionListScrollable(page);
  await page.keyboard.press("Escape");
  await plainEditDialog.getByRole("button", { name: "取消" }).click();
  await expect(plainEditDialog).toBeHidden();

  const editDialog = await openSubscriptionEditDialog(page, taggedName);
  const editTagInput = editDialog.getByLabel("标签", { exact: true });
  await editTagInput.fill("测试、研发、财务、运营、设计、增长");
  await editTagInput.click();
  await page.keyboard.type("layout");
  await expectTagInputPopoverLayout(page, editDialog);
  await page.keyboard.press("Escape");
  await editDialog.getByRole("button", { name: "取消" }).click();
  await expect(editDialog).toBeHidden();
});

test("mobile subscription card keeps date metadata naturally on the first available row", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 720 });
  await page.goto("/subscriptions");
  await expect(page.getByRole("heading", { name: "订阅列表" })).toBeVisible();

  const subscriptionName = uniqueE2EName(testInfo, "Netflix Pro");
  await createSubscriptionLayoutRecord(page, {
    name: subscriptionName,
    category: "hosting_domains",
    paymentMethod: "google_pay",
    startDate: "2026-02-20",
    nextBillingDate: "2026-05-31",
  });
  await page.reload();

  const card = subscriptionCard(page, subscriptionName);
  await expect(card).toBeVisible();
  await expect(card).toBeInViewport();
  await expectNoHorizontalOverflow(page, "mobile subscription card metadata");

  const layout = await captureSubscriptionCardLayout(card);

  expect(Math.abs(layout.startDate.top - layout.billingDate.top), "start and billing dates should share a row").toBeLessThanOrEqual(4);
  expect(layout.billingDate.left, "billing date should sit after start date").toBeGreaterThan(layout.startDate.right - 1);
  expect(layout.paymentMethod.top, "payment method can wrap only after the billing date row").toBeGreaterThanOrEqual(layout.startDate.top - 1);
  expect(layout.relativeBilling.top, "relative billing can wrap only after the billing date row").toBeGreaterThanOrEqual(layout.startDate.top - 1);

  expect(Math.abs(layout.categoryBadge.top - layout.statusBadge.top), "category and status badges should share a row").toBeLessThanOrEqual(4);
  expect(Math.abs(layout.statusBadge.top - layout.renewalBadge.top), "status and renewal badges should share a row").toBeLessThanOrEqual(4);
  expect(layout.categoryBadge.right, "category badge should stay inside card").toBeLessThanOrEqual(layout.cardRight + 1);
  expect(layout.statusBadge.right, "status badge should stay inside card").toBeLessThanOrEqual(layout.cardRight + 1);
  expect(layout.renewalBadge.right, "renewal badge should stay inside card").toBeLessThanOrEqual(layout.cardRight + 1);
});
