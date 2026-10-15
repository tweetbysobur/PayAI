"use client";

import { STOPPED_LABEL } from "@/lib/hooks/stoppedPayments";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Search, ArrowUpRight, ArrowLeftRight, ArrowDownLeft } from "lucide-react";
import { fetchWalletMoves, mergeByTime } from "@/lib/hooks/walletMoves";
import { useSyncRefresher } from "@/lib/hooks/useSync";
import { Input, SkeletonRows } from "@/components/ui";
import { useWalletService as useWallet } from "@/lib/wallet-service/WalletServiceContext";
import { SyncButton } from "@/components/dashboard/SyncButton";
import { ActivityRow, EmptyState, PageHeader } from "@/components/dashboard/primitives";
import { ActivityTabContent } from "@/components/dashboard/ActivityTabContent";
import { AnalyticsTabContent } from "@/components/dashboard/AnalyticsTabContent";
import { ComplianceTabContent } from "@/components/dashboard/ComplianceTabContent";

interface HistoryRow { at: number; decision: string; summary: string; amount: number | null; token: string; recipient?: string | null; domain?: string | null; txHash?: string; explorerUrl?: string; action?: string; feature?: string; direction?: "in" | "out" }

const short = (s?: string | null) => (s ? `${s.slice(0, 8)}…${s.slice(-6)}` : "—");
const DECISION_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  executed: "success", needs_review: "warning", blocked: "danger", refused: "danger", error: "danger",
  received: "success", sent_out: "neutral",
};
const DECISION_LABEL: Record<string, string> = {
  executed: "Settled", needs_review: STOPPED_LABEL, blocked: "Blocked", refused: "Declined", error: "Failed",
  received: "Received", sent_out: "Sent",
};
const STATUS_FILTERS = ["all", "received", "executed", "needs_review", "blocked", "refused"] as const;
const PAGE_SIZE = 12;

/** Compact relative time — "just now", "3m", "2h", "5d". */
function ago(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 45) return "just now";
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const TABS = [
  { key: "transactions", label: "Transactions", blurb: "Payments, swaps and deposits on your wallet, and whether they settled." },
  { key: "activity", label: "All activity", blurb: "Transactions, automation runs, swaps and wallet events in one feed." },
  { key: "analytics", label: "Analytics", blurb: "Volume and settlement totals for your wallet." },
  { key: "compliance", label: "Checks", blurb: "The checks every transaction goes through, and a manual address check." },
] as const;
type TabKey = typeof TABS[number]["key"];
function parseTab(v: string | null): TabKey {
  return TABS.some((t) => t.key === v) ? (v as TabKey) : "transactions";
}
/** Activity and Compliance were designed at a narrower column than the
 *  denser Transactions/Analytics tables and stat grids — kept per-tab so
 *  neither looks stretched-thin nor cramped in the shared shell. */
const TAB_WIDTH: Record<TabKey, string> = {
  transactions: "max-w-6xl", activity: "max-w-4xl", analytics: "max-w-6xl", compliance: "max-w-4xl",
};

function TransactionsPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<TabKey>(() => parseTab(searchParams.get("tab")));

  // The URL is the source of truth for which tab is open — so a link like
  // "?tab=compliance" from elsewhere in the app (or a bookmark, or browser
  // back/forward) lands on the right tab, not whatever was last clicked.
  useEffect(() => {
    setTab(parseTab(searchParams.get("tab")));
  }, [searchParams]);

  function selectTab(key: TabKey) {
    setTab(key);
    router.replace(key === "transactions" ? "/dashboard/transactions" : `/dashboard/transactions?tab=${key}`, { scroll: false });
  }

  const active = TABS.find((t) => t.key === tab) ?? TABS[0];

  return (
    <div className={`mx-auto ${TAB_WIDTH[tab]}`}>
      <PageHeader title="History" description={active.blurb} actions={<SyncButton />} />

      {/* Views of the same history — quiet text tabs, not a second nav bar. */}
      <div role="tablist" aria-label="History views" className="-mt-1 mb-6 flex gap-5 overflow-x-auto border-b border-border [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {TABS.map((t) => {
          const isActive = tab === t.key;
          return (
            <button
              key={t.key}
              role="tab"
              aria-selected={isActive}
              onClick={() => selectTab(t.key)}
              className={`-mb-px shrink-0 border-b-2 py-2.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${
                isActive ? "border-foreground font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {tab === "transactions" && <TransactionsTabContent />}
      {tab === "activity" && <ActivityTabContent />}
      {tab === "analytics" && <AnalyticsTabContent />}
      {tab === "compliance" && <ComplianceTabContent />}
    </div>
  );
}

export default function TransactionsPage() {
  return (
    <Suspense fallback={null}>
      <TransactionsPageInner />
    </Suspense>
  );
}

function TransactionsTabContent() {
  const wallet = useWallet();
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  // ?status= opens the list already filtered (the dashboard's "View them"
  // links to the payments the risk check stopped).
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<typeof STATUS_FILTERS[number]>(() => {
    const s = searchParams.get("status");
    return (STATUS_FILTERS as readonly string[]).includes(s ?? "") ? (s as typeof STATUS_FILTERS[number]) : "all";
  });
  const [page, setPage] = useState(1);

  // Scoped to the connected wallet — only the user's own transactions come
  // back. Without a wallet there's no identity to scope to, so it stays empty.
  // What PayAI executed, plus deposits (and sends made elsewhere), which
  // PayAI's own log never holds.
  const load = useCallback(() => {
    const payai = fetch("/api/agent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ intent: "Show my transaction history", walletAddress: wallet.address }) })
      .then((r) => r.json()).then((j) => (j.history ?? []) as HistoryRow[]).catch(() => [] as HistoryRow[]);
    return Promise.all([payai, fetchWalletMoves(wallet.address, wallet.providerId)])
      .then(([rows, moves]) => setHistory(mergeByTime<HistoryRow>(rows, moves)))
      .finally(() => setLoading(false));
  }, [wallet.address, wallet.providerId]);
  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);
  // A new deposit appears without leaving the page.
  useSyncRefresher(load);

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
    <div>
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
                aria-pressed={status === s}
                className={`h-8 rounded-md border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  status === s ? "border-foreground/40 bg-input text-foreground" : "border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                {s === "all" ? "All" : DECISION_LABEL[s] ?? s.replace("_", " ")}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-xl surface-purple px-4">
        {loading ? (
          <div className="py-4"><SkeletonRows rows={5} /></div>
        ) : !wallet.address ? (
          <EmptyState title="Connect your wallet" hint="Your history is private to your wallet. Connect it to see what PayAI has executed for you." />
        ) : history.length === 0 ? (
          <EmptyState title="No activity yet." hint="Payments, swaps and deposits show up here once they settle on Monad." action={{ label: "Tell PayAI what you want done", href: "/dashboard" }} />
        ) : filtered.length === 0 ? (
          <EmptyState title="No matches" hint="Nothing matches your search or filter." />
        ) : (
          <>
            <ul className="divide-y divide-border">
              {pageRows.map((h, i) => {
                // Swaps and protocol actions (wrap, Aave) have no recipient: their row
                // is titled by what happened.
                const swap = h.feature === "swap" || h.feature === "trade" || h.feature === "protocol" || h.action === "swap";
                const received = h.direction === "in";
                return (
                  <ActivityRow
                    key={`${h.at}-${i}`}
                    icon={received ? ArrowDownLeft : swap ? ArrowLeftRight : ArrowUpRight}
                    title={received ? "Deposit received" : h.direction === "out" ? "Sent outside PayAI" : swap ? (h.summary || "Swap") : <>To {h.domain ?? <span className="font-mono">{short(h.recipient)}</span>}</>}
                    status={{ tone: DECISION_TONE[h.decision] ?? "neutral", label: DECISION_LABEL[h.decision] ?? h.decision }}
                    meta={<span title={new Date(h.at).toLocaleString()}>{ago(h.at)} · Monad</span>}
                    amount={h.amount != null ? <>{received ? "+" : ""}{h.amount} <span className="text-xs font-normal text-muted-foreground">{h.token}</span></> : "—"}
                    receipt={h.txHash && h.explorerUrl ? { href: h.explorerUrl, label: short(h.txHash) } : null}
                  />
                );
              })}
            </ul>
            {totalPages > 1 && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border py-3 text-xs text-muted-foreground">
                <span>Page {page} of {totalPages} · {filtered.length} results</span>
                <div className="flex gap-2">
                  <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="h-8 rounded-md border border-border px-3 transition-colors hover:bg-input disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Previous</button>
                  <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages} className="h-8 rounded-md border border-border px-3 transition-colors hover:bg-input disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Next</button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
