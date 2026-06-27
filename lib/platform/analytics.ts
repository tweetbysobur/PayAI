/**
 * Analytics engine. Pure computation over the transaction log (every agent run)
 * enriched with on-chain merchant names. Produces the merchant dashboard's
 * revenue overview, trends, top customers, compliance metrics, and AI insights.
 *
 * Server-only (reads the in-process store + chain).
 */
import "server-only";
import { listTx } from "./store";
import type {
  AnalyticsSnapshot,
  Customer,
  ComplianceMetrics,
  Insight,
  RevenueOverview,
  TrendPoint,
  TxLogEntry,
} from "./types";

const DAY = 86_400_000;
const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function isSettled(t: TxLogEntry): boolean {
  return t.decision === "executed" && (t.amount ?? 0) > 0;
}
function isFailed(t: TxLogEntry): boolean {
  return t.decision === "blocked" || t.decision === "refused" || t.decision === "error";
}

export function computeRevenue(txs: TxLogEntry[]): RevenueOverview {
  const now = Date.now();
  const settled = txs.filter(isSettled);
  const sum = (since: number) =>
    settled.filter((t) => t.at >= since).reduce((s, t) => s + (t.amount ?? 0), 0);
  const failedCount = txs.filter(isFailed).length;
  const total = settled.reduce((s, t) => s + (t.amount ?? 0), 0);
  const considered = settled.length + failedCount;
  return {
    total,
    today: sum(now - DAY),
    thisWeek: sum(now - 7 * DAY),
    thisMonth: sum(now - 30 * DAY),
    currency: "USDC",
    settledCount: settled.length,
    failedCount,
    successRate: considered ? settled.length / considered : 1,
  };
}

export function computeTrend(txs: TxLogEntry[], days = 7): TrendPoint[] {
  const now = Date.now();
  const buckets = new Map<string, TrendPoint>();
  for (let i = days - 1; i >= 0; i--) {
    const k = dayKey(now - i * DAY);
    buckets.set(k, { date: k, revenue: 0, count: 0 });
  }
  for (const t of txs) {
    if (!isSettled(t)) continue;
    const k = dayKey(t.at);
    const b = buckets.get(k);
    if (b) {
      b.revenue += t.amount ?? 0;
      b.count += 1;
    }
  }
  return [...buckets.values()];
}

export function deriveCustomers(txs: TxLogEntry[], names: Record<string, string> = {}): Customer[] {
  const map = new Map<string, Customer>();
  for (const t of txs) {
    if (!isSettled(t) || !t.recipient) continue;
    const key = t.recipient.toLowerCase();
    const c =
      map.get(key) ??
      ({ address: t.recipient, name: names[key], totalPaid: 0, paymentCount: 0, avgRisk: 0, lastActivity: 0, riskLevel: "low" } as Customer);
    c.totalPaid += t.amount ?? 0;
    c.paymentCount += 1;
    c.avgRisk = (c.avgRisk * (c.paymentCount - 1) + (t.riskScore ?? 0)) / c.paymentCount;
    c.lastActivity = Math.max(c.lastActivity, t.at);
    c.riskLevel = c.avgRisk >= 60 ? "high" : c.avgRisk >= 30 ? "medium" : "low";
    map.set(key, c);
  }
  return [...map.values()].sort((a, b) => b.totalPaid - a.totalPaid);
}

export function computeCompliance(txs: TxLogEntry[]): ComplianceMetrics {
  let approved = 0, rejected = 0, review = 0, blocked = 0;
  for (const t of txs) {
    if (t.decision === "executed") approved++;
    else if (t.decision === "needs_review") review++;
    else if (t.decision === "blocked") { rejected++; blocked++; }
    else if (t.decision === "refused") blocked++;
  }
  const total = approved + rejected + review + blocked || 1;
  return { approved, rejected, review, blocked, approvalRate: approved / total };
}

export function detectInsights(txs: TxLogEntry[]): Insight[] {
  const out: Insight[] = [];
  const settled = txs.filter(isSettled);
  const failed = txs.filter(isFailed);

  // 1. High failure rate.
  const considered = settled.length + failed.length;
  if (considered >= 4 && failed.length / considered > 0.3) {
    out.push({
      id: "fail_rate", severity: "warning",
      title: "Elevated failure rate",
      detail: `${failed.length} of ${considered} recent payment attempts failed or were blocked.`,
      suggestion: "Review compliance rejections and guardrail caps; confirm recipients are resolvable.",
    });
  }

  // 2. Risky payments that still executed.
  const risky = settled.filter((t) => (t.riskScore ?? 0) >= 50);
  if (risky.length) {
    out.push({
      id: "risky_executed", severity: "warning",
      title: `${risky.length} higher-risk payment(s) executed`,
      detail: `Settled payments with risk ≥ 50 (max ${Math.max(...risky.map((t) => t.riskScore ?? 0))}).`,
      suggestion: "Consider lowering the auto-execute risk threshold or requiring review above 50.",
    });
  }

  // 3. Unusually large payment (> 3× median settled amount).
  if (settled.length >= 3) {
    const amts = settled.map((t) => t.amount ?? 0).sort((a, b) => a - b);
    const median = amts[Math.floor(amts.length / 2)] || 1;
    const big = settled.filter((t) => (t.amount ?? 0) > median * 3);
    for (const t of big.slice(0, 2)) {
      out.push({
        id: `large_${t.id}`, severity: "info",
        title: "Unusually large payment",
        detail: `${t.amount} ${t.token} to ${t.recipient?.slice(0, 10)}… (median is ${median}).`,
        suggestion: "Verify this transfer was expected.",
      });
    }
  }

  if (!out.length) {
    out.push({
      id: "healthy", severity: "info",
      title: "No anomalies detected",
      detail: settled.length ? "Recent activity looks normal." : "No payment activity yet.",
    });
  }
  return out;
}

/** Plain-language business summary for the AI assistant. */
export function buildSummary(snap: AnalyticsSnapshot): string {
  const r = snap.revenue;
  const top = snap.topCustomers[0];
  return [
    `You've settled ${r.settledCount} payment(s) for ${r.total} ${r.currency} total`,
    `(${r.thisWeek} this week), with a ${Math.round(r.successRate * 100)}% success rate.`,
    top ? `Top customer ${top.name ?? top.address.slice(0, 10) + "…"} paid ${top.totalPaid} ${r.currency}.` : "",
    `Compliance approval rate is ${Math.round(snap.compliance.approvalRate * 100)}%.`,
    snap.insights.find((i) => i.severity !== "info") ? `⚠ ${snap.insights.find((i) => i.severity !== "info")!.title}.` : "No anomalies flagged.",
  ].filter(Boolean).join(" ");
}

/** Assemble the full snapshot from the tx log + on-chain merchant names. */
export async function getAnalytics(merchantId: string): Promise<AnalyticsSnapshot> {
  const txs = await listTx(merchantId);
  let names: Record<string, string> = {};
  try {
    const { getOnchainMerchants } = await import("../monad/contracts");
    const merchants = await getOnchainMerchants();
    names = Object.fromEntries(merchants.map((m) => [m.wallet.toLowerCase(), m.name]));
  } catch {
    /* on-chain names are best-effort */
  }
  const revenue = computeRevenue(txs);
  return {
    revenue,
    trend: computeTrend(txs),
    volume: { count: revenue.settledCount, total: revenue.total },
    topCustomers: deriveCustomers(txs, names).slice(0, 5),
    compliance: computeCompliance(txs),
    insights: detectInsights(txs),
  };
}
