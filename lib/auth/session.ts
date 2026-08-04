/**
 * Session cookie — signed, stateless. Holds just enough to know "who is
 * signed in" (userId, authMethod, embedded address); no server-side session
 * table to keep in sync. Recovery of the wallet itself never depends on this
 * cookie surviving — Mera's createOrRecoverWallet(userId) is idempotent, so a
 * fresh device + a successful login always reaches the same address.
 *
 * Server-only.
 */
import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { AuthSession } from "./types";

export const SESSION_COOKIE = "payai_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

function secret(): string {
  const s = process.env.AUTH_SESSION_SECRET;
  if (s) return s;
  if (process.env.NODE_ENV === "production") {
    throw new Error("AUTH_SESSION_SECRET must be set in production to sign session cookies.");
  }
  return "dev-only-insecure-session-secret";
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

export function encodeSession(session: AuthSession): string {
  const payload = Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function decodeSession(cookieValue: string | undefined | null): AuthSession | null {
  if (!cookieValue) return null;
  const [payload, sig] = cookieValue.split(".");
  if (!payload || !sig) return null;
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as AuthSession;
  } catch {
    return null;
  }
}

export const SESSION_COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: MAX_AGE_SECONDS,
};
