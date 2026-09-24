/**
 * Which Google account opens a passkey wallet, looked up by address.
 *
 * The other direction (Google account → wallet) lives in accountWallet.ts
 * and is what blocks a second passkey at sign-in. This direction is what
 * Settings shows, and what stops a second Gmail account being attached to
 * a wallet that already has one.
 *
 * Server-only. The email here is private — do not return it without a
 * session or a wallet grant.
 */
import "server-only";
import { getRedis } from "./kv";

export interface LinkedLogin {
  userId: string;
  method: "google";
  label: string;
  address: `0x${string}`;
  credentialId: string;
  linkedAt: number;
}

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,256}$/;

const g = globalThis as unknown as { __payaiLinkedLogin?: Map<string, LinkedLogin> };
const mem = (g.__payaiLinkedLogin ??= new Map());

function storageKey(address: string): string {
  return `payai:wallet-login:${address.toLowerCase()}`;
}

export function parseLinkedLogin(value: unknown): LinkedLogin | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<LinkedLogin>;
  if (typeof row.userId !== "string" || !row.userId.startsWith("google:") || row.userId.length > 200) return null;
  if (row.method !== "google") return null;
  if (typeof row.label !== "string" || !row.label || row.label.length > 320) return null;
  if (typeof row.address !== "string" || !ADDR_RE.test(row.address)) return null;
  if (typeof row.credentialId !== "string" || !ID_RE.test(row.credentialId)) return null;
  const linkedAt = Number(row.linkedAt);
  if (!Number.isFinite(linkedAt)) return null;
  return {
    userId: row.userId,
    method: "google",
    label: row.label,
    address: row.address.toLowerCase() as `0x${string}`,
    credentialId: row.credentialId,
    linkedAt,
  };
}

export async function getLinkedLogin(address: string): Promise<LinkedLogin | null> {
  if (!ADDR_RE.test(address)) return null;
  const redis = await getRedis();
  const raw = redis ? await redis.get(storageKey(address)) : mem.get(address.toLowerCase());
  if (!raw) return null;
  try {
    return parseLinkedLogin(typeof raw === "string" ? JSON.parse(raw) : raw);
  } catch {
    return null;
  }
}

export async function putLinkedLogin(input: Omit<LinkedLogin, "linkedAt" | "address" | "method"> & { address: string }): Promise<LinkedLogin | null> {
  const row = parseLinkedLogin({ ...input, method: "google", linkedAt: Date.now() });
  if (!row) return null;
  const redis = await getRedis();
  if (redis) await redis.set(storageKey(row.address), JSON.stringify(row));
  else mem.set(row.address, row);
  return row;
}

export async function deleteLinkedLogin(address: string): Promise<void> {
  if (!ADDR_RE.test(address)) return;
  const redis = await getRedis();
  if (redis) await redis.del(storageKey(address));
  else mem.delete(address.toLowerCase());
}
