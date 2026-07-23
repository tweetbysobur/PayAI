"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "motion/react";
import { Bell, Wallet as WalletIcon, CheckCircle2, Clock3, XCircle, ExternalLink, CheckCheck, ArrowDownLeft, Repeat, PauseCircle, PlayCircle, Ban, Sparkles, ChevronRight, Copy, LogOut, ChevronDown } from "lucide-react";
import { useWallet } from "@/lib/wallet/useWallet";
import { useWalletBalances } from "@/lib/hooks/useWalletBalances";
import { useIdentity } from "@/lib/hooks/useIdentity";
import { MONAD_EXPLORER } from "@/lib/monad/public";
import { timeAgo } from "@/lib/hooks/useAgentConsole";
import type { NotifItem } from "@/lib/hooks/useNotifications";
import { Button } from "@/components/ui";
import { MonadMark } from "@/components/MonadMark";
import { Identicon } from "@/components/Identicon";
import { MobileNavTrigger } from "@/components/dashboard/MobileNav";
import { useToast } from "@/components/Toast";
import dynamic from "next/dynamic";
// Lazy-loaded: pulls in viem + qrcode.react, only needed once someone opens it.
const ReceiveModal = dynamic(() => import("@/components/dashboard/ReceiveModal").then((m) => m.ReceiveModal), { ssr: false });

interface Health {
  payment: { connected: boolean; engine: string };
  wallet: { network: string; chainId: number } | null;
}

const NOTIF_ICON: Record<string, { icon: typeof CheckCircle2; tone: string; accent: string; chip: string }> = {
  executed: { icon: CheckCircle2, tone: "text-success", accent: "bg-success", chip: "bg-success/12 text-success" },
  needs_review: { icon: Clock3, tone: "text-warning", accent: "bg-warning", chip: "bg-warning/12 text-warning" },
  blocked: { icon: XCircle, tone: "text-danger", accent: "bg-danger", chip: "bg-danger/12 text-danger" },
  refused: { icon: XCircle, tone: "text-danger", accent: "bg-danger", chip: "bg-danger/12 text-danger" },
  // Was missing — fell back to a neutral checkmark for a genuine failure.
  error: { icon: XCircle, tone: "text-danger", accent: "bg-danger", chip: "bg-danger/12 text-danger" },
  // Payment Automation lifecycle — a distinct visual language from one-off
  // payment outcomes above, so a glance at the icon says "this is about your
  // automation," not "this is a payment result."
  automation_created: { icon: Sparkles, tone: "text-primary", accent: "bg-primary", chip: "bg-primary/12 text-primary" },
  automation_upcoming_execution: { icon: Clock3, tone: "text-warning", accent: "bg-warning", chip: "bg-warning/12 text-warning" },
  automation_executed: { icon: Repeat, tone: "text-success", accent: "bg-success", chip: "bg-success/12 text-success" },
  automation_execution_failed: { icon: XCircle, tone: "text-danger", accent: "bg-danger", chip: "bg-danger/12 text-danger" },
  automation_paused: { icon: PauseCircle, tone: "text-warning", accent: "bg-warning", chip: "bg-warning/12 text-warning" },
  automation_resumed: { icon: PlayCircle, tone: "text-success", accent: "bg-success", chip: "bg-success/12 text-success" },
  automation_cancelled: { icon: Ban, tone: "text-muted-foreground", accent: "bg-border", chip: "bg-input text-muted-foreground" },
};

/** Real top navigation — network status from /api/health, the user's own connected wallet (read-only on-chain balances), notifications. */
export function Topbar({ health, notifications = [], onOpenNotifications, onMenuClick }: { health: Health | null; notifications?: NotifItem[]; onOpenNotifications?: () => void; onMenuClick?: () => void }) {
  const wallet = useWallet();
  const router = useRouter();
  const balances = useWalletBalances(wallet.address);
  const identity = useIdentity(wallet.address);
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [showNotifs, setShowNotifs] = useState(false);
  const [showWalletMenu, setShowWalletMenu] = useState(false);
  const [copied, setCopied] = useState(false);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const unread = notifications.filter((n) => !n.read).length;
  const openNotif = (href: string) => { setShowNotifs(false); onOpenNotifications?.(); router.push(href); };

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
            onClick={() => {
              setBusy(true);
              wallet.switchNetwork()
                .then(() => toast("Switched to Monad Mainnet"))
                .catch(() => toast("Couldn't switch network. Do it in your wallet.", "error"))
                .finally(() => setBusy(false));
            }}
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
              onClick={() => {
                // No injected wallet (typical on a phone browser) — send them to
                // /connect, which offers wallet-app deep links instead of a
                // dead-end error.
                if (typeof window !== "undefined" && !window.ethereum) { window.location.href = "/connect"; return; }
                setBusy(true);
                wallet.connect()
                  .then(() => toast("Wallet connected"))
                  .catch((e) => toast(e instanceof Error ? e.message : "Connection cancelled.", "error"))
                  .finally(() => setBusy(false));
              }}
            >
              {busy ? "Connecting…" : "Connect wallet"}
            </Button>
            {wallet.error && <span className="text-xs text-danger">{wallet.error}</span>}
          </div>
        )}

        {wallet.address && (
          <div className="relative">
            <button
              onClick={() => setShowWalletMenu((v) => !v)}
              className="flex items-center gap-2 rounded-full border border-border bg-panel px-3 py-1.5 text-xs text-foreground hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              title="Wallet menu"
              aria-label="Open wallet menu"
              aria-expanded={showWalletMenu}
            >
              <Identicon address={wallet.address} size={20} />
              {identity.display}
              <ChevronDown size={12} className={`text-muted-foreground transition-transform ${showWalletMenu ? "rotate-180" : ""}`} />
            </button>
            <AnimatePresence>
              {showWalletMenu && (
                <>
                  {/* Full-screen click-catcher to close the menu on outside click, without a
                      global document listener that would need its own cleanup wiring. */}
                  <div className="fixed inset-0 z-10" onClick={() => setShowWalletMenu(false)} />
                  <motion.div
                    initial={{ opacity: 0, y: -8, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -8, scale: 0.98 }}
                    transition={{ duration: 0.16, ease: "easeOut" }}
                    className="absolute right-0 top-11 z-20 w-64 overflow-hidden rounded-xl border border-border bg-panel shadow-2xl ring-1 ring-primary/5"
                  >
                    <div className="border-b border-border px-4 py-3">
                      <p className="font-mono text-sm text-foreground">{identity.display}</p>
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        {balances.loading ? "Loading balances…" : [balances.mon && `${Number(balances.mon).toFixed(2)} MON`, balances.usdc && `$${Number(balances.usdc).toFixed(2)} USDC`].filter(Boolean).join(" · ") || "—"}
                      </p>
                    </div>
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(wallet.address!).then(() => setCopied(true)).catch(() => {});
                        setTimeout(() => setCopied(false), 1500);
                      }}
                      className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-xs text-foreground transition hover:bg-input/50"
                    >
                      <Copy size={13} className="text-muted-foreground" /> {copied ? "Copied!" : "Copy address"}
                    </button>
                    <a
                      href={`${MONAD_EXPLORER}/address/${wallet.address}`}
                      target="_blank" rel="noreferrer"
                      className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-xs text-foreground transition hover:bg-input/50"
                    >
                      <ExternalLink size={13} className="text-muted-foreground" /> View on explorer
                    </a>
                    <button
                      onClick={() => { setShowWalletMenu(false); wallet.disconnect(); toast("Wallet disconnected", "info"); }}
                      className="flex w-full items-center gap-2.5 border-t border-border px-4 py-2.5 text-left text-xs text-danger transition hover:bg-danger/10"
                    >
                      <LogOut size={13} /> Disconnect
                    </button>
                  </motion.div>
                </>
              )}
            </AnimatePresence>
          </div>
        )}

        {wallet.address && (
          <button
            onClick={() => setReceiveOpen(true)}
            title="Receive"
            aria-label="Receive"
            className="rounded-full border border-border bg-panel p-2 text-muted-foreground transition hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ArrowDownLeft size={16} />
          </button>
        )}

        <div className="relative">
          <button
            onClick={() => { const next = !showNotifs; setShowNotifs(next); if (!next) onOpenNotifications?.(); }}
            aria-label={unread > 0 ? `Notifications (${unread} unread)` : "Notifications"}
            className="relative rounded-full border border-border bg-panel p-2 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Bell size={16} />
            {unread > 0 && <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[9px] font-semibold text-white">{unread > 9 ? "9+" : unread}</span>}
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
                    {unread > 0 && (
                      <span className="rounded-full bg-primary/12 px-2 py-0.5 text-[11px] font-medium text-primary">{unread} new</span>
                    )}
                  </div>
                  {unread > 0 && (
                    <button
                      onClick={() => onOpenNotifications?.()}
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
                          onClick={() => openNotif(n.href)}
                          className={`group relative flex cursor-pointer items-start gap-3 px-4 py-3 transition hover:bg-input/50 ${n.read ? "opacity-55" : ""}`}
                        >
                          <span className={`absolute left-0 top-0 h-full w-0.5 ${n.read ? "bg-transparent" : meta.accent}`} />
                          <span className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${meta.chip}`}>
                            <Icon size={14} />
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2">
                              <p className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                                {!n.read && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />}
                                {n.title}
                              </p>
                              <span className="shrink-0 text-[10px] text-muted-foreground">{timeAgo(n.at)}</span>
                            </div>
                            <p className="mt-0.5 truncate text-xs text-muted-foreground" title={n.detail}>{n.detail}</p>
                            <div className="mt-1.5 flex items-center gap-3">
                              <span className="inline-flex items-center gap-0.5 text-[11px] font-medium text-primary group-hover:underline">
                                View <ChevronRight size={11} />
                              </span>
                              {n.explorerUrl && (
                                <a href={n.explorerUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground transition hover:text-primary">
                                  Explorer <ExternalLink size={9} />
                                </a>
                              )}
                            </div>
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

      <ReceiveModal open={receiveOpen} onClose={() => setReceiveOpen(false)} />
    </header>
  );
}
