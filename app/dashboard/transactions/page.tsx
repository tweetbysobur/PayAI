"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { Search, ArrowUpRight, Receipt, CheckCircle2, ExternalLink, Wallet } from "lucide-react";
import { Badge, Card, Input, SkeletonRows } from "@/components/ui";
import { useWallet } from "@/lib/wallet/useWallet";
import { TokenLogo, VolumeInline } from "@/components/TokenLogo";

interface HistoryRow { at: number; decision: string; summary: string; amount: number | null; token: string; recipient?: string | null; domain?: string | null; txHash?: string; explorerUrl?: string }

const short = (s?: string | null) => (s ? `${s.slice(0, 8)}…${s.slice(-6)}` : "—");
const DECISION_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  executed: "success", needs_review: "warning", blocked: "danger", refused: "danger", error: "neutral",
};
const DECISION_LABEL: Record<string, string> = {
  executed: "Settled", needs_review: "In review", blocked: "Blocked", refused: "Declined", error: "Failed",
};
const STATUS_FILTERS = ["all", "executed", "needs_review", "blocked", "refused"] as const;
const PAGE_SIZE = 12;

/** Compact relative time — "just now", "3m", "2h", "5d". */
function ago(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 45) return "just now";
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function Transactions() {
  const wallet = useWallet();
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<typeof STATUS_FILTERS[number]>("all");
  const [page, setPage] = useState(1);

  useEffect(() => {
    // Scoped to the connected wallet — only the user's own transactions come
    // back. Without a wallet there's no identity to scope to, so it stays empty.
    setLoading(true);
    fetch("/api/agent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ intent: "Show my transaction history", walletAddress: wallet.address }) })
      .then((r) => r.json()).then((j) => setHistory(j.history ?? [])).finally(() => setLoading(false));
  }, [wallet.address]);

  // Headline stats — computed from the user's own settled payments.
  const stats = useMemo(() => {
    const settled = history.filter((h) => h.decision === "executed");
    const volumeByToken: Record<string, number> = {};
    for (const h of settled) if (h.amount != null) volumeByToken[h.token] = (volumeByToken[h.token] ?? 0) + h.amount;
    const considered = history.filter((h) => ["executed", "blocked", "refused", "error"].includes(h.decision)).length;
    return {
      settled: settled.length,
      volumeByToken,
      successRate: considered ? Math.round((settled.length / considered) * 100) : 100,
    };
  }, [history]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return history.filter((h) => {
      if (status !== "all" && h.decision !== status) return false;
      if (!q) return true;
      return (h.recipient?.toLowerCase().includes(q) ?? false) || (h.domain?.toLowerCase().includes(q) ?? false) || h.token.toLowerCase().includes(q);
    });
  }, [history, query, status]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <div className="mx-auto max-w-6xl">
      <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }} className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Transactions</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">Every payment you&apos;ve made through PayAI, settled on Monad Mainnet.</p>
      </motion.div>

      {/* Headline stats */}
      <div className="mb-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
        {[
          { label: "Payments settled", value: <span className="[font-variant-numeric:tabular-nums]">{stats.settled.toLocaleString()}</span>, icon: CheckCircle2, tone: "bg-success/12 text-success" },
          { label: "Volume", value: <VolumeInline byToken={stats.volumeByToken} size={14} />, icon: ArrowUpRight, tone: "bg-primary/12 text-primary" },
          { label: "Success rate", value: <span className="[font-variant-numeric:tabular-nums]">{stats.successRate}%</span>, icon: Receipt, tone: "bg-primary/12 text-primary" },
        ].map((s, i) => (
          <motion.div key={s.label} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05, duration: 0.3 }}>
            <Card className="p-4">
              <div className={`mb-3 flex h-9 w-9 items-center justify-center rounded-lg ${s.tone}`}><s.icon size={16} /></div>
              <div className="text-xl font-semibold text-foreground">{s.value}</div>
              <div className="mt-1 text-xs text-muted-foreground">{s.label}</div>
            </Card>
          </motion.div>
        ))}
      </div>

      {!loading && history.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="relative flex-1 sm:max-w-xs">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input value={query} onChange={(e) => { setQuery(e.target.value); setPage(1); }} placeholder="Search recipient, domain, or asset" className="w-full pl-9" />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {STATUS_FILTERS.map((s) => (
              <button
                key={s}
                onClick={() => { setStatus(s); setPage(1); }}
                className={`rounded-full border px-3 py-1.5 text-xs font-medium capitalize transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  status === s ? "border-primary/40 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                {s === "all" ? "All" : DECISION_LABEL[s] ?? s.replace("_", " ")}
              </button>
            ))}
          </div>
        </div>
      )}

      <Card className="!p-0 overflow-hidden">
        {loading ? (
          <SkeletonRows rows={4} className="p-6" />
        ) : !wallet.address ? (
          <EmptyState icon={Wallet} title="Connect your wallet" hint="Your transactions are private to your wallet. Connect it from the top bar to see your history." />
        ) : history.length === 0 ? (
          <EmptyState icon={Receipt} title="No transactions yet" hint="Send your first payment with Ask PayAI (⌘K). It settles on Monad in seconds and appears here." />
        ) : filtered.length === 0 ? (
          <EmptyState icon={Search} title="No matches" hint="No transactions match your search or filter." />
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-border bg-panel/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-5 py-3 font-medium">When</th>
                    <th className="px-3 py-3 font-medium">Recipient</th>
                    <th className="px-3 py-3 font-medium">Asset</th>
                    <th className="px-3 py-3 text-right font-medium">Amount</th>
                    <th className="px-3 py-3 font-medium">Status</th>
                    <th className="px-5 py-3 text-right font-medium">Proof</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((h, i) => (
                    <motion.tr
                      key={i}
                      initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: Math.min(i * 0.03, 0.3) }}
                      className="border-b border-border/60 transition-colors last:border-none hover:bg-panel/40"
                    >
                      <td className="px-5 py-3 text-xs text-muted-foreground" title={new Date(h.at).toLocaleString()}>{ago(h.at)}</td>
                      <td className="px-3 py-3">
                        {h.domain ? <span className="text-xs font-medium text-primary">{h.domain}</span> : <span className="font-mono text-xs text-foreground">{short(h.recipient)}</span>}
                      </td>
                      <td className="px-3 py-3">
                        <span className="inline-flex items-center gap-1.5 text-xs text-foreground"><TokenLogo token={h.token} size={15} /> {h.token}</span>
                      </td>
                      <td className="px-3 py-3 text-right font-mono text-xs text-foreground [font-variant-numeric:tabular-nums]">{h.amount ?? "—"}</td>
                      <td className="px-3 py-3"><Badge tone={DECISION_TONE[h.decision] ?? "neutral"}>{DECISION_LABEL[h.decision] ?? h.decision}</Badge></td>
                      <td className="px-5 py-3 text-right">
                        {h.txHash && h.explorerUrl ? (
                          <a href={h.explorerUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-xs text-primary hover:underline">
                            {short(h.txHash)} <ExternalLink size={11} />
                          </a>
                        ) : <span className="text-xs text-muted-foreground">—</span>}
                      </td>
                    </motion.tr>
                  ))}
                </tbody>
              </table>
            </div>
            {totalPages > 1 && (
              <div className="flex items-center justify-between border-t border-border px-5 py-3 text-xs text-muted-foreground">
                <span>Page {page} of {totalPages} · {filtered.length} results</span>
                <div className="flex gap-2">
                  <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="rounded-md border border-border px-3 py-1.5 transition hover:bg-panel disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Previous</button>
                  <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages} className="rounded-md border border-border px-3 py-1.5 transition hover:bg-panel disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Next</button>
                </div>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}

function EmptyState({ icon: Icon, title, hint }: { icon: typeof Receipt; title: string; hint: string }) {
  return (
    <div className="flex flex-col items-center px-6 py-16 text-center">
      <span className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-input text-muted-foreground"><Icon size={22} /></span>
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="mt-1 max-w-sm text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}
