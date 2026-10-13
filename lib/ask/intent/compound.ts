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
import { stripPoliteFraming } from "../planFastPath";

/** Verbs that start a money-moving action of their own. */
const ACTION_VERB_RE = /^(?:please\s+|also\s+|and\s+)?(send|pay|transfer|swap|convert|exchange|trade|buy|sell|schedule|wrap|unwrap|supply|withdraw|stake|bridge|split|distribute|airdrop)\b/i;
/** "…and 20 USDC to bob" — an action whose verb carries over from the one before. */
const CARRIED_TRANSFER_RE = /^(?:\$\s*)?\d[\d,]*(?:\.\d+)?\s*[a-z$][a-z0-9$]*\s+to\s+\S+/i;
/** Verbs that schedule something for later. */
const SCHEDULE_RE = /\b(schedule|every|each|daily|weekly|monthly|recurring|tomorrow|next\s+(?:week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i;
/** One word that names a recipient: a 0x address, a .nad name or a plain name. */
const RECIPIENT_WORD_RE = /^(?:0x[0-9a-f]{40}|[a-z0-9][a-z0-9-]*\.nads?|[a-z][a-z0-9_-]{0,31})$/i;
/** A recipient that can't be mistaken for a word: a 0x address or a .nad name. */
const STRONG_RECIPIENT_RE = /^(?:0x[0-9a-f]{40}|[a-z0-9][a-z0-9-]*\.nads?)$/i;
/** What may follow a second recipient in "pay A and B 5 USDC each". */
const TRAILING_AMOUNT_RE = /^(?:\$\s*)?\d[\d,]*(?:\.\d+)?\s*[a-z$][a-z0-9$]*(?:\s+each)?$/i;
/** Words that look like a name but are about time, tokens or politeness. */
const NOT_A_RECIPIENT = new Set([
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "today", "tomorrow", "tonight", "now", "later", "soon", "weekly", "monthly", "daily",
  "mon", "usdc", "wmon", "please", "thanks", "thank", "it", "them", "that", "this", "me",
]);

/** Where one clause ends and the next begins. */
const CONNECTOR_RE = /\s*(?:;|&|,\s*and\s+then|,\s*and|,\s*then|,|\s+and\s+then|\s+and\s+also|\s+and|\s+then|\s+also|\s+plus)\s+/i;

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
  // "Can you swap … and send …?" is the same request without the framing; the
  // verbs below are anchored to the start of a clause, so strip it first.
  const t = stripPoliteFraming(text).replace(/[.!?]+$/, "");
  if (!t) return null;
  const parts = t.split(CONNECTOR_RE).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) {
    // No connector at all, but a send naming two addresses/.nad names back to
    // back ("send 5 USDC to alice.nad bob.nad") still names two recipients.
    if (!ACTION_VERB_RE.test(t)) return null;
    const strong = [...new Set(t.split(" ").map((w) => w.replace(/[,;]$/, "")).filter((w) => STRONG_RECIPIENT_RE.test(w)).map((w) => w.toLowerCase()))];
    return strong.length > 1 ? { actions: [t], extraRecipients: strong.slice(1), scheduled: SCHEDULE_RE.test(t) } : null;
  }

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
        && /(?:\bto|^(?:please\s+|also\s+)?pay|^(?:please\s+|also\s+)?(?:send|transfer)(?=\s+[^\d\s]))\s+\S+$/i.test(p);
      // "send 5 USDC to alice.nad bob.nad" — two recipients, no connector.
      const strong = p.split(" ").map((w) => w.replace(/[,;]$/, "")).filter((w) => STRONG_RECIPIENT_RE.test(w));
      for (const w of new Set(strong.map((x) => x.toLowerCase())).values()) {
        if (w !== strong[0].toLowerCase()) extraRecipients.push(w);
      }
      continue;
    }
    const word = p.replace(/^(?:to\s+)/i, "");
    // "pay alice.nad and bob.nad 5 USDC each" — the second recipient is
    // followed by the amount, so the clause is more than one word.
    if (lastWasRecipientAction) {
      const [first, ...rest] = word.split(" ");
      const tail = rest.join(" ");
      if (STRONG_RECIPIENT_RE.test(first) && (!tail || TRAILING_AMOUNT_RE.test(tail))) { extraRecipients.push(first); continue; }
      if (tail && TRAILING_AMOUNT_RE.test(tail) && RECIPIENT_WORD_RE.test(first) && !NOT_A_RECIPIENT.has(first.toLowerCase())) { extraRecipients.push(first); continue; }
    }
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
/** Words that stand in for a recipient without naming one. */
const PLACEHOLDER_WORDS = new Set([
  "a", "an", "the", "my", "another", "some", "any", "someone", "somebody", "anyone", "person", "friend",
  "address", "wallet", "account", "recipient", "payee", "one", "him", "her", "them", "us",
]);
const SWAP_THEN_SEND_RE = /^swap\s+(?:(\d[\d,]*(?:\.\d+)?)\s+)?([a-z][a-z0-9]{1,9})\s+(?:to|for|into)\s+([a-z][a-z0-9]{1,9})(?:\s*,)?\s+(?:and then|and|then)\s+send\s+(?:(?:it|the result|(?:the\s+)?[a-z][a-z0-9]{1,9}|(?:\d[\d,]*(?:\.\d+)?\s+)?[a-z][a-z0-9]{1,9}))?\s*(?:to\s+(.+))?$/i;

/**
 * "swap MON to USDC and send it to an address": a swap, then a transfer of
 * its result — which the plan path does — but with the amount and/or the
 * recipient left out. Ask for exactly what is missing and show how to write
 * the whole request, instead of refusing it. Null when nothing is missing.
 */
function swapThenSendGap(text: string): Understanding | null {
  const t = stripPoliteFraming(text).replace(/[.!]+$/, "");
  const m = SWAP_THEN_SEND_RE.exec(t);
  if (!m) return null;
  const amount = m[1];
  const from = m[2].toUpperCase();
  const to = m[3].toUpperCase();
  // The first word after "to" is the recipient; anything after it is a memo.
  const recipient = m[4]?.trim().split(" ")[0];
  const hasRecipient = !!recipient && RECIPIENT_WORD_RE.test(recipient)
    && !PLACEHOLDER_WORDS.has(recipient.toLowerCase()) && !NOT_A_RECIPIENT.has(recipient.toLowerCase());
  const missing: string[] = [];
  if (!amount) missing.push(`how much ${from} to swap`);
  if (!hasRecipient) missing.push("who should receive it (a 0x address, a .nad name or a saved payee)");
  if (missing.length === 0) return null;
  const example = `swap ${amount ?? "5"} ${from} to ${to} and send it to ${hasRecipient ? recipient : "alice.nad"}`;
  return {
    kind: "unsupported", outcome: "unsupported", capability: "compound_incomplete",
    reply: `Yes — PayAI can do that as one plan: swap ${from} to ${to}, then send the ${to} you receive. I just need ${missing.join(" and ")}. Write it in one message, for example "${example}". I'll show you the whole plan — both steps — to review before anything runs. Nothing was prepared yet.`,
  };
}

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

  const gap = swapThenSendGap(text);
  if (gap) return gap;

  return {
    kind: "unsupported", outcome: "unsupported", capability: "compound_request",
    reply: `That's ${shape.actions.length} actions in one request, but I couldn't read every one of them exactly. Write each action in full — an amount, a token (MON or USDC) and who it goes to — on its own line or separated by commas, for example "swap 1 USDC to MON, send 1 MON to bob.nad". Recipients can be 0x addresses, .nad names or saved payees. Nothing was prepared.`,
  };
}
