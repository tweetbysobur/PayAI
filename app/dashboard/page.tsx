"use client";

import { stoppedNotice, STOPPED_LABEL } from "@/lib/hooks/stoppedPayments";
import { fetchHistory } from "@/lib/hooks/historyFetch";
import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowDownLeft, ArrowLeftRight, ArrowUpRight, AlertTriangle } from "lucide-react";
import dynamic from "next/dynamic";
import { Skeleton, SkeletonRows } from "@/components/ui";
import { Identicon } from "@/components/Identicon";
import { TokenLogo } from "@/components/TokenLogo";
import { useWalletService as useWallet } from "@/lib/wallet-service/WalletServiceContext";
import { AskEntry } from "@/components/dashboard/AskEntry";
import { useIdentity } from "@/lib/hooks/useIdentity";
import { usePortfolio, viewHoldings } from "@/lib/hooks/usePortfolio";
import { formatUsd } from "@/lib/hooks/useTokenPrices";
import { useSyncRefresher } from "@/lib/hooks/useSync";
import { SyncButton } from "@/components/dashboard/SyncButton";
import { useToast } from "@/components/Toast";
import { timeAgo } from "@/lib/hooks/useAgentConsole";
import {
  ActivityRow, EmptyState, SectionHeader, StatusIndicator, type StatusTone,
} from "@/components/dashboard/primitives";
// Lazy-loaded: pulls in viem + qrcode.react, only needed once someone opens it.
const ReceiveModal = dynamic(() => import("@/components/dashboard/ReceiveModal").then((m) => m.ReceiveModal), { ssr: false });

/**
 * The Dashboard — the entry point to PayAI: intent → plan → approval →
 * onchain execution. In order:
 *
 *   1–3  Welcome, what PayAI does, and the intent box (AskEntry). Submitting
 *        hands the exact words to Ask PayAI, which plans and asks for review
 *        and approval — the Dashboard executes nothing.
 *   4    Needs attention — wallet state, failing automations, payments the risk check stopped.
 *   5    Recent activity — this wallet's own executed transactions.
 *   6    Coming up — the next scheduled and recurring actions.
 *   7    Wallet — balance and top holdings, last: supporting information,
 *        not the identity of the page.
 *
 * Every value is this wallet's real data from the endpoints the rest of the
 * dashboard uses (history via /api/agent show-history, automations via
 * /api/automations, holdings via usePortfolio — the hook PortfolioCard uses)
 * and is scoped to the connected wallet. Unknown values read "—".
 */

interface HistoryRow { at: number; decision: string; summary: string; amount: number | null; token: string; recipient?: string | null; domain?: string | null; txHash?: string; explorerUrl?: string; action?: string; feature?: string }
interface Automation { id: string; amount: number; token: string; recipient: string; domain?: string | null; cadence: string; nextRun: number; status: string; purpose?: string; failureCount?: number; lastError?: string | null }

const short = (s?: string | null) => (s ? `${s.slice(0, 6)}…${s.slice(-4)}` : "—");

const DECISION: Record<string, { label: string; tone: StatusTone }> = {
  executed: { label: "Settled", tone: "success" },
  needs_review: { label: STOPPED_LABEL, tone: "warning" },
  blocked: { label: "Blocked", tone: "danger" },
  refused: { label: "Refused", tone: "danger" },
  error: { label: "Failed", tone: "danger" },
};

/** Capabilities, not examples: each only starts the sentence. */
const CAPABILITIES = [
  { label: "Send", fill: "Send " },
  { label: "Trade", fill: "Swap " },
  { label: "Automate", fill: "Automate " },
  { label: "Schedule", fill: "Schedule " },
] as const;

const isSwap = (h: HistoryRow) => h.feature === "swap" || h.feature === "trade" || h.action === "swap";

function when(ms: number): string {
  const d = new Date(ms);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? `Today, ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`
    : d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

interface AttentionItem { key: string; tone: StatusTone; title: string; detail?: string; action?: { label: string; href?: string; onClick?: () => void } }

export default function Dashboard() {
  const wallet = useWallet();
  const identity = useIdentity(wallet.readAddress);
  const { toast } = useToast();
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    // Scoped to the connected wallet — the server returns only this wallet's
    // history and automations. Without a wallet there's nothing to scope to,
    // so these come back empty by design.
    return Promise.all([
      fetch(`/api/automations${wallet.address ? `?wallet=${wallet.address}` : ""}`).then((r) => r.json()).then((j) => setAutomations(j.automations ?? [])).catch(() => {}),
      fetchHistory(wallet.address)
        .then((j) => setHistory((j.history ?? []) as HistoryRow[])).catch(() => {}),
    ]).finally(() => setLoaded(true));
  }, [wallet.address]);

  // Joins the dashboard's single sync (lib/hooks/useSync.tsx): the Refresh
  // button, a completed payment and the background heartbeat all land here.
  useSyncRefresher(refresh);

  const upcoming = useMemo(
    () => automations
      .filter((a) => a.status === "active" || a.status === "scheduled" || a.status === "executing")
      .sort((x, y) => x.nextRun - y.nextRun),
    [automations],
  );

  const attention = useMemo<AttentionItem[]>(() => {
    const items: AttentionItem[] = [];
    if (wallet.isLocked) {
      items.push({
        key: "locked", tone: "warning", title: "Your wallet is locked",
        detail: "Unlock it with your passkey to send, swap or approve. You can still receive.",
        action: {
          label: busy ? "Unlocking…" : "Unlock",
          onClick: () => {
            setBusy(true);
            wallet.setUpEmbeddedWallet({ create: false })
              .then(() => toast("Wallet unlocked"))
              .catch(() => toast(wallet.error ?? "Couldn't unlock your wallet.", "error"))
              .finally(() => setBusy(false));
          },
        },
      });
    } else if (!wallet.address) {
      items.push({ key: "connect", tone: "neutral", title: "No wallet connected", detail: "Connect a wallet to see your activity and start paying.", action: { label: "Connect", href: "/auth" } });
    } else if (wallet.isWrongNetwork) {
      items.push({
        key: "network", tone: "warning", title: "Your wallet is on the wrong network",
        detail: "PayAI settles on Monad Mainnet.",
        action: {
          label: busy ? "Switching…" : "Switch to Monad",
          onClick: () => {
            setBusy(true);
            wallet.switchNetwork()
              .then(() => toast("Switched to Monad Mainnet"))
              .catch(() => toast("Couldn't switch network. Do it in your wallet.", "error"))
              .finally(() => setBusy(false));
          },
        },
      });
    }
    for (const a of automations) {
      const name = a.purpose || "Automation";
      if (a.status === "failed") {
        items.push({ key: `af-${a.id}`, tone: "danger", title: `${name} stopped`, detail: a.lastError ?? "Its last run failed and it won't run again until you act.", action: { label: "Review", href: "/dashboard/automations" } });
      } else if ((a.failureCount ?? 0) > 0 && (a.status === "active" || a.status === "scheduled")) {
        items.push({ key: `aw-${a.id}`, tone: "warning", title: `${name}: last run failed`, detail: a.lastError ?? "It will try again at its next run.", action: { label: "Review", href: "/dashboard/automations" } });
      }
    }
    // Payments the risk check stopped: nothing was sent and nothing is waiting
    // (lib/hooks/stoppedPayments.ts). Recent ones only, so the warning clears.
    const stopped = stoppedNotice(history);
    if (stopped) {
      items.push({ key: "stopped", tone: "warning", title: stopped.title, detail: stopped.detail, action: { label: "View them", href: stopped.href } });
    }
    return items;
  }, [wallet, automations, history, busy, toast]);

  const walletState: { tone: StatusTone; label: string } = wallet.isLocked
    ? { tone: "warning", label: "Locked" }
    : !wallet.address ? { tone: "neutral", label: "Not connected" }
      : wallet.isWrongNetwork ? { tone: "warning", label: "Wrong network" }
        : { tone: "success", label: "Monad Mainnet" };

  const portfolio = usePortfolio(wallet.readAddress, wallet.isLocked);
  const topHoldings = useMemo(() => viewHoldings(portfolio.holdings, { hideZero: true, sort: "value" }).slice(0, 5), [portfolio.holdings]);
  const unpriced = portfolio.holdings.filter((h) => (h.balance ?? 0) > 0 && h.valueUsd == null).length;

  return (
    <div className="mx-auto max-w-5xl">
      {/* Who and where — one quiet line. */}
      <div className="mb-8 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 sm:mb-12">
        <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          {wallet.readAddress && (
            <span className="flex min-w-0 items-center gap-2">
              <Identicon address={wallet.readAddress} size={16} />
              <span className={identity.domain ? "truncate text-foreground" : "truncate font-mono text-foreground"}>{identity.domain ?? identity.display}</span>
            </span>
          )}
          <StatusIndicator tone={walletState.tone} label={walletState.label} />
        </span>
        <SyncButton />
      </div>

      {/* 1–3: what PayAI is, and the one thing to do here — tell it. */}
      <section aria-labelledby="welcome-title" className="mb-10 sm:mb-14">
        <h1 id="welcome-title" className="text-2xl font-semibold tracking-tight text-foreground sm:text-4xl">Welcome to PayAI</h1>
        <p className="mt-2 text-base font-medium text-foreground sm:text-xl">Turn intent into onchain execution in seconds.</p>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground sm:text-base">
          Tell PayAI what you want done. It understands your intent, prepares the action, and lets you review it before execution.
        </p>
        <div className="mt-6 max-w-3xl">
          <AskEntry
            id="intent"
            hideLabel
            label="What do you want to do?"
            placeholder="What do you want to do?"
            suggestions={CAPABILITIES}
          />
        </div>
      </section>

      {/* 4: only what genuinely needs the person. */}
      <section aria-labelledby="attention-title" className="mb-8 sm:mb-10">
        <SectionHeader id="attention-title" title="Needs attention" />
        {!loaded ? (
          <SkeletonRows rows={1} />
        ) : attention.length === 0 ? (
          <StatusIndicator tone="neutral" label="Nothing needs your attention." className="text-sm" />
        ) : (
          <ul className={`divide-y divide-border rounded-lg border bg-panel ${attention.some((i) => i.tone !== "neutral") ? "border-danger/40" : "border-border"}`}>
            {attention.map((item) => (
              <li key={item.key} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                <AlertTriangle size={15} aria-hidden className={`shrink-0 ${item.tone === "neutral" ? "text-muted-foreground" : "text-danger"}`} />
                <div className="min-w-0 flex-1 basis-48">
                  <p className="text-sm text-foreground">{item.title}</p>
                  {item.detail && <p className="mt-0.5 break-words text-xs text-muted-foreground">{item.detail}</p>}
                </div>
                {item.action && (item.action.href
                  ? <Link href={item.action.href} className="inline-flex h-8 shrink-0 items-center rounded-md border border-border px-3 text-xs font-medium text-foreground transition-colors hover:bg-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{item.action.label}</Link>
                  : <button type="button" disabled={busy} onClick={item.action.onClick} className="inline-flex h-8 shrink-0 items-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{item.action.label}</button>)}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 5–6: what happened, what's next. */}
      <div className="mb-8 grid gap-8 sm:mb-10 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <section aria-labelledby="recent-title" className="min-w-0">
          <SectionHeader id="recent-title" title="Recent activity" href="/dashboard/transactions" />
          <div className="rounded-lg border border-border bg-panel px-4">
            {!loaded ? (
              <div className="py-4"><SkeletonRows rows={4} /></div>
            ) : history.length === 0 ? (
              <EmptyState
                compact
                title="No activity yet"
                hint="What PayAI executes for you shows up here once it settles on Monad."
              />
            ) : (
              <ul className="divide-y divide-border">
                {history.slice(0, 6).map((h, i) => {
                  const d = DECISION[h.decision] ?? { label: h.decision, tone: "neutral" as const };
                  const swap = isSwap(h);
                  return (
                    <ActivityRow
                      key={`${h.at}-${i}`}
                      icon={swap ? ArrowLeftRight : ArrowUpRight}
                      title={swap ? (h.summary || "Swap") : <>To {h.domain ?? short(h.recipient)}</>}
                      status={d}
                      meta={timeAgo(h.at)}
                      amount={h.amount != null ? <>{h.amount} <span className="text-xs font-normal text-muted-foreground">{h.token}</span></> : "—"}
                      receipt={h.txHash && h.explorerUrl ? { href: h.explorerUrl, label: short(h.txHash) } : null}
                    />
                  );
                })}
              </ul>
            )}
          </div>
        </section>

        <section aria-labelledby="next-title" className="min-w-0">
          <SectionHeader id="next-title" title="Coming up" href="/dashboard/automations" linkLabel="Automations" />
          <div className="rounded-lg border border-border bg-panel px-4">
            {!loaded ? (
              <div className="py-4"><SkeletonRows rows={2} /></div>
            ) : upcoming.length === 0 ? (
              <EmptyState compact title="Nothing scheduled" hint="Scheduled and recurring actions show up here." />
            ) : (
              <ul className="divide-y divide-border">
                {upcoming.slice(0, 4).map((a) => (
                  <li key={a.id} className="py-3">
                    <div className="flex items-baseline justify-between gap-3">
                      <p className="min-w-0 truncate text-sm text-foreground">{a.purpose || "Automation"}</p>
                      <p className="shrink-0 text-sm font-medium tabular-nums text-foreground">{a.amount} <span className="text-xs font-normal text-muted-foreground">{a.token}</span></p>
                    </div>
                    <div className="mt-0.5 flex min-w-0 items-center gap-x-2 text-xs text-muted-foreground">
                      <StatusIndicator tone={a.status === "executing" ? "pending" : "neutral"} label={a.status === "executing" ? "Running now" : when(a.nextRun)} className="shrink-0" />
                      <span className="truncate">· {a.cadence} · to {a.domain ?? short(a.recipient)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>

      {/* 7: supporting wallet information — last, and compact. */}
      <section aria-labelledby="wallet-title">
        <SectionHeader id="wallet-title" title="Wallet" href="/dashboard/wallets" linkLabel="All assets" />
        <div className="rounded-lg border border-border bg-panel">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">Balance</p>
              <div className="mt-0.5 text-lg font-semibold tabular-nums text-foreground">
                {!wallet.readAddress ? "—"
                  : portfolio.loading && portfolio.holdings.length === 0 ? <Skeleton className="h-6 w-24" />
                  : formatUsd(portfolio.totalUsd) ?? "—"}
              </div>
              {unpriced > 0 && <p className="text-xs text-muted-foreground">Excludes {unpriced} unpriced asset{unpriced === 1 ? "" : "s"}</p>}
            </div>
            {wallet.readAddress && (
              <button type="button" onClick={() => setReceiveOpen(true)} className="inline-flex h-9 items-center gap-2 rounded-md border border-border px-3 text-sm text-foreground transition-colors hover:bg-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <ArrowDownLeft size={14} aria-hidden /> Receive
              </button>
            )}
          </div>
          <div className="px-4">
            {!wallet.readAddress ? (
              <EmptyState compact title="No wallet connected" action={{ label: "Connect", href: "/auth" }} />
            ) : portfolio.loading && portfolio.holdings.length === 0 ? (
              <div className="py-4"><SkeletonRows rows={2} /></div>
            ) : topHoldings.length === 0 ? (
              <EmptyState compact title="No assets yet" hint="Deposit MON or USDC to this wallet to fund execution." />
            ) : (
              <ul className="divide-y divide-border">
                {topHoldings.map((h) => (
                  <li key={h.address} className="flex items-center gap-3 py-2.5">
                    <TokenLogo token={h.symbol} logoURI={h.logoURI} size={24} />
                    <p className="min-w-0 flex-1 truncate text-sm text-foreground">{h.symbol}</p>
                    <p className="shrink-0 text-xs tabular-nums text-muted-foreground">{h.balance == null ? "—" : h.balance.toLocaleString(undefined, { maximumFractionDigits: h.balance < 1 ? 6 : 4 })}</p>
                    <p className="w-20 shrink-0 text-right text-sm tabular-nums text-foreground">{formatUsd(h.valueUsd) ?? "—"}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      <ReceiveModal open={receiveOpen} onClose={() => setReceiveOpen(false)} />
    </div>
  );
}
