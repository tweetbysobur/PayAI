"use client";

import { useState } from "react";
import { Bell, Wallet as WalletIcon } from "lucide-react";
import { useWallet } from "@/lib/wallet/useWallet";
import { useWalletBalances } from "@/lib/hooks/useWalletBalances";
import { Button } from "@/components/ui";
import { MonadMark } from "@/components/MonadMark";
import { MobileNavTrigger } from "@/components/dashboard/MobileNav";

interface Health {
  verigate: { connected: boolean; mode: string };
  wallet: { network: string; chainId: number } | null;
}

/** Real top navigation — network status from /api/health, the user's own connected wallet (read-only on-chain balances), notifications. */
export function Topbar({ health, notifications = [], onOpenNotifications, onMenuClick }: { health: Health | null; notifications?: string[]; onOpenNotifications?: () => void; onMenuClick?: () => void }) {
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
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-gradient-to-br from-primary to-secondary text-[9px] font-semibold text-primary-foreground">
              {wallet.address.slice(2, 4).toUpperCase()}
            </span>
            {wallet.address.slice(0, 6)}…{wallet.address.slice(-4)}
          </button>
        )}

        <div className="relative">
          <button
            onClick={() => setShowNotifs((s) => { const next = !s; if (!next) onOpenNotifications?.(); return next; })}
            aria-label={notifications.length > 0 ? `Notifications (${notifications.length} unread)` : "Notifications"}
            className="relative rounded-full border border-border bg-panel p-2 text-muted-foreground hover:text-foreground"
          >
            <Bell size={16} />
            {notifications.length > 0 && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-danger" />}
          </button>
          {showNotifs && (
            <div className="absolute right-0 top-10 z-10 w-72 rounded-lg border border-border bg-panel p-3 shadow-panel">
              {notifications.length === 0 ? (
                <p className="text-xs text-muted-foreground">No notifications.</p>
              ) : (
                <ul className="space-y-1.5">
                  {notifications.map((n, i) => <li key={i} className="text-xs text-foreground">{n}</li>)}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
