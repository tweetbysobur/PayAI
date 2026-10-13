"use client";

import { fetchHistory } from "@/lib/hooks/historyFetch";
import { useEffect, useRef, useState } from "react";
import { phraseSummary } from "@/lib/hooks/useAgentConsole";
import { useSyncRefresher } from "@/lib/hooks/useSync";
import { walletEventHref, type WalletEventType } from "@/lib/wallet-service/types";
import { dedupeByTx, historyTitle, txHref } from "@/lib/hooks/notificationItems";

interface HistoryRow { at: number; decision: string; summary: string; recipient?: string | null; domain?: string | null; txHash?: string; explorerUrl?: string; feature?: string; action?: string }
interface AutomationEventRow {
  id: string; type: string; at: number; title: string; detail: string; txHash?: string; explorerUrl?: string;
}
interface SupportTicketRow { id: string; category: string; description: string; createdAt: number }
interface WalletEventRow {
  id: string; type: string; at: number; title: string; detail: string;
  txHash?: string; explorerUrl?: string; amount?: number | null; token?: string | null;
}

export interface NotifItem {
  id: string;
  decision: string;
  title: string;
  detail: string;
  at: number;
  explorerUrl?: string;
  /** The transaction this is about, when there is one — one notification per
   *  transaction, and the row opens exactly it. */
  txHash?: string;
  /** In-app destination for this notification — clicking the row goes here. */
  href: string;
  /** True once the user has opened the bell after this arrived. Read items
   *  stay visible (dimmed) for 24h so nothing vanishes the instant it's seen. */
  read: boolean;
  /** Present on wallet money movements, so a deposit can be announced with
   *  the figure that actually landed rather than a generic message. */
  amount?: number | null;
  token?: string | null;
}

const SEEN_KEY = "veripay_notifs_seen_at";
/** Notifications live in the feed for 24h from when they happened, then age
 *  out on their own — whether or not they were ever opened. */
const RETENTION_MS = 24 * 60 * 60 * 1000;

/** Where a transaction-log row without a hash opens: its own filtered list. */
function historyListHref(decision: string): string {
  return decision === "executed" ? "/dashboard/transactions" : `/dashboard/transactions?status=${decision}`;
}

export function useNotifications(walletAddress?: string | null, providerId?: string | null) {
  const [notifications, setNotifications] = useState<NotifItem[]>([]);
  const [unread, setUnread] = useState(0);
  // True once the first feed for this wallet has arrived — lets the pop-up
  // tell "nothing yet" from "not loaded yet".
  const [loaded, setLoaded] = useState(false);
  // Held so the global refresh can trigger the same load the interval does,
  // without this hook needing to know what triggered it.
  const loadRef = useRef<() => void>(() => {});
  useSyncRefresher(() => loadRef.current());

  useEffect(() => {
    // Notifications are the user's OWN activity — scope every fetch to the
    // connected wallet (the server returns nothing without it, by design), so
    // the bell reflects your activity, not an empty/shared feed.
    setLoaded(false);
    if (!walletAddress) { setNotifications([]); setUnread(0); return; }
    let cancelled = false;
    function load() {
      if (document.hidden) return;
      const seenAt = Number(localStorage.getItem(SEEN_KEY) ?? 0);
      const cutoff = Date.now() - RETENTION_MS; // keep the last 24h, read or not

      const payments = fetchHistory(walletAddress)
        .then((j) => {
          const rows = (j.history ?? []) as HistoryRow[];
          return rows
            .filter((h) => h.at > cutoff && historyTitle(h))
            .map((h): Omit<NotifItem, "read"> => ({
              id: h.txHash ?? `${h.at}-${h.decision}`,
              decision: h.decision,
              title: historyTitle(h) as string,
              detail: phraseSummary(h.summary, h.decision),
              at: h.at,
              explorerUrl: h.explorerUrl,
              txHash: h.txHash,
              href: txHref(h.txHash) ?? historyListHref(h.decision),
            }));
        })
        .catch(() => [] as Omit<NotifItem, "read">[]);

      // Payment Automation lifecycle events — a real, server-timestamped log
      // (lib/platform/automationEvents.ts), not inferred from current status.
      const automations = fetch(`/api/automation-events?wallet=${walletAddress}`)
        .then((r) => r.json())
        .then((j) => {
          const rows = (j.events ?? []) as AutomationEventRow[];
          return rows
            .filter((e) => e.at > cutoff)
            .map((e): Omit<NotifItem, "read"> => ({
              id: e.id,
              decision: `automation_${e.type}`,
              title: e.title,
              detail: e.detail,
              at: e.at,
              explorerUrl: e.explorerUrl,
              txHash: e.txHash,
              href: txHref(e.txHash) ?? "/dashboard/automations",
            }));
        })
        .catch(() => [] as Omit<NotifItem, "read">[]);

      // Support tickets the wallet itself submitted — a real, timestamped
      // record (lib/platform/support.ts), not a synthesized "we emailed you"
      // claim PayAI can't back up (there's no email infra behind this yet).
      const tickets = fetch(`/api/support?wallet=${walletAddress}`)
        .then((r) => r.json())
        .then((j) => {
          const rows = (j.tickets ?? []) as SupportTicketRow[];
          return rows
            .filter((t) => t.createdAt > cutoff)
            .map((t): Omit<NotifItem, "read"> => ({
              id: `ticket-${t.id}`,
              decision: "support_ticket_submitted",
              title: "Support ticket submitted",
              detail: `Reference ${t.id} — ${t.description.slice(0, 80)}${t.description.length > 80 ? "…" : ""}`,
              at: t.createdAt,
              href: "/dashboard/help?tab=support",
            }));
        })
        .catch(() => [] as Omit<NotifItem, "read">[]);

      // Wallet-level notifications — created/connected/disconnected, deposits,
      // withdrawals (lib/platform/walletEvents.ts). Provider-agnostic: same
      // feed for an embedded PayAI Wallet or an external one.
      const walletEvents = fetch(`/api/wallet-events?wallet=${walletAddress}${providerId ? `&provider=${providerId}` : ""}`)
        .then((r) => r.json())
        .then((j) => {
          const rows = (j.events ?? []) as WalletEventRow[];
          return rows
            .filter((e) => e.at > cutoff)
            .map((e): Omit<NotifItem, "read"> => ({
              id: e.id,
              decision: e.type,
              title: e.title,
              detail: e.detail,
              at: e.at,
              explorerUrl: e.explorerUrl,
              // Not always Wallets — a swap, a refund, or an automation
              // signature belongs on the page that actually shows it. See
              // walletEventHref's own doc for why each type lands where it does.
              txHash: e.txHash,
              // The exact transaction when there is one; otherwise the page
              // that shows this kind of event (walletEventHref's own doc).
              href: txHref(e.txHash) ?? walletEventHref(e.type as WalletEventType),
              amount: e.amount,
              token: e.token,
            }));
        })
        .catch(() => [] as Omit<NotifItem, "read">[]);

      Promise.all([payments, automations, tickets, walletEvents]).then(([fresh, automationFresh, ticketFresh, walletFresh]) => {
        if (cancelled) return;
        // One notification per transaction: a swap, an automation run or a
        // payment can also arrive as a wallet event for the same hash. The
        // transaction-log row is the most specific, so it goes first and wins.
        const all = dedupeByTx([...fresh, ...walletFresh, ...automationFresh, ...ticketFresh]).sort((a, b) => b.at - a.at).slice(0, 15);
        // Read items stay in the feed (dimmed) until they age past 24h; only
        // unseen ones drive the unread badge.
        setNotifications(all.map((n) => ({ ...n, read: n.at <= seenAt })));
        setUnread(all.filter((n) => n.at > seenAt).length);
        setLoaded(true);
      });
    }
    loadRef.current = load;
    load();
    // No timer of its own: the dashboard's SyncProvider refreshes this hook
    // (registered above) every 20 s and on return to the tab. A second timer
    // here ran every load twice per cycle.
    return () => { cancelled = true; loadRef.current = () => {}; };
  }, [walletAddress, providerId]);

  // Opening the bell marks everything currently shown as read — but keeps it
  // visible (dimmed) for the rest of its 24h window rather than clearing it.
  function markSeen() {
    localStorage.setItem(SEEN_KEY, String(Date.now()));
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    setUnread(0);
  }

  return { notifications, unread, loaded, markSeen };
}
