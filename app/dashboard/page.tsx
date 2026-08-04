"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import Link from "next/link";
import {
  ArrowDownLeft, ArrowUpRight, ShieldCheck, Receipt, Send, FileText, UserPlus,
  ScrollText, Store, Wallet, Copy, Check, Repeat, TrendingUp, Coins, Activity, Sparkles, ArrowRight,
} from "lucide-react";
import { Badge, Card, CountUp } from "@/components/ui";
import { useTokenPrices, formatUsd } from "@/lib/hooks/useTokenPrices";
import { MONAD_USDC, MONAD_USDC_DECIMALS } from "@/lib/monad/public";
import { Identicon } from "@/components/Identicon";
import { MonadMark } from "@/components/MonadMark";
import { TokenLogo } from "@/components/TokenLogo";
import dynamic from "next/dynamic";
import { useToast } from "@/components/Toast";
// Lazy-loaded: pulls in viem + qrcode.react, only needed once someone opens it.
const ReceiveModal = dynamic(() => import("@/components/dashboard/ReceiveModal").then((m) => m.ReceiveModal), { ssr: false });
import { useWalletService as useWallet } from "@/lib/wallet-service/WalletServiceContext";
import { WelcomeCard } from "@/components/dashboard/WelcomeCard";
import { useWalletBalances } from "@/lib/hooks/useWalletBalances";
import { useIdentity } from "@/lib/hooks/useIdentity";

interface Revenue { total: number; today: number; thisWeek: number; thisMonth: number; currency: string; settledCount: number; failedCount: number; successRate: number }
interface TrendPoint { date: string; revenue: number; count: number }
interface Compliance { approved: number; rejected: number; review: number; blocked: number; approvalRate: number }
interface Analytics { revenue: Revenue; trend: TrendPoint[]; volume: { count: number; total: number }; compliance: Compliance }
interface HistoryRow { at: number; decision: string; summary: string; amount: number | null; token: string; recipient?: string | null; domain?: string | null; txHash?: string; explorerUrl?: string }
interface Onchain { configured: boolean; stats: { payments: number; volume: number; approved: number; rejected: number; requests: number } | null }
interface Automation { id: string; amount: number; token: string; recipient: string; domain?: string | null; cadence: string; nextRun: number; status: string; purpose?: string }

const short = (s?: string | null) => (s ? `${s.slice(0, 6)}…${s.slice(-4)}` : "—");
const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });
const DAY = 86_400_000;

const DECISION_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  executed: "success", needs_review: "warning", blocked: "danger", refused: "danger", error: "neutral",
};

export default function Overview() {
  const wallet = useWallet();
  const balances = useWalletBalances(wallet.address);
  const identity = useIdentity(wallet.address);
  const { toast } = useToast();
  const [a, setA] = useState<Analytics | null>(null);
  const [onchain, setOnchain] = useState<Onchain | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [health, setHealth] = useState<{ wallet?: { network: string } | null } | null>(null);
  const [copied, setCopied] = useState(false);
  const [receiveOpen, setReceiveOpen] = useState(false);

  const refresh = useCallback(() => {
    // Scope the user's own views to their connected wallet — the server returns
    // only this wallet's history/analytics, never another user's (see
    // /api/analytics + /api/agent show_history). Without a wallet, there's no
    // identity to scope to, so these come back empty by design.
    const walletHeaders = wallet.address ? { "x-wallet-address": wallet.address } : undefined;
    fetch("/api/analytics", { headers: walletHeaders }).then((r) => r.json()).then(setA).catch(() => {});
    fetch("/api/onchain").then((r) => r.json()).then(setOnchain).catch(() => {});
    fetch("/api/health").then((r) => r.json()).then(setHealth).catch(() => {});
    fetch(`/api/automations${wallet.address ? `?wallet=${wallet.address}` : ""}`).then((r) => r.json()).then((j) => setAutomations(j.automations ?? [])).catch(() => {});
    fetch("/api/agent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ intent: "Show my transaction history", walletAddress: wallet.address }) })
      .then((r) => r.json()).then((j) => setHistory(j.history ?? [])).catch(() => {});
  }, [wallet.address]);

  useEffect(() => {
    refresh();
    // Only poll while the tab is actually visible — background polling drains
    // the battery and churns the UI on mobile for nothing. Refresh immediately
    // when the user returns so the data is fresh on focus.
    const t = setInterval(() => { if (!document.hidden) refresh(); }, 20000);
    const onVisible = () => { if (!document.hidden) refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", onVisible); };
  }, [refresh]);

  const NATIVE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000";
  const totalMon = balances.mon ? Number(balances.mon) : null;
  const totalUsdc = balances.usdc ? Number(balances.usdc) : null;
  // One batched price fetch for both tiles, cached at module level and shared
  // with the token selector, so this adds no perceptible load cost.
  const { usdValue } = useTokenPrices([
    { address: NATIVE_TOKEN_ADDRESS, decimals: 18 },
    ...(MONAD_USDC ? [{ address: MONAD_USDC, decimals: MONAD_USDC_DECIMALS }] : []),
  ]);
  const monUsd = totalMon != null ? formatUsd(usdValue(NATIVE_TOKEN_ADDRESS, totalMon)) : null;
  const usdcUsd = totalUsdc != null && MONAD_USDC ? formatUsd(usdValue(MONAD_USDC, totalUsdc)) : null;

  // Period transaction counts (computed from real settled history).
  const counts = useMemo(() => {
    const now = Date.now();
    const settled = history.filter((h) => h.decision === "executed");
    return {
      lifetime: settled.length,
      month: settled.filter((h) => now - h.at <= 30 * DAY).length,
      week: settled.filter((h) => now - h.at <= 7 * DAY).length,
    };
  }, [history]);

  // AI insights — derived from real settled payments, never fabricated.
  const insights = useMemo(() => {
    const settled = history.filter((h) => h.decision === "executed" && h.amount != null);
    if (settled.length === 0) return null;
    const largest = settled.reduce((m, h) => (h.amount! > (m.amount ?? 0) ? h : m), settled[0]);
    const byAsset = settled.reduce<Record<string, number>>((acc, h) => { acc[h.token] = (acc[h.token] ?? 0) + 1; return acc; }, {});
    const topAsset = Object.entries(byAsset).sort((x, y) => y[1] - x[1])[0]?.[0] ?? "—";
    const byDay = settled.reduce<Record<string, number>>((acc, h) => { const d = new Date(h.at).toLocaleDateString(undefined, { weekday: "long" }); acc[d] = (acc[d] ?? 0) + 1; return acc; }, {});
    const topDay = Object.entries(byDay).sort((x, y) => y[1] - x[1])[0]?.[0] ?? "—";
    const avg = settled.reduce((s, h) => s + (h.amount ?? 0), 0) / settled.length;
    return { largest, topAsset, topDay, avg };
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
    navigator.clipboard?.writeText(wallet.address);
    setCopied(true);
    toast("Address copied");
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="mx-auto max-w-7xl">
      <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }} className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Overview</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">Your payments, balances, and activity on Monad Mainnet.</p>
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
                      {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
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
                <Badge tone={walletStatus.tone}>{walletStatus.label}</Badge>
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

      {/* Portfolio + headline KPIs (animated) */}
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: "MON balance", value: totalMon, decimals: 2, unit: "MON", placeholder: wallet.address ? "—" : "connect", icon: ArrowUpRight, token: "MON" as const, tone: "primary" as const, usd: monUsd },
          { label: "USDC balance", value: totalUsdc, decimals: 2, unit: "USDC", placeholder: wallet.address ? "—" : "connect", icon: Coins, token: "USDC" as const, tone: "success" as const, usd: usdcUsd },
          { label: "On-chain volume", value: onchain?.stats?.volume ?? null, decimals: 2, unit: "MON", placeholder: "—", icon: Receipt, token: null, tone: "neutral" as const, usd: null },
          { label: "Lifetime payments", value: counts.lifetime, decimals: 0, unit: null, placeholder: "—", icon: ShieldCheck, token: null, tone: "neutral" as const, usd: null },
        ].map((k, i) => {
          const iconTone = { primary: "bg-primary/12 text-primary-ink", success: "bg-success/12 text-success", neutral: "bg-input text-muted-foreground" }[k.tone];
          return (
            <motion.div key={k.label} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05, duration: 0.3 }} whileHover={{ y: -2 }}>
              <Card className="p-5 transition-colors hover:border-primary/30">
                <div className={`mb-3 flex h-9 w-9 items-center justify-center rounded-lg ${iconTone}`}>{k.token ? <TokenLogo token={k.token} size={18} /> : <k.icon size={16} />}</div>
                <p className="text-2xl font-semibold tracking-tight text-foreground [font-variant-numeric:tabular-nums]">
                  {k.value != null ? <CountUp value={k.value} decimals={k.decimals} /> : k.placeholder}
                  {k.value != null && k.unit && <span className="ml-1.5 text-sm font-medium text-muted-foreground">{k.unit}</span>}
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

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        {/* Recent transactions */}
        <Card title="Recent transactions" right={<Link href="/dashboard/transactions" className="text-xs text-primary-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm">View all</Link>}>
          {history.length === 0 ? (
            <EmptyHint icon={Receipt} title="No transactions yet" hint="Send your first payment with Ask PayAI (⌘K), or use the form directly. It settles on Monad in seconds." cta={{ label: "Send Payment", href: "/dashboard/payments" }} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-muted-foreground">
                  <tr><th className="py-1.5 pr-3">Recipient</th><th className="pr-3">Asset</th><th className="pr-3">Amount</th><th className="pr-3">Status</th><th className="pr-3">When</th><th>Explorer</th></tr>
                </thead>
                <tbody className="text-foreground">
                  {history.slice(0, 6).map((h, i) => (
                    <motion.tr key={i} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i * 0.04 }} className="border-t border-border">
                      <td className="py-1.5 pr-3 font-mono text-xs">{h.domain ?? short(h.recipient)}</td>
                      <td className="pr-3">{h.token}</td>
                      <td className="pr-3 [font-variant-numeric:tabular-nums]">{h.amount ?? "—"}</td>
                      <td className="pr-3"><Badge tone={DECISION_TONE[h.decision] ?? "neutral"}>{h.decision}</Badge></td>
                      <td className="pr-3 text-xs text-muted-foreground">{new Date(h.at).toLocaleDateString()}</td>
                      <td>{h.txHash && h.explorerUrl ? <a href={h.explorerUrl} target="_blank" rel="noreferrer" className="font-mono text-xs text-primary-ink hover:underline">{short(h.txHash)} ↗</a> : "—"}</td>
                    </motion.tr>
                  ))}
                </tbody>
              </table>
            </div>
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
              <Link href="/dashboard/compliance" className="mt-3 text-xs text-primary-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm">View payment checks →</Link>
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
                { icon: TrendingUp, label: "Largest payment", value: `${fmt(insights.largest.amount ?? 0)} ${insights.largest.token}` },
                { icon: Coins, label: "Most used asset", value: insights.topAsset },
                { icon: Activity, label: "Most active day", value: insights.topDay },
                { icon: Sparkles, label: "Average payment", value: fmt(insights.avg) },
              ].map((it) => (
                <div key={it.label} className="rounded-lg border border-border bg-input/30 p-3">
                  <it.icon size={15} className="mb-2 text-primary-ink" />
                  <p className="text-sm font-semibold text-foreground">{it.value}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{it.label}</p>
                </div>
              ))}
            </div>
          ) : <EmptyHint icon={Sparkles} title="No insights yet" hint="Once you make payments, PayAI surfaces patterns here." />}
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
            { label: "Analytics", sub: "Business metrics", icon: Store, href: "/dashboard/analytics" },
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
