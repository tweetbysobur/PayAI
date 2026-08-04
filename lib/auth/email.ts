/**
 * "Continue with Email" — a one-time code sent to the user's inbox. Gated on
 * AUTH_EMAIL_* the same way every other provider in this file is: PayAI has
 * no email-sending infrastructure yet (see lib/platform/automationEvents.ts's
 * notifyExternal — same situation), so until AUTH_EMAIL_API_KEY is set this
 * refuses cleanly instead of claiming to have sent an email nothing will
 * deliver. Codes are short-lived, single-use, and never logged.
 *
 * Server-only.
 */
import "server-only";
import { randomInt } from "node:crypto";
import { getRedis } from "@/lib/platform/kv";

const CODE_TTL_SECONDS = 10 * 60;
const key = (email: string) => `payai:auth:email-code:${email.toLowerCase().trim()}`;

const g = globalThis as unknown as { __payaiEmailCodes?: Map<string, { code: string; expiresAt: number }> };
const mem = (g.__payaiEmailCodes ??= new Map());

export function isEmailAuthConfigured(): boolean {
  return !!process.env.AUTH_EMAIL_API_KEY?.trim();
}

/** Sends (or in dev without a configured provider, throws) a 6-digit code. */
export async function sendEmailCode(email: string): Promise<void> {
  if (!isEmailAuthConfigured()) {
    throw new Error("Email sign-in is not configured yet (set AUTH_EMAIL_API_KEY).");
  }
  const code = String(randomInt(100000, 999999));
  const expiresAt = Date.now() + CODE_TTL_SECONDS * 1000;
  const r = await getRedis();
  if (r) await r.set(key(email), JSON.stringify({ code, expiresAt }));
  else mem.set(key(email), { code, expiresAt });

  // The actual send call — this is the one line that plugs in a real
  // provider (Resend, SES, Postmark…) once AUTH_EMAIL_API_KEY exists. Left
  // unimplemented on purpose rather than guessed, per the module doc above.
  throw new Error("Email provider not wired in yet — AUTH_EMAIL_API_KEY is set but no send() call is implemented.");
}

export async function verifyEmailCode(email: string, code: string): Promise<boolean> {
  const r = await getRedis();
  const raw = r ? await r.get(key(email)) : mem.get(key(email));
  if (!raw) return false;
  const parsed = typeof raw === "string" ? (JSON.parse(raw) as { code: string; expiresAt: number }) : (raw as { code: string; expiresAt: number });
  if (!parsed || Date.now() > parsed.expiresAt) return false;
  return parsed.code === code;
}
