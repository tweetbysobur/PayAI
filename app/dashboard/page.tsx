"use client";

import { useCallback, useEffect, useState } from "react";
import { motion } from "motion/react";
import Link from "next/link";
import { ArrowDownLeft, ArrowUpRight, ShieldCheck, Receipt, Send, FileText, UserPlus, ScrollText, Store } from "lucide-react";
import { Badge, Card } from "@/components/ui";
import { useWallet } from "@/lib/wallet/useWallet";
import { useWalletBalances } from "@/lib/hooks/useWalletBalances";

interface Revenue { total: number; today: number; thisWeek: number; thisMonth: number; currency: string; settledCount: number; failedCount: number; successRate: number }
interface TrendPoint { date: string; revenue: number; count: number }
interface Compliance { approved: number; rejected: number; review: number; blocked: number; approvalRate: number }
interface Analytics { revenue: Revenue; trend: TrendPoint[]; volume: { count: number; total: number }; compliance: Compliance }
interface HistoryRow { at: number; decision: string; summary: string; amount: number | null; token: string; recipient?: string | null; domain?: string | null; txHash?: string; explorerUrl?: string }
interface Onchain { configured: boolean; stats: { payments: number; volume: number; approved: number; rejected: number; requests: number } | null }

const short = (s?: string | null) => (s ? `${s.slice(0, 8)}…${s.slice(-6)}` : "—");
const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });

const DECISION_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  executed: "success", needs_review: "warning", blocked: "danger", refused: "danger", error: "neutral",
};

export default function Overview() {
  const wallet = useWallet();
  const balances = useWalletBalances(wallet.address);
  const [a, setA] = useState<Analytics | null>(null);
  const [onchain, setOnchain] = useState<Onchain | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);

  const refresh = useCallback(() => {
    fetch("/api/analytics").then((r) => r.json()).then(setA).catch(() => {});
    fetch("/api/onchain").then((r) => r.json()).then(setOnchain).catch(() => {});
    fetch("/api/agent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ intent: "Show my transaction history" }) })
      .then((r) => r.json()).then((j) => setHistory(j.history ?? [])).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15000);
    return () => clearInterval(t);
  }, [refresh]);

  const r = a?.revenue;
  const totalMon = balances.mon ? Number(balances.mon) : null;
  const totalUsdc = balances.usdc ? Number(balances.usdc) : null;
  const monShare = totalMon != null && totalUsdc != null && totalMon + totalUsdc > 0 ? totalMon / (totalMon + totalUsdc) : null;

  return (
    <div className="mx-auto max-w-7xl">
      <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }} className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Overview</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">Here&apos;s what&apos;s happening with your payments today.</p>
        </div>
        <div className="flex gap-2">
          <Link href="/dashboard/payments" className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
            <Send size={14} /> Send Payment
          </Link>
          <Link href="/dashboard/wallets" className="flex items-center gap-1.5 rounded-md border border-border px-4 py-2 text-sm text-foreground hover:bg-input">
            <ArrowDownLeft size={14} /> Receive
          </Link>
        </div>
      </motion.div>

      {/* KPI cards */}
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: "Wallet balance (MON)", value: totalMon != null ? fmt(totalMon) : wallet.address ? "—" : "connect wallet", unit: totalMon != null ? "MON" : null, icon: ArrowUpRight, tone: "primary" as const },
          { label: "Wallet balance (USDC)", value: totalUsdc != null ? fmt(totalUsdc) : wallet.address ? "—" : "connect wallet", unit: totalUsdc != null ? "USDC" : null, icon: ArrowDownLeft, tone: "success" as const },
          { label: "On-chain volume", value: onchain?.stats ? fmt(onchain.stats.volume) : "—", unit: onchain?.stats ? "USDC" : null, icon: Receipt, tone: "neutral" as const },
          { label: "Transactions", value: r ? `${r.settledCount + r.failedCount}` : "—", unit: null, icon: ShieldCheck, tone: "neutral" as const },
        ].map((k, i) => {
          const iconTone = {
            primary: "bg-primary/12 text-primary",
            success: "bg-success/12 text-success",
            neutral: "bg-input text-muted-foreground",
          }[k.tone];
          return (
            <motion.div
              key={k.label}
              initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05, duration: 0.3 }}
              whileHover={{ y: -2 }}
            >
              <Card className="p-5 transition-colors hover:border-primary/30">
                <div className={`mb-3 flex h-9 w-9 items-center justify-center rounded-lg ${iconTone}`}>
                  <k.icon size={16} />
                </div>
                <p className="text-2xl font-semibold tracking-tight text-foreground [font-variant-numeric:tabular-nums]">
                  {k.value}{k.unit && <span className="ml-1.5 text-sm font-medium text-muted-foreground">{k.unit}</span>}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">{k.label}</p>
              </Card>
            </motion.div>
          );
        })}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        {/* Recent transactions — recipient, domain, asset, amount, status, explorer */}
        <Card title="Recent transactions" right={<Link href="/dashboard/transactions" className="text-xs text-primary hover:underline">View all</Link>}>
          {history.length === 0 ? (
            <p className="text-sm text-muted-foreground">No transactions yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-muted-foreground">
                  <tr><th className="py-1.5 pr-3">Recipient</th><th className="pr-3">Domain</th><th className="pr-3">Asset</th><th className="pr-3">Amount</th><th className="pr-3">Status</th><th>Explorer</th></tr>
                </thead>
                <tbody className="text-foreground">
                  {history.slice(0, 6).map((h, i) => (
                    <motion.tr key={i} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i * 0.04 }} className="border-t border-border">
                      <td className="py-1.5 pr-3 font-mono text-xs">{short(h.recipient)}</td>
                      <td className="pr-3 text-xs text-primary">{h.domain ?? "—"}</td>
                      <td className="pr-3">{h.token}</td>
                      <td className="pr-3">{h.amount ?? "—"}</td>
                      <td className="pr-3"><Badge tone={DECISION_TONE[h.decision] ?? "neutral"}>{h.decision}</Badge></td>
                      <td>{h.txHash && h.explorerUrl ? <a href={h.explorerUrl} target="_blank" rel="noreferrer" className="font-mono text-xs text-primary hover:underline">{short(h.txHash)} ↗</a> : "—"}</td>
                    </motion.tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* Compliance status — real, from VeriGate aggregate */}
        <Card title="Compliance status">
          {a ? (
            <div className="flex flex-col items-center">
              <div className="relative h-32 w-32" title={`${Math.round(a.compliance.approvalRate * 100)}% approval rate`}>
                <svg width="128" height="128" viewBox="0 0 128 128" className="-rotate-90">
                  <circle cx="64" cy="64" r="54" fill="none" stroke="var(--color-border)" strokeWidth="10" />
                  <motion.circle
                    cx="64" cy="64" r="54" fill="none" stroke="var(--color-success)" strokeWidth="10" strokeLinecap="round"
                    strokeDasharray={2 * Math.PI * 54}
                    initial={{ strokeDashoffset: 2 * Math.PI * 54 }}
                    animate={{ strokeDashoffset: 2 * Math.PI * 54 * (1 - a.compliance.approvalRate) }}
                    transition={{ duration: 0.8, ease: "easeOut" }}
                  />
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <ShieldCheck className="mb-1 text-success" size={22} />
                  <span className="text-sm font-semibold text-foreground">{a.compliance.approvalRate >= 0.7 ? "Low Risk" : "Review"}</span>
                </div>
              </div>
              <div className="mt-4 grid w-full grid-cols-3 gap-2 text-center text-xs">
                <div><p className="text-foreground">{a.compliance.approved}</p><p className="text-muted-foreground">Approved</p></div>
                <div><p className="text-foreground">{a.compliance.review}</p><p className="text-muted-foreground">Review</p></div>
                <div><p className="text-foreground">{a.compliance.blocked + a.compliance.rejected}</p><p className="text-muted-foreground">Blocked</p></div>
              </div>
              <Link href="/dashboard/compliance" className="mt-3 text-xs text-primary hover:underline">View Compliance Center →</Link>
            </div>
          ) : <p className="text-sm text-muted-foreground">No payments processed yet — compliance status will appear here.</p>}
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        {/* Asset allocation — real connected-wallet balances */}
        <Card title="Asset allocation">
          {monShare != null ? (
            <div className="flex items-center gap-6">
              <div className="relative h-28 w-28 shrink-0" title={`MON ${Math.round(monShare * 100)}% · USDC ${Math.round((1 - monShare) * 100)}%`}>
                <svg width="112" height="112" viewBox="0 0 112 112" className="-rotate-90">
                  <circle cx="56" cy="56" r="44" fill="none" stroke="var(--color-secondary)" strokeWidth="14" />
                  <motion.circle
                    cx="56" cy="56" r="44" fill="none" stroke="var(--color-primary)" strokeWidth="14"
                    strokeDasharray={2 * Math.PI * 44}
                    initial={{ strokeDashoffset: 2 * Math.PI * 44 }}
                    animate={{ strokeDashoffset: 2 * Math.PI * 44 * (1 - monShare) }}
                    transition={{ duration: 0.8, ease: "easeOut" }}
                  />
                </svg>
              </div>
              <div className="flex-1 space-y-2 text-sm">
                <div className="flex items-center justify-between"><span className="flex items-center gap-2 text-foreground"><span className="h-2 w-2 rounded-full bg-primary" />MON</span><span className="text-muted-foreground">{fmt(totalMon ?? 0)}</span></div>
                <div className="flex items-center justify-between"><span className="flex items-center gap-2 text-foreground"><span className="h-2 w-2 rounded-full bg-secondary" />USDC</span><span className="text-muted-foreground">{fmt(totalUsdc ?? 0)}</span></div>
              </div>
            </div>
          ) : <p className="text-sm text-muted-foreground">Connect your wallet to see real balances.</p>}
        </Card>

        {/* Revenue trend — real, from /api/analytics */}
        <Card title="Payment activity (7d)">
          {a?.trend.length ? (
            <div className="flex h-32 items-end gap-2">
              {a.trend.map((t, i) => {
                const max = Math.max(1, ...a.trend.map((x) => x.revenue));
                return (
                  <div key={t.date} className="group relative flex flex-1 flex-col items-center gap-1">
                    <div className="pointer-events-none absolute -top-7 hidden whitespace-nowrap rounded-md border border-border bg-panel px-2 py-1 text-[10px] text-foreground shadow-panel group-hover:block">
                      {t.revenue.toFixed(2)} ({t.count} tx)
                    </div>
                    <motion.div className="w-full max-w-8 rounded-t bg-primary/70 transition-colors group-hover:bg-primary" initial={{ height: 0 }} animate={{ height: `${Math.max(2, (t.revenue / max) * 100)}px` }} transition={{ delay: i * 0.05, duration: 0.4 }} />
                    <span className="text-[10px] text-muted-foreground/70">{t.date.slice(5)}</span>
                  </div>
                );
              })}
            </div>
          ) : <p className="text-sm text-muted-foreground">No data yet.</p>}
        </Card>
      </div>

      {/* Quick actions */}
      <div className="mt-5">
        <p className="mb-2 text-sm font-medium text-foreground">Quick actions</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {[
            { label: "Send Payment", sub: "Pay anyone instantly", icon: Send, href: "/dashboard/payments" },
            { label: "Create Invoice", sub: "Request payments", icon: FileText, href: "/dashboard/invoices" },
            { label: "Add Recipient", sub: "Save contact", icon: UserPlus, href: "/dashboard/recipients" },
            { label: "Compliance Check", sub: "Verify address", icon: ShieldCheck, href: "/dashboard/compliance" },
            { label: "View Audit Logs", sub: "Check history", icon: ScrollText, href: "/dashboard/transactions" },
            { label: "Merchant Dashboard", sub: "Manage business", icon: Store, href: "/dashboard/analytics" },
          ].map((q) => (
            <Link key={q.label} href={q.href} className="group rounded-lg border border-border bg-panel p-4 transition hover:border-primary/40">
              <q.icon size={18} className="mb-2 text-muted-foreground group-hover:text-primary" />
              <p className="text-sm font-medium text-foreground">{q.label}</p>
              <p className="text-xs text-muted-foreground">{q.sub}</p>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
