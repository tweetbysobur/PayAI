"use client";

import { useMemo, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import Link from "next/link";
import {
  Activity as ActivityIcon, ArrowLeftRight, ArrowUpRight, CheckCircle2, Clock3,
  ExternalLink, LifeBuoy, Repeat, Search, Undo2, Wallet, XCircle,
} from "lucide-react";
import { Card, Skeleton } from "@/components/ui";
import { SyncButton } from "@/components/dashboard/SyncButton";
import { useWalletService as useWallet } from "@/lib/wallet-service/WalletServiceContext";
import { useActivity, filterActivity, type ActivityKind, type Period } from "@/lib/hooks/useActivity";

/**
 * Activity Center — everything that has happened, in one place.
 *
 * Payments lived in Transactions, automation runs behind each automation,
 * swaps only in the tx log, wallet movements only in the bell. "What happened
 * to my money this week?" had no page that could answer it. This does not
 * record anything new; it merges what is already there, which is why it can
 * never disagree with the pages it draws from.
 */

const KINDS: { key: ActivityKind; label: string; icon: typeof Wallet }[] = [
  { key: "payment", label: "Payments", icon: ArrowUpRight },
  { key: "automation", label: "Automations", icon: Repeat },
  { key: "swap", label: "Swaps", icon: ArrowLeftRight },
  { key: "refund", label: "Refunds", icon: Undo2 },
  { key: "wallet", label: "Wallet", icon: Wallet },
  { key: "support", label: "Support", icon: LifeBuoy },
];

const PERIODS: { key: Period; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
  { key: "all", label: "All" },
];

const KIND_ICON: Record<ActivityKind, typeof Wallet> = {
  payment: ArrowUpRight,
  automation: Repeat,
  swap: ArrowLeftRight,
  refund: Undo2,
  wallet: Wallet,
  support: LifeBuoy,
};

function ago(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 45) return "just now";
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export default function ActivityCenter() {
  const wallet = useWallet();
  const { items, loading } = useActivity(wallet.readAddress, wallet.providerId);
  const [period, setPeriod] = useState<Period>("week");
  const [kinds, setKinds] = useState<ActivityKind[]>([]);
  const [query, setQuery] = useState("");

  const rows = useMemo(
    () => filterActivity(items, { period, kinds, query }),
    [items, period, kinds, query],
  );

  function toggleKind(k: ActivityKind) {
    setKinds((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]));
  }

  return (
    <div className="mx-auto max-w-4xl">
      <motion.div
        initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }}
        className="mb-6 flex items-start justify-between gap-4"
      >
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Activity</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Every payment, automation, swap and wallet event in one feed.
          </p>
        </div>
        <SyncButton className="shrink-0 pt-1" />
      </motion.div>

      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex shrink-0 gap-0.5 rounded-lg border border-border bg-input p-0.5">
            {PERIODS.map((p) => (
              <button
                key={p.key}
                onClick={() => setPeriod(p.key)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
                  period === p.key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="relative min-w-0 flex-1">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search activity"
              aria-label="Search activity"
              className="w-full rounded-lg border border-border bg-input py-1.5 pl-8 pr-2.5 text-xs text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-primary/40"
            />
          </div>
        </div>

        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {KINDS.map((k) => {
            const on = kinds.includes(k.key);
            const Icon = k.icon;
            return (
              <button
                key={k.key}
                onClick={() => toggleKind(k.key)}
                aria-pressed={on}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition ${
                  on
                    ? "border-primary/40 bg-primary/10 text-primary-ink"
                    : "border-border text-muted-foreground hover:border-primary/30 hover:text-foreground"
                }`}
              >
                <Icon size={11} /> {k.label}
              </button>
            );
          })}
          {kinds.length > 0 && (
            <button
              onClick={() => setKinds([])}
              className="rounded-full px-2 py-1 text-[11px] text-muted-foreground transition hover:text-foreground"
            >
              Clear
            </button>
          )}
        </div>
      </Card>

      {!wallet.readAddress ? (
        <Card className="py-12 text-center">
          <p className="text-sm font-medium text-foreground">Connect a wallet to see your activity</p>
          <p className="mt-1 text-xs text-muted-foreground">Your feed is scoped to your own wallet.</p>
        </Card>
      ) : loading && items.length === 0 ? (
        <Card>
          <ul className="space-y-3">
            {[0, 1, 2, 3].map((i) => (
              <li key={i} className="flex items-center gap-3">
                <Skeleton className="h-8 w-8 rounded-full" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3 w-32" />
                  <Skeleton className="h-2.5 w-52" />
                </div>
                <Skeleton className="h-3 w-12" />
              </li>
            ))}
          </ul>
        </Card>
      ) : rows.length === 0 ? (
        <Card className="py-12 text-center">
          <span className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-input text-muted-foreground">
            <ActivityIcon size={20} />
          </span>
          <p className="text-sm font-medium text-foreground">
            {items.length === 0 ? "Nothing has happened yet" : "Nothing matches these filters"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {items.length === 0
              ? "Payments, automations and swaps land here as they happen."
              : "Try a wider period, or clear the filters."}
          </p>
        </Card>
      ) : (
        <Card>
          <ul className="divide-y divide-border">
            <AnimatePresence initial={false}>
              {rows.map((item) => {
                const Icon = KIND_ICON[item.kind];
                const tone =
                  item.status === "ok" ? "bg-success/12 text-success"
                    : item.status === "failed" ? "bg-danger/12 text-danger"
                    : item.status === "pending" ? "bg-warning/12 text-warning"
                    : "bg-input text-muted-foreground";
                const StatusIcon =
                  item.status === "ok" ? CheckCircle2
                    : item.status === "failed" ? XCircle
                    : item.status === "pending" ? Clock3
                    : null;
                return (
                  <motion.li
                    key={item.id}
                    layout
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.16 }}
                    className="flex items-start gap-3 py-3 first:pt-0 last:pb-0"
                  >
                    <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${tone}`}>
                      <Icon size={14} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className="flex items-center gap-1.5 truncate text-sm font-medium text-foreground">
                          {item.title}
                          {StatusIcon && <StatusIcon size={12} className={item.status === "ok" ? "text-success" : item.status === "failed" ? "text-danger" : "text-warning"} />}
                        </p>
                        <span className="shrink-0 text-[11px] text-muted-foreground" title={new Date(item.at).toLocaleString()}>
                          {ago(item.at)}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground" title={item.detail}>
                        {item.detail}
                      </p>
                      <div className="mt-1.5 flex items-center gap-3">
                        {item.href && (
                          <Link href={item.href} className="text-[11px] font-medium text-primary-ink hover:underline">
                            Open
                          </Link>
                        )}
                        {/* Only a real transaction gets an explorer link — the
                            synthetic markers used for contract-internal
                            transfers point at nothing. */}
                        {item.explorerUrl && item.txHash && !item.txHash.startsWith("internal:") && (
                          <a
                            href={item.explorerUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 font-mono text-[11px] text-muted-foreground transition hover:text-foreground"
                          >
                            {item.txHash.slice(0, 10)}… <ExternalLink size={9} />
                          </a>
                        )}
                      </div>
                    </div>
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ul>
        </Card>
      )}
    </div>
  );
}
