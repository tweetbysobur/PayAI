/**
 * PayAI Rooms — pure terms: parsing a room request, the exact fixed split,
 * and the room's derived status. No I/O, no clock (time is passed in), no
 * randomness — unit-tested directly (test/rooms-terms.test.ts).
 *
 * Spec: docs/hackathon/payai-rooms-cleanverse.md (§5, §6, §16).
 */
import { formatUnits, parseUnits } from "viem";

export const MIN_PARTICIPANTS = 2;
export const MAX_PARTICIPANTS = 20;
export const DEFAULT_EXPIRY_DAYS = 7;
export const MAX_EXPIRY_DAYS = 30;
export const MAX_MEMO = 80;
const DAY_MS = 86_400_000;
const UINT256_MAX = (1n << 256n) - 1n;

/** What a room can be denominated in. "native" is MON. */
export interface RoomAsset {
  symbol: string;
  /** Lowercase 0x address; the zero address for native MON. */
  address: string;
  decimals: number;
  native: boolean;
}
export const NATIVE_ADDRESS = "0x0000000000000000000000000000000000000000";

export interface RoomRequest {
  /** The token symbol as the user wrote it, upper-cased. */
  symbol: string;
  /** Decimal string as written ("100", "2.5"). */
  amount: string;
  /** Whether `amount` is each person's share ("20 USDC each") or the total. */
  per: "total" | "each";
  participants: number;
  /** A 0x address or .nad name the user wrote; null = the creator. */
  recipient: string | null;
  expiryDays: number;
}

export type ParseRoomResult = { ok: true; request: RoomRequest } | { ok: false; message: string };

const AMOUNT_TOKEN_RE = /(?:^|[\s(])\$?(\d+(?:\.\d+)?)\s*(a-?usdc|usdc|mon|[a-z][a-z0-9]{1,9})\b/gi;
const COUNT_RE = /\b(\d+)\s*(?:people|persons?|participants?|members?|friends?|payers?|contributors?|of\s+us)\b/gi;
const EACH_RE = /\b(each|per\s+(?:person|participant|head|member))\b/i;
/** Whoever the request names as the recipient — ANY word after these, so a
 *  name PayAI can't resolve is refused by the resolver rather than dropped
 *  (and the room silently paying the creator instead). */
const RECIPIENT_RE = /\b(?:to|paid\s+to|recipient(?:\s+is)?|collected\s+by|goes\s+to)\s+(?!\d+(?:\.\d+)?\b)(?!(?:the|a|an|each|every|everyone|us|them|people|participants?)\b)([^\s,;]+?)(?=[\s,;.!?]*$|[\s,;]|\.(?:\s|$))/i;
const EXPIRY_RE = /\b(?:in|for|within|expires?\s+in|closes?\s+in)\s+(\d+)\s*days?\b/i;
const UNSUPPORTED: [RegExp, string][] = [
  [/\b(weighted|unequal|proportional|percent(?:age)?s?)\b/i, "Rooms split the total equally for now — weighted shares aren't supported."],
  [/\b(stream(?:ing|ed)?|per\s+second|drip)\b/i, "Streaming payments aren't supported in Rooms."],
  [/\b(escrow|lock(?:ed)?\s+(?:funds|money)|hold\s+(?:the\s+)?funds|refund(?:s|able)?|release\s+when)\b/i,
    "A room described here is a direct room — no escrow: each share goes straight to the recipient and nothing is refunded. To hold funds in escrow with refunds if the goal isn't met, create an escrow room on the Rooms page."],
];

/** A deterministic read of "create a room for 100 USDC for 5 people (to bob.nad, in 3 days)". */
export function parseRoomRequest(text: string): ParseRoomResult {
  if (typeof text !== "string" || !text.trim()) return { ok: false, message: "Describe the room — for example \"a room for 100 USDC for 5 people\"." };
  const t = text.trim().replace(/\s+/g, " ");
  if (t.length > 300) return { ok: false, message: "Keep the room description under 300 characters." };
  for (const [re, message] of UNSUPPORTED) if (re.test(t)) return { ok: false, message };

  const amounts = [...t.matchAll(AMOUNT_TOKEN_RE)].filter((m) => !/^(people|persons?|participants?|members?|friends?|days?)$/i.test(m[2]));
  if (amounts.length === 0) return { ok: false, message: "How much should the room collect? Give an amount and a token, like \"100 USDC\"." };
  if (amounts.length > 1) return { ok: false, message: "That names more than one amount. Give one — the total (\"100 USDC\") or each share (\"20 USDC each\")." };
  const counts = [...t.matchAll(COUNT_RE)];
  if (counts.length === 0) return { ok: false, message: "How many people will pay? For example \"for 5 people\"." };
  if (counts.length > 1) return { ok: false, message: "That names more than one group size. Say how many people will pay, once." };

  const participants = Number(counts[0][1]);
  if (!Number.isInteger(participants) || participants < MIN_PARTICIPANTS || participants > MAX_PARTICIPANTS) {
    return { ok: false, message: `A room needs ${MIN_PARTICIPANTS} to ${MAX_PARTICIPANTS} people paying.` };
  }
  const expiryMatch = t.match(EXPIRY_RE);
  const expiryDays = expiryMatch ? Number(expiryMatch[1]) : DEFAULT_EXPIRY_DAYS;
  if (!Number.isInteger(expiryDays) || expiryDays < 1 || expiryDays > MAX_EXPIRY_DAYS) {
    return { ok: false, message: `A room can stay open for 1 to ${MAX_EXPIRY_DAYS} days.` };
  }
  return {
    ok: true,
    request: {
      symbol: amounts[0][2].toUpperCase().replace("-", ""),
      amount: amounts[0][1],
      per: EACH_RE.test(t) ? "each" : "total",
      participants,
      recipient: t.match(RECIPIENT_RE)?.[1] ?? null,
      expiryDays,
    },
  };
}

export type SplitResult =
  | { ok: true; totalUnits: bigint; shareUnits: bigint; total: string; share: string }
  | { ok: false; message: string };

/** The exact fixed split, in base units. A total that doesn't divide exactly
 *  at the token's decimals is refused, with the nearest exact alternatives —
 *  never rounded silently (spec Q-P2). */
export function fixedSplit(amount: string, per: "total" | "each", participants: number, asset: Pick<RoomAsset, "symbol" | "decimals">): SplitResult {
  if (!/^(0|[1-9][0-9]{0,30})(\.[0-9]+)?$/.test(amount)) return { ok: false, message: "Give a plain positive amount, like 100 or 2.5." };
  const frac = amount.split(".")[1] ?? "";
  if (frac.length > asset.decimals) return { ok: false, message: `${asset.symbol} has ${asset.decimals} decimal places — that amount has more.` };
  let units: bigint;
  try { units = parseUnits(amount, asset.decimals); } catch { return { ok: false, message: "Give a plain positive amount, like 100 or 2.5." }; }
  if (units <= 0n) return { ok: false, message: "The amount must be more than zero." };
  if (!Number.isInteger(participants) || participants < MIN_PARTICIPANTS || participants > MAX_PARTICIPANTS) {
    return { ok: false, message: `A room needs ${MIN_PARTICIPANTS} to ${MAX_PARTICIPANTS} people paying.` };
  }
  const n = BigInt(participants);
  const shareUnits = per === "each" ? units : units / n;
  const totalUnits = per === "each" ? units * n : units;
  if (totalUnits > UINT256_MAX) return { ok: false, message: "That amount is too large." };
  if (per === "total" && units % n !== 0n) {
    // Two exact alternatives at two decimals (cents), where they exist.
    const cent = asset.decimals >= 2 ? 10n ** BigInt(asset.decimals - 2) : 1n;
    const low = (units / n / cent) * cent;
    const high = low + cent;
    const fmt = (u: bigint) => trim(formatUnits(u, asset.decimals));
    const alts = [low > 0n ? `${fmt(low)} each (${fmt(low * n)} total)` : null, `${fmt(high)} each (${fmt(high * n)} total)`].filter(Boolean);
    return { ok: false, message: `${trim(amount)} ${asset.symbol} doesn't split exactly between ${participants} people. Try ${alts.join(" or ")}.` };
  }
  if (shareUnits <= 0n) return { ok: false, message: "Each share would be zero — use a larger amount." };
  return { ok: true, totalUnits, shareUnits, total: trim(formatUnits(totalUnits, asset.decimals)), share: trim(formatUnits(shareUnits, asset.decimals)) };
}

/** "100.000000" → "100", "2.50" → "2.5". */
export function trim(decimal: string): string {
  return decimal.includes(".") ? decimal.replace(/0+$/, "").replace(/\.$/, "") : decimal;
}

/* ── Status ─────────────────────────────────────────────────────────────── */

export type RoomStatus = "open" | "completed" | "expired" | "cancelled";

/**
 * Status is DERIVED from the facts, never stored, so it only moves forward
 * and no two writers can race it:
 *   cancelled — the creator cancelled it (only possible while nothing was paid);
 *   completed — `target` shares were confirmed before it closed;
 *   expired   — it reached its expiry without that;
 *   open      — otherwise.
 */
export function deriveStatus(r: { cancelledAt: number | null; expiresAt: number; target: number }, confirmedAt: readonly number[], now: number): { status: RoomStatus; completedAt: number | null } {
  if (r.cancelledAt != null) return { status: "cancelled", completedAt: null };
  const inTime = [...confirmedAt].filter((t) => t <= r.expiresAt).sort((a, b) => a - b);
  if (inTime.length >= r.target) return { status: "completed", completedAt: inTime[r.target - 1] };
  if (now >= r.expiresAt) return { status: "expired", completedAt: null };
  return { status: "open", completedAt: null };
}

export const expiryFrom = (createdAt: number, days: number) => createdAt + days * DAY_MS;

export function cleanMemo(memo: unknown): string | null {
  if (typeof memo !== "string") return null;
  const m = memo.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  return m ? m.slice(0, MAX_MEMO) : null;
}
