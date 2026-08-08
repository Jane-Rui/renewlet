import { expect, type Locator, type Page } from "@playwright/test";

function extractRemoteTestPhone(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;

  const data = (payload as { data?: unknown }).data;
  const settings = data && typeof data === "object" && !Array.isArray(data)
    ? (data as { settings?: unknown }).settings
    : null;
  const record = settings && typeof settings === "object" && !Array.isArray(settings)
    ? settings
    : Array.isArray((payload as { items?: unknown }).items)
      ? (payload as { items: unknown[] }).items[0]
      : payload;
  if (!record || typeof record !== "object") return null;

  const value = (record as { testPhone?: unknown }).testPhone;
  return typeof value === "string" ? value : null;
}

export async function gotoSettingsAfterHydration(page: Page) {
  // 设置页会先渲染默认值再被远端设置覆盖；E2E 必须等 GET 返回后再断言表单，避免首帧默认值造成 flaky。
  const settingsRead = page.waitForResponse((response) => (
    response.request().method() === "GET"
    && response.status() === 200
    && response.url().includes("/api/app/settings")
  ));

  await page.goto("/settings");
  const settingsResponse = await settingsRead;
  const remoteTestPhone = extractRemoteTestPhone(await settingsResponse.json().catch(() => null));
  const testPhoneInput = page.getByLabel(/^(第三方 API 测试号码|Third-party API test number)$/);
  await expect(testPhoneInput).toBeVisible();

  if (remoteTestPhone !== null) {
    await expect(testPhoneInput).toHaveValue(remoteTestPhone);
  }
}

export function getSettingsSaveButton(page: Page) {
  // 设置页已有 Turnstile 独立保存/放弃按钮；全局草稿操作必须限定底部保存栏，避免同名按钮误匹配。
  return page.getByTestId("settings-save-bar").getByRole("button", { name: /^(保存更改|Save changes)$/ });
}

export function getSettingsDiscardButton(page: Page) {
  return page.getByTestId("settings-save-bar").getByRole("button", { name: /^(放弃更改|Discard changes)$/ });
}

export async function fillChangedTestPhone(input: Locator) {
  const current = await input.inputValue();
  const next = current === "8613800000000" ? "8613900000000" : "8613800000000";
  await input.fill(next);
  await expect(input).toHaveValue(next);
  return next;
}
