import { apiFetch } from "@/lib/api-client";
import {
  authSecuritySettingsResponseSchema,
  type AuthSecuritySettings,
  type AuthSecuritySettingsUpdateBody,
} from "@/lib/api/schemas/admin";

/** 管理员访问安全服务；Turnstile secret 只能通过 PUT 入站，GET 响应只回 secretConfigured。 */
export const authSecurityService = {
  async read(signal?: AbortSignal): Promise<AuthSecuritySettings> {
    return await apiFetch("/api/app/admin/auth-security", authSecuritySettingsResponseSchema, signal ? { signal } : undefined);
  },

  async update(body: AuthSecuritySettingsUpdateBody): Promise<AuthSecuritySettings> {
    return await apiFetch("/api/app/admin/auth-security", authSecuritySettingsResponseSchema, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  },
};
