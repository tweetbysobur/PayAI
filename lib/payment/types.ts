/**
 * PayAI payment-layer domain types.
 *
 * This module is the single source of truth for *what the payment system can do*
 * (actions, tokens, networks) and *what it returns* (compliance, risk, execution).
 * The AI layer (lib/agent) imports these — never the other way around — so the
 * dependency arrow points AI → payment, keeping the layers cleanly separated.
 */

/* ── Primitives ─────────────────────────────────────────────────────────── */

/**
 * A token symbol — any fungible token deployed on Monad, not a fixed list.
 * The engine no longer hardcodes which symbols are valid: a payment carrying
 * a resolved `tokenAddress` (see PaymentRequest below) is accepted regardless
 * of its symbol, since the address itself is what execution actually uses.
 * SUPPORTED_TOKENS/NATIVE_TOKENS below remain only as the legacy fallback for
 * requests with no tokenAddress (e.g. the AI chat's un-migrated symbol-only
 * intents), never as an allowlist.
 */
export type Token = string;
export const SUPPORTED_TOKENS: Token[] = ["USDC", "USDT", "USD", "MON"];
/** Tokens settled as the chain's native asset rather than an ERC-20 transfer, when no tokenAddress is present. */
export const NATIVE_TOKENS: Token[] = ["MON"];
/** Sentinel address meaning "the chain's native asset" — matches the on-chain convention (PaymentExecutor, AutomationVault). */
export const NATIVE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000";

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
  /**
   * Funding source for automation execution:
   *   - undefined / "agent"  → legacy agent-funded path (instant payments).
   *   - "wallet"             → pull the pre-approved ERC-20 from `fromWallet`
   *                            (Wallet Automation, non-custodial).
   *   - "reserved"           → release from the AutomationVault under `automationId`
   *                            (Reserved Funds).
   */
  fundingMode?: "agent" | "wallet" | "reserved";
  /** Wallet Automation: the user wallet whose approved balance funds the pull. */
  fromWallet?: string | null;
  /** Reserved Funds: the automation id whose vault reservation funds the release. */
  automationId?: string | null;
  /**
   * The token's real contract address (NATIVE_TOKEN_ADDRESS for the chain's
   * native asset) — the source of truth execution actually settles against.
   * When present, it overrides any legacy symbol-based token lookup, which
   * is what makes execution work for ANY Monad token, not just MON/USDC.
   */
  tokenAddress?: string | null;
  /** The token's on-chain decimals, resolved once at creation time and stored with the automation — never re-guessed at execution time. */
  tokenDecimals?: number | null;
  /** The exact PaymentExecutor this automation was created against — see PaymentAutomation.executorAddress. Absent falls back to the current global config. */
  executorAddress?: string | null;
  /** The exact AutomationVault this automation was created against — see PaymentAutomation.vaultAddress. Absent falls back to the current global config. */
  vaultAddress?: string | null;
  /** PayAI's fee is charged ON TOP: the recipient receives `amount` in full
   *  and the contract is handed the gross (lib/payment/feeOnTop.ts). Set for
   *  automations created after the fee moved on top; older ones keep the fee
   *  taken out of the amount they were funded for. */
  feeOnTop?: boolean;
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
