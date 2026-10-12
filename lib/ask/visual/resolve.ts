/**
 * Visual intent input — turns what was read from an image (a decoded QR
 * payload and/or the vision model's structured reading) plus the user's
 * optional caption into ONE of:
 *
 *   intent    a plain request sentence ("Send 25 USDC to alice.nad") that the
 *             client hands to the normal Ask turn — the same plan grammar,
 *             validation, review card and wallet approval as typed text;
 *   clarify   something essential is missing (or nothing payable was found):
 *             say what was found and ask for the rest;
 *   conflict  the image and the caption disagree on a critical detail: ask,
 *             never pick one;
 *   blocked   the content can't be used (invalid recipient, unsupported QR,
 *             instructions aimed at PayAI inside the image).
 *
 * Only validated, structured fields reach the sentence — never free text
 * copied out of the image — so wording inside an image can't smuggle extra
 * instructions into the request. Nothing here executes or approves anything.
 * Pure; no I/O.
 */
import type { QrPayload } from "./qrPayload";
import { validAddress, validNad } from "./qrPayload";

export const MAX_VISUAL_ACTIONS = 5;

export interface ExtractedAction {
  type: "send" | "swap";
  amount: string | null;
  /** send: the token sent; swap: the token sold. */
  token: string | null;
  /** swap only: the token bought. */
  toToken: string | null;
  recipient: string | null;
  /** send only: "send it" — the previous swap's output. */
  amountFromPrevious: boolean;
}

/** The vision model's reading, after server-side coercion. */
export interface ImageExtraction {
  kind: "payment_instruction" | "invoice" | "wallet_address" | "other";
  actions: ExtractedAction[];
  /** Wallet addresses / .nad names printed in the image. */
  addresses: string[];
  invoice: { number: string | null; payee: string | null; dueDate: string | null; total: string | null; token: string | null; payTo: string | null } | null;
  /** Text in the image addressed to an assistant or AI ("ignore previous…",
   *  "approve automatically"). Always ignored; flagged so the user is told. */
  suspicious: boolean;
}

export type VisualResolution =
  | { kind: "intent"; text: string; found: string[] }
  | { kind: "clarify"; reply: string; found: string[]; address?: string }
  | { kind: "conflict"; reply: string; found: string[] }
  | { kind: "blocked"; reply: string; found: string[] };

export interface VisualInput {
  qr: QrPayload | null;
  image: ImageExtraction | null;
  caption: string;
}

/* ── small helpers ─────────────────────────────────────────────────────── */

const short = (a: string) => (/^0x[0-9a-f]{40}$/i.test(a) ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const NOT_TOKENS = new Set(["to", "for", "each", "and", "then", "of", "in", "on", "at", "usd", "dollars", "percent", "x", "times"]);

export function normAmount(s: string | null | undefined): string | null {
  if (s == null) return null;
  const t = String(s).replace(/[,\s]/g, "").replace(/^\$/, "");
  if (!/^\d{1,15}(?:\.\d{1,18})?$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return null;
  return t.replace(/^0+(?=\d)/, "").replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}

/** A token symbol (2–10 chars) or a token contract address, or null. */
export function normToken(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = String(s).trim().replace(/^\$/, "");
  const addr = validAddress(t);
  if (addr) return addr;
  if (/^[a-z][a-z0-9]{1,9}$/i.test(t) && !NOT_TOKENS.has(t.toLowerCase())) return t.toUpperCase();
  return null;
}

/** "invalid" when something recipient-shaped was given but isn't usable. */
export function normRecipient(s: string | null | undefined): string | null | "invalid" {
  if (!s) return null;
  const t = String(s).trim();
  if (!t) return null;
  return validAddress(t) ?? validNad(t) ?? "invalid";
}

const sameRecipient = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const sameAmount = (a: string, b: string) => Number(a) === Number(b);
const sameToken = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/* ── caption reading ──────────────────────────────────────────────────── */

export interface CaptionFacts {
  verb: "send" | "swap" | null;
  amount: string | null;
  token: string | null;
  toToken: string | null;
  recipient: string | null | "invalid";
  /** "this address", "pay this", "the invoice"… — points at the image. */
  refersToImage: boolean;
}

const SEND_VERB = /\b(send|pay|transfer|settle|tip)\b/i;
const SWAP_VERB = /\b(swap|convert|exchange|trade)\b/i;
const REFERS_RE = /\b(this|that|the)\s+(address|wallet|recipient|qr|qr\s*code|code|invoice|bill|image|picture|photo|screenshot|request|one|person)\b|\b(pay|send|settle)\s+(this|it|that)\b|\bto\s+(it|this|them|that)\b/i;

export function readCaption(caption: string): CaptionFacts {
  const c = caption.trim();
  const swap = SWAP_VERB.test(c);
  const verb = swap ? "swap" : SEND_VERB.test(c) ? "send" : null;
  let amount: string | null = null;
  let token: string | null = null;
  let toToken: string | null = null;
  // An amount is a number right after the verb ("send 5 USDC", "pay $20")
  // or written as money ("$20") — never any number in the sentence, which
  // read "invoice 104" or "due in 30 days" as amounts.
  const amt = /\b(?:send|pay|transfer|settle|tip|swap|convert|exchange|trade)(?:\s+(?:me|them|him|her|over|just|only|exactly|about))?\s+\$?(\d[\d,]*(?:\.\d+)?)(?:\s*([a-z][a-z0-9]{1,9}|0x[0-9a-f]{40}))?\b/i.exec(c)
    ?? /(?:^|\s)\$(\d[\d,]*(?:\.\d+)?)()\b/.exec(c);
  if (amt) {
    amount = normAmount(amt[1]);
    token = normToken(amt[2]);
  }
  if (swap) {
    const to = /\b(?:to|for|into)\s+([a-z][a-z0-9]{1,9}|0x[0-9a-f]{40})\b/i.exec(c);
    toToken = normToken(to?.[1]);
  }
  const rec = /\b(0x[0-9a-fA-F]{40})\b|\b([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.nad)\b/i.exec(c);
  let recipient: string | null | "invalid" = rec ? normRecipient(rec[1] ?? rec[2]) : null;
  if (!rec && /\b0x[0-9a-f]{6,}\b/i.test(c)) recipient = "invalid";
  return { verb, amount, token, toToken, recipient, refersToImage: REFERS_RE.test(c) };
}

/* ── composition ─────────────────────────────────────────────────────── */

interface Ready { type: "send" | "swap"; amount: string | null; token: string; toToken?: string; recipient?: string; fromPrevious: boolean }

export function sentenceFor(actions: Ready[]): string {
  const parts = actions.map((a, i) => {
    if (a.type === "swap") return `swap ${a.amount} ${a.token} to ${a.toToken}`;
    if (a.fromPrevious && i > 0) return `send it to ${a.recipient}`;
    return `send ${a.amount} ${a.token} to ${a.recipient}`;
  });
  const out = parts.reduce((acc, p, i) => (i === 0 ? p : `${acc}${/^send it/.test(p) ? " and " : ", then "}${p}`), "");
  return out.charAt(0).toUpperCase() + out.slice(1);
}

function missingReply(found: string[], missing: string[], example: string): string {
  const head = found.length ? "Here's what I could read:" : "I couldn't read a complete payment from that image.";
  return `${head}${found.length ? "\n" + found.map((f) => `• ${f}`).join("\n") : ""}\n\nI still need ${missing.join(" and ")}. Reply with the full request — for example “${example}” — and I'll prepare it for your review. Nothing was prepared.`;
}

/* ── deterministic red flags ─────────────────────────────────────────── */

/** Wording that tries to steer PayAI rather than describe a payment. Checked
 *  in code on every extracted field, so it holds even if the model was
 *  manipulated into not flagging it. */
const INJECTION_RE = /\b(ignore|disregard|override|bypass|skip|without)\b.{0,40}\b(instruction|rule|polic|confirm|approv|review|check|limit|security|prompt)|\b(system prompt|you are now|auto-?approve|pre-?approved|already approved|no confirmation|developer mode|jailbreak)\b|\b(approve|confirm|sign|execute)\s+(this|it|automatically|immediately|now)\b/i;
/** "All funds", "max", "entire balance"… — never derived from an image. */
const DRAIN_RE = /\b(all|max(imum)?|entire|everything|whole|full)\b.{0,20}\b(funds?|balance|tokens?|wallet|money|holdings|usdc|mon)?\b|\b100\s*%|\bbalance\b/i;

function fieldsOf(img: ImageExtraction): string[] {
  const out: string[] = [...img.addresses];
  for (const a of img.actions) out.push(...[a.amount, a.token, a.toToken, a.recipient].filter((x): x is string => !!x));
  if (img.invoice) out.push(...Object.values(img.invoice).filter((x): x is string => !!x));
  return out;
}

/** True when any extracted field carries steering wording or asks to move
 *  everything. */
export function imageLooksManipulative(img: ImageExtraction): boolean {
  const fields = fieldsOf(img);
  if (fields.some((f) => INJECTION_RE.test(f))) return true;
  const amounts = [...img.actions.map((a) => a.amount), img.invoice?.total ?? null].filter((x): x is string => !!x);
  return amounts.some((a) => DRAIN_RE.test(a));
}

/* ── the resolver ────────────────────────────────────────────────────── */

export function resolveVisualIntent(input: VisualInput): VisualResolution {
  const found: string[] = [];
  const cap = readCaption(input.caption);
  const img = input.image;

  if (img?.suspicious || (img && imageLooksManipulative(img))) {
    return {
      kind: "blocked", found,
      reply: "That image contains instructions aimed at PayAI or an assistant, or asks to move an unspecified amount such as “all funds”. I don't act on instructions inside images. If you want to make a payment, type the request yourself — nothing was prepared.",
    };
  }

  // QR: the decoder's result is authoritative for what the QR says.
  let qrRecipient: string | null = null;
  let qrAmount: string | null = null;
  let qrToken: string | null = null;
  if (input.qr) {
    if (!input.qr.ok) return { kind: "blocked", reply: `${input.qr.reason} Nothing was prepared.`, found };
    qrRecipient = input.qr.recipient;
    qrAmount = input.qr.amount ?? null;
    qrToken = input.qr.token ?? null;
    found.push(`Recipient ${input.qr.recipient} — from the QR code`);
    if (qrAmount && qrToken) found.push(`Amount ${qrAmount} ${qrToken === "MON" ? "MON" : short(qrToken)} — from the QR code`);
    else if (qrToken) found.push(`Token ${short(qrToken)} — from the QR code`);
    if (input.qr.rawTokenAmount) found.push("The QR code also carries a token amount in raw units, which PayAI won't guess — please state the amount");
  }

  // Printed addresses that disagree with the QR are a red flag (a swapped
  // sticker or a doctored image): ask, never choose.
  const printed = (img?.addresses ?? []).map((a) => normRecipient(a)).filter((a): a is string => !!a && a !== "invalid");
  if (qrRecipient && printed.some((p) => !sameRecipient(p, qrRecipient!))) {
    return {
      kind: "conflict", found,
      reply: `The QR code points to ${qrRecipient}, but the image also shows ${printed.find((p) => !sameRecipient(p, qrRecipient!))}. Which one should receive the payment? Reply with the full request using the address you trust. Nothing was prepared.`,
    };
  }

  // Image-side actions (instructions written in the image, or an invoice).
  let imgActions: ExtractedAction[] = (img?.actions ?? []).slice(0, MAX_VISUAL_ACTIONS + 1);
  if (imgActions.length > MAX_VISUAL_ACTIONS) {
    return { kind: "blocked", found, reply: `That image lists more than ${MAX_VISUAL_ACTIONS} actions. Send them in smaller groups. Nothing was prepared.` };
  }
  const inv = img?.invoice ?? null;
  if (inv) {
    if (inv.payee) found.push(`Invoice from ${inv.payee}${inv.number ? ` (#${inv.number})` : ""}`);
    if (inv.dueDate) found.push(`Due ${inv.dueDate}`);
    if (inv.total) found.push(`Total ${inv.total}${inv.token ? ` ${inv.token}` : ""} — from the invoice`);
    if (inv.payTo) found.push(`Pay to ${inv.payTo} — from the invoice`);
    if (imgActions.length === 0 && (inv.total || inv.payTo)) {
      imgActions = [{ type: "send", amount: inv.total, token: inv.token, toToken: null, recipient: inv.payTo, amountFromPrevious: false }];
    }
  }
  if (!inv) {
    for (const a of imgActions) {
      found.push(a.type === "swap"
        ? `Swap ${a.amount ?? "?"} ${a.token ?? "?"} to ${a.toToken ?? "?"} — from the image text`
        : `Send ${a.amountFromPrevious ? "the swap's output" : `${a.amount ?? "?"} ${a.token ?? "?"}`} to ${a.recipient ?? "?"} — from the image text`);
    }
  }
  if (!qrRecipient && imgActions.length === 0 && printed.length) {
    found.push(`Address ${printed[0]} — from the image text`);
  }

  // Invoices are paid only when the caption asks.
  if (inv && imgActions.length && cap.verb !== "send") {
    return {
      kind: "clarify", found,
      reply: `${found.length ? "Here's what I read from the invoice:\n" + found.map((f) => `• ${f}`).join("\n") + "\n\n" : ""}Do you want to pay it? Add a caption like “Pay this invoice”, or type the request yourself. Nothing was prepared.`,
    };
  }

  /* Several actions written in the image: the caption may confirm them but
     not quietly change them. */
  if (imgActions.length > 1) {
    if (cap.amount && !imgActions.some((a) => a.amount && sameAmount(a.amount, cap.amount!))) {
      return { kind: "conflict", found, reply: `Your caption says ${cap.amount}${cap.token ? ` ${cap.token}` : ""}, but the image lists different amounts. Which is right? Reply with the full request. Nothing was prepared.` };
    }
    if (cap.recipient && cap.recipient !== "invalid" && !imgActions.some((a) => a.recipient && sameRecipient(normRecipient(a.recipient) as string, cap.recipient as string))) {
      return { kind: "conflict", found, reply: `Your caption names ${cap.recipient}, but the image names a different recipient. Which is right? Reply with the full request. Nothing was prepared.` };
    }
    return finish(imgActions, found);
  }

  /* One action (or none) from the image; merge it with the QR and caption. */
  const base = imgActions[0] ?? null;
  const type: "send" | "swap" | null = cap.verb ?? base?.type ?? null;
  if (cap.verb && base && cap.verb !== base.type) {
    return { kind: "conflict", found, reply: `Your caption asks to ${cap.verb}, but the image describes a ${base.type}. Which do you want? Reply with the full request. Nothing was prepared.` };
  }

  // Each field from up to three sources; any two that disagree → ask.
  const pick = (label: string, values: { v: string | null; from: string }[], same: (a: string, b: string) => boolean):
    { v: string | null; conflict?: string } => {
    const have = values.filter((x) => x.v);
    for (let i = 1; i < have.length; i++) {
      if (!same(have[0].v!, have[i].v!)) {
        return { v: null, conflict: `The ${label} doesn't match: ${have[0].from} says ${have[0].v}, ${have[i].from} says ${have[i].v}. Which is right? Reply with the full request. Nothing was prepared.` };
      }
    }
    return { v: have[0]?.v ?? null };
  };

  if (cap.recipient === "invalid") {
    return { kind: "blocked", found, reply: "The recipient in your caption isn't a valid 0x address or .nad name. Nothing was prepared." };
  }
  const imgRecipient = base?.recipient ? normRecipient(base.recipient) : (!qrRecipient && printed.length === 1 ? printed[0] : null);
  if (imgRecipient === "invalid") {
    return { kind: "blocked", found, reply: `The recipient read from the image (${base?.recipient}) isn't a valid 0x address or .nad name, so it can't be paid. Nothing was prepared.` };
  }

  const recipient = pick("recipient", [
    { v: cap.recipient as string | null, from: "your caption" },
    { v: qrRecipient, from: "the QR code" },
    { v: imgRecipient, from: "the image" },
  ], sameRecipient);
  if (recipient.conflict) return { kind: "conflict", found, reply: recipient.conflict };

  const amount = pick("amount", [
    { v: cap.amount, from: "your caption" },
    { v: qrAmount, from: "the QR code" },
    { v: normAmount(base?.amount), from: "the image" },
  ], sameAmount);
  if (amount.conflict) return { kind: "conflict", found, reply: amount.conflict };

  const token = pick("token", [
    { v: cap.token, from: "your caption" },
    { v: qrToken, from: "the QR code" },
    { v: normToken(base?.token), from: "the image" },
  ], sameToken);
  if (token.conflict) return { kind: "conflict", found, reply: token.conflict };

  if (cap.amount && !cap.token && token.v) found.push(`Amount ${cap.amount} — from your caption`);
  else if (cap.amount && cap.token) found.push(`Amount ${cap.amount} ${cap.token} — from your caption`);
  if (cap.recipient) found.push(`Recipient ${cap.recipient} — from your caption`);

  // Nothing payable at all.
  if (!type && !recipient.v && !amount.v) {
    return { kind: "clarify", found, reply: missingReply(found, ["what you want to do"], "Send 10 USDC to alice.nad") };
  }

  // Only an address (a wallet QR, typically): show it and ask.
  if (!type && recipient.v && !amount.v) {
    return {
      kind: "clarify", found, address: recipient.v,
      reply: `I found this ${recipient.v.endsWith(".nad") ? "name" : "wallet address"}${qrRecipient ? " in the QR code" : " in the image"}:\n${recipient.v}\n\nWhat would you like to do with it? For example: “Send 5 USDC to this address”. Nothing was prepared.`,
    };
  }

  if ((type ?? "send") === "swap") {
    const to = cap.toToken ?? normToken(base?.toToken);
    const missing = [!amount.v && "how much to swap", !token.v && "which token to sell", !to && "which token to buy"].filter(Boolean) as string[];
    if (missing.length) return { kind: "clarify", found, reply: missingReply(found, missing, `Swap ${amount.v ?? "10"} ${token.v ?? "MON"} to ${to ?? "USDC"}`) };
    return finish([{ type: "swap", amount: amount.v, token: token.v, toToken: to, recipient: null, amountFromPrevious: false }], found);
  }

  const missing = [!amount.v && "the amount", !token.v && "the token (MON or USDC)", !recipient.v && "who should receive it"].filter(Boolean) as string[];
  if (missing.length) {
    return {
      kind: "clarify", found, ...(recipient.v ? { address: recipient.v } : {}),
      reply: missingReply(found, missing, `Send ${amount.v ?? "5"} ${token.v ?? "USDC"} to ${recipient.v ?? "alice.nad"}`),
    };
  }
  return finish([{ type: "send", amount: amount.v, token: token.v, toToken: null, recipient: recipient.v, amountFromPrevious: false }], found);
}

/** Validate every field of every action, then write the sentence. */
function finish(actions: ExtractedAction[], found: string[]): VisualResolution {
  const ready: Ready[] = [];
  for (const [i, a] of actions.entries()) {
    const n = actions.length > 1 ? ` (step ${i + 1})` : "";
    if (a.type === "swap") {
      const amount = normAmount(a.amount); const from = normToken(a.token); const to = normToken(a.toToken);
      if (!amount || !from || !to) return { kind: "clarify", found, reply: missingReply(found, [`the full swap${n} — amount, token sold and token bought`], "Swap 10 MON to USDC") };
      ready.push({ type: "swap", amount, token: from, toToken: to, fromPrevious: false });
      continue;
    }
    const recipient = normRecipient(a.recipient);
    if (recipient === "invalid") return { kind: "blocked", found, reply: `The recipient${n} (${a.recipient}) isn't a valid 0x address or .nad name, so it can't be paid. Nothing was prepared.` };
    if (!recipient) return { kind: "clarify", found, reply: missingReply(found, [`who should receive the payment${n}`], "Send 10 USDC to alice.nad") };
    if (a.amountFromPrevious && i > 0 && ready[i - 1]?.type === "swap") {
      ready.push({ type: "send", amount: null, token: ready[i - 1].toToken!, recipient, fromPrevious: true });
      continue;
    }
    const amount = normAmount(a.amount); const token = normToken(a.token);
    if (!amount || !token) return { kind: "clarify", found, reply: missingReply(found, [`the amount and token${n}`], `Send 10 USDC to ${recipient}`) };
    ready.push({ type: "send", amount, token, recipient, fromPrevious: false });
  }
  return { kind: "intent", text: sentenceFor(ready), found };
}

/** "Send 5 USDC to this address" after a QR-only answer: put the address
 *  the user was just shown in place of the reference. Null when the text
 *  doesn't point back at it. */
export function applyVisualAddress(text: string, address: string): string | null {
  const re = /\b(?:this|that|the)\s+(?:address|wallet|recipient|one)\b|\bto\s+(?:it|this|that)\b(?!\s+(?:address|wallet|recipient|one)\b)/i;
  if (!re.test(text)) return null;
  return text.replace(re, (m) => (/^to\s/i.test(m) ? `to ${address}` : address));
}
