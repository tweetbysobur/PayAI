/**
 * Short-lived httpOnly proof that this browser's passkey asked to attach
 * the next Google sign-in to a specific wallet. The OAuth callback will
 * not link anything without it.
 *
 * Server-only.
 */
import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { verifyMessage } from "viem";
import { cookieDomain } from "@/lib/hosts";
import { deleteAccountWallet, getAccountWallet, putAccountWallet } from "@/lib/platform/accountWallet";
import { deleteLinkedLogin, getLinkedLogin, putLinkedLogin } from "@/lib/platform/linkedLogin";
import {
  decideGoogleLink,
  GOOGLE_LINK_COOKIE,
  GOOGLE_LINK_TTL_MS,
  linkGoogleMessage,
  unlinkGoogleMessage,
} from "./linkGoogleShared";

export { GOOGLE_LINK_COOKIE, GOOGLE_LINK_TTL_MS };

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,256}$/;

interface LinkProof {
  address: string;
  credentialId: string;
  expiresAt: number;
}

function secret(): string {
  const s = process.env.AUTH_SESSION_SECRET;
  if (s) return s;
  if (process.env.NODE_ENV === "production") {
    throw new Error("AUTH_SESSION_SECRET must be set in production to sign Google linking.");
  }
  return "dev-only-insecure-session-secret";
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(`link-google.${payload}`).digest("base64url");
}

export function encodeLinkProof(proof: LinkProof): string {
  const payload = Buffer.from(JSON.stringify({
    address: proof.address.toLowerCase(),
    credentialId: proof.credentialId,
    expiresAt: proof.expiresAt,
  }), "utf8").toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function decodeLinkProof(cookieValue: string | undefined | null): LinkProof | null {
  if (!cookieValue) return null;
  const [payload, sig] = cookieValue.split(".");
  if (!payload || !sig) return null;
  try {
    const expected = sign(payload);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<LinkProof>;
    if (typeof parsed.address !== "string" || !ADDR_RE.test(parsed.address)) return null;
    if (typeof parsed.credentialId !== "string" || !ID_RE.test(parsed.credentialId)) return null;
    const expiresAt = Number(parsed.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;
    return { address: parsed.address.toLowerCase(), credentialId: parsed.credentialId, expiresAt };
  } catch {
    return null;
  }
}

export function linkProofCookieOpts(host?: string | null) {
  const domain = cookieDomain(host);
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(GOOGLE_LINK_TTL_MS / 1000),
    ...(domain ? { domain } : {}),
  };
}

function expiryOk(expiresAt: number): boolean {
  const now = Date.now();
  return Number.isFinite(expiresAt) && expiresAt > now - 30_000 && expiresAt <= now + GOOGLE_LINK_TTL_MS + 60_000;
}

export async function verifyLinkSignature(address: string, credentialId: string, expiresAt: number, signature: string): Promise<boolean> {
  if (!ADDR_RE.test(address) || !ID_RE.test(credentialId) || !signature || !expiryOk(expiresAt)) return false;
  return verifyMessage({
    address: address as `0x${string}`,
    message: linkGoogleMessage(address, credentialId, expiresAt),
    signature: signature as `0x${string}`,
  }).catch(() => false);
}

export async function verifyUnlinkSignature(address: string, expiresAt: number, signature: string): Promise<boolean> {
  if (!ADDR_RE.test(address) || !signature || !expiryOk(expiresAt)) return false;
  return verifyMessage({
    address: address as `0x${string}`,
    message: unlinkGoogleMessage(address, expiresAt),
    signature: signature as `0x${string}`,
  }).catch(() => false);
}

/**
 * Binds a Google account to a passkey wallet, or refuses.
 * Refusing leaves both records untouched, so a mistaken Gmail cannot
 * take over a wallet and a wallet cannot be pointed at a second Gmail.
 */
export async function applyGoogleLink(input: {
  googleUserId: string;
  label: string;
  address: string;
  credentialId: string;
}): Promise<{ ok: true } | { ok: false; reason: "google-taken" | "wallet-taken" }> {
  const [existingForGoogle, existingForWallet] = await Promise.all([
    getAccountWallet(input.googleUserId),
    getLinkedLogin(input.address),
  ]);
  const decision = decideGoogleLink({
    googleUserId: input.googleUserId,
    walletAddress: input.address,
    existingForGoogle,
    existingForWallet,
  });
  if (decision !== "link") return { ok: false, reason: decision };
  const saved = await putAccountWallet(input.googleUserId, { address: input.address, credentialId: input.credentialId });
  const shown = await putLinkedLogin({
    userId: input.googleUserId,
    label: input.label,
    address: input.address,
    credentialId: input.credentialId,
  });
  if (!saved || !shown) return { ok: false, reason: "wallet-taken" };
  return { ok: true };
}

export async function removeGoogleLink(address: string): Promise<{ userId: string } | null> {
  const row = await getLinkedLogin(address);
  if (!row) return null;
  await deleteLinkedLogin(address);
  await deleteAccountWallet(row.userId);
  return { userId: row.userId };
}
