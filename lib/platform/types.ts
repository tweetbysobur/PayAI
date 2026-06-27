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
  riskScore: number | null;
  compliance: string | null;
  txHash?: string;
  explorerUrl?: string;
  summary: string;
}

export type LinkStatus = "active" | "paid" | "expired";

export interface PaymentLink {
  id: string;
  merchantId: string;
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
