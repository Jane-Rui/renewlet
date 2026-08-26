// 桌面订阅 E2E 覆盖创建、筛选、编辑、Logo sheet 和持久化回读，是订阅主流程的跨组件回归基线。
import subscriptionCollectionContractFixtures from "../packages/shared/src/contract-fixtures/subscription-collection-contract-fixtures.json";
import { expect, test } from "./support/test";
import {
  createSubscription,
  expectEmptyTagCursorStaysInline,
  openAddSubscriptionDialog,
  openSubscriptionEditDialog,
  saveSubscriptionDialog,
  subscriptionCard,
  uniqueE2EName,
} from "./support/subscriptions";
import {
  expectActionNearContainerBottom,
  captureLogoSheetScrollMetrics,
  expectScrollContentNearFooter,
  expectVerticallyCenteredInViewport,
} from "./support/layout";
import { installLogoCandidateRoute } from "./support/media-candidates";
import { expectSideDrawerExitLifecycle } from "./support/side-drawer";

test("desktop advanced filters complete the right-side exit lifecycle", async ({ page }) => {
  await page.goto("/subscriptions");
  await expect(page.getByRole("heading", { name: "订阅列表" })).toBeVisible();

  const trigger = page.getByTestId("desktop-advanced-filter").getByRole("button", { name: "更多筛选" });
  await trigger.click();
  const panel = page.getByTestId("desktop-advanced-filter-panel");
  await expect(panel).toBeVisible();

  await expectSideDrawerExitLifecycle(
    page,
    panel,
    () => panel.getByRole("button", { name: "关闭" }).click(),
  );
  await expect(trigger).toBeFocused();
});

test("desktop tall subscription dialog keeps footer tight to the panel bottom", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto("/subscriptions");
  await expect(page.getByRole("heading", { name: "订阅列表" })).toBeVisible();

  const dialog = await openAddSubscriptionDialog(page);
  await expectVerticallyCenteredInViewport(page, dialog, "desktop tall subscription dialog");
  await expectActionNearContainerBottom(
    dialog,
    dialog.getByRole("button", { name: "添加订阅" }),
    "desktop tall subscription dialog submit",
  );
  await expectScrollContentNearFooter(
    dialog.locator("[data-subscription-dialog-scroll]"),
    "desktop tall subscription dialog scroll end",
  );
});

test("desktop subscription create, tag filter, edit, and reload persistence", async ({ page }, testInfo) => {
  const plainName = uniqueE2EName(testInfo, "Plain Cloud");
  const taggedName = uniqueE2EName(testInfo, "Tagged Cloud");
  const editedName = `${taggedName} Pro`;
  const tagName = uniqueE2EName(testInfo, "work");

  await page.goto("/subscriptions");
  await expect(page.getByRole("heading", { name: "订阅列表" })).toBeVisible();

  await createSubscription(page, {
    name: plainName,
    price: "15",
    currencyLabel: "USD",
  });
  await createSubscription(page, {
    name: taggedName,
    price: "20",
    currencyLabel: "USD",
    tags: `${tagName}、云服务`,
  });

  const desktopTagFilter = page.getByTestId("desktop-tag-filter");
  await expect(desktopTagFilter.getByRole("button", { name: "标签" })).toBeVisible();
  await desktopTagFilter.getByRole("button", { name: "标签" }).click();
  await page.getByPlaceholder("搜索标签...").fill(tagName);
  await page.getByRole("button", { name: tagName }).click();
  await expect(desktopTagFilter.getByRole("button", { name: "标签(1)" })).toBeVisible();
  await expect(page.getByTestId("desktop-selected-tags")).toBeVisible();
  await expect(subscriptionCard(page, taggedName)).toBeVisible();
  await expect(subscriptionCard(page, plainName)).toBeHidden();
  await page.getByRole("button", { name: "清空标签" }).click();
  await expect(subscriptionCard(page, plainName)).toBeVisible();

  const editDialog = await openSubscriptionEditDialog(page, taggedName);
  await expectVerticallyCenteredInViewport(page, editDialog, "desktop edit subscription dialog");
  await editDialog.getByLabel("服务名称", { exact: true }).fill(editedName);
  const desktopTagInput = editDialog.getByLabel("标签", { exact: true });
  await desktopTagInput.fill("Writing、test、Docs、Research");
  await desktopTagInput.click();
  await expectEmptyTagCursorStaysInline(page, editDialog);
  await page.keyboard.press("Escape");
  await saveSubscriptionDialog(page, editDialog, "保存修改");
  await expect(subscriptionCard(page, editedName)).toBeVisible();
  await expect(subscriptionCard(page, taggedName)).toBeHidden();

  const emptyTagDialog = await openAddSubscriptionDialog(page);
  await expectActionNearContainerBottom(
    emptyTagDialog,
    emptyTagDialog.getByRole("button", { name: "添加订阅" }),
    "desktop subscription dialog submit",
  );
  await emptyTagDialog.getByLabel("标签", { exact: true }).click();
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("Escape");
  await emptyTagDialog.getByRole("button", { name: "取消" }).click();
  await expect(emptyTagDialog).toBeHidden();

  await page.goto("/calendar");
  await expect(page.getByRole("heading", { name: "续费/到期日历", level: 1 })).toBeVisible();
  for (let attempts = 0; attempts < 3; attempts += 1) {
    const calendarEntry = page.getByRole("button", { name: editedName, exact: true }).first();
    if (await calendarEntry.isVisible().catch(() => false)) {
      await calendarEntry.click();
      break;
    }
    await page.getByRole("button", { name: "下个月" }).click();
  }
  const detailDialog = page.getByRole("dialog", { name: editedName });
  await expect(detailDialog).toBeVisible();
  await expectActionNearContainerBottom(
    detailDialog,
    detailDialog.getByRole("button", { name: "编辑" }),
    "desktop calendar detail edit",
  );
  await detailDialog.getByRole("button", { name: "关闭" }).click();
  await expect(detailDialog).toBeHidden();

  await page.goto("/subscriptions");
  await expect(subscriptionCard(page, plainName)).toBeVisible();
  await expect(subscriptionCard(page, editedName)).toBeVisible();
});

test("desktop 1000-row search uses one index request and keeps the virtual list scrollable", async ({ page }) => {
  const indexRequests: string[] = [];
  const collectionTemplate = subscriptionCollectionContractFixtures.collectionItems[0];
  if (!collectionTemplate) throw new Error("Missing recurring subscription collection contract fixture");
  const subscriptions = Array.from({ length: 1000 }, (_, index) => ({
    ...collectionTemplate,
    id: `scale-${index}`,
    name: `Scale Needle ${index}`,
  }));
  await page.route("**/api/app/subscriptions/index**", async (route) => {
    indexRequests.push(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { subscriptions, total: subscriptions.length } }),
    });
  });

  await page.goto("/subscriptions");
  await expect(page.getByRole("heading", { name: "订阅列表" })).toBeVisible();
  await page.getByPlaceholder("搜索订阅、标签或备注...").fill("Scale Needle");

  await expect(page.getByText("Scale Needle 0", { exact: true })).toBeVisible();
  expect(indexRequests).toHaveLength(1);
  expect(new URL(indexRequests[0] ?? "http://invalid").searchParams.get("q")).toBe("Scale Needle");

  const virtualList = page.getByTestId("virtualized-subscription-list");
  await expect(virtualList).toBeVisible();
  await page.locator("#root").evaluate((root) => root.scrollTo({ top: root.scrollHeight }));
  await expect(page.getByText("Scale Needle 999", { exact: true })).toBeVisible();
  expect(indexRequests).toHaveLength(1);
});

test("desktop import Logo editor gives search candidates a real scroll viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await installLogoCandidateRoute(page);

  await page.goto("/subscriptions");
  await expect(page.getByRole("heading", { name: "订阅列表" })).toBeVisible();

  await page.getByRole("button", { name: "导入数据" }).click();
  const importDialog = page.getByRole("dialog", { name: "导入数据" });
  await expect(importDialog).toBeVisible();

  await importDialog.getByRole("tab", { name: "粘贴 JSON" }).click();
  await importDialog.getByPlaceholder("粘贴 Renewlet 或 Wallos JSON...").fill(JSON.stringify([{
    Name: "Linear",
    "Payment Cycle": "Monthly",
    "Next Payment": "2026-06-01",
    Price: "$10",
    Category: "Software",
    "Payment Method": "Visa",
  }]));
  await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/api/app/import/preview") && response.request().method() === "POST",
    ),
    importDialog.getByRole("button", { name: "生成预览" }).click(),
  ]);

  await importDialog.getByRole("button", { name: "修改 Logo" }).first().click();
  const importLogoSheet = page.locator(".h5-import-logo-sheet");
  await expect(importLogoSheet).toBeVisible();
  await expect(importLogoSheet.getByRole("button", { name: /Linear 1/ }).first()).toBeVisible({ timeout: 10_000 });

  const scroll = await captureLogoSheetScrollMetrics(importLogoSheet, "import-logo-search-results");
  expect(scroll.scrollHeight, JSON.stringify(scroll, null, 2)).toBeGreaterThan(scroll.clientHeight);
  expect(scroll.clientHeight, JSON.stringify(scroll, null, 2)).toBeGreaterThanOrEqual(220);
  expect(scroll.scrollTop, JSON.stringify(scroll, null, 2)).toBeGreaterThanOrEqual(
    scroll.scrollHeight - scroll.clientHeight - 1,
  );
  expect(scroll.lastBottomGap, JSON.stringify(scroll, null, 2)).toBeGreaterThanOrEqual(8);
});
