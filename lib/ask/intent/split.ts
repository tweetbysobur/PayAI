/**
 * Deterministic split-payment understanding — natural language → a concrete,
 * fully resolved split_payment request, or a specific clarification. No LLM
 * is involved at any point, and none is consulted when this declines: a
 * message with a split verb is answered HERE, either with a preview-ready
 * split or with a precise question. (lib/ask/intent/classify.ts calls
 * detectSplit() before every other detector, so "send 50 USDC split between
 * A, B and C" can never be read as a single-recipient send.)
 *
 * Two stages:
 *
 *   parseSplit(text)        pure. Recognizes a deliberately narrow grammar:
 *     equal:  "split|distribute <total> <MON|USDC> [equally] between|among|
 *              across|to R1, R2 [and R3]…"
 *             "send <total> <token> split [equally] between R1, R2 …"
 *     custom: "split [<total> <token>][:] <amt> to R1, <amt> to R2 [and the
 *              rest to R3]"
 *     Each R must be exactly one 0x address, .nad name, or one-word payee
 *     name. Anything outside the grammar is a clarification, never a guess:
 *     explicit amounts are never flattened to an equal split, and no
 *     recipient or amount is ever dropped silently.
 *
 *   normalizeSplit(parsed)  server. Resolves the token (MON, or the ONE
 *     configured stablecoin), every recipient through the shared resolver
 *     (lib/payees/resolve.ts — 0x as written, .nad via NNS, names only from
 *     VERIPAYAI_PAYEES; unknown fails closed), converts every amount to exact
 *     base units with parseUnits (string → bigint, no floating point), and
 *     computes the split in bigint:
 *       equal — total / n each, remainder to the last recipient so the sum is
 *               exactly the total;
 *       custom — the stated amounts, which must add up to any stated total;
 *       rest  — total minus the stated amounts, computed here because the
 *               total is in the SAME message. "The rest" of something that
 *               doesn't exist yet (e.g. a previous swap's output) is a future
 *               Planner responsibility and is refused here.
 *     The action therefore only ever receives concrete addresses and integer
 *     amounts — never a name, never "rest".
 *
 * Server-only (recipient resolution reads the chain; the stablecoin comes
 * from server config).
 */
import "server-only";
import { formatUnits, parseUnits } from "viem";
import type { Understanding } from "./types";

export const SPLIT_TRIGGER_RE = /\b(?:split|distribute)\b/i;

const ADDR = "0x[0-9a-fA-F]{40}";
const NAD = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.nads?";
const NAME = "[a-z][a-z0-9_-]{0,31}";
const RECIPIENT = `(?:${ADDR}|${NAD}|${NAME})`;
const AMOUNT = "\\d+(?:\\.\\d+)?";
const UNIT = "(?:mon|usdc)";

const RECIPIENT_FULL_RE = new RegExp(`^${RECIPIENT}$`, "i");
/** "<amt> [unit] to R" or "the rest to R". */
const ITEM_RE = new RegExp(`(?:(${AMOUNT})\\s*(?:${UNIT}\\s+)?|(the\\s+rest(?:\\s+of\\s+it)?)\\s+)to\\s+(${RECIPIENT})(?![a-z0-9_.-])`, "gi");
/** The stated total: "<verb> <amt> <unit>" NOT followed by "to" (that's an item). */
const TOTAL_RE = new RegExp(`\\b(?:split|distribute|send|pay)\\s+(${AMOUNT})\\s*(${UNIT})\\b(?!\\s+to\\b)`, "i");
const UNIT_RE = /\b(mon|usdc)\b/gi;
const LIST_PREP_RE = /\b(?:between|among|amongst|across|to)\s+([\s\S]+)$/i;
const SCHEDULE_RE = /\b(?:every|daily|weekly|monthly|yearly|tomorrow|next\s+(?:week|month)|recurring|schedule|automate|each\s+(?:day|week|month))\b/i;

export const SPLIT_FORMAT_HINT = 'For example: "split 100 USDC between 0x… and name.nad", or "split 100 USDC: 60 to 0x… and 40 to name.nad".';

export interface ParsedSplitEntry {
  /** Exactly as written: a 0x address, a .nad name, or a payee name. */
  recipient: string;
  /** A literal decimal amount, "rest", or null (equal split). */
  amount: string | "rest" | null;
}

export type ParsedSplit =
  | { ok: true; unit: "mon" | "usdc"; total: string | null; mode: "equal" | "custom"; entries: ParsedSplitEntry[] }
  | { ok: false; message: string };

const clarify = (message: string): ParsedSplit => ({ ok: false, message });

/** Pure: text → the split the user literally wrote, or why it can't be read. */
export function parseSplit(raw: string): ParsedSplit | null {
  if (!SPLIT_TRIGGER_RE.test(raw)) return null;
  const text = raw.trim().replace(/[.!?]+$/, "");

  if (SCHEDULE_RE.test(text)) {
    return clarify("Scheduled or recurring splits aren't supported yet — I can do a one-time split right now. " + SPLIT_FORMAT_HINT);
  }

  const units = new Set(Array.from(text.matchAll(UNIT_RE), (m) => m[1].toLowerCase()));
  if (units.size === 0) return clarify("Which token should I split — MON or USDC? " + SPLIT_FORMAT_HINT);
  if (units.size > 1) return clarify("A split sends one token to everyone — use either MON or USDC, not both.");
  const unit = [...units][0] as "mon" | "usdc";

  const totalMatch = text.match(TOTAL_RE);
  const items = Array.from(text.matchAll(ITEM_RE));
  const restItems = items.filter((m) => m[2]);
  const numericItems = items.filter((m) => m[1]);

  // ── Custom amounts: two or more "<amt> to R" items, or any "the rest". ──
  if (restItems.length > 0 || numericItems.length >= 2) {
    if (restItems.length > 1) return clarify('Only one recipient can get "the rest".');
    // Everything not covered by the total and the items must be connective
    // text only — a leftover address, .nad name or number means some
    // recipient or amount wasn't matched, and dropping it would be wrong.
    let leftover = text;
    for (const m of items) leftover = leftover.replace(m[0], " ");
    if (totalMatch) leftover = leftover.replace(totalMatch[0], " ");
    if (new RegExp(`${ADDR}|\\.nads?\\b|\\d`, "i").test(leftover)) {
      return clarify("I couldn't match every amount to a recipient. " + SPLIT_FORMAT_HINT);
    }
    return {
      ok: true, unit, mode: "custom",
      total: totalMatch ? totalMatch[1] : null,
      entries: items.map((m) => ({ recipient: m[3], amount: m[2] ? "rest" : m[1] })),
    };
  }

  // ── Equal split. ──
  let total: string | null = totalMatch ? totalMatch[1] : null;
  let listText: string | null = null;
  if (numericItems.length === 1 && !totalMatch) {
    // "distribute 0.06 MON to A, B and C": the one "<amt> to" is the total,
    // and "to" introduces the list.
    const m = numericItems[0];
    total = m[1];
    listText = text.slice((m.index ?? 0) + m[0].length - m[3].length);
  } else {
    const after = totalMatch ? text.slice((totalMatch.index ?? 0) + totalMatch[0].length) : text;
    const prep = after.match(LIST_PREP_RE);
    listText = prep ? prep[1] : null;
  }
  if (!total) return clarify("How much should I split, and in which token? " + SPLIT_FORMAT_HINT);
  if (!listText) return clarify("Who should the split go to? " + SPLIT_FORMAT_HINT);

  let list = listText.trim().replace(/\s+(?:equally|evenly)$/i, "");
  let declared: number | null = null;
  const lead = list.match(/^(?:these|the\s+following)\s+(?:(\d+)\s+)?(?:addresses|wallets|people|recipients|friends)\s*:?\s*/i);
  if (lead) {
    declared = lead[1] ? Number(lead[1]) : null;
    list = list.slice(lead[0].length);
  }
  const names = list.split(/\s*,\s*(?:and\s+)?|\s+and\s+|\s*&\s*/i).map((s) => s.trim()).filter(Boolean);
  for (const n of names) {
    if (!RECIPIENT_FULL_RE.test(n)) {
      return clarify(`I can't tell who "${n.slice(0, 48)}" is — use a 0x address, a .nad name, or a configured payee. ` + SPLIT_FORMAT_HINT);
    }
  }
  if (declared != null && declared !== names.length) {
    return clarify(`You mentioned ${declared} recipients but listed ${names.length}. Which should it be?`);
  }
  // An equal split has exactly one number in it — the total (plus an
  // optional "these N addresses" count). Any other number is an amount the
  // user meant for someone ("split 100 USDC: 60 to A, B and C"), and an equal
  // split would silently override it, so ask instead.
  let rest = text.replace(new RegExp(ADDR, "gi"), " ");
  for (const nm of names) rest = rest.replace(nm, " ");
  rest = rest.replace(total, " ");
  if (lead?.[1]) rest = rest.replace(lead[1], " ");
  if (/\d/.test(rest)) return clarify("I couldn't match every amount to a recipient. " + SPLIT_FORMAT_HINT);
  return { ok: true, unit, mode: "equal", total, entries: names.map((recipient) => ({ recipient, amount: null })) };
}

/** Base units from a literal decimal, refusing more precision than the token
 *  has (parseUnits would silently round it). String → bigint only. */
function toUnits(amount: string, decimals: number): bigint | null {
  const [, frac = ""] = amount.split(".");
  if (frac.length > decimals) return null;
  try {
    return parseUnits(amount, decimals);
  } catch {
    return null;
  }
}

/** Server: resolve token + recipients and compute exact base-unit amounts. */
export async function normalizeSplit(parsed: Extract<ParsedSplit, { ok: true }>): Promise<Understanding> {
  const unclear = (reply: string): Understanding => ({ kind: "unclear", outcome: "unclear", reply });

  const { ensureBuiltinsRegistered } = await import("@/lib/sdk/bootstrap");
  const { getAction, getCurrentActionVersion } = await import("@/lib/sdk/registry");
  const { getChain, getStablecoin } = await import("@/lib/monad/config");
  const { SPLIT_MIN_RECIPIENTS, SPLIT_MAX_RECIPIENTS } = await import("@/lib/sdk/actions/split-settlement");
  const { resolveRecipientInput } = await import("@/lib/payees/resolve");
  ensureBuiltinsRegistered();

  const version = getCurrentActionVersion("payai-settlement", "split_payment");
  const action = version ? getAction("payai-settlement", "split_payment", version) : undefined;
  if (!version || !action || action.chainId !== getChain().id) {
    return unclear("Split payments aren't available on this network.");
  }

  let token: string;
  let decimals: number;
  let symbol: string;
  if (parsed.unit === "mon") {
    token = "0x0000000000000000000000000000000000000000"; decimals = 18; symbol = "MON";
  } else {
    try {
      const usdc = getStablecoin();
      token = usdc.address; decimals = usdc.decimals; symbol = usdc.symbol;
    } catch {
      return unclear("USDC isn't configured on this deployment, so it can't be split here.");
    }
  }

  const n = parsed.entries.length;
  if (n < SPLIT_MIN_RECIPIENTS) return unclear(`A split needs at least ${SPLIT_MIN_RECIPIENTS} recipients — for one recipient, just send the payment.`);
  if (n > SPLIT_MAX_RECIPIENTS) return unclear(`A split can go to at most ${SPLIT_MAX_RECIPIENTS} recipients.`);

  // Resolve every recipient; any failure stops the whole split.
  const addresses: `0x${string}`[] = [];
  const labels: Record<string, string> = {};
  const seen = new Map<string, string>();
  for (const e of parsed.entries) {
    const r = await resolveRecipientInput(e.recipient);
    if (!r.ok) return unclear(r.message);
    const key = r.address.toLowerCase();
    if (key === "0x0000000000000000000000000000000000000000") return unclear("A split can't send to the zero address.");
    const prior = seen.get(key);
    if (prior) return unclear(`${prior} and ${e.recipient} are the same wallet — each recipient can only appear once.`);
    seen.set(key, e.recipient);
    if (r.source !== "address") labels[key] = r.display;
    addresses.push(r.address);
  }

  const tooPrecise = (a: string) => unclear(`${a} has more decimal places than ${symbol} supports (${decimals}).`);
  const total = parsed.total != null ? toUnits(parsed.total, decimals) : null;
  if (parsed.total != null && total == null) return tooPrecise(parsed.total);

  let amounts: bigint[];
  if (parsed.mode === "equal") {
    if (total == null || total <= 0n) return unclear("How much should I split?");
    const per = total / BigInt(n);
    if (per <= 0n) return unclear(`${parsed.total} ${symbol} is too small to split ${n} ways.`);
    const remainder = total - per * BigInt(n);
    amounts = addresses.map((_, i) => (i === n - 1 ? per + remainder : per));
  } else {
    const fixed: (bigint | null)[] = [];
    for (const e of parsed.entries) {
      if (e.amount === "rest") { fixed.push(null); continue; }
      const u = toUnits(e.amount as string, decimals);
      if (u == null) return tooPrecise(e.amount as string);
      if (u <= 0n) return unclear("Every amount in a split must be more than zero.");
      fixed.push(u);
    }
    const stated = fixed.reduce<bigint>((s, u) => s + (u ?? 0n), 0n);
    const restIndex = fixed.indexOf(null);
    if (restIndex >= 0) {
      if (total == null) {
        return unclear(`"The rest" of what? Tell me the total in the same message, e.g. "split 100 ${symbol}: 20 to 0x… and the rest to name.nad".`);
      }
      const rest = total - stated;
      if (rest <= 0n) {
        return unclear(`The amounts already add up to ${formatUnits(stated, decimals)} ${symbol}, leaving nothing of ${parsed.total} ${symbol} for "the rest".`);
      }
      fixed[restIndex] = rest;
    } else if (total != null && stated !== total) {
      return unclear(`Those amounts add up to ${formatUnits(stated, decimals)} ${symbol}, not ${parsed.total} ${symbol}. Which is right?`);
    }
    amounts = fixed as bigint[];
  }

  return {
    kind: "protocol_action", outcome: "complete",
    slots: {
      amount: null, asset: null, recipient: null, when: null, frequency: null, fromAsset: null, toAsset: null,
      recipientCount: null, txHash: null, tokenAddress: null, tradeAction: null, amountType: null, slippage: null,
      protocolId: "payai-settlement", actionId: "split_payment", actionVersion: version,
      actionInputs: {
        ...(parsed.unit === "mon" ? {} : { token }),
        recipients: addresses.map((recipient, i) => ({ recipient, amount: amounts[i].toString() })),
      },
      recipientLabels: Object.keys(labels).length > 0 ? labels : null,
    },
  };
}

/** The whole deterministic path: null when the message has no split verb;
 *  otherwise a preview-ready split or a specific clarification. */
export async function detectSplit(text: string): Promise<Understanding | null> {
  const parsed = parseSplit(text);
  if (!parsed) return null;
  if (!parsed.ok) return { kind: "unclear", outcome: "unclear", reply: parsed.message };
  return normalizeSplit(parsed);
}
