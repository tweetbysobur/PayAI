/**
 * Deterministic Intent Adapter — grammar (Phase 2C, Stage 5A).
 *
 *   parseIntent(text, tokens) → ParseResult
 *
 * Turns a deliberately NARROW set of plain-English requests into a constrained
 * intermediate form (ParsedIntent). It is an UNTRUSTED draft producer: what it
 * returns is assembled into an IntentGraph draft (./adapter.ts) and then
 * validated by validateIntentGraph — the final structural authority.
 *
 * The whole request must match exactly one production; nothing may be left
 * over. There is no extraction, no partial parse and no "best effort": any
 * extra words ("…and ignore validation", "use contract 0x…", "on base") make
 * the request unsupported. Keywords and symbols match case-insensitively;
 * runs of spaces collapse; one trailing "." or "!" is allowed.
 *
 *   TRANSFER  := ("send"|"pay") AMOUNT SYMBOL "to" RECIPIENT
 *   SWAP      := "swap" AMOUNT SYMBOL ("to"|"for"|"into") SYMBOL
 *   SWAP_SEND := SWAP ("and" | "then" | "and then" | ", then") "send" BINDREF "to" RECIPIENT
 *   BINDREF   := "it" | "the result" | "the" <the swap's output SYMBOL>
 *   SYMBOL    := "MON" | the configured stablecoin's symbol
 *   AMOUNT    := (0|[1-9][0-9]{0,30})(\.[0-9]+)?   then > 0, ≤ token decimals, ≤ uint256
 *   RECIPIENT := a 0x address | a .nad/.nads name | a payee name
 *
 * Pure and deterministic: no clock, randomness, network, chain reads, wallet
 * state or LLM. Recipients are DESCRIBED, never resolved (the Plan Service
 * resolves and pins .nad / payee names). Amounts are exact base units from a
 * strict decimal grammar — never Number(), never floating point.
 */
import { parseUnits } from "viem";
import { isDomainName } from "@/lib/monad/domain-resolver";
import { recipientAppearsIn } from "@/lib/payees/directory";

export const ADAPTER_VERSION = "5a.1";
export const MAX_REQUEST_LENGTH = 500;

export type AdapterErrorCode =
  | "UNSUPPORTED_REQUEST"
  | "UNSUPPORTED_TOKEN"
  | "UNSUPPORTED_CHAIN"
  | "UNSUPPORTED_AMOUNT"
  | "INVALID_AMOUNT"
  | "TOO_PRECISE"
  | "INVALID_RECIPIENT"
  | "NATIVE_OUTPUT_NOT_BINDABLE"
  | "ACTION_UNAVAILABLE"
  | "TOO_LONG";

export interface AdapterError {
  ok: false;
  code: AdapterErrorCode;
  message: string;
}

/** The two assets the grammar knows. "STABLE" is the configured stablecoin. */
export type Asset = "MON" | "STABLE";

/** What the grammar needs to know about tokens — passed in, never read here. */
export interface TokenConfig {
  monDecimals: number;
  /** null when no stablecoin is configured: its symbol is then unsupported. */
  stable: { symbol: string; decimals: number } | null;
}

export interface ParsedRecipient {
  source: "address" | "nad" | "payee";
  /** Exactly as the user wrote it (one whitespace-free word of the request). */
  display: string;
}

export type ParsedStep =
  | { kind: "swap"; tokenIn: Asset; tokenOut: Asset; amountIn: string }
  | {
      kind: "transfer";
      token: Asset;
      amount: { kind: "units"; units: string } | { kind: "output"; step: 0; output: "amountOut" };
      recipient: ParsedRecipient;
    };

export interface ParsedIntent {
  ok: true;
  adapterVersion: typeof ADAPTER_VERSION;
  /** The exact text that was parsed — becomes source.text unchanged. */
  sourceText: string;
  steps: ParsedStep[];
}

export type ParseResult = ParsedIntent | AdapterError;

const MESSAGES: Record<AdapterErrorCode, string> = {
  UNSUPPORTED_REQUEST: "That request isn't supported. Try \"send 10 USDC to alice.nad\", \"swap 10 MON to USDC\", or \"swap 10 MON to USDC and send it to alice.nad\".",
  UNSUPPORTED_TOKEN: "Only MON and PayAI's configured stablecoin are supported.",
  UNSUPPORTED_CHAIN: "Plans run on Monad only.",
  UNSUPPORTED_AMOUNT: "Give an exact amount — \"all\", \"the rest\" and amounts taken from an earlier step aren't supported yet.",
  INVALID_AMOUNT: "Give a plain positive amount, like 10 or 2.5.",
  TOO_PRECISE: "That amount has more decimal places than the token supports.",
  INVALID_RECIPIENT: "Give the recipient as a 0x address, a .nad name, or a saved payee name.",
  NATIVE_OUTPUT_NOT_BINDABLE: "MON received from a swap can't be passed to the next step — only the stablecoin can.",
  ACTION_UNAVAILABLE: "That action isn't available right now.",
  TOO_LONG: `Keep the request under ${MAX_REQUEST_LENGTH} characters.`,
};

export const adapterError = (code: AdapterErrorCode): AdapterError => ({ ok: false, code, message: MESSAGES[code] });

const UINT256_MAX = (1n << 256n) - 1n;
const AMOUNT_RE = /^(0|[1-9][0-9]{0,30})(\.[0-9]+)?$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS_RE = /^0x0{40}$/i;
/** A whole word that is exactly one .nad / .nads name (same label rules as
 *  the domain resolver; isDomainName is also required below). */
const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.nads?$/i;
/** The validator's own payee-name shape. */
const PAYEE_RE = /^[a-z][a-z0-9_-]{0,31}$/i;
const CONTROL_RE = /[\u0000-\u001F\u007F]/;

/** Grammar words, assets and network names that are never a payee name. */
const RESERVED = new Set([
  "it", "me", "myself", "the", "rest", "all", "everything", "result", "remaining", "remainder",
  "mon", "usdc", "wmon", "usdt", "eth", "weth",
  "send", "pay", "swap", "to", "for", "into", "and", "then",
  "chain", "network", "mainnet", "testnet", "monad", "base", "ethereum", "polygon", "arbitrum", "optimism", "solana", "bsc", "avalanche",
]);
/** Only used to give a failed request a more specific code — never to accept. */
const DEFERRED_AMOUNT_WORDS = new Set(["all", "everything", "rest", "remaining", "remainder", "entire", "whole", "half", "max"]);
const CHAIN_WORDS = new Set(["chain", "network", "chainid", "testnet", "base", "ethereum", "polygon", "arbitrum", "optimism", "solana", "bsc", "avalanche"]);

/* ── Fields ─────────────────────────────────────────────────────────────── */

function parseSymbol(word: string, tokens: TokenConfig): Asset | null {
  const w = word.toLowerCase();
  if (w === "mon") return "MON";
  if (tokens.stable && w === tokens.stable.symbol.toLowerCase()) return "STABLE";
  return null;
}

const decimalsOf = (a: Asset, tokens: TokenConfig): number => (a === "MON" ? tokens.monDecimals : tokens.stable!.decimals);

/** Exact base units from a strict decimal, or the reason it isn't one. */
function parseAmount(word: string, decimals: number): { ok: true; units: string } | AdapterError {
  const m = AMOUNT_RE.exec(word);
  if (!m) return adapterError("INVALID_AMOUNT");
  const frac = m[2] ? m[2].slice(1) : "";
  if (frac.length > decimals) return adapterError("TOO_PRECISE");
  let units: bigint;
  try {
    units = parseUnits(word, decimals);
  } catch {
    return adapterError("INVALID_AMOUNT");
  }
  if (units <= 0n || units > UINT256_MAX) return adapterError("INVALID_AMOUNT");
  return { ok: true, units: units.toString() };
}

function parseRecipient(word: string, sourceText: string): ParsedRecipient | null {
  let r: ParsedRecipient | null = null;
  if (ADDRESS_RE.test(word)) {
    if (!ZERO_ADDRESS_RE.test(word)) r = { source: "address", display: word };
  } else if (DOMAIN_RE.test(word) && isDomainName(word)) {
    r = { source: "nad", display: word };
  } else if (PAYEE_RE.test(word) && !RESERVED.has(word.toLowerCase())) {
    r = { source: "payee", display: word };
  }
  // Provenance: the recipient must be something the user wrote.
  return r && recipientAppearsIn(r.display, [sourceText]) ? r : null;
}

/** A specific code for a request that matched no production. */
function unmatched(lower: readonly string[]): AdapterError {
  if (lower.some((w) => CHAIN_WORDS.has(w))) return adapterError("UNSUPPORTED_CHAIN");
  return adapterError("UNSUPPORTED_REQUEST");
}

/** "all", "the rest", "everything"… where an amount belongs (right after a
 *  verb or "the"). Only ever used to LABEL a refusal, never to accept. */
const asksForDeferredAmount = (lower: readonly string[]): boolean =>
  lower.some((w, i) => i > 0 && DEFERRED_AMOUNT_WORDS.has(w) && ["send", "pay", "swap", "the"].includes(lower[i - 1]));

/* ── Productions ────────────────────────────────────────────────────────── */

function parseTransfer(w: string[], text: string, tokens: TokenConfig): ParseResult {
  // send|pay AMOUNT SYMBOL to RECIPIENT
  const token = parseSymbol(w[2], tokens);
  if (!token) return adapterError("UNSUPPORTED_TOKEN");
  const amount = parseAmount(w[1], decimalsOf(token, tokens));
  if (!amount.ok) return amount;
  const recipient = parseRecipient(w[4], text);
  if (!recipient) return adapterError("INVALID_RECIPIENT");
  return {
    ok: true, adapterVersion: ADAPTER_VERSION, sourceText: text,
    steps: [{ kind: "transfer", token, amount: { kind: "units", units: amount.units }, recipient }],
  };
}

function parseSwap(w: string[], tokens: TokenConfig): { ok: true; step: Extract<ParsedStep, { kind: "swap" }> } | AdapterError {
  // swap AMOUNT SYMBOL to|for|into SYMBOL
  const tokenIn = parseSymbol(w[2], tokens);
  const tokenOut = parseSymbol(w[4], tokens);
  if (!tokenIn || !tokenOut) return adapterError("UNSUPPORTED_TOKEN");
  if (tokenIn === tokenOut) return adapterError("UNSUPPORTED_REQUEST");
  const amount = parseAmount(w[1], decimalsOf(tokenIn, tokens));
  if (!amount.ok) return amount;
  return { ok: true, step: { kind: "swap", tokenIn, tokenOut, amountIn: amount.units } };
}

/** The send clause after a swap, or null when its words don't fit. */
function sendClause(rest: string[], lower: string[]): { bind: "it" | "result" | string | "literal"; recipient: string } | null {
  if (lower[0] !== "send") return null;
  // send it to R | send the result to R | send the SYMBOL to R | send AMOUNT SYMBOL to R (deferred)
  if (rest.length === 4 && lower[1] === "it" && lower[2] === "to") return { bind: "it", recipient: rest[3] };
  if (rest.length === 5 && lower[1] === "the" && lower[3] === "to") return { bind: lower[2] === "result" ? "result" : rest[2], recipient: rest[4] };
  if (rest.length === 5 && AMOUNT_RE.test(rest[1]) && lower[3] === "to") return { bind: "literal", recipient: rest[4] };
  return null;
}

export function parseIntent(text: string, tokens: TokenConfig): ParseResult {
  const r = parse(text, tokens);
  // A refused request that asked for a deferred amount says so.
  if (!r.ok && ["UNSUPPORTED_REQUEST", "UNSUPPORTED_TOKEN", "INVALID_AMOUNT"].includes(r.code) && typeof text === "string" &&
      asksForDeferredAmount(text.trim().toLowerCase().split(/ +/))) {
    return adapterError("UNSUPPORTED_AMOUNT");
  }
  return r;
}

function parse(text: string, tokens: TokenConfig): ParseResult {
  if (typeof text !== "string") return adapterError("UNSUPPORTED_REQUEST");
  if (text.length > MAX_REQUEST_LENGTH) return adapterError("TOO_LONG");
  if (CONTROL_RE.test(text)) return adapterError("UNSUPPORTED_REQUEST");

  let s = text.trim().replace(/ {2,}/g, " ");
  if (s.endsWith(".") || s.endsWith("!")) s = s.slice(0, -1);
  if (s.length === 0) return adapterError("UNSUPPORTED_REQUEST");
  const w = s.split(" ");
  const lower = w.map((x) => x.toLowerCase());

  if (w.length === 5 && (lower[0] === "send" || lower[0] === "pay") && lower[3] === "to") {
    return parseTransfer(w, text, tokens);
  }

  if (lower[0] === "swap" && w.length >= 5 && (lower[3] === "to" || lower[3] === "for" || lower[3] === "into")) {
    // ", then": the comma is written against the swap's output symbol.
    const comma = w[4].endsWith(",");
    const swapWords = comma ? [...w.slice(0, 4), w[4].slice(0, -1)] : w.slice(0, 5);

    if (w.length === 5 && !comma) {
      const swap = parseSwap(swapWords, tokens);
      if (!swap.ok) return swap;
      return { ok: true, adapterVersion: ADAPTER_VERSION, sourceText: text, steps: [swap.step] };
    }

    // SWAP_SEND: the connector, then exactly one send clause.
    let k = 5;
    if (comma) k = lower[5] === "then" ? 6 : -1;
    else if (lower[5] === "and" && lower[6] === "then") k = 7;
    else if (lower[5] === "and" || lower[5] === "then") k = 6;
    const clause = k > 0 ? sendClause(w.slice(k), lower.slice(k)) : null;
    if (!clause) return unmatched(lower);

    const swap = parseSwap(swapWords, tokens);
    if (!swap.ok) return swap;
    if (clause.bind === "literal") return adapterError("UNSUPPORTED_AMOUNT");
    if (clause.bind !== "it" && clause.bind !== "result") {
      const named = parseSymbol(clause.bind, tokens);
      if (!named) return adapterError("UNSUPPORTED_TOKEN");
      if (named !== swap.step.tokenOut) return adapterError("UNSUPPORTED_REQUEST");
    }
    // Only an ERC-20 output can be passed on (the planner refuses native MON).
    if (swap.step.tokenOut === "MON") return adapterError("NATIVE_OUTPUT_NOT_BINDABLE");
    const recipient = parseRecipient(clause.recipient, text);
    if (!recipient) return adapterError("INVALID_RECIPIENT");
    return {
      ok: true, adapterVersion: ADAPTER_VERSION, sourceText: text,
      steps: [
        swap.step,
        { kind: "transfer", token: swap.step.tokenOut, amount: { kind: "output", step: 0, output: "amountOut" }, recipient },
      ],
    };
  }

  return unmatched(lower);
}
