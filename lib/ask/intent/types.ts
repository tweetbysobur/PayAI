/**
 * Ask PayAI — general semantic intent contract.
 *
 * This replaces per-message keyword/template matching with a single,
 * expandable "Understanding" shape produced by the semantic layer (see
 * classify.ts). The UI never decides what the user meant — it only renders
 * whatever this module hands it, and only ever advances a real operation on
 * an explicit click. Adding a future capability (e.g. `trading`) means
 * adding one entry to `ASK_INTENT_KINDS` and one branch in orchestrate.ts —
 * nothing in the UI has to change.
 */

export const ASK_INTENT_KINDS = [
  "send_payment",
  "swap",
  "schedule_payment",
  "recurring_payment",
  "check_balance",
  "transaction_history",
  "automation_management",
  "distribution",
] as const;

export type AskIntentKind = (typeof ASK_INTENT_KINDS)[number];

/**
 * Every slot any supported intent might need, all optional. A given kind
 * only ever reads the handful of fields relevant to it — see REQUIRED_SLOTS
 * in classify.ts for exactly which. Nothing here is ever filled by
 * assumption; a slot is either literally present in what the user said
 * (across the whole conversation) or it stays null and gets asked about.
 */
export interface AskSlots {
  amount?: string | null;
  asset?: string | null;
  recipient?: string | null;
  /** Natural description of a one-time future date ("next Friday", "2026-07-01", "tomorrow"). */
  when?: string | null;
  frequency?: "daily" | "weekly" | "monthly" | null;
  fromAsset?: string | null;
  toAsset?: string | null;
  recipientCount?: number | null;
}

/**
 * The single shape the semantic layer returns for every message.
 *
 *  - "actionable" kinds carry slots + whether every required slot is filled.
 *    Incomplete → `question` is the next thing to ask, in plain language.
 *    Complete   → ready to hand to the real backend for that capability.
 *  - "unsupported" is a real capability gap (e.g. staking) — understood, not
 *    reinterpreted as something PayAI does support.
 *  - "unclear" means the goal itself couldn't be identified at all.
 *  - "chat" is ordinary conversation — a greeting, a question about PayAI —
 *    with no operation implied.
 */
export type Understanding =
  | { kind: AskIntentKind; outcome: "incomplete"; slots: AskSlots; question: string }
  | { kind: AskIntentKind; outcome: "complete"; slots: AskSlots }
  | { kind: "unsupported"; outcome: "unsupported"; capability: string; reply: string }
  | { kind: "unclear"; outcome: "unclear"; reply: string }
  | { kind: "chat"; outcome: "chat"; reply: string };

export function isActionable(u: Understanding): u is Extract<Understanding, { outcome: "incomplete" | "complete" }> {
  return u.outcome === "incomplete" || u.outcome === "complete";
}
