// 移动端通知历史 E2E 用大量失败 job 撑开抽屉，专门保护长错误文本、滚动区域和顶部遮罩的布局边界。
import type { Page } from "@playwright/test";
import { expect, test } from "./support/test";
import { expectOverlayLeavesTopScrim } from "./support/layout";
import { gotoSettingsSectionAfterHydration } from "./support/settings";

type NotificationHistorySeed = {
  count: number;
};

async function createNotificationHistoryRecords(page: Page, seed: NotificationHistorySeed) {
  // 通过真实 PocketBase auth 写入 notification_jobs，既能快速造历史，又不绕过当前用户隔离。
  const result = await page.evaluate(async ({ count }) => {
    const authRaw = window.localStorage.getItem("pocketbase_auth");
    if (!authRaw) {
      throw new Error("Missing PocketBase auth state");
    }

    const auth = JSON.parse(authRaw) as { token?: string; record?: { id?: string } };
    if (!auth.token || !auth.record?.id) {
      throw new Error("PocketBase auth state is missing token or user id");
    }

    const responses: Array<{ ok: boolean; status: number; body: string }> = [];
    for (let index = 0; index < count; index += 1) {
      const minute = String(index).padStart(2, "0");
      const scheduledLocalTime = `04:${minute}`;
      const scheduledInstantUtc = `2026-05-18T20:${minute}:00.000Z`;
      const response = await window.fetch("/api/collections/notification_jobs/records", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${auth.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          user: auth.record.id,
          scheduledLocalDate: "2026-05-19",
          scheduledLocalTime,
          timeZone: "Asia/Shanghai",
          scheduledInstantUtc,
          status: "failed",
          attempts: index + 1,
          lastError: `email: dial tcp: lookup smtp.example.com: no such host ${index}`,
          result: {
            source: "cron",
            reason: "some_channels_failed",
            force: false,
            windowMinutes: 10,
            triggeredAtUtc: scheduledInstantUtc,
            schedule: {
              scheduledLocalDate: "2026-05-19",
              scheduledLocalTime,
              timeZone: "Asia/Shanghai",
              scheduledInstantUtc,
            },
            settings: {
              timezone: "Asia/Shanghai",
              locale: "zh-CN",
              notificationTimeLocal: "04:00",
              enabledChannels: ["email"],
              showExpired: false,
            },
            message: {
              title: "Renewlet 订阅提醒",
              content: `通知内容快照 ${index}\n${"Long diagnostic payload ".repeat(40)}`,
              timestamp: scheduledInstantUtc,
              hasPayload: true,
              items: [{
                subscriptionId: `sub-${index}`,
                name: `Notification Drawer Seed ${index}`,
                type: "renewal",
                price: "19",
                currency: "USD",
                status: "active",
                targetDate: "2026-05-20",
                reminderDays: 1,
                daysUntil: 1,
              }],
            },
            channels: {
              attempted: ["email"],
              succeeded: [],
              failed: [{ channel: "email", error: `dial tcp: lookup smtp.example.com: no such host ${index}` }],
            },
          },
        }),
      });

      responses.push({ ok: response.ok, status: response.status, body: await response.text() });
    }

    return responses;
  }, seed);

  for (const [index, response] of result.entries()) {
    expect(response.ok, `create notification history record ${index}: ${response.status} ${response.body}`).toBe(true);
  }
}

test("mobile notification history opens selected details in a bounded bottom drawer", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 720 });
  await page.goto("/");
  await createNotificationHistoryRecords(page, { count: 12 });

  // 先挂响应监听再进入设置页，避免本地高速接口在 click/goto 后瞬间完成导致等待丢包。
  const historyRead = page.waitForResponse((response) => (
    response.request().method() === "GET"
    && response.status() === 200
    && response.url().includes("/api/app/notifications/history")
  ));
  await gotoSettingsSectionAfterHydration(page, "settings-notifications");
  await historyRead;

  await page.getByRole("button", { name: "查看调度与历史" }).click();
  await page.getByRole("tab", { name: "发送历史" }).click();

  const rows = page.getByTestId("notification-history-row");
  await expect(rows.first()).toBeVisible();
  await expect(page.getByTestId("notification-history-desktop-detail")).toBeHidden();

  await rows.first().click();

  const drawer = page.getByTestId("notification-history-detail-drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer).toContainText("发送详情");
  await expect(drawer).toContainText("累计尝试渠道");
  await expect(drawer).toContainText("smtp.example.com");
  await expect(drawer).toHaveClass(/h5-notification-history-detail-drawer/);
  await expectOverlayLeavesTopScrim(page, drawer, "notification history detail drawer", 48);

  const metrics = await drawer.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      height: Math.round(rect.height * 100) / 100,
      viewportHeight: window.innerHeight,
    };
  });
  expect(metrics.height, "notification history drawer should not occupy the whole viewport").toBeLessThanOrEqual(
    metrics.viewportHeight * 0.79,
  );
});
