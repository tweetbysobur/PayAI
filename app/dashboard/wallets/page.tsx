"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { Wallet as WalletIcon, Sparkles, ArrowUpRight, ArrowDownLeft, Fuel, TrendingUp, RefreshCw, ShieldCheck, Radio, FileCheck2 } from "lucide-react";
import { Badge, Button, Card, Skeleton } from "@/components/ui";
import { useWallet } from "@/lib/wallet/useWallet";
import { useWalletBalances } from "@/lib/hooks/useWalletBalances";
import { useIdentity } from "@/lib/hooks/useIdentity";
import { MONAD_CHAIN_ID, MONAD_EXPLORER } from "@/lib/monad/public";
import { MonadMark } from "@/components/MonadMark";
import dynamic from "next/dynamic";
// Lazy-loaded: pulls in viem + qrcode.react, only needed once someone opens it.
const ReceiveModal = dynamic(() => import("@/components/dashboard/ReceiveModal").then((m) => m.ReceiveModal), { ssr: false });

interface OnchainContracts {
  configured: boolean;
  contracts?: { paymentExecutor: string; merchantRegistry: string; executorExplorer: string };
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

const short = (s?: string | null) => (s ? `${s.slice(0, 8)}…${s.slice(-6)}` : "—");
const fmt = (n?: number | null, d = 2) => (n != null ? n.toLocaleString(undefined, { maximumFractionDigits: d }) : "—");
const fmtUsd = (n?: number | null) => (n != null ? `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "—");

export default function Wallets() {
  const wallet = useWallet();
  const identity = useIdentity(wallet.address);
  const balances = useWalletBalances(wallet.address);
  const [onchainContracts, setOnchainContracts] = useState<OnchainContracts | null>(null);
  const [busy, setBusy] = useState(false);
  const [intel, setIntel] = useState<WalletIntel | null>(null);
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
    if (!wallet.address) { setIntel(null); return; }
    setLoading(true); setFetchError(null);
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

  const assetSplit = useMemo(() => {
    const mon = Number(balances.mon ?? 0);
    const usdc = Number(balances.usdc ?? 0);
    const monUsd = intel?.monPriceUsd != null ? mon * intel.monPriceUsd : null;
    const total = monUsd != null ? monUsd + usdc : mon + usdc;
    if (total <= 0) return null;
    const monShare = monUsd != null ? monUsd / total : mon / total;
    return { mon, usdc, monShare };
  }, [balances, intel?.monPriceUsd]);

  const dailyVolume = useMemo(() => {
    if (!intel?.events?.length) return [];
    const days: { date: string; volume: number; count: number }[] = [];
    const map = new Map<string, { volume: number; count: number }>();
    for (const e of intel.events) {
      if (!e.timestamp) continue;
      const key = new Date(e.timestamp).toISOString().slice(0, 10);
      const cur = map.get(key) ?? { volume: 0, count: 0 };
      cur.volume += e.amount; cur.count += 1;
      map.set(key, cur);
    }
    const sortedKeys = Array.from(map.keys()).sort().slice(-14);
    for (const k of sortedKeys) days.push({ date: k, ...map.get(k)! });
    return days;
  }, [intel?.events]);

  return (
    <div className="mx-auto max-w-7xl">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Wallets</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">Your connected wallet and live on-chain intelligence.</p>
        </div>
        {wallet.address && (
          <div className="flex items-center gap-2">
            <Button onClick={() => setReceiveOpen(true)} className="flex items-center gap-1.5 text-xs">
              <ArrowDownLeft size={13} /> Receive
            </Button>
            <Button variant="secondary" onClick={loadIntel} disabled={loading} className="flex items-center gap-1.5 text-xs">
              <RefreshCw size={13} className={loading ? "animate-spin" : ""} /> Refresh
            </Button>
          </div>
        )}
      </div>

      <div className="mb-4">
        <Card title="Your wallet">
          {wallet.address ? (
            <div className="flex items-center justify-between">
              <div>
                <p className="flex items-center gap-2 font-mono text-sm text-foreground"><WalletIcon size={14} className="text-primary-ink" /> {identity.display}</p>
                <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                  {wallet.chainId != null ? <><MonadMark size={11} /> Chain {wallet.chainId}</> : "—"}
                  {" · "}
                  <a href={`${MONAD_EXPLORER}/address/${wallet.address}`} target="_blank" rel="noreferrer" className="text-primary-ink hover:underline">View on explorer ↗</a>
                </p>
              </div>
              <div className="text-right">
                <p className="text-sm text-foreground">{balances.mon ? `${Number(balances.mon).toFixed(4)} MON` : "—"}</p>
                <p className="text-xs text-muted-foreground">{balances.usdc ? `${Number(balances.usdc).toFixed(2)} USDC` : "—"}</p>
              </div>
            </div>
          ) : (
            <Button disabled={busy} onClick={() => { setBusy(true); wallet.connect().catch(() => {}).finally(() => setBusy(false)); }}>
              {busy ? "Connecting…" : "Connect wallet"}
            </Button>
          )}
          {wallet.address && <Button variant="ghost" onClick={wallet.disconnect} className="mt-3 text-xs hover:text-danger">Disconnect</Button>}
        </Card>
      </div>

      {/* Security Center */}
      <Card title="Security Center" className="mb-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
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
          <div>
            <p className="mb-1.5 flex items-center gap-1.5 text-xs text-muted-foreground"><FileCheck2 size={12} /> Verified contracts</p>
            {onchainContracts?.configured && onchainContracts.contracts ? (
              <div className="space-y-1 text-xs">
                <a href={onchainContracts.contracts.executorExplorer} target="_blank" rel="noreferrer" className="block font-mono text-primary-ink hover:underline">PaymentExecutor: {short(onchainContracts.contracts.paymentExecutor)} ↗</a>
                <a href={`${MONAD_EXPLORER}/address/${onchainContracts.contracts.merchantRegistry}`} target="_blank" rel="noreferrer" className="block font-mono text-primary-ink hover:underline">MerchantRegistry: {short(onchainContracts.contracts.merchantRegistry)} ↗</a>
              </div>
            ) : <p className="text-xs text-muted-foreground">Not configured on this network.</p>}
          </div>
        </div>
      </Card>

      {/* Wallet Intelligence */}
      {!wallet.address ? (
        <Card>
          <p className="text-sm text-muted-foreground">Connect your wallet above to see your real balances, payment history, and on-chain activity.</p>
        </Card>
      ) : loading && !intel ? (
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
              { label: "Total wallet value", value: fmtUsd(intel.totalValueUsd), sub: intel.monPriceUsd == null ? "USD price unavailable" : null, icon: TrendingUp },
              { label: "MON balance", value: `${fmt(Number(intel.nativeBalance), 4)} MON`, icon: WalletIcon },
              { label: "USDC balance", value: `${fmt(Number(intel.usdcBalance))} USDC`, icon: WalletIcon },
              { label: "Gas spent (PayAI txs)", value: intel.gasSpentMon != null ? `${fmt(intel.gasSpentMon, 6)} MON` : "Unavailable", icon: Fuel },
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
              { label: "Payments sent", value: fmt(intel.paymentsSent, 0), icon: ArrowUpRight },
              { label: "Payments received", value: fmt(intel.paymentsReceived, 0), icon: ArrowDownLeft },
              { label: "Lifetime volume", value: `${fmt(intel.lifetimeVolume)} USDC`, icon: TrendingUp },
              { label: "Monthly volume (30d)", value: `${fmt(intel.monthlyVolume)} USDC`, icon: TrendingUp },
              { label: "Largest transaction", value: `${fmt(intel.largestTx)} USDC`, icon: TrendingUp },
              { label: "Average transaction", value: `${fmt(intel.averageTx)} USDC`, icon: TrendingUp },
              { label: "Transactions sent (nonce)", value: fmt(intel.txCountSent, 0), icon: TrendingUp },
              { label: ".nads domain", value: intel.domain ?? "Not set", icon: WalletIcon },
            ].map((k, i) => (
              <Card key={k.label} className="p-4">
                <p className="text-lg font-semibold text-foreground [font-variant-numeric:tabular-nums]">{k.value}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{k.label}</p>
              </Card>
            ))}
          </div>

          <Card title="AI Insights" className="mb-4">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/12 text-primary-ink"><Sparkles size={14} /></div>
              <p className="text-sm leading-relaxed text-foreground">{intel.insights}</p>
            </div>
          </Card>

          <div className="mb-4 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
            <Card title="Payment volume (last 14 days with activity)">
              {dailyVolume.length === 0 ? (
                <p className="text-sm text-muted-foreground">No payment activity yet. Volume will chart here once you send or receive through PayAI.</p>
              ) : (
                <div className="flex h-36 items-end gap-2 overflow-x-auto">
                  {dailyVolume.map((d, i) => {
                    const max = Math.max(1, ...dailyVolume.map((x) => x.volume));
                    return (
                      <div key={d.date} className="group relative flex min-w-8 flex-1 flex-col items-center gap-1">
                        <div className="pointer-events-none absolute -top-7 hidden whitespace-nowrap rounded-md border border-border bg-panel px-2 py-1 text-[10px] text-foreground shadow-panel group-hover:block">
                          {d.volume.toFixed(2)} USDC ({d.count} tx)
                        </div>
                        <motion.div className="w-full max-w-8 rounded-t bg-primary/70 transition-colors group-hover:bg-primary" initial={{ height: 0 }} animate={{ height: `${Math.max(2, (d.volume / max) * 100)}px` }} transition={{ delay: i * 0.04, duration: 0.4 }} />
                        <span className="text-[10px] text-muted-foreground/70">{d.date.slice(5)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>

            <Card title="Asset allocation">
              {assetSplit ? (
                <div className="flex items-center gap-6">
                  <div className="relative h-28 w-28 shrink-0" title={`MON ${Math.round(assetSplit.monShare * 100)}% · USDC ${Math.round((1 - assetSplit.monShare) * 100)}%`}>
                    <svg width="112" height="112" viewBox="0 0 112 112" className="-rotate-90">
                      <circle cx="56" cy="56" r="44" fill="none" stroke="var(--color-secondary)" strokeWidth="14" />
                      <motion.circle
                        cx="56" cy="56" r="44" fill="none" stroke="var(--color-primary)" strokeWidth="14"
                        strokeDasharray={2 * Math.PI * 44}
                        initial={{ strokeDashoffset: 2 * Math.PI * 44 }}
                        animate={{ strokeDashoffset: 2 * Math.PI * 44 * (1 - assetSplit.monShare) }}
                        transition={{ duration: 0.8, ease: "easeOut" }}
                      />
                    </svg>
                  </div>
                  <div className="flex-1 space-y-2 text-sm">
                    <div className="flex items-center justify-between"><span className="flex items-center gap-2 text-foreground"><span className="h-2 w-2 rounded-full bg-primary" />MON</span><span className="text-muted-foreground">{fmt(assetSplit.mon, 4)}</span></div>
                    <div className="flex items-center justify-between"><span className="flex items-center gap-2 text-foreground"><span className="h-2 w-2 rounded-full bg-secondary" />USDC</span><span className="text-muted-foreground">{fmt(assetSplit.usdc)}</span></div>
                  </div>
                </div>
              ) : <p className="text-sm text-muted-foreground">No balance yet. Connect a funded wallet to see allocation.</p>}
            </Card>
          </div>

          <Card title="Recent activity">
            {!intel.events || intel.events.length === 0 ? (
              <p className="text-sm text-muted-foreground">No on-chain payment activity yet for this wallet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs uppercase tracking-wide text-muted-foreground">
                    <tr>
                      <th className="py-1.5 pr-3">Direction</th><th className="pr-3">Counterparty</th><th className="pr-3">Amount</th>
                      <th className="pr-3">Block</th><th className="pr-3">Timestamp</th><th>Explorer</th>
                    </tr>
                  </thead>
                  <tbody className="text-foreground">
                    {intel.events.map((e, i) => (
                      <motion.tr key={`${e.txHash}-${i}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i * 0.03 }} className="border-t border-border">
                        <td className="py-1.5 pr-3"><Badge tone={e.direction === "sent" ? "warning" : "success"}>{e.direction === "sent" ? "Sent" : "Received"}</Badge></td>
                        <td className="pr-3 font-mono text-xs">{short(e.counterparty)}</td>
                        <td className="pr-3">{e.amount.toFixed(2)} {e.token}</td>
                        <td className="pr-3 font-mono text-xs text-muted-foreground">{e.blockNumber || "—"}</td>
                        <td className="pr-3 text-xs text-muted-foreground">{e.timestamp ? new Date(e.timestamp).toLocaleString() : "—"}</td>
                        <td>{e.explorerUrl ? <a href={e.explorerUrl} target="_blank" rel="noreferrer" className="font-mono text-xs text-primary-ink hover:underline">{short(e.txHash)} ↗</a> : "—"}</td>
                      </motion.tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      ) : null}

      <ReceiveModal open={receiveOpen} onClose={() => setReceiveOpen(false)} />
    </div>
  );
}
