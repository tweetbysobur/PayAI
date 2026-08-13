"use client";

import { useEffect, useState } from "react";
import { phraseSummary } from "@/lib/hooks/useAgentConsole";

interface HistoryRow { at: number; decision: string; summary: string; recipient?: string | null; domain?: string | null; txHash?: string; explorerUrl?: string }
interface AutomationEventRow {
  id: string; type: string; at: number; title: string; detail: string; txHash?: string; explorerUrl?: string;
}
interface SupportTicketRow { id: string; category: string; description: string; createdAt: number }

export interface NotifItem {
  id: string;
  decision: string;
  title: string;
  detail: string;
  at: number;
  explorerUrl?: string;
  /** In-app destination for this notification — clicking the row goes here. */
  href: string;
  /** True once the user has opened the bell after this arrived. Read items
   *  stay visible (dimmed) for 24h so nothing vanishes the instant it's seen. */
  read: boolean;
}

/** Scoped per wallet — a global key would leak one wallet's "last seen" time
 *  into another wallet's read/unread state on a shared browser (wallet B
 *  connecting after wallet A would see B's own unopened notifications marked
 *  already-read, just because their timestamps predate A's last visit). */
function seenKey(walletAddress: string): string {
  return `veripay_notifs_seen_at:${walletAddress.toLowerCase()}`;
}
/** Notifications live in the feed for 24h from when they happened, then age
 *  out on their own — whether or not they were ever opened. */
const RETENTION_MS = 24 * 60 * 60 * 1000;

const LABEL: Record<string, string> = {
  executed: "Payment sent",
  needs_review: "Payment needs review",
  blocked: "Payment blocked",
  refused: "Payment refused",
  // Was missing entirely — an execution error (RPC failure, agent-wallet
  // balance, an automation auto-pausing after repeated failures) is
  // exactly the outcome a user most needs to be told about, and it was
  // silently dropped from notifications because this map had no entry for it.
  error: "Payment failed",
};

export function useNotifications(walletAddress?: string | null) {
  const [notifications, setNotifications] = useState<NotifItem[]>([]);
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    // Notifications are the user's OWN activity — scope every fetch to the
    // connected wallet (the server returns nothing without it, by design), so
    // the bell reflects your activity, not an empty/shared feed.
    if (!walletAddress) { setNotifications([]); setUnread(0); return; }
    const address = walletAddress; // narrow once — TS won't narrow a param across the nested load() closure
    let cancelled = false;
    function load() {
      if (document.hidden) return;
      const seenAt = Number(localStorage.getItem(seenKey(address)) ?? 0);
      const cutoff = Date.now() - RETENTION_MS; // keep the last 24h, read or not

      const payments = fetch("/api/agent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ intent: "Show my transaction history", walletAddress }) })
        .then((r) => r.json())
        .then((j) => {
          const rows = (j.history ?? []) as HistoryRow[];
          return rows
            .filter((h) => h.at > cutoff && LABEL[h.decision])
            .map((h): Omit<NotifItem, "read"> => ({
              id: h.txHash ?? `${h.at}-${h.decision}`,
              decision: h.decision,
              title: LABEL[h.decision],
              detail: phraseSummary(h.summary, h.decision),
              at: h.at,
              explorerUrl: h.explorerUrl,
              href: "/dashboard/transactions",
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
              href: "/dashboard/automations",
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
              href: "/dashboard/support",
            }));
        })
        .catch(() => [] as Omit<NotifItem, "read">[]);

      Promise.all([payments, automations, tickets]).then(([fresh, automationFresh, ticketFresh]) => {
        if (cancelled) return;
        const all = [...fresh, ...automationFresh, ...ticketFresh].sort((a, b) => b.at - a.at).slice(0, 15);
        // Read items stay in the feed (dimmed) until they age past 24h; only
        // unseen ones drive the unread badge.
        setNotifications(all.map((n) => ({ ...n, read: n.at <= seenAt })));
        setUnread(all.filter((n) => n.at > seenAt).length);
      });
    }
    load();
    const t = setInterval(load, 20000);
    return () => { cancelled = true; clearInterval(t); };
  }, [walletAddress]);

  // Opening the bell marks everything currently shown as read — but keeps it
  // visible (dimmed) for the rest of its 24h window rather than clearing it.
  function markSeen() {
    if (!walletAddress) return;
    localStorage.setItem(seenKey(walletAddress), String(Date.now()));
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    setUnread(0);
  }

  return { notifications, unread, markSeen };
}
