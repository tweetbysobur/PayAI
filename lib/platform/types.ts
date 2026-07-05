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

/** A recurring or one-off payment scheduled to fire automatically when due. */
export type ScheduleCadence = "once" | "daily" | "weekly" | "monthly";
/** "failed" is terminal and distinct from "cancelled": the user didn't stop it,
 *  it stopped itself — either a hard compliance block (won't clear on retry)
 *  or repeated execution errors past the retry budget. Surfaced loudly, never
 *  silently merged into "cancelled" or quietly re-tried forever. */
export type ScheduleStatus = "upcoming" | "completed" | "cancelled" | "failed";

/** When a recurring schedule stops on its own, without the user cancelling it.
 *  "never" (the old default behavior) is discouraged in the UI — real standing
 *  orders default to a bound. */
export type ScheduleEndCondition =
  | { type: "never" }
  | { type: "after_count"; totalRuns: number }
  | { type: "until_date"; untilMs: number };

export interface ScheduledPayment {
  id: string;
  merchantId: string;
  /** The wallet that created this schedule. Used to scope a connected user's
   *  own schedules on the shared demo tenant — one wallet-only user must
   *  never see or cancel another's scheduled payment. Null on merchant-account
   *  tenants, which are already isolated by merchantId. */
  sender?: string | null;
  amount: number;
  token: string;
  /** Resolved 0x address the payment settles to. */
  recipient: string;
  /** Original .nad/.nads domain, when the recipient was resolved from one. */
  domain?: string | null;
  cadence: ScheduleCadence;
  /** Unix ms of the next (or only) scheduled run. */
  nextRun: number;
  status: ScheduleStatus;
  createdAt: number;
  /** Every fired run, newest first — real on-chain receipts, never fabricated. */
  runs: { at: number; txHash?: string; explorerUrl?: string; decision: string; detail?: string }[];
  /** Optional human label/memo. */
  memo?: string;
  /** Defaults to `{ type: "never" }` for schedules created before this existed. */
  endCondition?: ScheduleEndCondition;
  /** Successful (executed) runs only — checked against after_count. */
  runsCompleted: number;
  /** Consecutive execution errors since the last success (or since creation).
   *  Reset to 0 on every successful run. A hard compliance block does NOT
   *  count here — that goes straight to "failed" since retrying won't help. */
  failureCount: number;
  /** The reason the schedule stopped or is at risk of stopping, for display. */
  lastError?: string | null;
}

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
