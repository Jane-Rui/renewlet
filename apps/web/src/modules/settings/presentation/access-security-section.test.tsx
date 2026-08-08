import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SettingsAuthSecurityController } from "../application/use-auth-security-settings-controller";
import { AccessSecuritySection } from "./access-security-section";

const translations: Record<string, string> = {
  "common.disabled": "未启用",
  "common.enabled": "已启用",
  "settings.accessSecurity": "访问安全",
  "settings.turnstileClearSecret": "清除密钥",
  "settings.turnstileClearing": "清除中...",
  "settings.turnstileDiscard": "放弃更改",
  "settings.turnstileEnable": "要求邮箱密码登录通过人机验证",
  "settings.turnstileEnableHelp": "启用后必须同时填写 Site key 和 Secret key，否则人机验证不会生效。",
  "settings.turnstileHelp": "启用后，Renewlet 会在邮箱密码登录前校验 Turnstile，用于降低爆破和撞库风险；通行密钥、身份验证器二阶段和首次设置不受影响。",
  "settings.turnstileSave": "保存 Turnstile 配置",
  "settings.turnstileSaving": "保存中...",
  "settings.turnstileSecret": "Secret key",
  "settings.turnstileSecretConfigured": "密钥已配置",
  "settings.turnstileSecretConfiguredPlaceholder": "已保存，留空则保持不变",
  "settings.turnstileSecretHelp": "只保存在服务端，用于调用 Cloudflare Siteverify；不会进入公开状态、导出或云备份。",
  "settings.turnstileSecretKeepHelp": "留空保持当前密钥；填写新值会替换旧密钥。",
  "settings.turnstileSecretPlaceholder": "输入 Cloudflare Turnstile Secret key",
  "settings.turnstileSiteKey": "Site key",
  "settings.turnstileSiteKeyHelp": "公开给登录页渲染 Turnstile widget。",
  "settings.turnstileSiteKeyPlaceholder": "0x4AAAA...",
  "settings.turnstileTitle": "Cloudflare Turnstile",
};

vi.mock("@/i18n/I18nProvider", () => ({
  useI18n: () => ({
    t: (key: string) => translations[key] ?? key,
  }),
}));

function createController(overrides: Partial<SettingsAuthSecurityController> = {}): SettingsAuthSecurityController {
  return {
    canManage: true,
    disabled: false,
    isLoading: false,
    isSaving: false,
    isClearingSecret: false,
    secretConfigured: false,
    hasChanges: false,
    draft: { enabled: false, siteKey: "", secret: "" },
    setEnabled: vi.fn(),
    setSiteKey: vi.fn(),
    setSecret: vi.fn(),
    discard: vi.fn(),
    save: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    clearSecret: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    ...overrides,
  };
}

function renderAccessSecuritySection(controller = createController()) {
  return render(
    <AccessSecuritySection
      id="settings-access-security"
      className="scroll-mt-test"
      controller={controller}
    />,
  );
}

describe("AccessSecuritySection", () => {
  it("does not render for users that cannot manage site access security", () => {
    const { container } = renderAccessSecuritySection(createController({ canManage: false }));

    expect(container.firstChild).toBeNull();
  });

  it("renders Turnstile human verification as a top-level access security section", () => {
    renderAccessSecuritySection(createController({
      draft: { enabled: true, siteKey: "site-key", secret: "" },
      secretConfigured: true,
    }));

    expect(screen.getByRole("heading", { name: "访问安全" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Cloudflare Turnstile" })).toBeInTheDocument();
    expect(screen.getByText("已启用")).toBeInTheDocument();
    expect(screen.getByText("密钥已配置")).toBeInTheDocument();
    expect(screen.getByText("启用后，Renewlet 会在邮箱密码登录前校验 Turnstile，用于降低爆破和撞库风险；通行密钥、身份验证器二阶段和首次设置不受影响。")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "要求邮箱密码登录通过人机验证" })).toBeChecked();
    expect(screen.getByLabelText("Site key")).toHaveValue("site-key");
    expect(screen.getByLabelText("Secret key")).toHaveAttribute("placeholder", "已保存，留空则保持不变");
    expect(screen.getByRole("button", { name: "保存 Turnstile 配置" })).toBeDisabled();
  });

  it("forwards edits, discard, save and clear-secret actions to the controller", async () => {
    const user = userEvent.setup();
    const controller = createController({
      hasChanges: true,
      secretConfigured: true,
      draft: { enabled: true, siteKey: "site-key", secret: "" },
    });
    renderAccessSecuritySection(controller);

    await user.click(screen.getByRole("checkbox", { name: "要求邮箱密码登录通过人机验证" }));
    fireEvent.change(screen.getByLabelText("Site key"), { target: { value: "site-key-2" } });
    fireEvent.change(screen.getByLabelText("Secret key"), { target: { value: "secret-2" } });
    await user.click(screen.getByRole("button", { name: "保存 Turnstile 配置" }));
    await user.click(screen.getByRole("button", { name: "放弃更改" }));
    await user.click(screen.getByRole("button", { name: "清除密钥" }));

    expect(controller.setEnabled).toHaveBeenCalledWith(false);
    expect(controller.setSiteKey).toHaveBeenCalledWith("site-key-2");
    expect(controller.setSecret).toHaveBeenCalledWith("secret-2");
    expect(controller.save).toHaveBeenCalledTimes(1);
    expect(controller.discard).toHaveBeenCalledTimes(1);
    expect(controller.clearSecret).toHaveBeenCalledTimes(1);
  });
});
