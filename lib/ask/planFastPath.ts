/**
 * Ask PayAI's fast path to a plan.
 *
 * Some requests are exact enough to need no model at all:
 *
 *   send 0.1 MON to 0x…                    → one transfer
 *   swap 5 USDC to MON                     → one swap
 *   swap 5 USDC to MON and send it to bob  → a swap, then a transfer of its output
 *   send 1 MON to a and 2 MON to b, then swap 5 USDC to MON → three actions, in order
 *
 * For those, Ask skips the semantic layer and asks the Plan API to build the
 * plan directly (POST /api/plans {text}) — one round trip, no LLM. The
 * server's deterministic adapter (lib/plan-adapter) is the authority: it
 * accepts only these exact shapes, with nothing left over, and refuses
 * anything else. This module is only a cheap browser-side HINT that a message
 * is worth trying on that path; when the server refuses, Ask falls back to
 * its normal understanding path as if this never ran.
 *
 * Pure; no imports.
 */

export type PlanRequestKind = "transfer" | "swap" | "swap_send" | "multi";

const AMOUNT = String.raw`(?:0|[1-9][0-9]{0,30})(?:\.[0-9]+)?`;
const SYMBOL = String.raw`[a-z][a-z0-9]{1,9}`;
const RECIPIENT = String.raw`(?:0x[0-9a-f]{40}|[a-z0-9][a-z0-9-]*\.nads?|[a-z][a-z0-9_-]{0,31})`;

const TRANSFER_C = new RegExp(String.raw`^(?:send|pay) ${AMOUNT} ${SYMBOL} to ${RECIPIENT}$`, "i");
const NEXT_TRANSFER_C = new RegExp(String.raw`^${AMOUNT} ${SYMBOL} to ${RECIPIENT}$`, "i");
const SWAP_C = new RegExp(String.raw`^swap ${AMOUNT} ${SYMBOL} (?:to|for|into) ${SYMBOL}$`, "i");
const BOUND_SEND_C = new RegExp(String.raw`^send (?:it|the result|the ${SYMBOL}) to ${RECIPIENT}$`, "i");

/** Mirrors the server grammar's connectors (lib/plan-adapter/grammar.ts). */
const CONNECTOR = /\s*(?:,\s*and\s+then|,\s*and|,\s*then|,|\s+and\s+then|\s+and|\s+then)\s+/i;
/** The Intent IR's own resource bounds (lib/plan/types.ts — mirrored, this
 *  module is import-free). Not a product limit. */
const MAX_ACTIONS = 500;
export const MAX_PLAN_TEXT = 40_000;

type Clause = "transfer" | "next_transfer" | "swap" | "bound_send";

function clauseKind(c: string): Clause | null {
  if (BOUND_SEND_C.test(c)) return "bound_send";
  if (TRANSFER_C.test(c)) return "transfer";
  if (SWAP_C.test(c)) return "swap";
  if (NEXT_TRANSFER_C.test(c)) return "next_transfer";
  return null;
}

/** Which plan shape a message looks like, or null. Whitespace runs collapse,
 *  like the server grammar's. */
export function matchPlanRequest(text: string): PlanRequestKind | null {
  return analyzePlanRequest(text)?.kind ?? null;
}

/** The shape and number of actions of a message, or null when it isn't one
 *  the deterministic grammar could accept. */
export function analyzePlanRequest(text: string): { kind: PlanRequestKind; actions: number } | null {
  if (typeof text !== "string") return null;
  let t = text.trim().replace(/\s+/g, " ");
  if (t.length === 0 || t.length > MAX_PLAN_TEXT) return null;
  if (t.endsWith(".") || t.endsWith("!")) t = t.slice(0, -1);
  const parts = t.split(CONNECTOR);
  if (parts.length > MAX_ACTIONS || parts.some((p) => p.length === 0)) return null;
  const kinds: Clause[] = [];
  for (const p of parts) {
    const k = clauseKind(p);
    if (!k) return null;
    const prev = kinds[kinds.length - 1];
    if (k === "bound_send" && prev !== "swap") return null;
    if (k === "next_transfer" && prev !== "transfer" && prev !== "next_transfer") return null;
    kinds.push(k);
  }
  if (kinds.length === 1) return kinds[0] === "transfer" ? { kind: "transfer", actions: 1 } : kinds[0] === "swap" ? { kind: "swap", actions: 1 } : null;
  if (kinds.length === 2 && kinds[0] === "swap" && kinds[1] === "bound_send") return { kind: "swap_send", actions: 2 };
  return { kind: "multi", actions: kinds.length };
}

/** The instant "working on it" line while the plan is being built. */
export const PLAN_THINKING_LABEL: Readonly<Record<PlanRequestKind, string>> = {
  transfer: "Preparing your transfer",
  swap: "Preparing your swap",
  swap_send: "Preparing your swap and transfer",
  multi: "Preparing your actions",
};

/** The one line above the review card — the card itself carries the detail. */
export const PLAN_FOUND_TEXT: Readonly<Record<PlanRequestKind, string>> = {
  transfer: "Here's your transfer.",
  swap: "Here's your swap.",
  swap_send: "Here's your swap, then the transfer.",
  multi: "Here are your actions, in order.",
};

/** PLAN_FOUND_TEXT, with the count the SERVER's plan has (never the hint's). */
export function planFoundText(kind: PlanRequestKind, actions: number): string {
  return kind === "multi" ? `Here are your ${actions} actions, in order.` : PLAN_FOUND_TEXT[kind];
}
