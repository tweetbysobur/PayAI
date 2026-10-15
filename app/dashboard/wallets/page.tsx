"use client";

import { FundingSourcePicker } from "@/components/dashboard/FundingSourcePicker";
import { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { Wallet as WalletIcon, ArrowUpRight, ArrowDownLeft, Repeat, Activity, TrendingUp, RefreshCw, ShieldCheck, Radio, FileCheck2, KeyRound, Fingerprint, Copy, Check, ExternalLink, LogOut } from "lucide-react";
import Link from "next/link";
import { Badge, Button, Card, Skeleton } from "@/components/ui";
import { useWalletService as useWallet } from "@/lib/wallet-service/WalletServiceContext";
import { LinkedWalletsCard } from "@/components/dashboard/LinkedWalletsCard";
import { WalletManager } from "@/components/dashboard/WalletManager";
import { PortfolioCard } from "@/components/dashboard/PortfolioCard";
import { usePortfolio } from "@/lib/hooks/usePortfolio";
import { formatUsd } from "@/lib/hooks/useTokenPrices";
import { useIdentity } from "@/lib/hooks/useIdentity";
import { useUsername } from "@/lib/hooks/useUsername";
import { useCopy } from "@/lib/hooks/useCopy";
import { fetchHistory } from "@/lib/hooks/historyFetch";
import type { WalletActivitySummary } from "@/lib/platform/walletActivity";
import { MONAD_CHAIN_ID, MONAD_CHAIN_NAME, MONAD_EXPLORER } from "@/lib/monad/public";
import { suiteFromOnchain, type OnchainContractFields } from "@/lib/monad/contractSuite";
import { MonadMark } from "@/components/MonadMark";
import { Identicon } from "@/components/Identicon";
import dynamic from "next/dynamic";
// Lazy-loaded: pulls in viem + qrcode.react, only needed once someone opens it.
const ReceiveModal = dynamic(() => import("@/components/dashboard/ReceiveModal").then((m) => m.ReceiveModal), { ssr: false });

interface OnchainContracts {
  configured: boolean;
  contracts?: OnchainContractFields;
}

interface WalletEvent {
  paymentId: number; direction: "sent" | "received"; counterparty: string;
  amount: number; token: string; riskScore: number; txHash: string; blockNumber: number; timestamp: number | null; explorerUrl: string;
}

interface WalletIntel {
  ok: boolean; configured: boolean; error?: string;
  address?: string; network?: string; chainId?: number; explorerAddressUrl?: string;
  nativeBalance?: string; usdcBalance?: string; monPriceUsd?: number | null; totalValueUsd?: number | null;
  txCountSent?: number; paymentsSent?: number; paymentsReceived?: number;
  volumeSent?: number; volumeReceived?: number; lifetimeVolume?: number; monthlyVolume?: number;
  largestTx?: number; averageTx?: number; gasSpentMon?: number | null;
  events?: WalletEvent[]; domain?: string | null; insights?: string;
}

/** One row of this wallet's own PayAI history (POST /api/agent show_history). */
interface ActivityRow {
  at: number; decision: string; summary: string; amount: number | null; token: string;
  feature?: string; action?: string; txHash?: string; explorerUrl?: string;
}

const short = (s?: string | null) => (s ? `${s.slice(0, 8)}…${s.slice(-6)}` : "—");
const fmt = (n?: number | null, d = 2) => (n != null ? n.toLocaleString(undefined, { maximumFractionDigits: d }) : "—");

/** Allocation segments: shades of the brand colour, largest first. */
const ALLOCATION_OPACITY = [1, 0.7, 0.48, 0.32, 0.2];

export default function Wallets() {
  const wallet = useWallet();
  const identity = useIdentity(wallet.address);
  // Username, then .nad domain, then a short address — never the raw 42-char
  // address as the primary label. wallet.label falls back to the full
  // address when nothing nicer is set, and rendering that inline forced
  // everything beside it (the badge, the balance) into whatever sliver of
  // width was left, which is what wrapped the badge's own text onto three
  // lines. Same identity priority Topbar already uses.
  const handle = useUsername(wallet.address);
  // One read of every holding for the whole page: the Portfolio card, the
  // total and the allocation all come from it, so they always agree.
  const portfolio = usePortfolio(wallet.readAddress, wallet.isLocked);
  const { copy, copied } = useCopy();
  const [onchainContracts, setOnchainContracts] = useState<OnchainContracts | null>(null);
  const [intel, setIntel] = useState<WalletIntel | null>(null);
  // This wallet's own PayAI activity — the same private, wallet-scoped log
  // the Transactions page lists. Null when it couldn't be read (e.g. the
  // wallet is locked), which is shown as such, never as "no activity".
  const [activity, setActivity] = useState<{ summary: WalletActivitySummary; rows: ActivityRow[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [sessionStartedAt, setSessionStartedAt] = useState<number | null>(null);
  const [receiveOpen, setReceiveOpen] = useState(false);

  useEffect(() => {
    fetch("/api/onchain").then((r) => r.json()).then(setOnchainContracts).catch(() => {});
  }, []);

  useEffect(() => {
    if (!wallet.address) { setSessionStartedAt(null); return; }
    const key = `payai_session_${wallet.address.toLowerCase()}`;
    const existing = sessionStorage.getItem(key);
    if (existing) setSessionStartedAt(Number(existing));
    else { const now = Date.now(); sessionStorage.setItem(key, String(now)); setSessionStartedAt(now); }
  }, [wallet.address]);

  const loadIntel = useCallback(() => {
    if (!wallet.address) { setIntel(null); setActivity(null); return; }
    setLoading(true); setFetchError(null);
    fetchHistory(wallet.address)
      .then((j) => {
        const summary = (j as { summary?: WalletActivitySummary }).summary;
        setActivity(summary ? { summary, rows: ((j.history ?? []) as ActivityRow[]).filter((r) => r.decision === "executed").slice(0, 10) } : null);
      })
      .catch(() => setActivity(null));
    fetch(`/api/wallet-intelligence?address=${wallet.address}`)
      .then((r) => r.json())
      .then((j) => {
        if (!j.ok) { setFetchError(j.error || "Couldn't load wallet data from the network."); setIntel(null); }
        else setIntel(j);
      })
      .catch(() => setFetchError("Couldn't reach the network. Check your connection and try again."))
      .finally(() => setLoading(false));
  }, [wallet.address]);

  useEffect(() => { loadIntel(); }, [loadIntel, wallet.chainId]);

  // Allocation by USD value across every priced holding — memecoins
  // included — the four largest by name, the rest together as "Other".
  const allocation = useMemo(() => {
    const priced = portfolio.holdings
      .filter((h) => h.valueUsd != null && h.valueUsd > 0)
      .sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));
    const total = priced.reduce((n, h) => n + (h.valueUsd ?? 0), 0);
    if (total <= 0) return null;
    const top = priced.slice(0, 4).map((h) => ({ key: h.address, label: h.symbol, amount: h.balance, usd: h.valueUsd ?? 0 }));
    const rest = priced.slice(4).reduce((n, h) => n + (h.valueUsd ?? 0), 0);
    const parts = rest > 0 ? [...top, { key: "other", label: `Other (${priced.length - 4})`, amount: null, usd: rest }] : top;
    return { total, parts: parts.map((p) => ({ ...p, share: p.usd / total })) };
  }, [portfolio.holdings]);
  const unpricedHeld = portfolio.holdings.filter((h) => (h.balance ?? 0) > 0 && h.valueUsd == null).length;

  const daily = activity?.summary.daily ?? [];

  return (
    <div className="mx-auto max-w-7xl">
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Wallets</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">Your wallets, balances and on-chain activity.</p>
        </div>
        {wallet.address && (
          // One row at every width: two equal actions and a square refresh —
          // never a lone button wrapped onto a second line.
          <div className="grid grid-cols-[1fr_1fr_auto] gap-2 sm:flex sm:items-center">
            <button type="button" onClick={() => setReceiveOpen(true)}
              className="inline-flex h-10 items-center justify-center gap-1.5 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <ArrowDownLeft size={14} aria-hidden /> Receive
            </button>
            <Link href="/dashboard/payments"
              className="inline-flex h-10 items-center justify-center gap-1.5 rounded-md border border-border px-4 text-sm font-medium text-foreground transition-colors hover:bg-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <ArrowUpRight size={14} aria-hidden /> Send
            </Link>
            <button type="button" onClick={loadIntel} disabled={loading} aria-label="Refresh" title="Refresh"
              className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-input hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} aria-hidden />
            </button>
          </div>
        )}
      </div>

      <div className="mb-4">
        <Card className="!p-0 overflow-hidden">
          {wallet.address ? (
            <>
              {/* Hairline top edge — the premium-surface tell used elsewhere
                  (platform metrics, dashboard showcase). */}
              <div aria-hidden className="h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />
              {/* Identity only — no balance here. Portfolio (right below)
                  already reads every holding, MON and USDC included, straight
                  from the chain with USD values; repeating two of those
                  numbers up here was the same figures twice on one screen,
                  and worse, sitting in a spot that read as if it were
                  competing with Portfolio rather than introducing it. This
                  card's job is identity — whose wallet this is, and which
                  kind — not a second, partial balance. */}
              <div className="flex min-w-0 items-center gap-3.5 p-5 sm:p-6">
                <Identicon address={wallet.address} size={44} className="shrink-0 rounded-full ring-1 ring-border" />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-base font-semibold text-foreground">
                      {handle.hasUsername ? handle.display : identity.display}
                    </p>
                    {/* shrink-0 + whitespace-nowrap: this is the exact fix
                        for the badge that wrapped "PayAI / Wallet /
                        (Embedded)" onto three lines — it was never given a
                        floor width, so it shrank along with everything
                        else competing for the row. */}
                    <span className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-md border px-2 py-0.5 text-[11px] font-medium ${wallet.kind === "embedded" ? "border-primary/30 bg-primary/10 text-primary-ink" : "border-border bg-input text-muted-foreground"}`}>
                      {wallet.kind === "embedded" ? "PayAI Wallet" : "External wallet"}
                    </span>
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <button
                      onClick={() => copy(wallet.address!, "Address copied")}
                      className="inline-flex items-center gap-1 font-mono transition hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
                      title="Copy full address"
                    >
                      {short(wallet.address)}
                      {copied === wallet.address ? <Check size={11} className="text-success" /> : <Copy size={11} />}
                    </button>
                    <span className="inline-flex items-center gap-1 whitespace-nowrap">
                      <MonadMark size={11} /> {wallet.chainId === MONAD_CHAIN_ID ? MONAD_CHAIN_NAME : `Chain ${wallet.chainId ?? "—"}`}
                    </span>
                    <a
                      href={`${MONAD_EXPLORER}/address/${wallet.address}`} target="_blank" rel="noreferrer"
                      className="inline-flex items-center gap-1 whitespace-nowrap text-primary-ink hover:underline"
                    >
                      Explorer <ExternalLink size={10} />
                    </a>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between gap-3 border-t border-border bg-background/40 px-5 py-3 sm:px-6">
                <p className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground" title="Non-custodial: PayAI never holds your keys">
                  <ShieldCheck size={11} className="shrink-0 text-primary-ink" /> You hold this wallet&apos;s keys
                </p>
                <button
                  onClick={wallet.disconnect}
                  className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-muted-foreground transition hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
                >
                  <LogOut size={12} /> Disconnect
                </button>
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
              <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/12 text-primary-ink"><WalletIcon size={20} /></span>
              <div>
                <p className="text-sm font-medium text-foreground">No wallet connected</p>
                <p className="mt-0.5 text-xs text-muted-foreground">Connect a wallet to see balances and on-chain activity.</p>
              </div>
              <Button onClick={() => { window.location.href = "/auth"; }} className="mt-1">Connect wallet</Button>
            </div>
          )}
        </Card>
      </div>

      {wallet.readAddress && (
        <div className="mb-4">
          <PortfolioCard address={wallet.readAddress} locked={wallet.isLocked} portfolio={portfolio} />
        </div>
      )}

      {/* With an account AND a connected wallet, where funds come from is a
          choice the person makes here, explicitly — not whichever happened
          to connect last. */}
      {wallet.accountAddress && wallet.externalAddress && (
        <div className="mb-4">
          <Card>
            <FundingSourcePicker />
          </Card>
        </div>
      )}

      {wallet.accountAddress && (
        <div className="mb-4">
          <WalletManager />
        </div>
      )}

      {wallet.accountAddress && (
        <div className="mb-4">
          <LinkedWalletsCard />
        </div>
      )}

      {/* "Connected Wallets" used to duplicate WalletManager directly above
          it — same active-wallet indicator, same "add another wallet" link,
          just less capable. Recovery Status is the one thing here that isn't
          shown anywhere else, so it keeps its own card. */}
      {wallet.address && (
        <div className="mb-4">
          <Card title="Recovery Status">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/12 text-primary-ink">
                {wallet.kind === "embedded" ? <Fingerprint size={15} /> : <KeyRound size={15} />}
              </span>
              <div>
                {wallet.kind === "embedded" ? (
                  <>
                    <p className="text-sm text-foreground">Recoverable via {wallet.authMethod ?? "your sign-in"}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Sign in again with {wallet.authMethod ?? "the same account"} on any device to recover this exact wallet. PayAI never sees your private key.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-sm text-foreground">Self-custody — you hold the keys</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Recovery is entirely up to your wallet app (seed phrase / hardware device). PayAI has no ability to recover or reset it.
                    </p>
                  </>
                )}
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* Security Center */}
      <Card title="Security Center" className="mb-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <p className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground"><Radio size={12} /> Network status</p>
            {wallet.address ? (
              wallet.isWrongNetwork ? (
                <Badge tone="danger">Wrong network</Badge>
              ) : (
                <Badge tone="success">{wallet.chainId === MONAD_CHAIN_ID ? "Monad verified" : `Chain ${wallet.chainId}`}</Badge>
              )
            ) : <Badge tone="neutral">Not connected</Badge>}
          </div>
          <div>
            <p className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground"><WalletIcon size={12} /> Wallet connection</p>
            <Badge tone={wallet.address ? "success" : "neutral"}>{wallet.address ? "Connected" : "Disconnected"}</Badge>
          </div>
          <div>
            <p className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground"><ShieldCheck size={12} /> Active session</p>
            <p className="text-sm text-foreground">{sessionStartedAt ? `Since ${new Date(sessionStartedAt).toLocaleTimeString()}` : "No active session"}</p>
          </div>
        </div>
        <div className="mt-4 border-t border-border pt-4">
          <p className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground"><FileCheck2 size={12} /> Verified contracts</p>
          {onchainContracts?.configured && onchainContracts.contracts ? (
            <ul className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
              {suiteFromOnchain(onchainContracts.contracts, MONAD_EXPLORER).map((row) => (
                <li key={row.id}>
                  <a
                    href={row.explorer}
                    target="_blank"
                    rel="noreferrer"
                    className="block text-xs hover:underline"
                  >
                    <span className="font-medium text-foreground">{row.name}</span>
                    <span className="ml-2 font-mono text-primary-ink">{short(row.address)} ↗</span>
                  </a>
                  <p className="mt-0.5 text-[11px] leading-4 text-muted-foreground">{row.blurb}</p>
                </li>
              ))}
            </ul>
          ) : <p className="text-xs text-muted-foreground">Not configured on this network.</p>}
          <p className="mt-3 text-[11px] text-muted-foreground">
            Interactive payments go through <span className="text-foreground">PayAIForwarder</span>. Interactive trades go through <span className="text-foreground">PayAITradeExecutor</span>. PaymentExecutor is the automation path, not the contract your wallet pays.
          </p>
        </div>
      </Card>

      {/* Wallet Intelligence */}
      {/* Without a wallet the card at the top already says what to do. */}
      {!wallet.address ? null : loading && !intel ? (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Card key={i} className="p-5">
                <Skeleton className="mb-3 h-9 w-9 rounded-lg" />
                <Skeleton className="h-6 w-20" />
                <Skeleton className="mt-2 h-3 w-24" />
              </Card>
            ))}
          </div>
          <Card>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <RefreshCw size={14} className="animate-spin" /> Loading wallet intelligence from Monad…
            </div>
          </Card>
        </div>
      ) : fetchError ? (
        <Card>
          <p className="text-sm text-danger">{fetchError}</p>
          <Button variant="secondary" onClick={loadIntel} className="mt-3 text-xs">Try again</Button>
        </Card>
      ) : intel && !intel.configured ? (
        <Card><p className="text-sm text-muted-foreground">On-chain payment history isn&apos;t available yet. The PaymentExecutor contract isn&apos;t configured on this network.</p></Card>
      ) : intel ? (
        <>
          <h2 className="mb-3 mt-2 text-sm font-medium text-foreground">Wallet Intelligence</h2>

          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              { label: "Total wallet value", value: formatUsd(portfolio.totalUsd) ?? "—", sub: unpricedHeld > 0 ? `Excludes ${unpricedHeld} unpriced token${unpricedHeld === 1 ? "" : "s"}` : null, icon: TrendingUp },
              { label: "MON balance", value: `${fmt(Number(intel.nativeBalance), 4)} MON`, icon: WalletIcon },
              { label: "USDC balance", value: `${fmt(Number(intel.usdcBalance))} USDC`, icon: WalletIcon },
              { label: "PayAI transactions", value: activity ? fmt(activity.summary.transactions, 0) : "—", sub: activity ? null : "Unlock your wallet to see activity", icon: Activity },
            ].map((k, i) => (
              <motion.div key={k.label} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.05, duration: 0.3 }}>
                <Card className="p-5">
                  <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-primary/12 text-primary-ink"><k.icon size={16} /></div>
                  <p className="text-xl font-semibold tracking-tight text-foreground [font-variant-numeric:tabular-nums]">{k.value}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{k.sub ?? k.label}</p>
                </Card>
              </motion.div>
            ))}
          </div>

          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              { label: "Payments sent", value: activity ? fmt(activity.summary.payments, 0) : "—", icon: ArrowUpRight },
              { label: "Swaps", value: activity ? fmt(activity.summary.swaps, 0) : "—", icon: Repeat },
              {
                label: "Sent in the last 30 days",
                value: !activity ? "—" : Object.keys(activity.summary.sent30dByToken).length === 0 ? "0"
                  : Object.entries(activity.summary.sent30dByToken).map(([t, v]) => `${fmt(v, 4)} ${t}`).join(" · "),
                icon: TrendingUp,
              },
              { label: "On-chain transactions sent", value: fmt(intel.txCountSent, 0), icon: ArrowUpRight },
            ].map((k) => (
              <Card key={k.label} className="p-4">
                <p className="break-words text-lg font-semibold text-foreground [font-variant-numeric:tabular-nums]">{k.value}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{k.label}</p>
              </Card>
            ))}
          </div>

          <div className="mb-4 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
            <Card title="PayAI activity (last 14 active days)">
              {!activity ? (
                <p className="text-sm text-muted-foreground">Unlock your wallet to see your PayAI activity.</p>
              ) : daily.length === 0 ? (
                <p className="text-sm text-muted-foreground">No PayAI transactions yet. Your activity will chart here once you send, swap or automate through PayAI.</p>
              ) : (
                <div className="flex h-36 items-end gap-2 overflow-x-auto">
                  {daily.map((d, i) => {
                    const max = Math.max(1, ...daily.map((x) => x.count));
                    return (
                      <div key={d.date} className="group relative flex min-w-8 flex-1 flex-col items-center gap-1">
                        <div className="pointer-events-none absolute -top-7 hidden whitespace-nowrap rounded-md border border-border bg-panel px-2 py-1 text-[10px] text-foreground shadow-panel group-hover:block">
                          {d.count} transaction{d.count === 1 ? "" : "s"}
                        </div>
                        <motion.div className="w-full max-w-8 rounded-t bg-primary/70 transition-colors group-hover:bg-primary" initial={{ height: 0 }} animate={{ height: `${Math.max(4, (d.count / max) * 100)}px` }} transition={{ delay: i * 0.04, duration: 0.4 }} />
                        <span className="text-[10px] text-muted-foreground/70">{d.date.slice(5)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>

            <Card title="Asset allocation">
              {allocation ? (
                <div className="flex items-center gap-6">
                  <svg width="112" height="112" viewBox="0 0 112 112" className="shrink-0 -rotate-90" aria-hidden>
                    <circle cx="56" cy="56" r="44" fill="none" stroke="var(--color-muted-foreground)" strokeOpacity="0.15" strokeWidth="14" />
                    {allocation.parts.reduce<{ offset: number; els: React.ReactNode[] }>((acc, p, i) => {
                      const c = 2 * Math.PI * 44;
                      acc.els.push(
                        <circle
                          key={p.key} cx="56" cy="56" r="44" fill="none" strokeWidth="14"
                          stroke="var(--color-primary)" strokeOpacity={ALLOCATION_OPACITY[i] ?? 0.2}
                          strokeDasharray={`${c * p.share} ${c}`} strokeDashoffset={-c * acc.offset}
                        />,
                      );
                      acc.offset += p.share;
                      return acc;
                    }, { offset: 0, els: [] }).els}
                  </svg>
                  <div className="min-w-0 flex-1 space-y-2 text-sm">
                    {allocation.parts.map((p, i) => (
                      <div key={p.key} className="flex items-center justify-between gap-3">
                        <span className="flex min-w-0 items-center gap-2 text-foreground">
                          <span className="h-2 w-2 shrink-0 rounded-full bg-primary" style={{ opacity: ALLOCATION_OPACITY[i] ?? 0.2 }} />
                          <span className="truncate">{p.label}</span>
                        </span>
                        <span className="shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                          <span className="text-foreground">{formatUsd(p.usd)}</span> · {Math.round(p.share * 100)}%
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : <p className="text-sm text-muted-foreground">No priced holdings yet.</p>}
            </Card>
          </div>

          <Card title="Recent activity">
            {!activity ? (
              <p className="text-sm text-muted-foreground">Unlock your wallet to see your PayAI activity.</p>
            ) : activity.rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">No PayAI transactions yet for this wallet.</p>
            ) : (
              <ul className="divide-y divide-border">
                {activity.rows.map((r, i) => (
                  <li key={`${r.txHash ?? r.at}-${i}`} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <p className="truncate text-sm text-foreground">{r.summary}</p>
                      <p className="text-[11px] text-muted-foreground">{new Date(r.at).toLocaleString()}</p>
                    </div>
                    {r.explorerUrl || r.txHash ? (
                      <Link
                        href={`/dashboard/transactions?tab=activity&tx=${encodeURIComponent(r.txHash ?? "")}`}
                        className="shrink-0 font-mono text-xs text-primary-ink hover:underline"
                      >
                        {short(r.txHash)}
                      </Link>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
            {activity && activity.rows.length > 0 && (
              <Link href="/dashboard/transactions" className="mt-3 inline-block text-xs text-muted-foreground hover:text-foreground">
                All transactions →
              </Link>
            )}
          </Card>
        </>
      ) : null}

      <ReceiveModal open={receiveOpen} onClose={() => setReceiveOpen(false)} />
    </div>
  );
}
