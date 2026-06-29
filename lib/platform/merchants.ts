/**
 * Merchant accounts — the tenancy root.
 *
 * Each merchant has an id (tenant key) and a secret apiKey. All platform data
 * (transaction log, links, analytics, customers) is namespaced by merchant id
 * so tenants are isolated. KV-backed with in-memory fallback.
 *
 * Server-only.
 */
import "server-only";
import { getRedis } from "./kv";

export interface Merchant {
  id: string;
  name: string;
  apiKey: string;
  wallet?: string;
  createdAt: number;
}

const MERCHANTS_KEY = "veripay:merchants"; // hash id -> Merchant
const APIKEYS_KEY = "veripay:apikeys"; // hash apiKey -> id

const g = globalThis as unknown as { __veripayMerchants?: Map<string, Merchant> };
const mem = (g.__veripayMerchants ??= new Map());

/** Stable default tenant so the public demo works with no signup. */
export const DEMO_TENANT = "demo";

function rand(n: number): string {
  const a = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < n; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
}
function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "merchant";
}

export async function createMerchant(name: string, wallet?: string): Promise<Merchant> {
  const id = `${slug(name)}-${rand(5)}`;
  const merchant: Merchant = { id, name: name.trim().slice(0, 60), apiKey: `vpk_${rand(32)}`, wallet, createdAt: Date.now() };
  const r = await getRedis();
  if (r) {
    await r.hset(MERCHANTS_KEY, { [id]: merchant });
    await r.hset(APIKEYS_KEY, { [merchant.apiKey]: id });
  } else {
    mem.set(id, merchant);
  }
  return merchant;
}

export async function getMerchantById(id: string): Promise<Merchant | null> {
  const r = await getRedis();
  if (r) return ((await r.hget(MERCHANTS_KEY, id)) as Merchant | null) ?? null;
  return mem.get(id) ?? null;
}

/** Every registered merchant id — used to aggregate platform-wide activity across all tenants. */
export async function listAllMerchantIds(): Promise<string[]> {
  const r = await getRedis();
  if (r) {
    const h = (await r.hgetall(MERCHANTS_KEY)) ?? {};
    return Object.keys(h);
  }
  return [...mem.keys()];
}

export async function getMerchantByApiKey(apiKey: string): Promise<Merchant | null> {
  const r = await getRedis();
  if (r) {
    const id = (await r.hget(APIKEYS_KEY, apiKey)) as string | null;
    return id ? getMerchantById(id) : null;
  }
  for (const m of mem.values()) if (m.apiKey === apiKey) return m;
  return null;
}

export async function setMerchantWallet(id: string, wallet: string): Promise<Merchant | null> {
  const m = await getMerchantById(id);
  if (!m) return null;
  m.wallet = wallet;
  const r = await getRedis();
  if (r) await r.hset(MERCHANTS_KEY, { [id]: m });
  else mem.set(id, m);
  return m;
}

/** Public view (never leak the apiKey). */
export function publicMerchant(m: Merchant): { id: string; name: string; wallet?: string; createdAt: number } {
  return { id: m.id, name: m.name, wallet: m.wallet, createdAt: m.createdAt };
}
