import { accountSecurityKeyRing } from "./account-security-key";
import type { Env } from "./types";

const DEFAULT_SESSION_TTL_DAYS = 30;

export const mfaTextEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export async function encryptMfaSecret(env: Env, plaintext: string): Promise<string> {
  const key = await aesGcmKey(env);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, mfaTextEncoder.encode(plaintext)));
  return `v1.${base64Url(nonce)}.${base64Url(ciphertext)}`;
}

export async function decryptMfaSecret(env: Env, value: string): Promise<string> {
  const [version, nonceText, ciphertextText] = value.split(".");
  if (version !== "v1" || !nonceText || !ciphertextText) throw new Error("invalid MFA ciphertext");
  const key = await aesGcmKey(env);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64Url(nonceText) },
    key,
    fromBase64Url(ciphertextText),
  );
  return textDecoder.decode(plaintext);
}

export async function recoveryCodeHash(env: Env, code: string): Promise<string> {
  return hmacSha256((await accountSecurityKeyRing(env)).recoveryCode, "renewlet:mfa:recovery:v1:", normalizeRecoveryCode(code));
}

export async function mfaTicketHash(env: Env, token: string): Promise<string> {
  return hmacSha256((await accountSecurityKeyRing(env)).mfaTicket, "renewlet:mfa:ticket:v1:", token);
}

export async function passkeyChallengeHash(env: Env, token: string): Promise<string> {
  return hmacSha256((await accountSecurityKeyRing(env)).passkeyChallenge, "renewlet:passkey:challenge:v1:", token);
}

export function timingSafeEqual(left: string, right: string): boolean {
  const leftBytes = mfaTextEncoder.encode(left);
  const rightBytes = mfaTextEncoder.encode(right);
  if (leftBytes.length !== rightBytes.length) return false;
  let diff = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return diff === 0;
}

export function sessionTtlDays(env: Env): number {
  const value = Number.parseInt(env.SESSION_TTL_DAYS ?? "", 10);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_SESSION_TTL_DAYS;
}

export function base64Url(data: Uint8Array): string {
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function fromBase64Url(input: string): ArrayBuffer {
  const normalized = input.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(input.length / 4) * 4, "=");
  const binary = atob(normalized);
  const data = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) data[index] = binary.charCodeAt(index);
  return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
}

async function aesGcmKey(env: Env): Promise<CryptoKey> {
  return (await accountSecurityKeyRing(env)).totpSeed;
}

async function hmacSha256(key: CryptoKey, prefix: string, input: string): Promise<string> {
  const signature = await crypto.subtle.sign("HMAC", key, mfaTextEncoder.encode(prefix + input));
  return base64Url(new Uint8Array(signature));
}

function normalizeRecoveryCode(code: string): string {
  return code.trim().toUpperCase().replaceAll("-", "").replaceAll(" ", "");
}
