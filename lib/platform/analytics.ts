/**
 * Analytics engine. Pure computation over the transaction log (every agent run)
 * enriched with on-chain merchant names. Produces the merchant dashboard's
 * revenue overview, trends, top customers, compliance metrics, and AI insights.
 *
 * Server-only (reads the in-process store + chain).
 */
import "server-only";
import { listTx } from "./store";
import { DEMO_TENANT, listAllMerchantIds } from "./merchants";
import type {
  AnalyticsSnapshot,
  Customer,
  ComplianceMetrics,
  Insight,
  RevenueFeature,
  RevenueOverview,
  TrendPoint,
  TxLogEntry,
} from "./types";
import type { TokenInfo } from "../monad/tokenRegistry";

const FEATURES: RevenueFeature[] = ["payment", "swap", "automation", "bulk"];

/** Which feature bucket a tx's revenue belongs in. Falls back to inferring
 *  from `action` for entries recorded before TxLogEntry.feature existed. */
function featureOf(t: TxLogEntry): RevenueFeature {
  if (t.feature === "trade") return "swap";
  // Never reached for volume (every aggregation skips protocol rows first);
  // here only so the type stays exhaustive.
  if (t.feature === "protocol") return "swap";
  if (t.feature) return t.feature;
  return t.action === "swap" ? "swap" : "payment";
}

const DAY = 86_400_000;
const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function isSettled(t: TxLogEntry): boolean {
  // A swap moves your own money between two tokens you already hold. Counting
  // it as settled payment volume double-counts funds that never left, and
  // inflates "revenue" with an amount nobody paid anybody.
  return t.decision === "executed" && t.action !== "swap" && t.feature !== "protocol" && (t.amount ?? 0) > 0;
}
function isFailed(t: TxLogEntry): boolean {
  return t.decision === "blocked" || t.decision === "refused" || t.decision === "error";
}

/**
 * Settled amounts, summed separately per token.
 *
 * Amounts in different assets cannot be added together. 5 MON plus 5 USDC is
 * not 10 of anything, and presenting it as one figure invents a number that
 * no transaction supports. (lib/platform/analytics.ts already refuses to do
 * this for platform-wide activity — see PlatformActivity.volumeByToken; the
 * per-merchant view simply never got the same treatment.)
 */
export function sumByToken(txs: TxLogEntry[], since = 0): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of txs) {
    if (!isSettled(t) || t.at < since) continue;
    const token = t.token || "USDC";
    out[token] = (out[token] ?? 0) + (t.amount ?? 0);
  }
  return out;
}

/**
 * Volume of every completed transaction across every feature — payments,
 * swaps, automations, bulk distributions — summed separately per token.
 *
 * Deliberately NOT the same as sumByToken/isSettled: this measures total
 * platform activity, so a swap counts here even though (per isSettled's
 * comment above) it still isn't money paid to someone else and must stay
 * out of revenue. Keep the two separate rather than merging swaps into
 * revenue — this function answers "how much moved through PayAI," not
 * "how much did anyone get paid."
 */
export function sumActivityByToken(txs: TxLogEntry[], since = 0): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of txs) {
    if (t.decision !== "executed" || t.feature === "protocol" || (t.amount ?? 0) <= 0 || t.at < since) continue;
    const token = t.token || "USDC";
    out[token] = (out[token] ?? 0) + (t.amount ?? 0);
  }
  return out;
}

/**
 * Every completed transaction across every feature, bucketed by calendar
 * month and by feature, amounts kept per-token (never blended — same rule as
 * sumByToken/sumActivityByToken). `months` calendar months ending with the
 * current one, oldest first; a month with no activity still gets a bucket so
 * a chart over this data never has a hole.
 */
export function computeMonthlyVolumeByFeature(txs: TxLogEntry[], months = 6): MonthlyFeatureVolume[] {
  const now = new Date();
  const buckets = new Map<string, MonthlyFeatureVolume>();
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = d.toISOString().slice(0, 7);
    buckets.set(key, {
      month: key,
      byFeature: { payment: {}, swap: {}, automation: {}, bulk: {} },
    });
  }
  for (const t of txs) {
    if (t.decision !== "executed" || t.feature === "protocol" || (t.amount ?? 0) <= 0) continue;
    const key = new Date(t.at).toISOString().slice(0, 7);
    const bucket = buckets.get(key);
    if (!bucket) continue; // outside the window
    const byFeatureToken = bucket.byFeature[featureOf(t)];
    const token = t.token || "USDC";
    byFeatureToken[token] = (byFeatureToken[token] ?? 0) + (t.amount ?? 0);
  }
  return [...buckets.values()];
}

/**
 * Live USD prices for whichever token symbols appear in `tokens`, resolved
 * against the verified token registry and quoted off the same DEX the swap
 * engine uses (lib/monad/prices.ts) — current market rate, never a
 * fabricated or historical-at-tx-time number. A symbol this deployment
 * can't confidently price (unverified, no pool, or a pool too shallow to
 * trust) is simply absent from the returned price map.
 */
async function loadUsdPrices(tokens: string[]): Promise<{
  bySymbol: Map<string, TokenInfo>;
  prices: Record<string, number | null>;
}> {
  const { getVerifiedTokens } = await import("../monad/tokenRegistry");
  const { getUsdPrices } = await import("../monad/prices");
  const verified = await getVerifiedTokens();
  const bySymbol = new Map(verified.map((t) => [t.symbol.toUpperCase(), t]));
  const targets = [...new Set(tokens.map((s) => s.toUpperCase()))]
    .map((s) => bySymbol.get(s))
    .filter((t): t is TokenInfo => !!t);
  const prices = targets.length ? await getUsdPrices(targets) : {};
  return { bySymbol, prices };
}

/** Convert one per-token amount map to a USD total using an already-loaded
 *  price map (see loadUsdPrices) — pure/local, no network of its own, so
 *  pricing dozens of buckets (months × features) costs one price fetch
 *  total instead of one per bucket. A token absent from the price map is
 *  left OUT of the total and named in `unpriced`, rather than guessed at —
 *  the total is real money moved, only ever under-reported, never invented. */
function usdTotal(
  byToken: Record<string, number>,
  bySymbol: Map<string, TokenInfo>,
  prices: Record<string, number | null>,
): { totalUsd: number | null; unpriced: string[] } {
  let total = 0;
  let anyPriced = false;
  const unpriced: string[] = [];
  for (const [sym, amount] of Object.entries(byToken)) {
    if (!(amount > 0)) continue;
    const t = bySymbol.get(sym.toUpperCase());
    const usd = t ? prices[t.address.toLowerCase()] : null;
    if (t && usd != null) {
      total += amount * usd;
      anyPriced = true;
    } else {
      unpriced.push(sym);
    }
  }
  return { totalUsd: anyPriced ? total : null, unpriced };
}

/** A USD amount converted to its MON-equivalent using an already-loaded
 *  price map (see loadUsdPrices) — MON is the platform's native asset, so
 *  the platform-wide headline figures are denominated in it, with the $
 *  value shown alongside rather than instead of it. `null` when either the
 *  USD amount or MON's own live price is unavailable — never shown as
 *  "≈ 0 MON", which would misrepresent "can't convert" as "worth nothing". */
export function usdToMon(
  usd: number | null,
  bySymbol: Map<string, TokenInfo>,
  prices: Record<string, number | null>,
): number | null {
  if (usd == null) return null;
  const mon = bySymbol.get("MON");
  const monPrice = mon ? prices[mon.address.toLowerCase()] : null;
  if (!monPrice) return null;
  return usd / monPrice;
}

/** The token the headline figures are denominated in: whichever asset this
 *  merchant has actually settled the most payments in. Falls back to USDC so
 *  an empty dashboard still has something to label its zeroes with. */
export function headlineCurrency(txs: TxLogEntry[]): string {
  const counts = new Map<string, number>();
  for (const t of txs) {
    if (!isSettled(t)) continue;
    const token = t.token || "USDC";
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  let best = "USDC";
  let bestCount = 0;
  for (const [token, count] of counts) {
    if (count > bestCount) { best = token; bestCount = count; }
  }
  return best;
}

export function computeRevenue(txs: TxLogEntry[]): RevenueOverview {
  const now = Date.now();
  const currency = headlineCurrency(txs);
  const settled = txs.filter(isSettled);
  // Headline figures are ONE token's worth. They used to add every settled
  // amount together and label the result USDC, so a 5 MON payment showed up as
  // 5 USDC of revenue. Everything else is still reported, per token, in
  // `byToken` — under-reporting one headline is recoverable, a fabricated
  // total is not.
  const inCurrency = settled.filter((t) => (t.token || "USDC") === currency);
  const sum = (since: number) =>
    inCurrency.filter((t) => t.at >= since).reduce((s, t) => s + (t.amount ?? 0), 0);
  const failedCount = txs.filter(isFailed).length;
  const considered = settled.length + failedCount;
  return {
    total: inCurrency.reduce((s, t) => s + (t.amount ?? 0), 0),
    today: sum(now - DAY),
    thisWeek: sum(now - 7 * DAY),
    thisMonth: sum(now - 30 * DAY),
    currency,
    byToken: sumByToken(txs),
    settledCount: settled.length,
    failedCount,
    successRate: considered ? settled.length / considered : 1,
  };
}

export function computeTrend(txs: TxLogEntry[], days = 7, currency = headlineCurrency(txs)): TrendPoint[] {
  const now = Date.now();
  const buckets = new Map<string, TrendPoint>();
  for (let i = days - 1; i >= 0; i--) {
    const k = dayKey(now - i * DAY);
    buckets.set(k, { date: k, revenue: 0, count: 0 });
  }
  for (const t of txs) {
    // Same rule as the headline: one currency per chart, so a bar's height
    // means something. `count` still counts every settled payment.
    if (!isSettled(t) || (t.token || "USDC") !== currency) continue;
    const k = dayKey(t.at);
    const b = buckets.get(k);
    if (b) {
      b.revenue += t.amount ?? 0;
      b.count += 1;
    }
  }
  return [...buckets.values()];
}

export function deriveCustomers(
  txs: TxLogEntry[],
  names: Record<string, string> = {},
  currency = headlineCurrency(txs),
): Customer[] {
  const map = new Map<string, Customer>();
  for (const t of txs) {
    // `totalPaid` is rendered next to the headline currency, so it has to be
    // that currency alone — otherwise the top-customer list ranks people by a
    // sum of unlike amounts.
    if (!isSettled(t) || !t.recipient || (t.token || "USDC") !== currency) continue;
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

/** Raw (per-token, never blended) volume for one calendar month, broken down
 *  by feature. See computeMonthlyVolumeByFeature. */
export interface MonthlyFeatureVolume {
  month: string; // YYYY-MM
  byFeature: Record<RevenueFeature, Record<string, number>>;
}

/** One calendar month's volume, in USD, broken down by feature. A `null`
 *  feature/total means nothing in it could be confidently priced that
 *  month — shown as "—" in the UI, never as $0 (which would read as "no
 *  activity" when the truth is "activity we can't price"). */
export interface MonthlyFeatureUsd {
  month: string; // YYYY-MM
  byFeature: Record<RevenueFeature, number | null>;
  total: number | null;
}

export interface PlatformActivity {
  /** Settled (executed) payments across every tenant — counts every real
   *  payment PayAI has processed, custodial or wallet-signed, not just the
   *  ones anchored on PaymentExecutor (most payments are direct wallet sends
   *  that never touch that contract). */
  totalPayments: number;
  /** Settled volume, summed separately per token — never blended into one
   *  number across different assets, which would misrepresent the amount. */
  volumeByToken: Record<string, number>;
  /** volumeByToken converted to a single USD figure, then to its
   *  MON-equivalent — the headline "X MON (≈ $Y)" figure, replacing a
   *  per-token list (which reads as clutter once every asset can be
   *  expressed in one real unit). Converting-then-summing is not the
   *  cross-asset blending sumByToken refuses to do (5 MON + 5 USDC is not
   *  10 of anything; 5 MON worth of USD + 5 USDC worth of USD is a real
   *  $10). `null` when nothing could be priced — see unpricedSettledTokens. */
  settledVolumeUsd: number | null;
  settledVolumeMon: number | null;
  /** Token symbols in volumeByToken that could NOT be priced (unverified,
   *  no pool, or an untrustworthy quote) — so settledVolumeUsd/Mon are
   *  never presented as more complete than they are. */
  unpricedSettledTokens: string[];
  /** Volume of every COMPLETED transaction across every feature — payments,
   *  swaps, automations, bulk distributions — summed separately per token.
   *  Unlike volumeByToken, this includes swaps: it's total platform
   *  activity, kept separate from (not blended into) settled payment
   *  volume/revenue above. See sumActivityByToken. */
  activityVolumeByToken: Record<string, number>;
  /** activityVolumeByToken converted to a single USD figure, then to its
   *  MON-equivalent — same "one number, not a per-token list" treatment as
   *  settledVolumeUsd/Mon above, for the swap-inclusive activity total.
   *  `null` when nothing in activityVolumeByToken could be priced. See
   *  unpricedTokens for what (if anything) is excluded from it. */
  activityVolumeUsd: number | null;
  activityVolumeMon: number | null;
  /** Token symbols present in activityVolumeByToken that could NOT be
   *  priced (unverified, no pool, or an untrustworthy quote) — so
   *  activityVolumeUsd is never presented as more complete than it is. */
  unpricedTokens: string[];
  /** Last 6 calendar months, oldest first, activity volume in USD broken
   *  down by feature — see MonthlyFeatureUsd. */
  monthlyVolumeUsd: MonthlyFeatureUsd[];
  /** Aggregate compliance outcome across every payment (approval rate etc.). */
  compliance: ComplianceMetrics;
  /** Settled payments per day for the last 7 days — real activity series. */
  trend: TrendPoint[];
  /** The most recent settled payments as {token, amount} ONLY — no recipient,
   *  sender, or tx hash, so nothing here identifies a user. Powers the public
   *  "recent activity" preview without leaking anyone's wallet or history. */
  recent: { token: string; amount: number }[];
}

/**
 * Platform-wide activity for the public landing page: aggregate counts, per-token
 * volume, compliance rate, a 7-day trend, and recent (anonymized) amounts across
 * every tenant. Deliberately returns ONLY aggregate/non-identifying numbers —
 * never a recipient, sender, or wallet address — so it's safe to expose on an
 * unauthenticated, public endpoint.
 */
export async function getPlatformActivity(): Promise<PlatformActivity> {
  const merchantIds = await listAllMerchantIds();
  const tenantIds = [...new Set([DEMO_TENANT, ...merchantIds])];
  const txLists = await Promise.all(tenantIds.map((id) => listTx(id)));
  const allTxs = txLists.flat().sort((a, b) => b.at - a.at);

  const settled = allTxs.filter(isSettled);
  const volumeByToken: Record<string, number> = {};
  for (const t of settled) {
    volumeByToken[t.token] = (volumeByToken[t.token] ?? 0) + (t.amount ?? 0);
  }
  const activityVolumeByToken = sumActivityByToken(allTxs);
  const monthly = computeMonthlyVolumeByFeature(allTxs, 6);

  // One price fetch for every token this response could possibly need,
  // shared across both headline totals and all 6 months × 4 features — not
  // one fetch per figure. "MON" is always included: the headline figures
  // are denominated in it even on a request with zero native-token activity.
  const allTokens = new Set<string>(["MON", ...Object.keys(activityVolumeByToken)]);
  for (const m of monthly) for (const f of FEATURES) for (const tok of Object.keys(m.byFeature[f])) allTokens.add(tok);

  let settledVolumeUsd: number | null = null;
  let settledVolumeMon: number | null = null;
  let unpricedSettledTokens: string[] = [];
  let activityVolumeUsd: number | null = null;
  let activityVolumeMon: number | null = null;
  let unpricedTokens: string[] = [];
  let monthlyVolumeUsd: MonthlyFeatureUsd[];
  try {
    const { bySymbol, prices } = await loadUsdPrices([...allTokens]);

    const settledOverall = usdTotal(volumeByToken, bySymbol, prices);
    settledVolumeUsd = settledOverall.totalUsd;
    unpricedSettledTokens = settledOverall.unpriced;
    settledVolumeMon = usdToMon(settledVolumeUsd, bySymbol, prices);

    const activityOverall = usdTotal(activityVolumeByToken, bySymbol, prices);
    activityVolumeUsd = activityOverall.totalUsd;
    unpricedTokens = activityOverall.unpriced;
    activityVolumeMon = usdToMon(activityVolumeUsd, bySymbol, prices);

    monthlyVolumeUsd = monthly.map((m) => {
      const byFeature = {} as Record<RevenueFeature, number | null>;
      let total: number | null = null;
      for (const feature of FEATURES) {
        const { totalUsd } = usdTotal(m.byFeature[feature], bySymbol, prices);
        byFeature[feature] = totalUsd;
        if (totalUsd != null) total = (total ?? 0) + totalUsd;
      }
      return { month: m.month, byFeature, total };
    });
  } catch {
    // Pricing is best-effort (live on-chain quotes) — a failure here must
    // never take down the whole platform-stats response, just leave the USD
    // figures unavailable.
    unpricedSettledTokens = Object.keys(volumeByToken);
    unpricedTokens = [...allTokens];
    monthlyVolumeUsd = monthly.map((m) => ({
      month: m.month,
      byFeature: { payment: null, swap: null, automation: null, bulk: null },
      total: null,
    }));
  }

  const recent = settled.slice(0, 8).map((t) => ({ token: t.token, amount: t.amount ?? 0 }));
  return {
    totalPayments: settled.length,
    volumeByToken,
    settledVolumeUsd,
    settledVolumeMon,
    unpricedSettledTokens,
    activityVolumeByToken,
    activityVolumeUsd,
    activityVolumeMon,
    unpricedTokens,
    monthlyVolumeUsd,
    compliance: computeCompliance(allTxs),
    trend: computeTrend(allTxs, 7),
    recent,
  };
}

/** Assemble the full snapshot from the tx log + on-chain merchant names.
 *  When `sender` is given, the snapshot covers only that wallet's activity —
 *  so a connected user's analytics reflect their own payments, not the whole
 *  shared demo tenant. */
export async function getAnalytics(merchantId: string, opts?: { sender?: string | null }): Promise<AnalyticsSnapshot> {
  const txs = await listTx(merchantId, { sender: opts?.sender });
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
    trend: computeTrend(txs, 7, revenue.currency),
    volume: { count: revenue.settledCount, total: revenue.total },
    topCustomers: deriveCustomers(txs, names, revenue.currency).slice(0, 5),
    compliance: computeCompliance(txs),
    insights: detectInsights(txs),
  };
}
