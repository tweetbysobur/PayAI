/**
 * Platform data store — per-merchant transaction log + payment links.
 *
 * All data is namespaced by merchant id (`veripay:{merchantId}:…`) so tenants
 * are isolated. KV-backed (shared client) with in-memory fallback for local dev.
 * The async API is the seam; backend choice is invisible to callers.
 *
 * Server-only.
 */
import "server-only";
import { getRedis } from "./kv";
import type { PaymentLink, TxLogEntry } from "./types";

const MAX_TX = 500;
const txKey = (m: string) => `veripay:${m}:txlog`;
const linkKey = (m: string) => `veripay:${m}:links`;

// In-memory fallback, namespaced per merchant (survives dev HMR).
const g = globalThis as unknown as { __veripayMem?: Map<string, { txLog: TxLogEntry[]; links: PaymentLink[] }> };
const mem = (g.__veripayMem ??= new Map());
function memOf(m: string) {
  let s = mem.get(m);
  if (!s) mem.set(m, (s = { txLog: [], links: [] }));
  return s;
}

/* ── Transaction log ────────────────────────────────────────────────────── */

export async function recordTx(merchantId: string, entry: Omit<TxLogEntry, "id" | "at">): Promise<TxLogEntry> {
  const row: TxLogEntry = { id: `tx_${crypto.randomUUID()}`, at: Date.now(), ...entry };
  const r = await getRedis();
  if (r) {
    await r.lpush(txKey(merchantId), row);
    await r.ltrim(txKey(merchantId), 0, MAX_TX - 1);
  } else {
    const s = memOf(merchantId);
    s.txLog.unshift(row);
    if (s.txLog.length > MAX_TX) s.txLog.length = MAX_TX;
  }
  return row;
}

export async function listTx(merchantId: string, opts?: { sender?: string | null }): Promise<TxLogEntry[]> {
  const r = await getRedis();
  const all = r ? ((await r.lrange(txKey(merchantId), 0, MAX_TX - 1)) as TxLogEntry[]) : memOf(merchantId).txLog;
  // When a wallet is given, return ONLY that wallet's own entries — this is how a
  // connected user's dashboard stays private even though wallet-only users share
  // the demo tenant's store. No wallet → full tenant view (merchant accounts).
  const sender = opts?.sender?.trim().toLowerCase();
  if (!sender) return all;
  return all.filter((t: TxLogEntry) => (t.sender ?? "").toLowerCase() === sender);
}

/* ── Payment links ──────────────────────────────────────────────────────── */

function baseUrl(): string {
  return process.env.VERIPAYAI_PUBLIC_URL || "https://veripayai.vercel.app";
}

export async function createLink(
  merchantId: string,
  input: { amount: number; token?: string; memo?: string; expiresInDays?: number | null; recipient?: string },
): Promise<PaymentLink> {
  const id = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const now = Date.now();
  const link: PaymentLink = {
    id,
    merchantId,
    url: `${baseUrl()}/pay/${id}`,
    amount: input.amount,
    token: input.token || "USDC",
    recipient: input.recipient,
    memo: input.memo,
    status: "active",
    createdAt: now,
    expiresAt: input.expiresInDays ? now + input.expiresInDays * 86_400_000 : null,
  };
  const r = await getRedis();
  if (r) {
    await r.hset(linkKey(merchantId), { [id]: link });
    await r.set(`veripay:link:${id}`, link); // global mirror for /pay/{id} checkout
  } else {
    memOf(merchantId).links.unshift(link);
  }
  return link;
}

/** List a merchant's links, lazily flipping expired ones (newest first). */
export async function listLinks(merchantId: string): Promise<PaymentLink[]> {
  const r = await getRedis();
  let links: PaymentLink[];
  if (r) {
    const h = (await r.hgetall(linkKey(merchantId))) ?? {};
    links = (Object.values(h) as PaymentLink[]).sort((a, b) => b.createdAt - a.createdAt);
  } else {
    links = memOf(merchantId).links;
  }
  const now = Date.now();
  for (const l of links) {
    if (l.status === "active" && l.expiresAt && l.expiresAt < now) {
      l.status = "expired";
      if (r) await r.hset(linkKey(merchantId), { [l.id]: l });
    }
  }
  return links;
}

/** Look up a link by id across all tenants (checkout page has no tenant context). */
export async function getLinkGlobal(id: string): Promise<PaymentLink | undefined> {
  const r = await getRedis();
  if (r) {
    // Links live in per-merchant hashes; without a tenant we can't target one.
    // Store a global id→link mirror for public checkout lookups.
    const mirror = (await r.get(`veripay:link:${id}`)) as PaymentLink | null;
    return mirror ?? undefined;
  }
  for (const s of mem.values()) {
    const l = s.links.find((x: PaymentLink) => x.id === id);
    if (l) return l;
  }
  return undefined;
}

/** Mark a link paid after the caller has independently verified the on-chain transfer. */
export async function markLinkPaid(id: string, txHash: string): Promise<PaymentLink | undefined> {
  const link = await getLinkGlobal(id);
  if (!link || link.status === "paid") return link;
  link.status = "paid";
  link.paidAt = Date.now();
  link.txHash = txHash;
  const r = await getRedis();
  if (r) {
    await r.hset(linkKey(link.merchantId), { [id]: link });
    await r.set(`veripay:link:${id}`, link);
  } else {
    const s = memOf(link.merchantId);
    const i = s.links.findIndex((x: PaymentLink) => x.id === id);
    if (i >= 0) s.links[i] = link;
  }
  return link;
}
