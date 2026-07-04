"use client";

import { useEffect, useState } from "react";
import { phraseSummary } from "@/lib/hooks/useAgentConsole";

interface HistoryRow { at: number; decision: string; summary: string; recipient?: string | null; domain?: string | null; txHash?: string; explorerUrl?: string }

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
};

export function useNotifications(walletAddress?: string | null) {
  const [notifications, setNotifications] = useState<NotifItem[]>([]);

  useEffect(() => {
    // Notifications are the user's OWN payment outcomes — scope the history
    // fetch to the connected wallet (the server returns nothing without it, by
    // design), so the bell reflects your activity, not an empty/shared feed.
    if (!walletAddress) { setNotifications([]); return; }
    let cancelled = false;
    function load() {
      if (document.hidden) return;
      fetch("/api/agent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ intent: "Show my transaction history", walletAddress }) })
        .then((r) => r.json())
        .then((j) => {
          if (cancelled) return;
          const rows = (j.history ?? []) as HistoryRow[];
          const seenAt = Number(localStorage.getItem(SEEN_KEY) ?? 0);
          const fresh: NotifItem[] = rows
            .filter((h) => h.at > seenAt && LABEL[h.decision])
            .slice(0, 8)
            .map((h) => ({
              id: h.txHash ?? `${h.at}-${h.decision}`,
              decision: h.decision,
              title: LABEL[h.decision],
              detail: phraseSummary(h.summary, h.decision),
              at: h.at,
              explorerUrl: h.explorerUrl,
            }));
          setNotifications(fresh);
        })
        .catch(() => {});
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
