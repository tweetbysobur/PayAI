"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { ArrowDownLeft, ArrowUpRight, AlertTriangle, X, ExternalLink } from "lucide-react";
import type { NotifItem } from "@/lib/hooks/useNotifications";
import { headline, newAlerts, type AlertKind } from "@/lib/notify/alerts";
import { playNotificationSound, unlockNotificationSound } from "@/lib/notify/sound";

/**
 * Pops up every transaction PayAI sees, while you're on the page.
 *
 *   - A deposit gets a celebration: the amount that landed, a burst of
 *     confetti and a "cha-ching".
 *   - Any other transaction — a payment, a swap or trade, an automation run,
 *     a withdrawal — gets a short card and a soft sound; a failure gets a
 *     lower tone.
 *
 * Only genuinely new activity: what has been announced is remembered per
 * wallet, so a reload, a second tab or coming back tomorrow never replays it,
 * and the first visit doesn't replay the past 24 hours. Several arriving at
 * once show as one card ("and 2 more") — everything is also in the bell.
 * Nothing queues up in a hidden tab.
 */

const SEEN_KEY = (address: string) => `payai_activity_alert_at_${address.toLowerCase()}`;
const DISMISS_MS: Record<AlertKind, number> = { deposit: 9_000, failure: 8_000, activity: 6_000 };

function readSeenAt(address: string): number | null {
  try {
    const v = localStorage.getItem(SEEN_KEY(address));
    return v == null ? null : Number(v) || 0;
  } catch {
    return null;
  }
}

function writeSeenAt(address: string, at: number): void {
  try {
    localStorage.setItem(SEEN_KEY(address), String(at));
  } catch {
    /* private browsing — an alert may simply repeat once */
  }
}

const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: n < 1 ? 6 : 4 });

interface Shown { item: NotifItem; kind: AlertKind; more: number; key: number }

export function ActivityAlert({ notifications, address, loaded = true }: { notifications: NotifItem[]; address?: string | null; loaded?: boolean }) {
  const router = useRouter();
  const [shown, setShown] = useState<Shown | null>(null);
  // High-water mark of what has been announced, in a ref as well as storage
  // so polls in the same session can't announce twice.
  const seenAt = useRef<number | null>(null);

  useEffect(() => { unlockNotificationSound(); }, []);

  useEffect(() => {
    if (!address) { seenAt.current = null; setShown(null); return; }
    if (seenAt.current === null) {
      const stored = readSeenAt(address);
      if (stored === null) {
        // First time on this browser: start from the newest thing already in
        // the feed, so the past day isn't replayed. Anchored to the feed's own
        // timestamps, not this device's clock, which may be off.
        if (!loaded) return;
        seenAt.current = notifications.reduce((m, n) => Math.max(m, n.at), 0);
        writeSeenAt(address, seenAt.current);
        return;
      }
      seenAt.current = stored;
    }
    if (typeof document !== "undefined" && document.hidden) return;

    const fresh = newAlerts(notifications, seenAt.current);
    const top = headline(fresh);
    if (!top) return;
    const newest = fresh[0].at;
    seenAt.current = newest;
    writeSeenAt(address, newest);
    setShown({ ...top, key: newest });
    playNotificationSound(top.kind);
  }, [notifications, address, loaded]);

  useEffect(() => {
    if (!shown) return;
    const t = setTimeout(() => setShown(null), DISMISS_MS[shown.kind]);
    return () => clearTimeout(t);
  }, [shown]);

  const open = (href: string) => { setShown(null); router.push(href); };

  return (
    <AnimatePresence>
      {shown && (
        <motion.div
          key={shown.key}
          // Top of the screen: the bottom is where small toasts live, and a
          // transaction should never be mistaken for "address copied".
          initial={{ opacity: 0, y: -24, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -16, scale: 0.98 }}
          transition={{ type: "spring", stiffness: 320, damping: 26 }}
          className="fixed inset-x-4 top-4 z-[80] mx-auto w-auto max-w-sm sm:inset-x-auto sm:right-6 sm:top-6"
          role="status"
          aria-live="polite"
        >
          {shown.kind === "deposit" ? (
            <DepositCard shown={shown} onOpen={open} onClose={() => setShown(null)} />
          ) : (
            <ActivityCard shown={shown} onOpen={open} onClose={() => setShown(null)} />
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function DepositCard({ shown, onOpen, onClose }: { shown: Shown; onOpen: (href: string) => void; onClose: () => void }) {
  const { item, more } = shown;
  return (
    // Confetti sits outside the clipped card so it can burst over its edges.
    <div className="relative">
      <Confetti />
      <div className="overflow-hidden rounded-2xl surface-purple shadow-2xl">
      <div className="relative flex items-start gap-3 p-4">
        <motion.span
          initial={{ scale: 0.4, rotate: -20, opacity: 0 }}
          animate={{ scale: 1, rotate: 0, opacity: 1 }}
          transition={{ delay: 0.05, type: "spring", stiffness: 300, damping: 14 }}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-success/15 text-success"
        >
          <ArrowDownLeft size={20} aria-hidden />
        </motion.span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium uppercase tracking-wide text-success">Deposit received</p>
          <motion.p
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ delay: 0.12, type: "spring", stiffness: 260, damping: 16 }}
            className="mt-0.5 origin-left truncate text-xl font-semibold tracking-tight text-foreground [font-variant-numeric:tabular-nums]"
          >
            {item.amount != null ? `+${fmt(item.amount)} ${item.token ?? ""}` : item.title}
          </motion.p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            Arrived in your wallet{more > 0 ? ` · and ${more} more` : ""}
          </p>
          <Actions item={item} onOpen={onOpen} />
        </div>
        <CloseButton onClose={onClose} />
      </div>
      <Lifespan kind="deposit" />
      </div>
    </div>
  );
}

function ActivityCard({ shown, onOpen, onClose }: { shown: Shown; onOpen: (href: string) => void; onClose: () => void }) {
  const { item, kind, more } = shown;
  const failed = kind === "failure";
  return (
    <div className="overflow-hidden rounded-2xl surface-purple shadow-2xl">
      <div className="flex items-start gap-3 p-4">
        <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${failed ? "bg-danger/10 text-danger" : "bg-primary/10 text-primary-ink"}`}>
          {failed ? <AlertTriangle size={17} aria-hidden /> : <ArrowUpRight size={17} aria-hidden />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-foreground">{item.title}</p>
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{item.detail}</p>
          {more > 0 && <p className="mt-0.5 text-[11px] text-muted-foreground">and {more} more in notifications</p>}
          <Actions item={item} onOpen={onOpen} />
        </div>
        <CloseButton onClose={onClose} />
      </div>
      <Lifespan kind={kind} />
    </div>
  );
}

function Actions({ item, onOpen }: { item: NotifItem; onOpen: (href: string) => void }) {
  return (
    <div className="mt-2.5 flex items-center gap-3">
      <button
        onClick={() => onOpen(item.href)}
        className="rounded-sm text-xs font-medium text-primary-ink transition hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        View
      </button>
      {item.explorerUrl && (
        <a href={item.explorerUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-muted-foreground transition hover:text-foreground">
          Explorer <ExternalLink size={10} aria-hidden />
        </a>
      )}
    </div>
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      onClick={onClose}
      aria-label="Dismiss"
      className="-mr-1 -mt-1 shrink-0 rounded-md p-1.5 text-muted-foreground transition hover:bg-input hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <X size={14} />
    </button>
  );
}

/** A quiet progress line, so the card visibly has a lifespan. */
function Lifespan({ kind }: { kind: AlertKind }) {
  return (
    <motion.span
      initial={{ scaleX: 1 }}
      animate={{ scaleX: 0 }}
      transition={{ duration: DISMISS_MS[kind] / 1000, ease: "linear" }}
      className={`block h-0.5 origin-left ${kind === "failure" ? "bg-danger/40" : kind === "deposit" ? "bg-success/50" : "bg-primary/40"}`}
    />
  );
}

/* A short confetti burst inside the deposit card. Skipped entirely when the
   device asks for reduced motion. Deterministic angles, no randomness, so it
   renders the same on server and client. */
const PIECES = Array.from({ length: 34 }, (_, i) => {
  const angle = (i / 34) * Math.PI * 2;
  const dist = 90 + ((i * 37) % 80);
  return {
    x: Math.cos(angle) * dist * 1.4,
    y: Math.sin(angle) * dist * 0.8 - 30,
    rotate: (i * 47) % 360,
    color: ["#7C3AED", "#A78BFA", "#C4B5FD", "#FCD34D", "#34D399", "#FFFFFF"][i % 6],
    w: i % 3 === 0 ? 5 : 8,
    h: i % 3 === 0 ? 12 : 8,
    delay: (i % 6) * 0.02,
  };
});

function Confetti() {
  const reduce = useReducedMotion();
  if (reduce) return null;
  return (
    <span aria-hidden className="pointer-events-none absolute left-10 top-10 z-10">
      {PIECES.map((p, i) => (
        <motion.span
          key={i}
          initial={{ x: 0, y: 0, opacity: 1, rotate: 0, scale: 0.5 }}
          animate={{ x: p.x, y: [0, p.y, p.y + 70], opacity: [1, 1, 0], rotate: p.rotate + 270, scale: 1 }}
          transition={{ duration: 1.8, delay: p.delay, ease: "easeOut", times: [0, 0.55, 1] }}
          className="absolute block rounded-[2px]"
          style={{ width: p.w, height: p.h, background: p.color }}
        />
      ))}
    </span>
  );
}
