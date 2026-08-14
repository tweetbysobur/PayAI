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

export interface WalletOperationIntent extends IntentBase {
  kind: "wallet_operation";
  operation: "balance" | "recent_payments" | "explain_transaction";
  /** Free-form context the card can show (e.g. which transaction). Display
   *  only — never parsed back into a parameter. */
  detail?: string | null;
}

export type Intent =
  | PaymentIntent
  | ScheduledPaymentIntent
  | RecurringPaymentIntent
  | SwapIntent
  | DistributionIntent
  | WalletOperationIntent;

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
  explain_transaction: "Transaction explainer",
};
