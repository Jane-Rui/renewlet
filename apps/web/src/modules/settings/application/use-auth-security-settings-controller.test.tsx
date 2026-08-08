// Turnstile 人机验证 controller 测试保护 write-only secret 语义；它是站点级状态，不进入账号 settings 草稿。
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthSecuritySettingsController } from "./use-auth-security-settings-controller";

const mocks = vi.hoisted(() => ({
  remote: undefined as unknown,
  mutateAsync: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/hooks/use-auth-security", () => ({
  useAuthSecuritySettings: (enabled: boolean) => ({
    data: enabled ? mocks.remote : undefined,
    isLoading: false,
  }),
  useUpdateAuthSecuritySettings: () => ({
    mutateAsync: mocks.mutateAsync,
    isPending: false,
  }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mocks.toast }),
}));

vi.mock("@/i18n/I18nProvider", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

describe("useAuthSecuritySettingsController", () => {
  beforeEach(() => {
    mocks.remote = {
      turnstile: { enabled: true, siteKey: "site-key", secretConfigured: true },
    };
    mocks.mutateAsync.mockReset().mockResolvedValue({
      turnstile: { enabled: true, siteKey: "site-key", secretConfigured: true },
    });
    mocks.toast.mockReset();
  });

  it("saves a new Turnstile secret only when the draft contains one", async () => {
    const { result } = renderHook(() => useAuthSecuritySettingsController(true, false));

    await waitFor(() => expect(result.current.draft.siteKey).toBe("site-key"));
    act(() => {
      result.current.setSecret(" new-secret ");
    });
    await waitFor(() => expect(result.current.draft.secret).toBe(" new-secret "));
    await act(async () => {
      await result.current.save();
    });

    expect(mocks.mutateAsync).toHaveBeenCalledWith({
      turnstile: { enabled: true, siteKey: "site-key", secret: "new-secret" },
    });
  });

  it("omits Turnstile secret to keep the stored value", async () => {
    const { result } = renderHook(() => useAuthSecuritySettingsController(true, false));

    await waitFor(() => expect(result.current.draft.siteKey).toBe("site-key"));
    act(() => {
      result.current.setSiteKey("site-key-2");
    });
    await waitFor(() => expect(result.current.draft.siteKey).toBe("site-key-2"));
    await act(async () => {
      await result.current.save();
    });

    expect(mocks.mutateAsync).toHaveBeenCalledWith({
      turnstile: { enabled: true, siteKey: "site-key-2" },
    });
  });

  it("clears the Turnstile secret by sending an explicit empty string", async () => {
    mocks.mutateAsync.mockResolvedValueOnce({
      turnstile: { enabled: false, siteKey: "site-key", secretConfigured: false },
    });
    const { result } = renderHook(() => useAuthSecuritySettingsController(true, false));

    await waitFor(() => expect(result.current.secretConfigured).toBe(true));
    await act(async () => {
      await result.current.clearSecret();
    });

    expect(mocks.mutateAsync).toHaveBeenCalledWith({
      turnstile: { enabled: false, siteKey: "site-key", secret: "" },
    });
    expect(result.current.secretConfigured).toBe(false);
  });
});
