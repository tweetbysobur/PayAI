"use client";

import { useState } from "react";
import { Bell, Wallet as WalletIcon, CheckCircle2, Clock3, XCircle, ExternalLink } from "lucide-react";
import { useWallet } from "@/lib/wallet/useWallet";
import { useWalletBalances } from "@/lib/hooks/useWalletBalances";
import { timeAgo } from "@/lib/hooks/useAgentConsole";
import type { NotifItem } from "@/lib/hooks/useNotifications";
import { Button } from "@/components/ui";
import { MonadMark } from "@/components/MonadMark";
import { Identicon } from "@/components/Identicon";
import { MobileNavTrigger } from "@/components/dashboard/MobileNav";

interface Health {
  verigate: { connected: boolean; mode: string };
  wallet: { network: string; chainId: number } | null;
}

const NOTIF_ICON: Record<string, { icon: typeof CheckCircle2; tone: string }> = {
  executed: { icon: CheckCircle2, tone: "text-success" },
  needs_review: { icon: Clock3, tone: "text-warning" },
  blocked: { icon: XCircle, tone: "text-danger" },
  refused: { icon: XCircle, tone: "text-danger" },
};

/** Real top navigation — network status from /api/health, the user's own connected wallet (read-only on-chain balances), notifications. */
export function Topbar({ health, notifications = [], onOpenNotifications, onMenuClick }: { health: Health | null; notifications?: NotifItem[]; onOpenNotifications?: () => void; onMenuClick?: () => void }) {
  const wallet = useWallet();
  const balances = useWalletBalances(wallet.address);
  const [busy, setBusy] = useState(false);
  const [showNotifs, setShowNotifs] = useState(false);

  return (
    <header className="flex items-center justify-between gap-3 border-b border-border bg-background px-4 py-3 sm:px-6">
      <div className="flex items-center gap-2">
        {onMenuClick && <MobileNavTrigger onClick={onMenuClick} />}
        <div
          className="flex items-center gap-2 rounded-full border border-border bg-panel py-1.5 pl-2.5 pr-3 text-xs"
          title={health?.verigate.connected ? "Connected to Monad" : "Connecting to Monad…"}
        >
          <MonadMark size={15} />
          <span className="hidden font-medium text-foreground sm:inline">{health?.wallet?.network ?? "Monad"}</span>
          <span className="relative ml-0.5 flex h-1.5 w-1.5">
            {health?.verigate.connected && (
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
            )}
            <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${health?.verigate.connected ? "bg-success" : "bg-muted-foreground"}`} />
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
            className="flex items-center gap-2 rounded-full border border-border bg-panel px-3 py-1.5 text-xs text-foreground hover:border-primary/40"
            title="Disconnect"
            aria-label="Disconnect wallet"
          >
            <Identicon address={wallet.address} size={20} />
            {wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}
          </button>
        )}

        <div className="relative">
          <button
            onClick={() => { const next = !showNotifs; setShowNotifs(next); if (!next) onOpenNotifications?.(); }}
            aria-label={notifications.length > 0 ? `Notifications (${notifications.length} unread)` : "Notifications"}
            className="relative rounded-full border border-border bg-panel p-2 text-muted-foreground hover:text-foreground"
          >
            <Bell size={16} />
            {notifications.length > 0 && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-danger" />}
          </button>
          {showNotifs && (
            <div className="absolute right-0 top-11 z-20 w-80 overflow-hidden rounded-xl border border-border bg-panel shadow-2xl">
              <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
                <p className="text-sm font-semibold text-foreground">Notifications</p>
                {notifications.length > 0 && (
                  <span className="rounded-full bg-primary/12 px-2 py-0.5 text-[11px] font-medium text-primary">{notifications.length} new</span>
                )}
              </div>
              {notifications.length === 0 ? (
                <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
                  <Bell size={20} className="text-muted-foreground/50" />
                  <p className="text-xs text-muted-foreground">You&apos;re all caught up.</p>
                </div>
              ) : (
                <ul className="max-h-80 divide-y divide-border overflow-y-auto">
                  {notifications.map((n) => {
                    const meta = NOTIF_ICON[n.decision] ?? { icon: CheckCircle2, tone: "text-muted-foreground" };
                    const Icon = meta.icon;
                    return (
                      <li key={n.id} className="flex items-start gap-3 px-4 py-3">
                        <Icon size={15} className={`mt-0.5 shrink-0 ${meta.tone}`} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-xs font-medium text-foreground">{n.title}</p>
                            <span className="shrink-0 text-[10px] text-muted-foreground">{timeAgo(n.at)}</span>
                          </div>
                          <p className="mt-0.5 truncate text-xs text-muted-foreground" title={n.detail}>{n.detail}</p>
                          {n.explorerUrl && (
                            <a href={n.explorerUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-[11px] text-primary hover:underline">
                              View on explorer <ExternalLink size={9} />
                            </a>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
