/**
 * Payment Automation lifecycle notifications — reusable across every future
 * automation engine (recurring payments today; payroll, subscriptions,
 * treasury, savings, installments, business payouts, merchant payments later).
 *
 * Deliberately separate from the payment tx log (lib/platform/store.ts):
 * that log's `decision` field feeds revenue/analytics aggregation, and mixing
 * lifecycle noise ("created", "paused", "resumed") into it would corrupt that
 * math. This module is a pure notification stream — nothing here is read by
 * analytics, so any future automation kind can write to it freely.
 *
 * Same storage seam as everywhere else: KV list when configured (LPUSH/LTRIM/
 * LRANGE), in-memory fallback for local dev.
 *
 * Server-only.
 */
import "server-only";
import { getRedis } from "./kv";
import type { AutomationEvent, AutomationEventType } from "./types";

const MAX_EVENTS = 300;
const key = (m: string) => `veripay:${m}:automation-events`;

const g = globalThis as unknown as { __veripaySchedules?: Map<string, unknown> };
const memList = (g as unknown as { __payaiAutomationEvents?: Map<string, AutomationEvent[]> });
const mem = (memList.__payaiAutomationEvents ??= new Map());

/**
 * The seam for a future notification channel (email, push, webhook). No-op
 * today by design — PayAI has no email/push infrastructure yet, and this
 * module should never *claim* to send one. Wiring a real provider here later
 * requires touching only this one function.
 */
async function notifyExternal(_event: AutomationEvent): Promise<void> {
  // Intentionally empty — see doc comment above.
}

export async function recordAutomationEvent(input: {
  merchantId: string;
  automationId: string;
  kind?: string;
  sender?: string | null;
  type: AutomationEventType;
  title: string;
  detail: string;
  amount?: number | null;
  token?: string | null;
  txHash?: string;
  explorerUrl?: string;
}): Promise<AutomationEvent> {
  const event: AutomationEvent = {
    id: `evt_${crypto.randomUUID()}`,
    automationId: input.automationId,
    kind: input.kind ?? "recurring_payment",
    merchantId: input.merchantId,
    sender: input.sender ?? null,
    type: input.type,
    at: Date.now(),
    title: input.title,
    detail: input.detail,
    amount: input.amount ?? null,
    token: input.token ?? null,
    txHash: input.txHash,
    explorerUrl: input.explorerUrl,
  };
  const r = await getRedis();
  if (r) {
    await r.lpush(key(input.merchantId), event);
    await r.ltrim(key(input.merchantId), 0, MAX_EVENTS - 1);
  } else {
    const list = mem.get(input.merchantId) ?? [];
    list.unshift(event);
    if (list.length > MAX_EVENTS) list.length = MAX_EVENTS;
    mem.set(input.merchantId, list);
  }
  await notifyExternal(event);
  return event;
}

export async function listAutomationEvents(
  merchantId: string,
  opts?: { sender?: string | null; limit?: number },
): Promise<AutomationEvent[]> {
  const r = await getRedis();
  const all = r
    ? ((await r.lrange(key(merchantId), 0, MAX_EVENTS - 1)) as AutomationEvent[])
    : (mem.get(merchantId) ?? []);
  const sender = opts?.sender?.trim().toLowerCase();
  const scoped = sender ? all.filter((e: AutomationEvent) => (e.sender ?? "").toLowerCase() === sender) : all;
  return scoped.slice(0, opts?.limit ?? MAX_EVENTS);
}
