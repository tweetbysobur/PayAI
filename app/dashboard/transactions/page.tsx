"use client";

import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Badge, Card, Input } from "@/components/ui";
import { useWallet } from "@/lib/wallet/useWallet";

interface HistoryRow { at: number; decision: string; summary: string; amount: number | null; token: string; recipient?: string | null; domain?: string | null; txHash?: string; explorerUrl?: string }

const short = (s?: string | null) => (s ? `${s.slice(0, 8)}…${s.slice(-6)}` : "—");
const DECISION_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  executed: "success", needs_review: "warning", blocked: "danger", refused: "danger", error: "neutral",
};
const STATUS_FILTERS = ["all", "executed", "needs_review", "blocked", "refused"] as const;
const PAGE_SIZE = 15;

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
      <h1 className="mb-1 text-2xl font-semibold text-foreground">Transactions</h1>
      <p className="mb-6 text-sm text-muted-foreground">Full audit trail of payments processed through your agent.</p>

      {!loading && history.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="relative flex-1 sm:max-w-xs">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => { setQuery(e.target.value); setPage(1); }}
              placeholder="Search recipient, domain, or asset"
              className="w-full pl-9"
            />
          </div>
          <div className="flex gap-1.5">
            {STATUS_FILTERS.map((s) => (
              <button
                key={s}
                onClick={() => { setStatus(s); setPage(1); }}
                className={`rounded-full border px-3 py-1.5 text-xs font-medium transition ${
                  status === s ? "border-primary/40 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                {s === "all" ? "All" : s.replace("_", " ")}
              </button>
            ))}
          </div>
        </div>
      )}

      <Card>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : history.length === 0 ? (
          <p className="text-sm text-muted-foreground">{wallet.address ? "No transactions yet." : "Connect your wallet to see your transactions."}</p>
        ) : filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground">No transactions match your search.</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="py-2 pr-3">Time</th><th className="pr-3">Recipient</th><th className="pr-3">Domain</th>
                    <th className="pr-3">Asset</th><th className="pr-3">Amount</th><th className="pr-3">Status</th><th>Explorer</th>
                  </tr>
                </thead>
                <tbody className="text-foreground">
                  {pageRows.map((h, i) => (
                    <tr key={i} className="border-t border-border">
                      <td className="py-2 pr-3 text-xs text-muted-foreground">{new Date(h.at).toLocaleString()}</td>
                      <td className="pr-3 font-mono text-xs">{short(h.recipient)}</td>
                      <td className="pr-3 text-xs text-primary">{h.domain ?? "—"}</td>
                      <td className="pr-3">{h.token}</td>
                      <td className="pr-3">{h.amount ?? "—"}</td>
                      <td className="pr-3"><Badge tone={DECISION_TONE[h.decision] ?? "neutral"}>{h.decision}</Badge></td>
                      <td>{h.txHash && h.explorerUrl ? <a href={h.explorerUrl} target="_blank" rel="noreferrer" className="font-mono text-xs text-primary hover:underline">{short(h.txHash)} ↗</a> : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {totalPages > 1 && (
              <div className="mt-4 flex items-center justify-between text-xs text-muted-foreground">
                <span>Page {page} of {totalPages} ({filtered.length} results)</span>
                <div className="flex gap-2">
                  <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="rounded-md border border-border px-3 py-1.5 disabled:opacity-40">Previous</button>
                  <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages} className="rounded-md border border-border px-3 py-1.5 disabled:opacity-40">Next</button>
                </div>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
