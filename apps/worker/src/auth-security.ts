import { authSecuritySettingsPayloadSchema, authSecuritySettingsUpdateBodySchema } from "@renewlet/shared/schemas/admin";
import { HttpError, readJson, requestLocale, successJson } from "./http";
import { serverText } from "./server-i18n";
import { requireAdmin } from "./auth";
import {
  authSecurityResponseFromStored,
  readAuthSecuritySettings,
  saveAuthSecuritySettings,
  turnstileComplete,
} from "./auth-security-store";
import type { Env } from "./types";

export async function readAuthSecurity(request: Request, env: Env): Promise<Response> {
  await requireAdmin(request, env);
  return successJson(authSecuritySettingsPayloadSchema.parse(authSecurityResponseFromStored(await readAuthSecuritySettings(env))));
}

export async function updateAuthSecurity(request: Request, env: Env): Promise<Response> {
  const locale = requestLocale(request);
  await requireAdmin(request, env);
  const body = await readJson(request, authSecuritySettingsUpdateBodySchema, locale);
  const current = await readAuthSecuritySettings(env);
  // shared schema 是 Docker/Worker/前端共同 wire-shape：secret 省略=保留，空字符串=清空，响应只回 secretConfigured。
  const next = {
    turnstileEnabled: body.turnstile.enabled,
    turnstileSiteKey: body.turnstile.siteKey.trim(),
    turnstileSecret: body.turnstile.secret === undefined ? current.turnstileSecret : body.turnstile.secret.trim(),
  };
  if (next.turnstileEnabled && !turnstileComplete(next)) {
    throw new HttpError(400, serverText(locale, "auth.turnstileConfigIncomplete"), "TURNSTILE_CONFIG_INCOMPLETE");
  }
  const saved = await saveAuthSecuritySettings(env, next);
  return successJson(authSecuritySettingsPayloadSchema.parse(authSecurityResponseFromStored(saved)));
}
