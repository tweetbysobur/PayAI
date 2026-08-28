"use client";

import { useCallback, useMemo, useState } from "react";
import { motion } from "motion/react";
import Link from "next/link";
import {
  ArrowDownLeft, ShieldCheck, Receipt, Send, FileText, UserPlus,
  ScrollText, Store, Wallet, Copy, Check, Repeat, TrendingUp, Coins, Activity, Sparkles, ArrowRight,
  ArrowLeftRight, CheckCircle2, Clock3, XCircle, AlertTriangle, ExternalLink,
} from "lucide-react";
import { Card, CountUp } from "@/components/ui";
import { AskMark } from "@/components/AskMark";
import { Identicon } from "@/components/Identicon";
import { MonadMark } from "@/components/MonadMark";
import { TokenLogo } from "@/components/TokenLogo";
import dynamic from "next/dynamic";
import { useCopy } from "@/lib/hooks/useCopy";
// Lazy-loaded: pulls in viem + qrcode.react, only needed once someone opens it.
const ReceiveModal = dynamic(() => import("@/components/dashboard/ReceiveModal").then((m) => m.ReceiveModal), { ssr: false });
import { useWalletService as useWallet } from "@/lib/wallet-service/WalletServiceContext";
import { WelcomeCard } from "@/components/dashboard/WelcomeCard";
import { PortfolioCard } from "@/components/dashboard/PortfolioCard";
import { useIdentity } from "@/lib/hooks/useIdentity";
import { useSyncRefresher } from "@/lib/hooks/useSync";
import { SyncButton } from "@/components/dashboard/SyncButton";

interface Revenue { total: number; today: number; thisWeek: number; thisMonth: number; currency: string; settledCount: number; failedCount: number; successRate: number }
interface TrendPoint { date: string; revenue: number; count: number }
interface Compliance { approved: number; rejected: number; review: number; blocked: number; approvalRate: number }
interface Analytics { revenue: Revenue; trend: TrendPoint[]; volume: { count: number; total: number }; compliance: Compliance }
interface HistoryRow { at: number; decision: string; summary: string; amount: number | null; token: string; recipient?: string | null; domain?: string | null; txHash?: string; explorerUrl?: string; action?: string; feature?: string }
interface Automation { id: string; amount: number; token: string; recipient: string; domain?: string | null; cadence: string; nextRun: number; status: string; purpose?: string }

const short = (s?: string | null) => (s ? `${s.slice(0, 6)}…${s.slice(-4)}` : "—");
const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });

const DECISION_LABEL: Record<string, string> = {
  executed: "Sent", needs_review: "Needs review", blocked: "Blocked", refused: "Refused", error: "Failed",
};
const DECISION_ICON: Record<string, typeof CheckCircle2> = {
  executed: CheckCircle2, needs_review: Clock3, blocked: XCircle, refused: XCircle, error: AlertTriangle,
};
/** Same success/warning/danger/neutral tones as everywhere else, just mapped
 *  onto the icon chip's bg/text pair instead of a Badge's border+bg. */
const DECISION_ICON_TONE: Record<string, string> = {
  executed: "bg-success/12 text-success",
  needs_review: "bg-warning/12 text-warning",
  blocked: "bg-danger/12 text-danger",
  refused: "bg-danger/12 text-danger",
  error: "bg-input text-muted-foreground",
};

export default function Overview() {
  const wallet = useWallet();
  const identity = useIdentity(wallet.address);
  const [a, setA] = useState<Analytics | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [health, setHealth] = useState<{ wallet?: { network: string } | null } | null>(null);
  const { copy, copied } = useCopy();
  const [receiveOpen, setReceiveOpen] = useState(false);

  const refresh = useCallback(() => {
    // Scope the user's own views to their connected wallet — the server returns
    // only this wallet's history/analytics, never another user's (see
    // /api/analytics + /api/agent show_history). Without a wallet, there's no
    // identity to scope to, so these come back empty by design.
    const walletHeaders = wallet.address ? { "x-wallet-address": wallet.address } : undefined;
    // Returned so the global sync can wait for all of it — a spinner that
    // stops before the data lands is worse than no spinner.
    return Promise.all([
      fetch("/api/analytics", { headers: walletHeaders }).then((r) => r.json()).then(setA).catch(() => {}),
      fetch("/api/health").then((r) => r.json()).then(setHealth).catch(() => {}),
      fetch(`/api/automations${wallet.address ? `?wallet=${wallet.address}` : ""}`).then((r) => r.json()).then((j) => setAutomations(j.automations ?? [])).catch(() => {}),
      fetch("/api/agent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ intent: "Show my transaction history", walletAddress: wallet.address }) })
        .then((r) => r.json()).then((j) => setHistory(j.history ?? [])).catch(() => {}),
    ]);
  }, [wallet.address]);

  // The page no longer runs its own timer. It joins the dashboard's single
  // sync — which keeps the same visibility-aware cadence, but means the
  // Refresh button, a completed swap and the background heartbeat all update
  // this page through exactly one path instead of three.
  useSyncRefresher(refresh);

  // A row is a trade if its feature/action marks it as a swap or trade — the
  // same rule the analytics module uses in featureOf; everything else settled
  // is a payment. Used by the insights split below (scoped to the recent window
  // this endpoint returns, hence surfaced as context, not a lifetime KPI — the
  // headline KPIs use the uncapped analytics totals instead).
  const isTradeRow = (h: HistoryRow) => h.feature === "swap" || h.feature === "trade" || h.action === "swap";

  // AI insights — patterns across ALL settled activity (payments and trades
  // alike), derived from the transaction log, never fabricated. This used to
  // speak only in payment terms ("Largest payment", "Average payment") even
  // though the same log already carries swaps and trades; the framing is now
  // capability-neutral, and the payment/trade split is surfaced directly.
  const insights = useMemo(() => {
    const settled = history.filter((h) => h.decision === "executed" && h.amount != null);
    if (settled.length === 0) return null;
    const largest = settled.reduce((m, h) => (h.amount! > (m.amount ?? 0) ? h : m), settled[0]);
    const byAsset = settled.reduce<Record<string, number>>((acc, h) => { acc[h.token] = (acc[h.token] ?? 0) + 1; return acc; }, {});
    const topAsset = Object.entries(byAsset).sort((x, y) => y[1] - x[1])[0]?.[0] ?? "—";
    const byDay = settled.reduce<Record<string, number>>((acc, h) => { const d = new Date(h.at).toLocaleDateString(undefined, { weekday: "long" }); acc[d] = (acc[d] ?? 0) + 1; return acc; }, {});
    const topDay = Object.entries(byDay).sort((x, y) => y[1] - x[1])[0]?.[0] ?? "—";
    const trades = settled.filter(isTradeRow).length;
    return { largest, topAsset, topDay, trades, payments: settled.length - trades };
  }, [history]);

  const upcoming = automations.filter((s) => s.status === "active" || s.status === "scheduled" || s.status === "executing");
  const network = health?.wallet?.network ?? "Monad";
  // "Locked" is deliberately distinct from "Not connected": after a reload the
  // embedded wallet's in-memory key is gone, but the wallet itself still
  // exists and is one passkey check away. Showing "Not connected" there reads
  // like the wallet was lost.
  const walletStatus = wallet.isLocked
    ? { label: "Locked", tone: "warning" as const }
    : !wallet.address
      ? { label: "Not connected", tone: "neutral" as const }
      : wallet.isWrongNetwork
        ? { label: "Wrong network", tone: "warning" as const }
        : { label: "Active", tone: "success" as const };

  function copyAddr() {
    if (!wallet.address) return;
    void copy(wallet.address, "Address copied");
  }

  return (
    <div className="mx-auto max-w-7xl">
      <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }} className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Overview</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">Your on-chain operator on Monad — payments, trades, and automations in one place.</p>
        </div>
        {/* Refreshes the whole dashboard, not just this page — see
            lib/hooks/useSync.tsx for what is registered. */}
        <SyncButton className="shrink-0 pt-1" />
      </motion.div>

      {/* Ask PayAI — the primary affordance, not a ⌘K afterthought. This is
          the product: describe an intent in natural language and PayAI
          prepares the action for review. Styled as the dashboard's strongest
          element (purple wash, display type, a composer-shaped entry) so the
          hierarchy says "start here" without adding another equal-weight card.
          It is a Link into the real /dashboard/ask surface — no capability is
          claimed here that the chat doesn't already do. */}
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, delay: 0.05 }} className="mb-6">
        <Link
          href="/dashboard/ask"
          className="group relative block overflow-hidden rounded-2xl border border-primary/30 bg-gradient-to-br from-primary/[0.1] via-panel to-panel p-6 shadow-[0_25px_70px_-35px_hsl(var(--primary)/0.5)] transition-all duration-200 hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:p-7"
        >
          <div aria-hidden className="pointer-events-none absolute inset-0 rounded-2xl ring-1 ring-inset ring-primary/15" />
          <div className="relative flex items-start gap-4">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/20 text-primary-ink transition-colors group-hover:bg-primary/30">
              <AskMark size={20} />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">What do you want to do on-chain?</h2>
              <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-muted-foreground">
                Describe your intent and PayAI will prepare the action for you to review and approve.
              </p>
              {/* Composer-shaped entry — reads as "type here", but is a link
                  into the real Ask PayAI surface where the actual input lives. */}
              <div className="mt-4 flex items-center gap-2.5 rounded-xl border border-border bg-background/60 px-3.5 py-2.5 transition-colors group-hover:border-primary/40">
                <Sparkles size={15} className="shrink-0 text-primary-ink" />
                <span className="flex-1 truncate text-sm text-muted-foreground">Send a payment, trade a token, or automate something…</span>
                <span className="hidden shrink-0 items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground sm:inline-flex">
                  Ask PayAI <ArrowRight size={13} className="transition-transform duration-200 group-hover:translate-x-0.5" />
                </span>
              </div>
            </div>
          </div>
        </Link>
      </motion.div>

      {/* A brand-new wallet lands on a dashboard with nothing in it, which
          says "you have nothing" rather than "here's what to do". This shows
          only while there is genuinely no activity, and retires itself for
          good the moment there is. */}
      <WelcomeCard
        address={wallet.address}
        show={!!wallet.address && history.length === 0 && automations.length === 0}
      />

      {/* Wallet summary */}
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }} className="mb-5">
        <Card className="!p-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              {wallet.address ? <Identicon address={wallet.address} size={40} /> : <span className="flex h-10 w-10 items-center justify-center rounded-full bg-input text-muted-foreground"><Wallet size={18} /></span>}
              <div>
                <div className="flex items-center gap-2">
                  {identity.domain ? (
                    <p className="text-sm font-semibold text-foreground">{identity.domain}</p>
                  ) : (
                    <p className="font-mono text-sm text-foreground">{wallet.address ? identity.display : wallet.isLocked ? "Wallet locked" : "No wallet connected"}</p>
                  )}
                  {wallet.address && (
                    <button onClick={copyAddr} className="text-muted-foreground transition hover:text-foreground" title="Copy address">
                      {copied === wallet.address ? <Check size={13} className="text-success" /> : <Copy size={13} />}
                    </button>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {wallet.address
                    ? (identity.domain ? <span className="font-mono">{short(wallet.address)}</span> : "Connected wallet")
                    : wallet.isLocked
                      ? <button onClick={() => { void wallet.setUpEmbeddedWallet({ create: false }).catch(() => {}); }} className="text-primary-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm">Unlock with your passkey →</button>
                      : <Link href="/auth" className="text-primary-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm">Connect to get started →</Link>}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-5">
              <div className="text-right">
                <div className="flex items-center justify-end gap-1.5 text-sm font-medium text-foreground"><MonadMark size={14} /> {network}</div>
                <p className="mt-0.5 text-xs text-muted-foreground">Network</p>
              </div>
              <div className="text-right">
                <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${
                  { success: "border-success/30 bg-success/10 text-success", warning: "border-warning/30 bg-warning/10 text-warning", neutral: "border-border bg-input text-muted-foreground" }[walletStatus.tone]
                }`}>
                  <span className="relative flex h-1.5 w-1.5">
                    {/* The pulse is what makes "Active" read as a live signal
                        rather than a static label — reserved for the one
                        state that's actually live right now. */}
                    {walletStatus.tone === "success" && (
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75 motion-reduce:hidden" />
                    )}
                    <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${{ success: "bg-success", warning: "bg-warning", neutral: "bg-muted-foreground" }[walletStatus.tone]}`} />
                  </span>
                  {walletStatus.label}
                </span>
                <p className="mt-1 text-xs text-muted-foreground">Status</p>
              </div>
            </div>
          </div>
        </Card>
      </motion.div>

      {/* Primary actions — the fast path: pay or get paid */}
      <div className="mb-5 grid grid-cols-2 gap-3 sm:max-w-md">
        <Link href="/dashboard/payments" className="flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3.5 text-sm font-medium text-primary-foreground transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
          <Send size={16} /> Send
        </Link>
        <button onClick={() => setReceiveOpen(true)} className="flex items-center justify-center gap-2 rounded-xl border border-border bg-panel px-4 py-3.5 text-sm font-medium text-foreground transition hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <ArrowDownLeft size={16} /> Receive
        </button>
      </div>

      {/* Headline KPIs — capability-neutral, covering all of PayAI's activity
          rather than payments alone. Every figure here is a real, uncapped
          total from the analytics/automations the page already fetches:
          `volume.count` is every completed transaction across every feature
          (payments, swaps, automations, bulk); `settledCount` is settled
          payments; automations is this wallet's configured automations;
          success rate is settled/(settled+failed). Balances aren't dropped —
          the PortfolioCard directly below is their fuller home, with every
          token and its dollar value, not just MON/USDC.

          A dedicated "Trades" KPI is deliberately NOT here: no current
          endpoint exposes an exact, uncapped trade count, and a headline
          number derived from the capped history slice would over- or
          under-state it. Trading presence is surfaced honestly in the recent
          insights row below and the Swaps filter on the Activity tab. */}
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: "On-chain activity", value: a?.volume.count ?? null, decimals: 0, unit: null, placeholder: "—", icon: Activity, token: null, tone: "primary" as const, usd: null },
          { label: "Payments settled", value: a?.revenue.settledCount ?? null, decimals: 0, unit: null, placeholder: "—", icon: Send, token: null, tone: "success" as const, usd: null },
          { label: "Automations", value: automations.length || (a ? 0 : null), decimals: 0, unit: null, placeholder: "—", icon: Repeat, token: null, tone: "neutral" as const, usd: null },
          { label: "Success rate", value: a && a.volume.count > 0 ? Math.round(a.revenue.successRate * 100) : null, decimals: 0, unit: a && a.volume.count > 0 ? "%" : null, placeholder: "—", icon: ShieldCheck, token: null, tone: "neutral" as const, usd: null },
        ].map((k, i) => {
          const iconTone = { primary: "bg-primary/12 text-primary-ink", success: "bg-success/12 text-success", neutral: "bg-input text-muted-foreground" }[k.tone];
          return (
            <motion.div key={k.label} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05, duration: 0.3 }} whileHover={{ y: -2 }}>
              <Card className="p-5 transition-colors hover:border-primary/30">
                <div className={`mb-3 flex h-9 w-9 items-center justify-center rounded-lg ${iconTone}`}>{k.token ? <TokenLogo token={k.token} size={18} /> : <k.icon size={16} />}</div>
                <p className="text-2xl font-semibold tracking-tight text-foreground [font-variant-numeric:tabular-nums]">
                  {k.value != null ? <CountUp value={k.value} decimals={k.decimals} /> : k.placeholder}
                  {k.value != null && k.unit && <span className={`text-sm font-medium text-muted-foreground ${k.unit === "%" ? "" : "ml-1.5"}`}>{k.unit}</span>}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">{k.label}</p>
                {/* Approximate dollar value, only when the token is genuinely
                    priceable. Reserved line height so a tile never reflows when
                    the price resolves a moment after the balance. */}
                {k.token && (
                  <p className="mt-0.5 min-h-[1rem] text-[11px] tabular-nums text-muted-foreground/70">
                    {k.usd ?? ""}
                  </p>
                )}
              </Card>
            </motion.div>
          );
        })}
      </div>

      {/* Everything this wallet holds, at its real dollar value — not just the
          MON/USDC tiles above. Reuses the exact PortfolioCard/usePortfolio
          pair already proven on the Wallets page: holdings are DISCOVERED
          from on-chain transfers, not a maintained list, so a token bought
          through Ask PayAI's trade flow (a memecoin, a Nad.Fun launch,
          anything) shows up here on its own with a real price or an honest
          "—", never a fabricated number. */}
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15, duration: 0.3 }} className="mb-5">
        <PortfolioCard address={wallet.readAddress} locked={wallet.isLocked} />
      </motion.div>

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        {/* Recent transactions */}
        <Card title="Recent transactions" right={<Link href="/dashboard/transactions" className="text-xs text-primary-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm">View all</Link>}>
          {history.length === 0 ? (
            <EmptyHint icon={Receipt} title="No transactions yet" hint="Describe a payment or a trade in Ask PayAI, or use the form directly. It settles on Monad in seconds." cta={{ label: "Ask PayAI", href: "/dashboard/ask" }} />
          ) : (
            <ul className="divide-y divide-border">
              {history.slice(0, 6).map((h, i) => {
                const StatusIcon = DECISION_ICON[h.decision] ?? AlertTriangle;
                return (
                  <motion.li
                    key={i}
                    initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04, duration: 0.25 }}
                    className="flex items-center gap-3 py-3 first:pt-0 last:pb-0"
                  >
                    <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${DECISION_ICON_TONE[h.decision] ?? "bg-input text-muted-foreground"}`}>
                      <StatusIcon size={16} />
                    </span>

                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">{h.domain ?? short(h.recipient)}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {DECISION_LABEL[h.decision] ?? h.decision} · {new Date(h.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                      </p>
                    </div>

                    <div className="shrink-0 text-right">
                      <p className="flex items-center justify-end gap-1.5 text-sm font-semibold tabular-nums text-foreground">
                        <TokenLogo token={h.token} size={13} />
                        {h.amount ?? "—"} <span className="text-xs font-normal text-muted-foreground">{h.token}</span>
                      </p>
                      {h.txHash && h.explorerUrl ? (
                        <a href={h.explorerUrl} target="_blank" rel="noreferrer" className="mt-0.5 inline-flex items-center gap-0.5 font-mono text-[11px] text-primary-ink hover:underline">
                          {short(h.txHash)} <ExternalLink size={9} />
                        </a>
                      ) : (
                        <span className="mt-0.5 block text-[11px] text-muted-foreground">—</span>
                      )}
                    </div>
                  </motion.li>
                );
              })}
            </ul>
          )}
        </Card>

        {/* Compliance status */}
        <Card title="Payment checks">
          {a ? (
            <div className="flex flex-col items-center">
              <div className="relative h-32 w-32" title={`${Math.round(a.compliance.approvalRate * 100)}% approval rate`}>
                <svg width="128" height="128" viewBox="0 0 128 128" className="-rotate-90">
                  <circle cx="64" cy="64" r="54" fill="none" stroke="var(--color-border)" strokeWidth="10" />
                  <motion.circle cx="64" cy="64" r="54" fill="none" stroke="var(--color-success)" strokeWidth="10" strokeLinecap="round"
                    strokeDasharray={2 * Math.PI * 54} initial={{ strokeDashoffset: 2 * Math.PI * 54 }}
                    animate={{ strokeDashoffset: 2 * Math.PI * 54 * (1 - a.compliance.approvalRate) }} transition={{ duration: 0.8, ease: "easeOut" }} />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <ShieldCheck className="mb-1 text-success" size={22} />
                  <span className="text-sm font-semibold text-foreground">{Math.round(a.compliance.approvalRate * 100)}%</span>
                </div>
              </div>
              <div className="mt-4 grid w-full grid-cols-3 gap-2 text-center text-xs">
                <div><p className="text-foreground">{a.compliance.approved}</p><p className="text-muted-foreground">Approved</p></div>
                <div><p className="text-foreground">{a.compliance.review}</p><p className="text-muted-foreground">Pending</p></div>
                <div><p className="text-foreground">{a.compliance.blocked + a.compliance.rejected}</p><p className="text-muted-foreground">Rejected</p></div>
              </div>
              <Link href="/dashboard/transactions?tab=compliance" className="mt-3 text-xs text-primary-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm">View payment checks →</Link>
            </div>
          ) : <EmptyHint icon={ShieldCheck} title="No compliance data yet" hint="Every payment is screened. Results appear here." />}
        </Card>
      </div>

      {/* AI insights + Automations preview */}
      <div className="mt-4 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Card title="AI insights">
          {insights ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { icon: TrendingUp, label: "Largest transaction", value: `${fmt(insights.largest.amount ?? 0)} ${insights.largest.token}` },
                { icon: Coins, label: "Most used asset", value: insights.topAsset },
                { icon: Activity, label: "Most active day", value: insights.topDay },
                { icon: ArrowLeftRight, label: "Payments · Trades", value: `${insights.payments} · ${insights.trades}` },
              ].map((it) => (
                <div key={it.label} className="rounded-lg border border-border bg-input/30 p-3">
                  <it.icon size={15} className="mb-2 text-primary-ink" />
                  <p className="text-sm font-semibold text-foreground">{it.value}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{it.label}</p>
                </div>
              ))}
            </div>
          ) : <EmptyHint icon={Sparkles} title="No insights yet" hint="Once you make payments or trades, PayAI surfaces patterns here." />}
        </Card>

        <Card title="Payment Automations" right={<Link href="/dashboard/automations" className="text-xs text-primary-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm">Manage</Link>}>
          {upcoming.length === 0 ? (
            <EmptyHint icon={Repeat} title="No automations yet" hint="Create recurring or future-dated payments, or swap between MON and USDC on a schedule." cta={{ label: "Create Automation", href: "/dashboard/automations" }} />
          ) : (
            <div className="space-y-2.5">
              {upcoming.slice(0, 3).map((s) => (
                <div key={s.id} className="flex items-center justify-between rounded-lg border border-border bg-input/30 px-3 py-2.5">
                  <div className="flex items-center gap-2.5">
                    <Repeat size={15} className="text-primary-ink" />
                    <div>
                      <p className="text-sm text-foreground">{s.purpose ?? "Automation"} · {s.amount} {s.token}</p>
                      <p className="text-xs text-muted-foreground">{s.cadence} · {new Date(s.nextRun).toLocaleDateString()}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* Quick actions */}
      <div className="mt-5">
        <p className="mb-2 text-sm font-medium text-foreground">Quick actions</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {[
            { label: "Send Payment", sub: "Pay anyone instantly", icon: Send, href: "/dashboard/payments" },
            { label: "Automations", sub: "Recurring payments", icon: Repeat, href: "/dashboard/automations" },
            { label: "Create Invoice", sub: "Request payments", icon: FileText, href: "/dashboard/invoices" },
            { label: "Add Recipient", sub: "Save contact", icon: UserPlus, href: "/dashboard/recipients" },
            { label: "Audit Logs", sub: "Check history", icon: ScrollText, href: "/dashboard/transactions" },
            { label: "Analytics", sub: "Business metrics", icon: Store, href: "/dashboard/transactions?tab=analytics" },
          ].map((q) => (
            <Link key={q.label} href={q.href} className="group rounded-lg border border-border bg-panel p-4 transition hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <q.icon size={18} className="mb-2 text-muted-foreground group-hover:text-primary-ink" />
              <p className="text-sm font-medium text-foreground">{q.label}</p>
              <p className="text-xs text-muted-foreground">{q.sub}</p>
            </Link>
          ))}
        </div>
      </div>

      <ReceiveModal open={receiveOpen} onClose={() => setReceiveOpen(false)} />
    </div>
  );
}

function EmptyHint({ icon: Icon, title, hint, cta }: { icon: typeof Receipt; title: string; hint: string; cta?: { label: string; href: string } }) {
  return (
    <div className="flex flex-col items-center py-6 text-center">
      <span className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl bg-input text-muted-foreground"><Icon size={18} /></span>
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="mt-1 max-w-xs text-xs text-muted-foreground">{hint}</p>
      {cta && (
        <Link href={cta.href} className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-2 text-xs font-medium text-primary-foreground transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {cta.label} <ArrowRight size={12} />
        </Link>
      )}
    </div>
  );
}
