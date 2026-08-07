import { beforeEach, describe, expect, it, vi } from "vitest";
import { passkeyService } from "./passkey-service";

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  startAuthentication: vi.fn(),
  startRegistration: vi.fn(),
  cancelCeremony: vi.fn(),
  writeProductSession: vi.fn(),
}));

vi.mock("@/lib/api-client", () => ({
  apiFetch: mocks.apiFetch,
}));

vi.mock("@simplewebauthn/browser", () => ({
  startAuthentication: mocks.startAuthentication,
  startRegistration: mocks.startRegistration,
  WebAuthnAbortService: {
    cancelCeremony: mocks.cancelCeremony,
  },
}));

vi.mock("@/services/product-session", () => ({
  writeProductSession: mocks.writeProductSession,
}));

const sessionResponse = {
  type: "session" as const,
  session: { expiresAt: "2026-07-03T00:00:00.000Z" },
  user: {
    id: "user-1",
    email: "passkey@example.com",
    name: "Passkey User",
    role: "user",
    banned: false,
  },
};

describe("passkeyService", () => {
  beforeEach(() => {
    mocks.apiFetch.mockReset();
    mocks.startAuthentication.mockReset().mockResolvedValue({
      id: "credential-id",
      response: { clientDataJSON: "client-data" },
      type: "public-key",
      clientExtensionResults: {},
    });
    mocks.startRegistration.mockReset().mockResolvedValue({
      id: "new-credential-id",
      response: { clientDataJSON: "client-data" },
      type: "public-key",
      clientExtensionResults: {},
    });
    mocks.cancelCeremony.mockReset();
    mocks.writeProductSession.mockReset();
  });

  it("cancels an active browser WebAuthn ceremony through SimpleWebAuthn", () => {
    passkeyService.cancelActiveCeremony();

    expect(mocks.cancelCeremony).toHaveBeenCalledTimes(1);
  });

  it("uses unauthenticated API mode for independent passkey sign-in", async () => {
    mocks.apiFetch
      .mockResolvedValueOnce({
        challengeId: "challenge-1",
        expiresAt: "2026-07-03T00:00:00.000Z",
        options: { challenge: "challenge-value", rpId: "renewlet.example" },
      })
      .mockResolvedValueOnce(sessionResponse);

    await expect(passkeyService.authenticate({ useBrowserAutofill: true })).resolves.toEqual({
      status: "authenticated",
      session: sessionResponse,
    });

    const optionsInit = mocks.apiFetch.mock.calls[0]?.[2] as RequestInit & { authMode?: string };
    const verifyInit = mocks.apiFetch.mock.calls[1]?.[2] as RequestInit & { authMode?: string };
    expect(mocks.apiFetch.mock.calls[0]?.[0]).toBe("/api/app/auth/passkeys/authenticate/options");
    expect(optionsInit.authMode).toBe("none");
    expect(mocks.apiFetch.mock.calls[1]?.[0]).toBe("/api/app/auth/passkeys/authenticate/verify");
    expect(verifyInit.authMode).toBe("none");
    expect(mocks.startAuthentication).toHaveBeenCalledWith(expect.objectContaining({
      useBrowserAutofill: true,
    }));
    expect(JSON.parse(String(verifyInit.body))).toMatchObject({
      challengeId: "challenge-1",
      response: { id: "credential-id" },
    });
  });

  it("treats user cancellation as a neutral passkey result and skips verification", async () => {
    mocks.apiFetch.mockResolvedValueOnce({
      challengeId: "challenge-1",
      expiresAt: "2026-07-03T00:00:00.000Z",
      options: { challenge: "challenge-value", rpId: "renewlet.example" },
    });
    const cause = Object.assign(new Error("The operation either timed out or was not allowed."), {
      name: "NotAllowedError",
    });
    mocks.startAuthentication.mockRejectedValueOnce(Object.assign(new Error("The operation either timed out or was not allowed."), {
      name: "WebAuthnError",
      code: "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY",
      cause,
    }));

    await expect(passkeyService.authenticate()).resolves.toEqual({ status: "cancelled" });

    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
    expect(mocks.apiFetch.mock.calls[0]?.[0]).toBe("/api/app/auth/passkeys/authenticate/options");
  });

  it("treats an aborted WebAuthn ceremony as a neutral passkey result and skips verification", async () => {
    mocks.apiFetch.mockResolvedValueOnce({
      challengeId: "challenge-1",
      expiresAt: "2026-07-03T00:00:00.000Z",
      options: { challenge: "challenge-value", rpId: "renewlet.example" },
    });
    mocks.startAuthentication.mockRejectedValueOnce(Object.assign(new Error("Manually cancelling existing WebAuthn API call"), {
      name: "WebAuthnError",
      code: "ERROR_CEREMONY_ABORTED",
    }));

    await expect(passkeyService.authenticate()).resolves.toEqual({ status: "cancelled" });

    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
    expect(mocks.apiFetch.mock.calls[0]?.[0]).toBe("/api/app/auth/passkeys/authenticate/options");
  });

  it("stores the renewed session after registering a passkey", async () => {
    mocks.apiFetch
      .mockResolvedValueOnce({
        challengeId: "register-challenge",
        expiresAt: "2026-07-03T00:00:00.000Z",
        options: { challenge: "challenge-value", rp: { name: "Renewlet" } },
      })
      .mockResolvedValueOnce(sessionResponse);

    await passkeyService.register({ name: "MacBook Touch ID", currentPassword: "password123" });

    expect(mocks.apiFetch.mock.calls[1]?.[0]).toBe("/api/app/auth/passkeys/register/verify");
    expect(mocks.writeProductSession).toHaveBeenCalledWith(sessionResponse);
  });

  it("stores the renewed session after deleting a passkey", async () => {
    mocks.apiFetch.mockResolvedValueOnce(sessionResponse);

    await passkeyService.delete("pkey_1", { currentPassword: "password123" });

    expect(mocks.apiFetch).toHaveBeenCalledWith("/api/app/auth/passkeys/pkey_1/delete", expect.anything(), expect.objectContaining({
      method: "POST",
    }));
    expect(mocks.writeProductSession).toHaveBeenCalledWith(sessionResponse);
  });
});
