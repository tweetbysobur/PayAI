/**
 * Merchant-platform types. The platform layer sits on top of the agent +
 * payment layers and turns raw activity (on-chain payments + the agent
 * transaction log) into merchant-facing analytics, customers, links, invoices,
 * and AI-assistant answers.
 */

/** One recorded agent run (every outcome, not just settled). */
export interface TxLogEntry {
  id: string;
  at: number; // unix ms
  decision: "executed" | "needs_review" | "blocked" | "refused" | "error";
  action: string;
  amount: number | null;
  token: string;
  recipient: string | null;
  /** The original .nad/.nads domain, when the recipient was resolved from one. */
  domain?: string | null;
  /** The wallet that initiated this payment. Used to scope a connected user's
   *  dashboard to their OWN activity — one user never sees another's history,
   *  even though wallet-only users share the demo tenant's store. Null for the
   *  custodial/agent path (no end-user wallet) and read-only outcomes. */
  sender?: string | null;
  riskScore: number | null;
  compliance: string | null;
  txHash?: string;
  explorerUrl?: string;
  summary: string;
}

/**
 * A lifecycle notification for a Payment Automation — distinct from a payment
 * TxLogEntry (which is a settlement outcome feeding revenue analytics). This is
 * a generic, reusable event log: `kind` identifies which automation engine
 * produced it, so a future engine (payroll, subscriptions, treasury, savings,
 * installments…) reuses this same shape and the same notification feed
 * instead of inventing its own — the whole reason this is its own module
 * rather than folded into the tx log.
 */
export type AutomationEventType =
  | "created" | "upcoming_execution" | "executed" | "execution_failed"
  | "paused" | "resumed" | "cancelled";

export interface AutomationEvent {
  id: string;
  automationId: string;
  /** Which automation engine raised this — "recurring_payment" today; a future
   *  kind (e.g. "payroll_run") plugs into the same event log unchanged. */
  kind: string;
  merchantId: string;
  sender?: string | null;
  type: AutomationEventType;
  at: number;
  title: string;
  detail: string;
  amount?: number | null;
  token?: string | null;
  txHash?: string;
  explorerUrl?: string;
}

/** Payment Automation frequency. Custom stays intentionally small in v1. */
export type AutomationCadence = "once" | "daily" | "weekly" | "monthly" | "custom";
export type AutomationIntervalUnit = "days" | "weeks" | "months";
/** One clear status per automation. */
export type AutomationStatus = "active" | "paused" | "completed" | "cancelled" | "failed" | "scheduled" | "executing";

export type ScheduleCadence = AutomationCadence;
export type ScheduleStatus = AutomationStatus;

/** When a recurring automation stops on its own, without the user cancelling it.
 *  "never" (the old default behavior) is discouraged in the UI — real standing
 *  orders default to a bound. */
export type AutomationEndCondition =
  | { type: "never" }
  | { type: "after_count"; totalRuns: number }
  | { type: "until_date"; untilMs: number };
export type ScheduleEndCondition = AutomationEndCondition;

export interface AutomationExecution {
  at: number;
  txHash?: string;
  explorerUrl?: string;
  decision: string;
  detail?: string;
  gasFee?: number;
}

export interface PaymentAutomation {
  id: string;
  merchantId: string;
  /** The wallet that created this automation. Used to scope a connected user's
   *  own automations on the shared demo tenant — one wallet-only user must
   *  never see or cancel another's automation. Null on merchant-account
   *  tenants, which are already isolated by merchantId. */
  sender?: string | null;
  amount: number;
  token: string;
  /** Resolved 0x address the payment settles to. */
  recipient: string;
  /** Original .nad/.nads domain, when the recipient was resolved from one. */
  domain?: string | null;
  cadence: AutomationCadence;
  intervalCount?: number;
  intervalUnit?: AutomationIntervalUnit;
  timezone?: string;
  purpose: string;
  /** Unix ms of the next (or only) automation execution. */
  nextRun: number;
  status: AutomationStatus;
  createdAt: number;
  /** The `nextRun` value an "upcoming execution" reminder has already been sent
   *  for — prevents re-notifying on every cron tick within the lookahead
   *  window. Cleared implicitly whenever nextRun advances past it. */
  remindedForRun?: number | null;
  /** Every fired run, newest first — real on-chain receipts, never fabricated. */
  runs: AutomationExecution[];
  /** Optional human label/memo. */
  memo?: string;
  /** Defaults to `{ type: "never" }` for automations created before this existed. */
  endCondition?: AutomationEndCondition;
  /** Successful (executed) runs only — checked against after_count. */
  runsCompleted: number;
  /** Consecutive execution errors since the last success (or since creation).
   *  Reset to 0 on every successful run. A hard compliance block does NOT
   *  count here — that goes straight to "failed" since retrying won't help. */
  failureCount: number;
  /** The reason the automation stopped or is at risk of stopping, for display. */
  lastError?: string | null;
  /** The wallet signature captured at CREATION — an immutable record of the
   *  terms the owner originally authorized. Deliberately never overwritten by
   *  edits: it stays verifiable against `signatureMessage` forever. If a
   *  material term (amount/cadence/timing) is later changed, `modifiedAt` is
   *  stamped so the audit trail reflects that current terms may differ from
   *  this original authorization rather than silently contradicting it. */
  signature?: string | null;
  signatureMessage?: string | null;
  /** Unix ms of the last material edit (amount/cadence/timing/end-condition),
   *  null if never edited since creation. Every edit is itself gated by a
   *  fresh action-scoped wallet signature (see verifyMutation), so this marks
   *  a re-authorized change, not an unauthorized one. */
  modifiedAt?: number | null;
  /**
   * How this automation is funded at execution:
   *   - "wallet"   → Wallet Automation (non-custodial): pull the user's
   *                  pre-approved ERC-20 at execution. Default for USDC.
   *   - "reserved" → Reserved Funds: pay out from the user's AutomationVault
   *                  reservation.
   * Absent on legacy records = the old agent-funded path.
   */
  fundingMode?: "wallet" | "reserved";
  /** Reserved Funds: the tx hash that funded the vault reservation (audit trail). */
  reserveTxHash?: string | null;
}

export type ScheduledPayment = PaymentAutomation;

export type LinkStatus = "active" | "paid" | "expired";

export interface PaymentLink {
  id: string;
  merchantId: string;
  /** The wallet that created this link. Scopes listing to the caller's own
   *  links on the shared demo tenant, same reasoning as ScheduledPayment.sender. */
  sender?: string | null;
  url: string;
  amount: number;
  token: string;
  /** Merchant payout wallet snapshotted at link creation, if one was on file. */
  recipient?: string;
  memo?: string;
  status: LinkStatus;
  createdAt: number;
  expiresAt: number | null;
  paidAt?: number;
  txHash?: string;
}

export interface RevenueOverview {
  total: number;
  today: number;
  thisWeek: number;
  thisMonth: number;
  currency: string;
  settledCount: number;
  failedCount: number;
  successRate: number; // 0..1
}

export interface TrendPoint {
  date: string; // YYYY-MM-DD
  revenue: number;
  count: number;
}

export interface Customer {
  address: string;
  name?: string;
  totalPaid: number;
  paymentCount: number;
  avgRisk: number;
  lastActivity: number;
  riskLevel: "low" | "medium" | "high";
}

export interface ComplianceMetrics {
  approved: number;
  rejected: number;
  review: number;
  blocked: number;
  approvalRate: number; // 0..1
}

export interface Insight {
  id: string;
  severity: "info" | "warning" | "critical";
  title: string;
  detail: string;
  suggestion?: string;
}

export interface AnalyticsSnapshot {
  revenue: RevenueOverview;
  trend: TrendPoint[];
  volume: { count: number; total: number };
  topCustomers: Customer[];
  compliance: ComplianceMetrics;
  insights: Insight[];
}

export interface AssistantAnswer {
  intent: string;
  answer: string;
  data?: unknown;
  action?: { type: string; result: unknown };
}
