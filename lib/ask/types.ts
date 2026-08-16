/**
 * Ask PayAI — intent & operation type system.
 *
 * This is the contract between the (future) AI layer and the UI. The AI
 * layer's job is to turn natural language into one of these structured
 * `Intent` shapes; the UI's job is to render that shape into an
 * `OperationCard` and gate every state transition on an explicit user
 * action. Nothing in this file executes anything — see OperationCard's own
 * doc comment for the safety model this exists to enforce.
 *
 * No `any`, no free-text execution: every field a transaction depends on
 * (token, amount, recipient, network, frequency) is a typed, present-or-
 * absent value, never inferred at render time. If a required field is
 * missing, that's an `AskAssistantMessage` asking for it, not a card with a
 * blank filled in.
 */

export type Network = "monad";

interface IntentBase {
  network: Network;
}

export interface PaymentIntent extends IntentBase {
  kind: "payment";
  token: string;
  amount: string;
  recipient: string;
  recipientDomain?: string | null;
  estimatedFee?: string | null;
  purpose?: string | null;
  /**
   * Present only for a real (non-mock) payment produced by the live PayAI
   * pipeline (see lib/ask/sendPayment/orchestrator.ts) — the unsigned
   * transaction and replay context needed to actually execute it via the
   * existing wallet/confirm flow. Absent for demo/mock cards, which never
   * reach a wallet signature. Nothing in components/ask/ reads this field;
   * it exists purely for the orchestration layer that owns confirmation.
   */
  execution?: {
    unsignedTx: { to: string; data: string; value?: string; from: string };
    confirmRawText: string;
    requestId?: string;
  };
}

/** What a schedule/recurring card needs to hand off to the real Automations
 *  creator — every Payment Automation still requires its own wallet
 *  signature there (see app/dashboard/automations), so Ask PayAI never
 *  "executes" one in-chat; it only prefills the real creator, exactly like
 *  the existing command bar's automation_prefill handling does. */
export interface AutomationHandoff {
  prefill: { amount: number; token: string; recipient: string; domain?: string | null; cadence: string; nextRun: number | null };
}

export interface ScheduledPaymentIntent extends IntentBase {
  kind: "scheduled_payment";
  token: string;
  amount: string;
  recipient: string;
  recipientDomain?: string | null;
  /** ISO 8601 */
  startDate: string;
  estimatedFee?: string | null;
  handoff?: AutomationHandoff;
}

export interface RecurringPaymentIntent extends IntentBase {
  kind: "recurring_payment";
  token: string;
  amount: string;
  recipient: string;
  recipientDomain?: string | null;
  frequency: "daily" | "weekly" | "monthly" | "custom";
  /** ISO 8601 */
  startDate: string;
  /** ISO 8601, absent = runs until cancelled */
  endDate?: string | null;
  handoff?: AutomationHandoff;
}

export interface SwapIntent extends IntentBase {
  kind: "swap";
  fromToken: string;
  toToken: string;
  fromAmount: string;
  /** A quote, not a guarantee — always labeled "estimated" wherever shown. */
  toAmountEstimate?: string | null;
  slippage?: string | null;
  /**
   * Present only for a real (non-mock) swap produced by the live PayAI
   * pipeline — the real DEX plan (quote + unsigned steps) needed to
   * actually execute it. Absent for demo/mock cards.
   */
  execution?: {
    plan: { quote: { fromToken: string; toToken: string; amountIn: number; amountOut: number; minAmountOut: number; feeTier: number; slippage: number; priceImpact: number | null }; steps: { kind: "approve" | "swap"; label: string; tx: { to: string; data: string; value: string } }[]; summary: string };
    provider?: string;
    /** When this quote was fetched (Date.now() at dispatch time) — a
     *  confirm click long after this is a stale price, not a guaranteed
     *  one; see useAskChat's staleness check before executeSwapIntent. */
    quotedAt: number;
  };
}

export interface DistributionIntent extends IntentBase {
  kind: "distribution";
  token: string;
  /** Set when the amount is split evenly; absent for a custom per-row split. */
  amountPerRecipient?: string | null;
  totalAmount: string;
  recipientCount: number;
}

/** A single past transaction, rendered from real, already-verified data —
 *  never a live guess. `status` reflects what actually happened on-chain
 *  (see lib/ask/intent/orchestrate.ts's resolveTransaction), not a claim. */
export interface WalletTransactionView {
  type: string;
  asset: string;
  amount: string;
  sender: string;
  recipient: string;
  status: "success" | "pending" | "failed";
  /** Human-readable, already formatted — e.g. "Aug 14, 2026, 3:04 PM". */
  timestamp: string;
  txHash?: string;
  explorerUrl?: string;
  /** Swap/trade only — what was actually received + which DEX served it, so
   *  a trade reads as "50 USDC → 12,345 RANDO via Uniswap v3" rather than
   *  just its spent side. Absent for a payment (no output side) and for
   *  swap/trade rows recorded before these fields existed. */
  outputAmount?: string | null;
  outputToken?: string | null;
  provider?: string | null;
}

export interface WalletOperationIntent extends IntentBase {
  kind: "wallet_operation";
  operation: "balance" | "recent_payments" | "transaction";
  /** Real data only, populated entirely by the orchestrator from actual API
   *  responses — this type and the component that renders it never invent
   *  a number. An absent field renders an honest "no data" state. */
  balances?: { token: string; amount: string }[];
  /** Best-effort — from the existing /api/wallet-intelligence endpoint's
   *  real MON-price quote. Absent (not fabricated as $0) when that endpoint
   *  isn't configured or a price isn't available. */
  totalValueUsd?: string | null;
  payments?: {
    to: string; amount: string; token: string; when: string; status: "success" | "pending" | "failed";
    txHash?: string; explorerUrl?: string;
    /** Swap/trade rows only — see WalletTransactionView's own doc. */
    outputAmount?: string | null; outputToken?: string | null; provider?: string | null;
  }[];
  transaction?: WalletTransactionView;
}

/** One real, usable trading route — which provider, which two symbols, and
 *  what 1 unit of the input actually converts to right now. Only routes
 *  that genuinely resolved are ever included (see lib/monad/tokenIntelligence
 *  — "only show a pair if an actual usable route exists"). */
export interface TokenRoute {
  provider: string;
  inputToken: string;
  outputToken: string;
  estimatedOutput: string;
  priceImpact: string | null;
  available: true;
}

/** A specific requested amount, quoted through whichever real route serves
 *  it — the discovery layer Step 3's execution builds on. `route: null`
 *  means no usable route existed for that pair, never a 0. */
export interface QuotedAmount {
  amount: string;
  quoteAsset: string;
  route: TokenRoute | null;
}

/** Real market data only — every field is either a genuine freshly-read
 *  value or `null`, never a fabricated 0 or "$0.00" standing in for
 *  "unavailable". `price` can be null even when `routes` is non-empty — a
 *  route can exist but be too shallow to price honestly (see
 *  lib/monad/prices's getUsdPrice, which this reuses). liquidity/volume24h/
 *  priceChange24h are null until this app has an indexer to source them
 *  from (see lib/monad/tokenIntelligence). `signals` are descriptive tags
 *  only, never a verdict ("scam"/"safe" is never inferred from these). */
export interface TokenMarketData {
  price: string | null;
  priceQuoteAsset: string | null;
  liquidity: string | null;
  volume24h: string | null;
  priceChange24h: string | null;
  quoteAssetsChecked: string[];
  routes: TokenRoute[];
  signals: string[];
  /** Date.now() when this snapshot was actually fetched — may be a few
   *  seconds old (served from lib/monad/tokenIntelligence's short-lived
   *  market-data cache), never implied to be "live this instant". */
  lastUpdated: number;
}

/** Nad.Fun status for a token the Lens recognizes — mirrors
 *  lib/monad/tokenIntelligence's TokenNadFunInfo (itself mirroring
 *  lib/monad/nadfun's getNadFunStatus). Absent/null, not a false status,
 *  when the token was never on Nad.Fun at all. */
export interface TokenNadFunInfo {
  status: "bonding_curve" | "graduated" | "locked" | "unsupported";
  isLocked: boolean;
  availableToBuy: string | null;
}

/** Everything real and known about one identified ERC-20 token — populated
 *  entirely by lib/monad/tokenIntelligence's on-chain reads, never invented. */
export interface TokenData {
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: string | null;
  verified: boolean;
  userBalance: string | null;
  isTradable: boolean;
  explorerUrl: string;
  market: TokenMarketData;
  /** Present only when a specific amount was actually requested (e.g. "how
   *  much would I get for 50?") — absent, not null, when nothing was asked. */
  quote?: QuotedAmount | null;
  /** Optional (not every caller populates it) so existing token-lookup
   *  fixtures/tests stay valid without updating every literal. */
  nadFun?: TokenNadFunInfo | null;
}

/** Read-only lookup of an arbitrary Monad address — never signs, never
 *  moves funds. `status` is what the on-chain inspection actually found:
 *  an EOA ("wallet"), a contract that didn't behave like an ERC-20
 *  ("unknown_contract"), or a real identified token ("token", with `data`
 *  populated). See lib/monad/tokenIntelligence.ts's TokenInspection, which
 *  this mirrors. */
export interface TokenIntelligenceIntent extends IntentBase {
  kind: "token_intelligence";
  address: string;
  status: "wallet" | "unknown_contract" | "token";
  data?: TokenData;
}

/** Which real DEX served the quote, and the actual hop path it returned —
 *  always a direct [input, output] pair with this app's current
 *  infrastructure (neither Uniswap's QuoterV2 call nor Kuru's simulate call
 *  used anywhere in this codebase does multi-hop routing), so a multi-hop
 *  path is never fabricated here — see lib/monad/tradeQuote's own doc. */
export interface TradeRoute {
  provider: string;
  path: string[];
}

/** Everything shown on a trade preview — every field computed from a real,
 *  just-fetched quote (see lib/monad/tradeQuote.ts), never a hardcoded
 *  example. PRE-EXECUTION ONLY: nothing about this type or its card ever
 *  signs, approves, or moves funds — see OperationCard's TradePreviewBody
 *  for the disabled confirm affordance this renders with. */
export interface TradePreviewData {
  action: "buy" | "sell";
  spend: { amount: string; token: string };
  receive: { amount: string; token: string };
  rate: string;
  minimumReceived: string;
  priceImpact: string | null;
  /** True when priceImpact exceeds swap.ts's existing MAX_PRICE_IMPACT —
   *  still shown (this step never blocks on it, only the real execution
   *  path in Step 4 will), just flagged clearly rather than buried. */
  highPriceImpact: boolean;
  route: TradeRoute;
  slippage: string;
  network: "Monad";
  /** Date.now() when this quote was fetched — a confirm long after this is
   *  a stale price; see useAskChat's staleness handling for the existing
   *  swap card, which this mirrors. */
  quotedAt: number;
}

export interface TradePreviewIntent extends IntentBase {
  kind: "trade_preview";
  data: TradePreviewData;
  /**
   * Present only when a wallet was connected at preview time — the request
   * fields needed to re-quote and build real unsigned steps at confirm-time
   * (see /api/ask/trade/build and lib/ask/intent/orchestrate.ts's
   * executeTradeIntent). Absent means preview-only / informational: no
   * wallet to execute against, so the card never enters the confirm funnel
   * (see OperationCard.tsx's isInfo).
   */
  execution?: {
    request: {
      action: "buy" | "sell";
      inputToken: string;
      outputToken: string;
      amount: string;
      amountType: "exact_input" | "exact_output" | "usd" | "percentage" | "balance_all";
      slippage: string | null;
    };
  };
}

export type Intent =
  | PaymentIntent
  | ScheduledPaymentIntent
  | RecurringPaymentIntent
  | SwapIntent
  | DistributionIntent
  | WalletOperationIntent
  | TokenIntelligenceIntent
  | TradePreviewIntent;

/**
 * Where an Operation sits in the mandatory funnel:
 * intent -> preview -> explicit confirm -> passkey/wallet auth -> execution -> result.
 * The UI is the ONLY thing allowed to advance a card from one status to the
 * next, always in response to a real click — never automatically, and never
 * skipping a step.
 */
export type OperationStatus =
  | "preview"     // shown, nothing confirmed yet — "Review payment"
  | "ready"       // reviewed — "Confirm with passkey" / "Confirm in wallet"
  | "confirming"  // signature in flight, nothing sent to chain yet
  | "success"     // executed — real result attached
  | "error";      // failed or rejected

export interface TransactionResult {
  txHash: string;
  explorerUrl: string;
  blockNumber?: number;
  gasFee?: string;
}

export interface OperationError {
  message: string;
  /** Machine-readable when available, for future retry/telemetry logic. */
  code?: string;
  /** Present only when a transaction actually reached the chain before
   *  failing (e.g. a mined revert) — absent for a pre-broadcast failure
   *  (rejected signature, no route, build failure), since there's no real
   *  transaction to point at yet. Never fabricated: always the same hash
   *  the wallet actually returned. */
  txHash?: string;
  explorerUrl?: string;
}

export interface Operation {
  id: string;
  intent: Intent;
  status: OperationStatus;
  result?: TransactionResult;
  error?: OperationError;
  /** Override the "ready" step's button — used for a schedule/recurring
   *  handoff card, where the action is "go set this up" rather than a
   *  wallet signature. Absent keeps the existing "Confirm with passkey". */
  confirmLabel?: string;
  confirmIcon?: "passkey" | "go";
}

export type MessageRole = "user" | "assistant";

export interface AskMessage {
  id: string;
  role: MessageRole;
  /** Plain text. The one thing this is never allowed to become is an
   *  executable instruction — an Operation is what executes, and it only
   *  exists as structured data attached below, never parsed from this string. */
  content: string;
  createdAt: number;
  /** Present when this assistant message carries a structured card. */
  operation?: Operation;
}

export const NETWORK_LABEL: Record<Network, string> = {
  monad: "Monad",
};

export const FREQUENCY_LABEL: Record<RecurringPaymentIntent["frequency"], string> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
  custom: "Custom",
};

export const WALLET_OP_LABEL: Record<WalletOperationIntent["operation"], string> = {
  balance: "Balance",
  recent_payments: "Recent payments",
  transaction: "Transaction",
};
