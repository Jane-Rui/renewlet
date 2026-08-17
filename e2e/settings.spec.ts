import { expect, test } from "./support/test";
import {
  captureLayoutSnapshot,
  expectLabelControlGap,
  expectRootScrollContainer,
  expectStableLayout,
} from "./support/layout";
import {
  fillChangedTestPhone,
  getSettingsDiscardButton,
  getSettingsSaveButton,
  gotoSettingsAfterHydration,
} from "./support/settings";

test("settings save, language switch, and floating layer layout stability", async ({ page }) => {
  await gotoSettingsAfterHydration(page);
  await expect(page.getByRole("heading", { name: "系统配置" })).toBeVisible();
  await expectLabelControlGap(page.getByLabel("月度预算金额", { exact: true }), "settings monthly budget");
  await expectLabelControlGap(page.getByLabel("第三方 API 测试号码", { exact: true }), "settings test phone");

  const testPhoneInput = page.getByLabel("第三方 API 测试号码", { exact: true });
  await fillChangedTestPhone(testPhoneInput);
  const saveChangesButton = getSettingsSaveButton(page);
  await expect(saveChangesButton).toBeVisible();
  // 浮层打开后背景可能被 aria-hidden，先保存 ElementHandle 才能比较固定按钮的视觉位置。
  const saveChangesButtonElement = await saveChangesButton.elementHandle();
  if (!saveChangesButtonElement) {
    throw new Error("Missing save button element before opening floating layers");
  }

  const settingsContent = page.getByTestId("settings-main");
  const settingsBeforeSelect = await captureLayoutSnapshot(page, {
    content: settingsContent,
    saveButton: saveChangesButtonElement,
  });
  expectRootScrollContainer(settingsBeforeSelect);

  const languageSelect = page.getByRole("combobox", { name: "语言" });
  await languageSelect.click();
  await expect(page.getByRole("option", { name: "English" })).toBeVisible();
  const settingsWithSelectOpen = await captureLayoutSnapshot(page, {
    content: settingsContent,
    saveButton: saveChangesButtonElement,
  });
  expect(settingsWithSelectOpen.bodyScrollLocked).toBe(true);
  expectRootScrollContainer(settingsWithSelectOpen);
  expectStableLayout(settingsBeforeSelect, settingsWithSelectOpen, "settings language select");

  await page.keyboard.press("Escape");
  await expect(page.getByRole("option", { name: "English" })).toBeHidden();

  await page.getByRole("button", { name: "修改密码" }).click();
  const passwordDialog = page.getByRole("dialog", { name: "修改密码" });
  await expect(passwordDialog).toBeVisible();
  const settingsWithPasswordDialogOpen = await captureLayoutSnapshot(page, {
    content: settingsContent,
    saveButton: saveChangesButtonElement,
  });
  expect(settingsWithPasswordDialogOpen.bodyScrollLocked).toBe(true);
  expectRootScrollContainer(settingsWithPasswordDialogOpen);
  expectStableLayout(settingsBeforeSelect, settingsWithPasswordDialogOpen, "settings password dialog");
  await expectLabelControlGap(passwordDialog.getByLabel("当前密码", { exact: true }), "settings current password");
  await expectLabelControlGap(passwordDialog.getByLabel("新密码", { exact: true }), "settings new password");
  await expectLabelControlGap(passwordDialog.getByLabel("确认密码", { exact: true }), "settings confirm password");

  await passwordDialog.getByRole("button", { name: "Close" }).click();
  await expect(passwordDialog).toBeHidden();
  await saveChangesButton.click();
  await expect(saveChangesButton).toBeHidden();

  await languageSelect.click();
  await page.getByRole("option", { name: "English" }).click();
  await expect(page.getByRole("heading", { name: "System settings" })).toBeVisible();
  await page.getByRole("combobox", { name: "Language" }).click();
  await page.getByRole("option", { name: "中文" }).click();
  await expect(page.getByRole("heading", { name: "系统配置" })).toBeVisible();

  const discardChangesButton = getSettingsDiscardButton(page);
  if (await discardChangesButton.isVisible()) {
    await discardChangesButton.click();
    await expect(discardChangesButton).toBeHidden();
  }
});
