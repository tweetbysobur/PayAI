"use client";

import { useEffect, useState } from "react";
import { phraseSummary } from "@/lib/hooks/useAgentConsole";

interface HistoryRow { at: number; decision: string; summary: string; recipient?: string | null; domain?: string | null; txHash?: string; explorerUrl?: string }
interface AutomationEventRow {
  id: string; type: string; at: number; title: string; detail: string; txHash?: string; explorerUrl?: string;
}

export interface NotifItem {
  id: string;
  decision: string;
  title: string;
  detail: string;
  at: number;
  explorerUrl?: string;
}

const SEEN_KEY = "veripay_notifs_seen_at";

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

  useEffect(() => {
    // Notifications are the user's OWN activity — scope every fetch to the
    // connected wallet (the server returns nothing without it, by design), so
    // the bell reflects your activity, not an empty/shared feed.
    if (!walletAddress) { setNotifications([]); return; }
    let cancelled = false;
    function load() {
      if (document.hidden) return;
      const seenAt = Number(localStorage.getItem(SEEN_KEY) ?? 0);

      const payments = fetch("/api/agent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ intent: "Show my transaction history", walletAddress }) })
        .then((r) => r.json())
        .then((j) => {
          const rows = (j.history ?? []) as HistoryRow[];
          return rows
            .filter((h) => h.at > seenAt && LABEL[h.decision])
            .map((h): NotifItem => ({
              id: h.txHash ?? `${h.at}-${h.decision}`,
              decision: h.decision,
              title: LABEL[h.decision],
              detail: phraseSummary(h.summary, h.decision),
              at: h.at,
              explorerUrl: h.explorerUrl,
            }));
        })
        .catch(() => [] as NotifItem[]);

      // Payment Automation lifecycle events — a real, server-timestamped log
      // (lib/platform/automationEvents.ts), not inferred from current status.
      const automations = fetch(`/api/automation-events?wallet=${walletAddress}`)
        .then((r) => r.json())
        .then((j) => {
          const rows = (j.events ?? []) as AutomationEventRow[];
          return rows
            .filter((e) => e.at > seenAt)
            .map((e): NotifItem => ({
              id: e.id,
              decision: `automation_${e.type}`,
              title: e.title,
              detail: e.detail,
              at: e.at,
              explorerUrl: e.explorerUrl,
            }));
        })
        .catch(() => [] as NotifItem[]);

      Promise.all([payments, automations]).then(([fresh, automationFresh]) => {
        if (cancelled) return;
        setNotifications([...fresh, ...automationFresh].sort((a, b) => b.at - a.at).slice(0, 10));
      });
    }
    load();
    const t = setInterval(load, 20000);
    return () => { cancelled = true; clearInterval(t); };
  }, [walletAddress]);

  function markSeen() {
    localStorage.setItem(SEEN_KEY, String(Date.now()));
    setNotifications([]);
  }

  return { notifications, markSeen };
}
