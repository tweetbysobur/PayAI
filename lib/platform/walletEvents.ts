/**
 * Wallet-level notifications — wallet created, connected, disconnected,
 * deposits, withdrawals. Sibling to automationEvents.ts, which is scoped to
 * a specific automationId; these aren't (a wallet connect/disconnect has no
 * automation behind it), so this is its own small store on the same KV-list
 * pattern (LPUSH/LTRIM/LRANGE, in-memory fallback for local dev).
 *
 * Server-only.
 */
import "server-only";
import { getRedis } from "./kv";
import type { WalletNotification, WalletEventType, WalletProviderId } from "@/lib/wallet-service/types";

const MAX_EVENTS = 200;
const key = (merchantId: string, sender: string) => `payai:${merchantId}:wallet-events:${sender.toLowerCase()}`;

const g = globalThis as unknown as { __payaiWalletEvents?: Map<string, WalletNotification[]> };
const mem = (g.__payaiWalletEvents ??= new Map());

export async function recordWalletEvent(input: {
  merchantId: string;
  sender: string;
  type: WalletEventType;
  providerId: WalletProviderId;
  title: string;
  detail: string;
  amount?: number | null;
  token?: string | null;
  txHash?: string;
  explorerUrl?: string;
}): Promise<WalletNotification> {
  const event: WalletNotification = {
    id: `wevt_${crypto.randomUUID()}`,
    merchantId: input.merchantId,
    sender: input.sender.toLowerCase(),
    type: input.type,
    providerId: input.providerId,
    at: Date.now(),
    title: input.title,
    detail: input.detail,
    amount: input.amount ?? null,
    token: input.token ?? null,
    txHash: input.txHash,
    explorerUrl: input.explorerUrl,
  };
  const k = key(input.merchantId, input.sender);
  const r = await getRedis();
  if (r) {
    await r.lpush(k, event);
    await r.ltrim(k, 0, MAX_EVENTS - 1);
  } else {
    const list = mem.get(k) ?? [];
    list.unshift(event);
    if (list.length > MAX_EVENTS) list.length = MAX_EVENTS;
    mem.set(k, list);
  }
  return event;
}

export async function listWalletEvents(merchantId: string, sender: string, limit = MAX_EVENTS): Promise<WalletNotification[]> {
  const k = key(merchantId, sender);
  const r = await getRedis();
  const all = r ? ((await r.lrange(k, 0, MAX_EVENTS - 1)) as WalletNotification[]) : (mem.get(k) ?? []);
  return all.slice(0, limit);
}

/** Rewrites a wallet's feed — newest first, as listWalletEvents returns it.
 *  Only for the reconciler's one-time clean-up, which holds the wallet's scan
 *  lock so nothing is recorded in between. */
export async function replaceWalletEvents(merchantId: string, sender: string, events: WalletNotification[]): Promise<void> {
  const k = key(merchantId, sender);
  const r = await getRedis();
  if (r) {
    await r.del(k);
    for (let i = events.length - 1; i >= 0; i--) await r.lpush(k, events[i]);
  } else {
    mem.set(k, [...events]);
  }
}
