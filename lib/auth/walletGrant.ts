/**
 * HttpOnly cookie proving this browser unlocked a specific wallet.
 *
 * Signed with AUTH_SESSION_SECRET, same as the account session. The cookie
 * is not a key: it cannot sign a transaction. It only authorises reading
 * the PayAI records that belong to the address inside it.
 *
 * Server-only.
 */
import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { verifyMessage } from "viem";
import { cookieDomain } from "@/lib/hosts";
import { WALLET_GRANT_COOKIE, WALLET_GRANT_TTL_MS, walletGrantMessage } from "./walletGrantShared";

export { WALLET_GRANT_COOKIE, WALLET_GRANT_TTL_MS, walletGrantMessage };

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

interface GrantPayload {
  address: string;
  expiresAt: number;
}

function secret(): string {
  const s = process.env.AUTH_SESSION_SECRET;
  if (s) return s;
  if (process.env.NODE_ENV === "production") {
    throw new Error("AUTH_SESSION_SECRET must be set in production to sign wallet grants.");
  }
  return "dev-only-insecure-session-secret";
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(`wallet-grant.${payload}`).digest("base64url");
}

export function encodeWalletGrant(address: string, expiresAt: number): string {
  const payload = Buffer.from(JSON.stringify({ address: address.toLowerCase(), expiresAt }), "utf8").toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function decodeWalletGrant(cookieValue: string | undefined | null): GrantPayload | null {
  if (!cookieValue) return null;
  const [payload, sig] = cookieValue.split(".");
  if (!payload || !sig) return null;
  try {
    const expected = sign(payload);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<GrantPayload>;
    if (typeof parsed.address !== "string" || !ADDR_RE.test(parsed.address)) return null;
    const expiresAt = Number(parsed.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
    return { address: parsed.address.toLowerCase(), expiresAt };
  } catch {
    return null;
  }
}

export function requestHasWalletGrant(req: NextRequest, address: string): boolean {
  if (!ADDR_RE.test(address)) return false;
  const grant = decodeWalletGrant(req.cookies.get(WALLET_GRANT_COOKIE)?.value);
  return !!grant && grant.address === address.toLowerCase();
}

export function walletGrantCookieOpts(host?: string | null, maxAgeSeconds = Math.floor(WALLET_GRANT_TTL_MS / 1000)) {
  const domain = cookieDomain(host);
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: maxAgeSeconds,
    ...(domain ? { domain } : {}),
  };
}

/** The one expiry window a grant may request. Kept as a single function so the
 *  route can name this failure separately from a bad signature, without a
 *  second copy of the bounds. */
export function grantExpiryInWindow(expiresAt: number, now = Date.now()): boolean {
  if (!Number.isFinite(expiresAt)) return false;
  if (expiresAt < now - 30_000) return false;
  if (expiresAt > now + WALLET_GRANT_TTL_MS + 60_000) return false;
  return true;
}

/** Confirms the signature was made by `address` over a bounded expiry. */
export async function verifyWalletGrantSignature(address: string, expiresAt: number, signature: string): Promise<boolean> {
  if (!ADDR_RE.test(address) || !signature) return false;
  if (!grantExpiryInWindow(expiresAt)) return false;
  return verifyMessage({
    address: address as `0x${string}`,
    message: walletGrantMessage(address, expiresAt),
    signature: signature as `0x${string}`,
  }).catch(() => false);
}

/** 401 for a private read that did not prove the wallet. The empty lists
 *  keep dashboard code that reads `body.events` from throwing. */
export function walletGrantRequired(): NextResponse {
  return NextResponse.json(
    {
      error: "Unlock your wallet to view this.",
      code: "wallet_grant_required",
      known: false,
      events: [],
      tickets: [],
      automations: [],
      schedules: [],
      links: [],
      history: [],
      wallets: [],
    },
    { status: 401 },
  );
}

/**
 * Private PayAI records on the shared tenant require a grant for `address`.
 * A merchant presenting its API key already proved it owns that tenant, so
 * its own dashboard is not asked for a passkey. Returns a response to send
 * back, or null when the read may proceed.
 */
export async function denyPrivateRead(req: NextRequest, address: string | null | undefined): Promise<NextResponse | null> {
  if (!address || address === "__none__" || !ADDR_RE.test(address)) return null;
  const { resolveTenantId } = await import("@/lib/platform/tenant");
  const { DEMO_TENANT } = await import("@/lib/platform/merchants");
  const merchantId = await resolveTenantId(req);
  if (merchantId !== DEMO_TENANT) return null;
  if (requestHasWalletGrant(req, address)) return null;
  return walletGrantRequired();
}
