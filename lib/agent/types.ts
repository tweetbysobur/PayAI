/**
 * Agent (AI-layer) types.
 *
 * The AI layer is responsible for *understanding* — turning natural language
 * into a structured intent and deciding whether it's safe to forward. It imports
 * the payment-layer result types (compliance / risk / transaction) only to
 * assemble the final response envelope returned to the client.
 */
import type {
  ComplianceResult,
  Network,
  PaymentAction,
  RiskAssessment,
  Token,
  TransactionResult,
} from "../payment/types";
import type { Receipt } from "../payment/feeMath";

/** The structured intent extracted from a user's natural-language request. */
export interface ParsedIntent {
  action: PaymentAction;
  amount: number | null;
  token: Token;
  recipient: string | null;
  /** Display name when the recipient was a directory payee resolved to an address. */
  payeeName?: string;
  /** The original .nad/.nads domain, when the recipient was resolved from one. */
  domain?: string;
  purpose: string | null;
  network: Network;
  /** Verbatim user input, kept for the trace. */
  rawText: string;
  /** One-line restatement of what the agent understood. */
  summary: string;
  /** 0–1 — how confident the parser is it understood the intent. */
  confidence: number;
}

/** How the intent was parsed. */
export type IntentSource = "deterministic" | "llm" | "fallback";

/** PayAI-side guardrail outcome, evaluated before the payment layer runs. */
export interface GuardrailResult {
  allowed: boolean;
  violations: string[];
}

/** One line in the agent's reasoning / execution trace. */
export interface TraceEntry {
  step: string;
  status: "ok" | "warn" | "blocked" | "info";
  detail: string;
}

export type AgentDecision =
  | "executed"
  | "needs_review"
  | "blocked"
  | "refused"
  | "error"
  /** A read-only query (history / compliance status) — no payment was attempted. */
  | "info"
  /** Approved, but execution must be signed by the user's own connected wallet. */
  | "ready_to_sign";

/** An unsigned transaction the connected wallet must sign and broadcast itself. */
export interface UnsignedTx {
  to: string;
  data: string;
  from: string;
}

/** The complete structured response returned by POST /api/agent. */
export interface AgentResult {
  decision: AgentDecision;
  intent: ParsedIntent;
  source: IntentSource;
  guardrail: GuardrailResult;
  compliance: ComplianceResult | null;
  risk: RiskAssessment | null;
  transaction: TransactionResult | null;
  /** Mirrors intent.confidence at the top level for convenience. */
  confidence: number;
  /** Mirrors risk.score; null when risk was never assessed. */
  riskScore: number | null;
  trace: TraceEntry[];
  error?: string;
  /** Payload for "info" decisions (e.g. tx history rows, compliance metrics). */
  data?: unknown;
  /** Present only for "ready_to_sign" — the client signs this with the connected wallet. */
  unsignedTx?: UnsignedTx;
  /** The sanitized text to replay against /api/agent/confirm once signed. */
  confirmRawText?: string;
  /**
   * The real receipt (payment amount, platform fee, gas, total), computed
   * SERVER-SIDE via lib/payment/feeEngine.ts's buildReceipt() — present only
   * on an "executed" result. Client code must render this field directly and
   * never recompute a receipt itself: feeEngine.ts is server-only (it reads
   * live fee config from process.env), so a client-side calculation can only
   * ever silently see a zeroed-out config, not the real one.
   */
  receipt?: Receipt;
}
