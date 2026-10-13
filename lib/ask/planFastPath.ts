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

/** Conversational framing around a request ("can you … ?", "please …", ", please"). */
const POLITE_LEAD_RE = /^(?:(?:hey|hi|hello|ok|okay|so)[,!]?\s+)?(?:(?:can|could|would|will) you(?: please)?|please|pls|i(?:'d| would) like (?:you )?to|i want to|i need to|let's|lets)[,]?\s+/i;
const POLITE_TAIL_RE = /[,]?\s*(?:please|pls|thanks|thank you)\s*$/i;

/** The request with its polite framing removed: "Can you swap 5 MON to USDC
 *  and send it to bob.nad?" → "swap 5 MON to USDC and send it to bob.nad".
 *  Only framing words and trailing "?"s are dropped — never an amount, token
 *  or recipient — and the server's grammar still decides whether what is left
 *  is a plan. Whitespace runs collapse. */
export function stripPoliteFraming(text: string): string {
  if (typeof text !== "string") return text;
  let t = text.trim().replace(/\s+/g, " ");
  t = t.replace(/\?+$/, "").trim().replace(POLITE_TAIL_RE, "").trim();
  t = t.replace(POLITE_LEAD_RE, "").trim();
  return t;
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

/* ── "…5 USDC each to alice.nad and bob.nad" ─────────────────────────────── */

const LIST = String.raw`(.+?)`;
const EACH_RES = [
  new RegExp(String.raw`^(?:send|pay) (${AMOUNT}) (${SYMBOL}) each to ${LIST}$`, "i"),
  new RegExp(String.raw`^(?:send|pay) (${AMOUNT}) (${SYMBOL}) to ${LIST} each$`, "i"),
  new RegExp(String.raw`^(?:send|pay) (${AMOUNT}) (${SYMBOL}) to each of ${LIST}$`, "i"),
  new RegExp(String.raw`^(?:send|pay) ${LIST} (${AMOUNT}) (${SYMBOL}) each$`, "i"),
];
/** Which capture groups hold [amount, symbol, list] for each pattern above. */
const EACH_GROUPS: [number, number, number][] = [[1, 2, 3], [1, 2, 3], [1, 2, 3], [2, 3, 1]];
const LIST_SPLIT = /\s*(?:,\s*and|,|\s+and|\s*&)\s+/i;
const FULL_RECIPIENT = new RegExp(`^${RECIPIENT}$`, "i");
const NOT_RECIPIENTS = new Set(["it", "me", "myself", "all", "the", "each", "everyone", "them", "us", "rest"]);

/**
 * "send 5 USDC each to alice.nad and bob.nad" → the written-out form the Plan
 * API's grammar accepts: "send 5 USDC to alice.nad, 5 USDC to bob.nad".
 *
 * Only when the request says "each" (so the amount is plainly per recipient —
 * without it the amount could be a total or a share, and nothing is guessed),
 * names at least two different recipients that each look like one, and has
 * nothing left over. Anything else returns null and is handled as before. The
 * server still parses, resolves and validates every transfer, and the user
 * reviews each one before approving.
 */
export function expandEachRequest(text: string): string | null {
  if (typeof text !== "string") return null;
  let t = text.trim().replace(/\s+/g, " ");
  if (t.endsWith(".") || t.endsWith("!")) t = t.slice(0, -1);
  if (!/\beach\b/i.test(t)) return null;
  for (let i = 0; i < EACH_RES.length; i++) {
    const m = EACH_RES[i].exec(t);
    if (!m) continue;
    const [ia, is, il] = EACH_GROUPS[i];
    const recipients = m[il].split(LIST_SPLIT).map((r) => r.trim());
    if (recipients.length < 2 || recipients.length > MAX_ACTIONS) return null;
    if (!recipients.every((r) => FULL_RECIPIENT.test(r) && !NOT_RECIPIENTS.has(r.toLowerCase()))) return null;
    if (new Set(recipients.map((r) => r.toLowerCase())).size !== recipients.length) return null;
    return `send ${m[ia]} ${m[is]} to ${recipients.join(`, ${m[ia]} ${m[is]} to `)}`;
  }
  return null;
}

/** What Ask sends the Plan API for a message: its polite framing removed and an
 *  explicit "each" written out per recipient. Never changes an amount, token
 *  or recipient. */
export function toPlanText(text: string): string {
  const stripped = stripPoliteFraming(text);
  return expandEachRequest(stripped) ?? reorderRecipientFirst(stripped) ?? stripped;
}

/** A recipient that is unmistakably one: a 0x address or a .nad name. */
const STRICT_RECIPIENT = String.raw`(?:0x[0-9a-f]{40}|[a-z0-9][a-z0-9-]*\.nads?)`;
const RECIPIENT_FIRST_LEAD = new RegExp(String.raw`^(?:send|pay) (${STRICT_RECIPIENT}) (${AMOUNT}) (${SYMBOL})$`, "i");
const RECIPIENT_FIRST_NEXT = new RegExp(String.raw`^(?:(?:send|pay) )?(${STRICT_RECIPIENT}) (${AMOUNT}) (${SYMBOL})$`, "i");

/**
 * "pay alice.nad 1 MON and bob.nad 2 MON" → "send 1 MON to alice.nad, 2 MON
 * to bob.nad" — the same transfers with the recipient moved after the amount,
 * which is the order the Plan API's grammar reads. Only when there are at
 * least two transfers, every one names a 0x address or a .nad name (never a
 * bare word) followed by an amount and a token, and nothing is left over.
 * Never changes an amount, token or recipient; anything else returns null.
 */
export function reorderRecipientFirst(text: string): string | null {
  if (typeof text !== "string") return null;
  let t = text.trim().replace(/\s+/g, " ");
  if (t.endsWith(".") || t.endsWith("!")) t = t.slice(0, -1);
  const parts = t.split(CONNECTOR);
  if (parts.length < 2 || parts.length > MAX_ACTIONS) return null;
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const m = (i === 0 ? RECIPIENT_FIRST_LEAD : RECIPIENT_FIRST_NEXT).exec(parts[i]);
    if (!m) return null;
    out.push(`${m[2]} ${m[3]} to ${m[1]}`);
  }
  return `send ${out.join(", ")}`;
}
