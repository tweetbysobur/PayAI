"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Bell, Wallet as WalletIcon, CheckCircle2, Clock3, XCircle, ExternalLink, CheckCheck } from "lucide-react";
import { useWallet } from "@/lib/wallet/useWallet";
import { useWalletBalances } from "@/lib/hooks/useWalletBalances";
import { useIdentity } from "@/lib/hooks/useIdentity";
import { timeAgo } from "@/lib/hooks/useAgentConsole";
import type { NotifItem } from "@/lib/hooks/useNotifications";
import { Button } from "@/components/ui";
import { MonadMark } from "@/components/MonadMark";
import { Identicon } from "@/components/Identicon";
import { MobileNavTrigger } from "@/components/dashboard/MobileNav";

interface Health {
  payment: { connected: boolean; engine: string };
  wallet: { network: string; chainId: number } | null;
}

const NOTIF_ICON: Record<string, { icon: typeof CheckCircle2; tone: string; accent: string; chip: string }> = {
  executed: { icon: CheckCircle2, tone: "text-success", accent: "bg-success", chip: "bg-success/12 text-success" },
  needs_review: { icon: Clock3, tone: "text-warning", accent: "bg-warning", chip: "bg-warning/12 text-warning" },
  blocked: { icon: XCircle, tone: "text-danger", accent: "bg-danger", chip: "bg-danger/12 text-danger" },
  refused: { icon: XCircle, tone: "text-danger", accent: "bg-danger", chip: "bg-danger/12 text-danger" },
};

/** Real top navigation — network status from /api/health, the user's own connected wallet (read-only on-chain balances), notifications. */
export function Topbar({ health, notifications = [], onOpenNotifications, onMenuClick }: { health: Health | null; notifications?: NotifItem[]; onOpenNotifications?: () => void; onMenuClick?: () => void }) {
  const wallet = useWallet();
  const balances = useWalletBalances(wallet.address);
  const identity = useIdentity(wallet.address);
  const [busy, setBusy] = useState(false);
  const [showNotifs, setShowNotifs] = useState(false);

  return (
    <header className="flex items-center justify-between gap-3 border-b border-border bg-background px-4 py-3 sm:px-6">
      <div className="flex items-center gap-2">
        {onMenuClick && <MobileNavTrigger onClick={onMenuClick} />}
        <div
          className="flex items-center gap-2 rounded-full border border-border bg-panel py-1.5 pl-2.5 pr-3 text-xs"
          title={health?.payment.connected ? "Connected to Monad" : "Connecting to Monad…"}
        >
          <MonadMark size={15} />
          <span className="hidden font-medium text-foreground sm:inline">{health?.wallet?.network ?? "Monad"}</span>
          <span className="relative ml-0.5 flex h-1.5 w-1.5">
            {health?.payment.connected && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
            )}
            <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${health?.payment.connected ? "bg-success" : "bg-muted-foreground"}`} />
          </span>
        </div>
      </div>

      <div className="flex items-center gap-3">
        {wallet.address && wallet.isWrongNetwork ? (
          <Button
            variant="secondary"
            className="text-xs text-warning"
            disabled={busy}
            onClick={() => { setBusy(true); wallet.switchNetwork().catch(() => {}).finally(() => setBusy(false)); }}
          >
            {busy ? "Switching…" : "Wrong network — switch to Monad"}
          </Button>
        ) : wallet.address ? (
          <div className="flex items-center gap-2 rounded-full border border-border bg-panel px-3 py-1.5 text-xs">
            <WalletIcon size={14} className="text-primary" />
            <span className="font-medium text-foreground">
              {balances.loading ? "…" : balances.mon ? `${Number(balances.mon).toFixed(2)} MON` : "—"}
            </span>
            {balances.usdc && <span className="text-muted-foreground">${Number(balances.usdc).toFixed(2)} USDC</span>}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              className="text-xs"
              disabled={busy}
              onClick={() => { setBusy(true); wallet.connect().catch(() => {}).finally(() => setBusy(false)); }}
            >
              {busy ? "Connecting…" : "Connect wallet"}
            </Button>
            {wallet.error && <span className="text-xs text-danger">{wallet.error}</span>}
          </div>
        )}

        {wallet.address && (
          <button
            onClick={wallet.disconnect}
            className="flex items-center gap-2 rounded-full border border-border bg-panel px-3 py-1.5 text-xs text-foreground hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title="Disconnect"
            aria-label="Disconnect wallet"
          >
            <Identicon address={wallet.address} size={20} />
            {identity.display}
          </button>
        )}

        <div className="relative">
          <button
            onClick={() => { const next = !showNotifs; setShowNotifs(next); if (!next) onOpenNotifications?.(); }}
            aria-label={notifications.length > 0 ? `Notifications (${notifications.length} unread)` : "Notifications"}
            className="relative rounded-full border border-border bg-panel p-2 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Bell size={16} />
            {notifications.length > 0 && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-danger" />}
          </button>
          <AnimatePresence>
            {showNotifs && (
              <motion.div
                initial={{ opacity: 0, y: -8, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -8, scale: 0.98 }}
                transition={{ duration: 0.16, ease: "easeOut" }}
                className="absolute right-0 top-11 z-20 w-[22rem] overflow-hidden rounded-xl border border-border bg-panel shadow-2xl ring-1 ring-primary/5"
              >
                <div className="flex items-center justify-between border-b border-border bg-gradient-to-b from-primary/[0.04] to-transparent px-4 py-3">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-semibold text-foreground">Notifications</p>
                    {notifications.length > 0 && (
                      <span className="rounded-full bg-primary/12 px-2 py-0.5 text-[11px] font-medium text-primary">{notifications.length} new</span>
                    )}
                  </div>
                  {notifications.length > 0 && (
                    <button
                      onClick={() => { onOpenNotifications?.(); setShowNotifs(false); }}
                      className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground transition hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
                    >
                      <CheckCheck size={12} /> Mark all read
                    </button>
                  )}
                </div>
                {notifications.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
                    <span className="flex h-10 w-10 items-center justify-center rounded-full bg-input text-muted-foreground/60">
                      <CheckCheck size={18} />
                    </span>
                    <p className="text-xs font-medium text-foreground">You&apos;re all caught up</p>
                    <p className="text-[11px] text-muted-foreground">New payments and alerts show up here.</p>
                  </div>
                ) : (
                  <ul className="max-h-96 divide-y divide-border overflow-y-auto">
                    {notifications.map((n, i) => {
                      const meta = NOTIF_ICON[n.decision] ?? { icon: CheckCircle2, tone: "text-muted-foreground", accent: "bg-border", chip: "bg-input text-muted-foreground" };
                      const Icon = meta.icon;
                      return (
                        <motion.li
                          key={n.id}
                          initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.04, duration: 0.2 }}
                          className="relative flex items-start gap-3 px-4 py-3 transition hover:bg-input/50"
                        >
                          <span className={`absolute left-0 top-0 h-full w-0.5 ${meta.accent}`} />
                          <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${meta.chip}`}>
                            <Icon size={14} />
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-xs font-medium text-foreground">{n.title}</p>
                              <span className="shrink-0 text-[10px] text-muted-foreground">{timeAgo(n.at)}</span>
                            </div>
                            <p className="mt-0.5 truncate text-xs text-muted-foreground" title={n.detail}>{n.detail}</p>
                            {n.explorerUrl && (
                              <a href={n.explorerUrl} target="_blank" rel="noreferrer" className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline">
                                View on explorer <ExternalLink size={9} />
                              </a>
                            )}
                          </div>
                        </motion.li>
                      );
                    })}
                  </ul>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </header>
  );
}
