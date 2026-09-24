/**
 * The wallet a Google / X / email sign-in already has.
 *
 * The passkey — not this row — is what can spend. The row only stops a second
 * sign-in from minting a second passkey when the first wallet is on another
 * device and this browser's silent probe finds nothing. Losing the row is
 * recoverable (the passkey still derives the same address). A wrong row is
 * recoverable too: unlocking the real passkey overwrites it.
 *
 * Server-only.
 */
import "server-only";
import { getRedis } from "./kv";

export interface AccountWalletLink {
  address: `0x${string}`;
  credentialId: string;
  linkedAt: number;
}

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,256}$/;

const g = globalThis as unknown as { __payaiAccountWallet?: Map<string, AccountWalletLink> };
const mem = (g.__payaiAccountWallet ??= new Map());

function storageKey(userId: string): string {
  return `payai:account-wallet:${userId}`;
}

export function isLinkableUserId(userId: string): boolean {
  return userId.length > 2 && userId.length <= 200 && !/[\r\n\0]/.test(userId) && userId.includes(":");
}

export function parseAccountWallet(value: unknown): AccountWalletLink | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<AccountWalletLink>;
  if (typeof row.address !== "string" || !ADDR_RE.test(row.address)) return null;
  if (typeof row.credentialId !== "string" || !ID_RE.test(row.credentialId)) return null;
  const linkedAt = Number(row.linkedAt);
  if (!Number.isFinite(linkedAt)) return null;
  return { address: row.address.toLowerCase() as `0x${string}`, credentialId: row.credentialId, linkedAt };
}

export async function getAccountWallet(userId: string): Promise<AccountWalletLink | null> {
  if (!isLinkableUserId(userId)) return null;
  const redis = await getRedis();
  const raw = redis ? await redis.get(storageKey(userId)) : mem.get(userId);
  if (!raw) return null;
  try {
    return parseAccountWallet(typeof raw === "string" ? JSON.parse(raw) : raw);
  } catch {
    return null;
  }
}

/** Overwrites on purpose. The caller just unlocked `address` with its
 *  passkey; keeping an older empty-wallet link would send them back there. */
export async function putAccountWallet(userId: string, input: { address: string; credentialId: string }): Promise<AccountWalletLink | null> {
  if (!isLinkableUserId(userId)) return null;
  const row = parseAccountWallet({ address: input.address, credentialId: input.credentialId, linkedAt: Date.now() });
  if (!row) return null;
  const redis = await getRedis();
  if (redis) await redis.set(storageKey(userId), JSON.stringify(row));
  else mem.set(userId, row);
  return row;
}

export async function deleteAccountWallet(userId: string): Promise<void> {
  if (!isLinkableUserId(userId)) return;
  const redis = await getRedis();
  if (redis) await redis.del(storageKey(userId));
  else mem.delete(userId);
}
