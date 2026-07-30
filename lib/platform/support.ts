/**
 * Support Center ticket storage.
 *
 * Same seam as automationEvents.ts: KV list (LPUSH/LTRIM/LRANGE) when
 * configured, in-memory fallback for local dev. Deliberately does NOT send an
 * email or push a notification anywhere — PayAI has no email/support
 * infrastructure wired up yet, and this module must never *claim* to. A
 * ticket is durably recorded and given a reference id; reaching a human today
 * means the user (or the team, reading listTickets) actually looks at it.
 * Wiring a real notification later only touches notifyExternal below.
 *
 * Server-only.
 */
import "server-only";
import { getRedis } from "./kv";
import type { SupportCategory, SupportTicket } from "./types";

const MAX_TICKETS = 500;
const key = (m: string) => `veripay:${m}:support-tickets`;

const g = globalThis as unknown as { __payaiSupportTickets?: Map<string, SupportTicket[]> };
const mem = (g.__payaiSupportTickets ??= new Map());

/** Seam for a real notification (email/Slack/webhook) once one exists.
 *  No-op today — see the file-level doc comment for why that's honest. */
async function notifyExternal(_ticket: SupportTicket): Promise<void> {
  // Intentionally empty.
}

export async function createTicket(input: {
  merchantId: string;
  sender?: string | null;
  category: SupportCategory;
  description: string;
  automationId?: string | null;
  txHash?: string | null;
}): Promise<SupportTicket> {
  const ticket: SupportTicket = {
    id: `tkt_${crypto.randomUUID().slice(0, 8)}`,
    merchantId: input.merchantId,
    sender: input.sender ?? null,
    category: input.category,
    description: input.description,
    automationId: input.automationId ?? null,
    txHash: input.txHash ?? null,
    status: "open",
    createdAt: Date.now(),
  };
  const r = await getRedis();
  if (r) {
    await r.lpush(key(input.merchantId), ticket);
    await r.ltrim(key(input.merchantId), 0, MAX_TICKETS - 1);
  } else {
    const list = mem.get(input.merchantId) ?? [];
    list.unshift(ticket);
    if (list.length > MAX_TICKETS) list.length = MAX_TICKETS;
    mem.set(input.merchantId, list);
  }
  await notifyExternal(ticket);
  return ticket;
}

export async function listTickets(
  merchantId: string,
  opts?: { sender?: string | null; limit?: number },
): Promise<SupportTicket[]> {
  const r = await getRedis();
  const all = r
    ? ((await r.lrange(key(merchantId), 0, MAX_TICKETS - 1)) as SupportTicket[])
    : (mem.get(merchantId) ?? []);
  const sender = opts?.sender?.trim().toLowerCase();
  const scoped = sender ? all.filter((t: SupportTicket) => (t.sender ?? "").toLowerCase() === sender) : all;
  return scoped.slice(0, opts?.limit ?? MAX_TICKETS);
}
