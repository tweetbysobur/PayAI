/**
 * PayAI payment-layer domain types.
 *
 * This module is the single source of truth for *what the payment system can do*
 * (actions, tokens, networks) and *what it returns* (compliance, risk, execution).
 * The AI layer (lib/agent) imports these — never the other way around — so the
 * dependency arrow points AI → payment, keeping the layers cleanly separated.
 */

/* ── Primitives ─────────────────────────────────────────────────────────── */

export type Token = "USDC" | "USDT" | "USD" | "MON";
export const SUPPORTED_TOKENS: Token[] = ["USDC", "USDT", "USD", "MON"];
/** Tokens settled as the chain's native asset rather than an ERC-20 transfer. */
export const NATIVE_TOKENS: Token[] = ["MON"];

export type Network = "monad" | "base" | "polygon" | "ethereum";
export const SUPPORTED_NETWORKS: Network[] = [
  "monad",
  "base",
  "polygon",
  "ethereum",
];

/** Canonical set of actions the agent can request from the payment layer. */
export type PaymentAction =
  | "send_payment"
  | "create_payment_link"
  | "create_checkout_link"
  | "pay_invoice";

/** A normalized, payment-layer view of a request (derived from a parsed intent). */
export interface PaymentRequest {
  action: PaymentAction;
  amount: number | null;
  token: Token;
  /** Address or human name; may be null for link-style actions. */
  recipient: string | null;
  purpose: string | null;
  network: Network;
  /** Original invoice reference for pay_invoice. */
  invoiceRef?: string | null;
  /** PayAI risk score (0–100), set after assessment; anchored on-chain. */
  riskScore?: number;
  /** Idempotency key — required for any execution that moves funds. */
  requestId?: string;
}

/* ── Compliance ─────────────────────────────────────────────────────────── */

export type ComplianceStatus = "approved" | "review" | "rejected";

export interface ComplianceCheck {
  id: string;
  label: string;
  passed: boolean;
  detail: string;
  /** "hard" failures reject the request; "soft" failures route it to review. */
  severity: "hard" | "soft";
}

export interface ComplianceResult {
  status: ComplianceStatus;
  checks: ComplianceCheck[];
  summary: string;
}

/* ── Risk ───────────────────────────────────────────────────────────────── */

export type RiskLevel = "low" | "medium" | "high";

export interface RiskFactor {
  id: string;
  label: string;
  /** Contribution to the 0–100 score. */
  points: number;
  detail: string;
}

export interface RiskAssessment {
  /** 0 (safe) … 100 (severe). */
  score: number;
  level: RiskLevel;
  factors: RiskFactor[];
}

/* ── Execution ──────────────────────────────────────────────────────────── */

export type ExecutionMode = "simulation" | "monad";
export type TxStatus = "settled" | "pending" | "skipped" | "failed";

export interface TransactionResult {
  status: TxStatus;
  network: Network;
  mode: ExecutionMode;
  detail: string;
  /** Present for on-chain transfers / invoice payments. */
  txHash?: string;
  explorerUrl?: string;
  /** Present for payment / checkout links. */
  link?: string;
  amount?: number;
  token?: Token;
  recipient?: string;
  /** On-chain gas fee actually paid, e.g. "0.00042 MON". */
  gasFee?: string;
  /** Pre-execution gas estimate, e.g. "0.00041 MON". */
  gasEstimate?: string;
  blockNumber?: number;
  /** Unix ms when the settling block was mined — full traceability. */
  blockTimestamp?: number;
  /** The wallet that signed/broadcast the transaction. */
  sender?: string;
  /** Idempotency key this execution was claimed under. */
  requestId?: string;
  /** Decoded on-chain PaymentExecuted event, when settled via PaymentExecutor. */
  event?: {
    name: string;
    paymentId: number;
    args: Record<string, string | number>;
  };
  /** VeriPayRegistry audit anchor (when the registry contract is deployed). */
  registryTxHash?: string;
  registryExplorerUrl?: string;
}
