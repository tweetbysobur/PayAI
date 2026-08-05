"use client";

import { useMemo, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Check, Copy, ExternalLink, Eye, EyeOff, Search, Wallet } from "lucide-react";
import { Card, Skeleton } from "@/components/ui";
import { TokenLogo } from "@/components/TokenLogo";
import { formatUsd } from "@/lib/hooks/useTokenPrices";
import { usePortfolio, viewHoldings, type SortKey } from "@/lib/hooks/usePortfolio";
import { MONAD_EXPLORER } from "@/lib/monad/public";
import { useCopy } from "@/lib/hooks/useCopy";

/**
 * Everything this wallet holds, not just the two assets the dashboard was
 * built around.
 *
 * Tokens arrive on their own — swap into something new and it shows up here
 * with its balance and value, because holdings are read from the chain rather
 * than from a list someone has to maintain.
 *
 * A token with no price we trust shows "—" for its value, never a zero. Zero
 * is a claim about what something is worth; "—" is the truth, which is that we
 * don't know.
 */

const SORTS: { key: SortKey; label: string }[] = [
  { key: "value", label: "Value" },
  { key: "balance", label: "Balance" },
  { key: "symbol", label: "Name" },
];

/** An unknown balance reads as "—", never as 0: printing a zero we never
 *  measured is the kind of wrong number a user acts on. */
function amount(n: number | null): string {
  if (n == null) return "—";
  if (n === 0) return "0";
  if (n < 0.0001) return n.toExponential(2);
  return n.toLocaleString(undefined, { maximumFractionDigits: n < 1 ? 6 : 4 });
}

export function PortfolioCard({ address }: { address: string | null }) {
  const { holdings, loading, totalUsd } = usePortfolio(address);
  const { copy, copied } = useCopy();
  const [hideZero, setHideZero] = useState(true);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("value");

  const rows = useMemo(
    () => viewHoldings(holdings, { hideZero, query, sort }),
    [holdings, hideZero, query, sort],
  );
  const hiddenCount = holdings.length - viewHoldings(holdings, { hideZero, sort }).length;

  return (
    <Card>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/12 text-primary-ink">
              <Wallet size={14} />
            </span>
            Portfolio
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {loading && holdings.length === 0
              ? "Reading your balances…"
              : `${rows.length} asset${rows.length === 1 ? "" : "s"}`}
          </p>
        </div>
        <div className="text-right">
          <p className="text-lg font-semibold tracking-tight text-foreground [font-variant-numeric:tabular-nums]">
            {holdings.length === 0 && loading ? <Skeleton className="h-6 w-20" /> : formatUsd(totalUsd)}
          </p>
          <p className="text-[11px] text-muted-foreground">Total value</p>
        </div>
      </div>

      {/* Controls stay out of the way until there is enough here to need them. */}
      {holdings.length > 2 && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search tokens"
              aria-label="Search tokens"
              className="w-full rounded-lg border border-border bg-input py-1.5 pl-8 pr-2.5 text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-primary/40"
            />
          </div>
          <div className="flex shrink-0 gap-0.5 rounded-lg border border-border bg-input p-0.5">
            {SORTS.map((s) => (
              <button
                key={s.key}
                onClick={() => setSort(s.key)}
                className={`rounded-md px-2 py-1 text-[11px] font-medium transition ${
                  sort === s.key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
          <button
            onClick={() => setHideZero((h) => !h)}
            title={hideZero ? "Show zero balances" : "Hide zero balances"}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground transition hover:border-primary/40 hover:text-foreground"
          >
            {hideZero ? <EyeOff size={12} /> : <Eye size={12} />}
            {hideZero ? "Hiding empty" : "Showing all"}
          </button>
        </div>
      )}

      {loading && holdings.length === 0 ? (
        <ul className="space-y-2">
          {[0, 1, 2].map((i) => (
            <li key={i} className="flex items-center gap-3 rounded-xl border border-border px-3.5 py-3">
              <Skeleton className="h-8 w-8 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-2.5 w-28" />
              </div>
              <Skeleton className="h-4 w-16" />
            </li>
          ))}
        </ul>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center">
          <p className="text-xs font-medium text-foreground">
            {query ? "No tokens match that search" : "Nothing here yet"}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {query ? "Try a symbol, a name, or a contract address." : "Assets appear here as soon as they arrive."}
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          <AnimatePresence initial={false}>
            {rows.map((h) => (
              <motion.li
                key={h.address}
                layout
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.18 }}
                className="group flex items-center gap-3 rounded-xl border border-border px-3.5 py-3 transition hover:border-primary/30"
              >
                <TokenLogo token={h.symbol} size={28} />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 truncate text-sm font-medium text-foreground">
                    {h.symbol}
                    {!h.verified && !h.native && (
                      <span
                        title="Not on the verified token list. Check the contract before trusting it."
                        className="rounded-full bg-warning/12 px-1.5 py-0.5 text-[9px] font-medium text-warning"
                      >
                        Unverified
                      </span>
                    )}
                  </p>
                  <p className="truncate text-[11px] text-muted-foreground">{h.name}</p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-sm font-medium text-foreground [font-variant-numeric:tabular-nums]">
                    {amount(h.balance)}
                  </p>
                  <p className="text-[11px] text-muted-foreground [font-variant-numeric:tabular-nums]">
                    {h.valueUsd != null ? formatUsd(h.valueUsd) : "—"}
                  </p>
                </div>
                {/* Contract actions, revealed on hover so the row stays calm —
                    and always present for keyboard and touch. */}
                {!h.native && (
                  <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100 sm:opacity-0">
                    <button
                      onClick={() => void copy(h.address, "Contract address copied")}
                      aria-label={`Copy ${h.symbol} contract address`}
                      className="rounded-md p-1.5 text-muted-foreground transition hover:bg-input hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {copied === h.address ? <Check size={12} className="text-success" /> : <Copy size={12} />}
                    </button>
                    <a
                      href={`${MONAD_EXPLORER}/token/${h.address}`}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`View ${h.symbol} on the explorer`}
                      className="rounded-md p-1.5 text-muted-foreground transition hover:bg-input hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <ExternalLink size={12} />
                    </a>
                  </div>
                )}
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}

      {hideZero && hiddenCount > 0 && !query && (
        <button
          onClick={() => setHideZero(false)}
          className="mt-2.5 text-[11px] text-muted-foreground transition hover:text-foreground"
        >
          {hiddenCount} empty {hiddenCount === 1 ? "balance" : "balances"} hidden — show
        </button>
      )}
    </Card>
  );
}
