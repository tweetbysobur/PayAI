/**
 * Compound requests on Ask PayAI's single-intent path.
 *
 * Ask has two ways to understand a message. Several actions in one request
 * ("send 10 USDC to alice.nad, then swap 5 MON to USDC") are served by the
 * plan path (lib/ask/planTurn.ts → the Plan API's deterministic grammar),
 * which keeps every action, in order, under one review and one approval.
 * Everything else goes through the single-intent path (classify.ts), whose
 * Understanding holds exactly ONE operation.
 *
 * That single-intent path must never stand in for a compound request: it
 * would keep one action and silently drop the rest ("send 10 USDC to Alice,
 * then send 20 USDC to Bob" became a send to Alice only; "send 10 USDC to
 * alice.nad and schedule 5 USDC to bob.nad every Friday" became ONE weekly
 * payment of 10 USDC to alice.nad). So before it reads a message, this guard
 * looks for more than one action — or more than one recipient for one
 * action — and when it finds them, it says plainly what PayAI can and can't
 * do with that, and prepares nothing.
 *
 * Deliberately conservative in what it accepts as "one action": a false
 * positive costs the user one clarifying reply; a false negative costs them
 * an action they asked for and never got.
 *
 * Pure and deterministic: no I/O, no model.
 */
import type { Understanding } from "./types";

/** Verbs that start a money-moving action of their own. */
const ACTION_VERB_RE = /^(?:please\s+|also\s+|and\s+)?(send|pay|transfer|swap|convert|exchange|trade|buy|sell|schedule|wrap|unwrap|supply|withdraw|stake|bridge|split|distribute|airdrop)\b/i;
/** "…and 20 USDC to bob" — an action whose verb carries over from the one before. */
const CARRIED_TRANSFER_RE = /^(?:\$\s*)?\d[\d,]*(?:\.\d+)?\s*[a-z$][a-z0-9$]*\s+to\s+\S+/i;
/** Verbs that schedule something for later. */
const SCHEDULE_RE = /\b(schedule|every|each|daily|weekly|monthly|recurring|tomorrow|next\s+(?:week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i;
/** One word that names a recipient: a 0x address, a .nad name or a plain name. */
const RECIPIENT_WORD_RE = /^(?:0x[0-9a-f]{40}|[a-z0-9][a-z0-9-]*\.nads?|[a-z][a-z0-9_-]{0,31})$/i;
/** Words that look like a name but are about time, tokens or politeness. */
const NOT_A_RECIPIENT = new Set([
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "today", "tomorrow", "tonight", "now", "later", "soon", "weekly", "monthly", "daily",
  "mon", "usdc", "wmon", "please", "thanks", "thank", "it", "them", "that", "this", "me",
]);

/** Where one clause ends and the next begins. */
const CONNECTOR_RE = /\s*(?:;|,\s*and\s+then|,\s*and|,\s*then|,|\s+and\s+then|\s+and\s+also|\s+and|\s+then|\s+also|\s+plus)\s+/i;

export interface CompoundShape {
  /** Clauses that are an action of their own, in order. */
  actions: string[];
  /** Extra recipients joined to one action ("pay Alice and Bob"). */
  extraRecipients: string[];
  /** True when at least one action is scheduled or recurring. */
  scheduled: boolean;
}

/** The request's clauses, when it holds more than one action or more than
 *  one recipient for an action. Null for an ordinary single request. */
export function analyzeCompound(text: string): CompoundShape | null {
  if (typeof text !== "string") return null;
  const t = text.trim().replace(/\s+/g, " ").replace(/[.!?]+$/, "");
  if (!t) return null;
  const parts = t.split(CONNECTOR_RE).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;

  const actions: string[] = [];
  const extraRecipients: string[] = [];
  let lastWasRecipientAction = false;
  for (const p of parts) {
    if (ACTION_VERB_RE.test(p) || (actions.length > 0 && CARRIED_TRANSFER_RE.test(p))) {
      actions.push(p);
      // "pay alice" / "send 10 USDC to alice" — a clause that ENDS in its
      // recipient, so a bare name after it is a second one. ("…to bob.nad for
      // coffee and snacks" ends in its memo; "snacks" is not a recipient.)
      lastWasRecipientAction = (/^(?:please\s+|also\s+)?(send|pay|transfer)\b/i.test(p) || CARRIED_TRANSFER_RE.test(p))
        && /(?:\bto|^(?:please\s+|also\s+)?pay)\s+\S+$/i.test(p);
      continue;
    }
    const word = p.replace(/^(?:to\s+)/i, "");
    if (lastWasRecipientAction && RECIPIENT_WORD_RE.test(word) && !NOT_A_RECIPIENT.has(word.toLowerCase())) {
      extraRecipients.push(word);
      continue;
    }
    // Any other clause ("…and let me know") belongs to the one before it.
  }
  if (actions.length < 2 && extraRecipients.length === 0) return null;
  return { actions, extraRecipients, scheduled: actions.some((a) => SCHEDULE_RE.test(a)) };
}

/**
 * The single-intent path's answer to a compound request, or null when the
 * request is a single action. Always "unsupported" — never a partial
 * operation — so nothing can be prepared from it.
 */
export function detectCompoundRequest(text: string): Understanding | null {
  const shape = analyzeCompound(text);
  if (!shape) return null;

  if (shape.actions.length < 2) {
    // One action, several recipients, and no way to tell how much each gets.
    const names = [shape.actions[0]?.match(/\bto\s+(\S+)/i)?.[1] ?? shape.actions[0]?.split(" ").slice(-1)[0], ...shape.extraRecipients]
      .filter(Boolean);
    return {
      kind: "unsupported", outcome: "unsupported", capability: "multiple_recipients",
      reply: `That names more than one recipient (${names.join(", ")}). Tell me exactly what each one should get — for example "send 10 USDC to alice.nad and 10 USDC to bob.nad" — or use "split 20 USDC between alice.nad and bob.nad" to divide one amount. Nothing was prepared.`,
    };
  }

  if (shape.scheduled) {
    return {
      kind: "unsupported", outcome: "unsupported", capability: "compound_schedule",
      reply: `That's ${shape.actions.length} actions, and at least one is scheduled or recurring. Scheduled and recurring payments can't be combined with other actions in one request yet — send each one as its own message. Nothing was prepared.`,
    };
  }

  return {
    kind: "unsupported", outcome: "unsupported", capability: "compound_request",
    reply: `That's ${shape.actions.length} actions in one request. PayAI can plan several transfers and swaps together when each one is written out exactly — for example "send 10 USDC to alice.nad, then swap 5 MON to USDC" — with each recipient as a 0x address, a .nad name or a saved payee. Nothing was prepared.`,
  };
}
