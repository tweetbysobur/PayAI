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
import { cookieDomain } from "@/lib/hosts";

export const SESSION_COOKIE = "payai_session";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

/**
 * Whether account sessions can be signed at all. Social and email sign-in
 * depend on this; the passkey wallet does NOT — it needs no server session,
 * so an unconfigured deployment still gives users a fully working wallet
 * while reporting the social methods as unavailable.
 */
export function isSessionConfigured(): boolean {
  return !!process.env.AUTH_SESSION_SECRET?.trim() || process.env.NODE_ENV !== "production";
}

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

/**
 * Never throws. A cookie that can't be verified — tampered, malformed, or
 * signed with a secret this deployment no longer has — means "not signed
 * in", which is exactly what an unauthenticated visitor already is. Letting
 * it throw instead would turn a stale cookie into a 500 on every request
 * that reads the session, including the public capability probe.
 *
 * Age is checked HERE, not left to the cookie's own maxAge. The browser
 * dropping a cookie after 30 days protects nobody: a session copied out of
 * one (from a shared machine, a backup, a logged request) can be replayed by
 * hand forever, because the signature over the payload never stops being
 * valid. The signed `createdAt` is what actually bounds a session's life.
 */
export function decodeSession(cookieValue: string | undefined | null): AuthSession | null {
  if (!cookieValue) return null;
  const [payload, sig] = cookieValue.split(".");
  if (!payload || !sig) return null;
  try {
    const expected = sign(payload);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as AuthSession;
    const createdAt = Number(session?.createdAt);
    // A missing or future-dated createdAt is not a session worth honouring:
    // it is either malformed or forged against a clock we don't share.
    if (!Number.isFinite(createdAt) || createdAt > Date.now() + 60_000) return null;
    if (Date.now() - createdAt > MAX_AGE_SECONDS * 1000) return null;
    return session;
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

/** Scope the session to *.usepayai.xyz so login on the apex callback
 *  is visible on app.usepayai.xyz. Preview/localhost stay host-only. */
export function sessionCookieOpts(host?: string | null) {
  const domain = cookieDomain(host);
  return domain ? { ...SESSION_COOKIE_OPTS, domain } : SESSION_COOKIE_OPTS;
}
