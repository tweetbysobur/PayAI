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
  // Wallet intelligence — read-only, never signs anything.
  "wallet_balance",
  "token_balance",
  "transaction_history",
  "wallet_activity",
  "transaction_status",
  "transaction_details",
  "automation_management",
  "distribution",
  // Token intelligence — read-only lookup of an ARBITRARY Monad contract
  // address (not necessarily one PayAI's own wallet holds). Detected purely
  // deterministically (an EVM address in the message) — see classify.ts's
  // detectTokenLookup() — never by asking Anthropic to spot an address.
  "token_lookup",
  // Trade intent + quote preview (Step 3) — STILL read-only/pre-execution:
  // this only ever produces a real quote and a preview card, never a
  // signature request. Distinct from "swap" above (which is the existing,
  // EXECUTABLE MON/USDC-style pipeline) specifically so this new capability
  // can target an arbitrary, uncurated token by contract address without
  // touching that already-working, already-hardened execution path at all.
  "trade",
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
  /**
   * A specific past transaction the user is referring to — filled only when
   * the model can resolve exactly one from conversation context (e.g. the
   * hash it just showed in its own last reply). Left null for "my latest
   * transaction" / "did it go through" with nothing more specific said; the
   * orchestrator resolves that case against real recent activity itself.
   */
  txHash?: string | null;
  /** An EVM contract address named in the message (or carried over from a
   *  prior token_lookup, once the conversation has already identified one) —
   *  always a regex-matched literal from the text, never guessed. */
  tokenAddress?: string | null;
  /** "trade" intent only: buy = acquiring fromAsset→toAsset's OUTPUT side,
   *  sell = disposing of the INPUT side. fromAsset/toAsset (above) carry the
   *  actual two assets — a symbol, an address, or (for whichever side isn't
   *  explicitly named) the token already identified via conversation context. */
  tradeAction?: "buy" | "sell" | null;
  /** "trade" intent only: how `amount` should be interpreted. exact_output
   *  ("I want exactly 100 tokens") is recognized but never resolved to a
   *  quote yet — see classify.ts's own note on why, and orchestrate.ts's
   *  dispatchTrade for the honest "not supported yet" reply this produces. */
  amountType?: "exact_input" | "exact_output" | "usd" | "percentage" | "balance_all" | null;
  /** "trade" intent only: a slippage tolerance the user explicitly asked
   *  for, as a plain number of percent (e.g. "1" for 1%) — never invented,
   *  left null to mean "use PayAI's own default". Validated against the
   *  existing MAX_SLIPPAGE ceiling before use, never silently clamped. */
  slippage?: string | null;
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
