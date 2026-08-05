"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "motion/react";
import { ArrowDownLeft, X, ExternalLink } from "lucide-react";
import type { NotifItem } from "@/lib/hooks/useNotifications";

/**
 * Announces money arriving, the moment PayAI sees it.
 *
 * Money landing is the one event worth interrupting someone for — it's what
 * a bank app pushes to your lock screen. A row quietly appearing under the
 * bell is not that, so a deposit gets its own alert: the figure that
 * actually arrived, large enough to read at a glance, and a way straight to
 * the transaction.
 *
 * Two rules keep it from becoming noise:
 *   - **Only genuinely new deposits.** The last announced timestamp is
 *     remembered per wallet, so a reload, a second tab, or coming back
 *     tomorrow never replays money you already knew about.
 *   - **Only while you're looking.** Nothing queues up in a hidden tab to
 *     ambush you later.
 */

const SEEN_KEY = (address: string) => `payai_deposit_alert_at_${address.toLowerCase()}`;
/** Long enough to read and act on, short enough not to sit in the way. */
const DISMISS_MS = 9_000;

function readSeenAt(address: string): number {
  try {
    return Number(localStorage.getItem(SEEN_KEY(address)) ?? 0);
  } catch {
    return 0;
  }
}

function writeSeenAt(address: string, at: number): void {
  try {
    localStorage.setItem(SEEN_KEY(address), String(at));
  } catch {
    /* private browsing — the alert simply may repeat once */
  }
}

const fmt = (n: number) =>
  n.toLocaleString(undefined, { maximumFractionDigits: n < 1 ? 6 : 4 });

export function DepositAlert({
  notifications,
  address,
}: {
  notifications: NotifItem[];
  address?: string | null;
}) {
  const router = useRouter();
  const [shown, setShown] = useState<NotifItem | null>(null);
  // The high-water mark of what has been announced. Held in a ref as well as
  // storage so several polls in the same session can't announce twice.
  const seenAt = useRef<number | null>(null);

  useEffect(() => {
    if (!address) { seenAt.current = null; setShown(null); return; }
    if (seenAt.current === null) seenAt.current = readSeenAt(address);

    const fresh = notifications
      .filter((n) => n.decision === "deposit_received" && n.at > (seenAt.current ?? 0))
      .sort((a, b) => a.at - b.at);
    if (fresh.length === 0) return;

    // If several arrived between polls, announce the most recent and mark the
    // rest as seen — they're all in the bell, and a stack of pop-ups is the
    // opposite of premium.
    const latest = fresh[fresh.length - 1];
    seenAt.current = latest.at;
    writeSeenAt(address, latest.at);
    setShown(latest);
  }, [notifications, address]);

  useEffect(() => {
    if (!shown) return;
    const t = setTimeout(() => setShown(null), DISMISS_MS);
    return () => clearTimeout(t);
  }, [shown]);

  const amount = shown?.amount;
  const token = shown?.token ?? "";

  return (
    <AnimatePresence>
      {shown && (
        <motion.div
          // Top of the screen: the bottom is where transient toasts live, and
          // a deposit should never be mistaken for "address copied".
          initial={{ opacity: 0, y: -24, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -16, scale: 0.98 }}
          transition={{ type: "spring", stiffness: 320, damping: 26 }}
          className="fixed inset-x-4 top-4 z-[80] mx-auto w-auto max-w-sm sm:inset-x-auto sm:right-6 sm:top-6"
          role="status"
          aria-live="polite"
        >
          <div className="overflow-hidden rounded-2xl border border-success/25 bg-panel shadow-2xl ring-1 ring-success/10">
            <div className="flex items-start gap-3 p-4">
              <motion.span
                initial={{ scale: 0.6, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ delay: 0.08, type: "spring", stiffness: 300, damping: 18 }}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-success/12 text-success"
              >
                <ArrowDownLeft size={19} />
              </motion.span>

              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Deposit received
                </p>
                <p className="mt-0.5 truncate text-lg font-semibold tracking-tight text-foreground [font-variant-numeric:tabular-nums]">
                  {amount != null ? `+${fmt(amount)} ${token}` : shown.title}
                </p>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  Arrived in your wallet
                </p>

                <div className="mt-2.5 flex items-center gap-3">
                  <button
                    onClick={() => { setShown(null); router.push("/dashboard/wallets"); }}
                    className="text-xs font-medium text-primary-ink transition hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
                  >
                    View wallet
                  </button>
                  {shown.explorerUrl && (
                    <a
                      href={shown.explorerUrl} target="_blank" rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-muted-foreground transition hover:text-foreground"
                    >
                      Explorer <ExternalLink size={10} />
                    </a>
                  )}
                </div>
              </div>

              <button
                onClick={() => setShown(null)}
                aria-label="Dismiss"
                className="-mr-1 -mt-1 shrink-0 rounded-md p-1.5 text-muted-foreground transition hover:bg-input hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X size={14} />
              </button>
            </div>

            {/* A quiet progress line, so the alert visibly has a lifespan
                rather than vanishing without explanation. */}
            <motion.span
              initial={{ scaleX: 1 }}
              animate={{ scaleX: 0 }}
              transition={{ duration: DISMISS_MS / 1000, ease: "linear" }}
              className="block h-0.5 origin-left bg-success/40"
            />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
