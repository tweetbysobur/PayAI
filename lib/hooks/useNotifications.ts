"use client";

import { useEffect, useState } from "react";

interface HistoryRow { at: number; decision: string; summary: string; recipient?: string | null; domain?: string | null }

const SEEN_KEY = "veripay_notifs_seen_at";

const LABEL: Record<string, string> = {
  executed: "Payment executed",
  needs_review: "Payment needs review",
  blocked: "Payment blocked",
  refused: "Payment refused",
};

export function useNotifications() {
  const [notifications, setNotifications] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    function load() {
      fetch("/api/agent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ intent: "Show my transaction history" }) })
        .then((r) => r.json())
        .then((j) => {
          if (cancelled) return;
          const rows = (j.history ?? []) as HistoryRow[];
          const seenAt = Number(localStorage.getItem(SEEN_KEY) ?? 0);
          const fresh = rows
            .filter((h) => h.at > seenAt && LABEL[h.decision])
            .slice(0, 8)
            .map((h) => `${LABEL[h.decision]}${h.domain ? ` — ${h.domain}` : ""}: ${h.summary}`);
          setNotifications(fresh);
        })
        .catch(() => {});
    }
    load();
    const t = setInterval(load, 20000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  function markSeen() {
    localStorage.setItem(SEEN_KEY, String(Date.now()));
    setNotifications([]);
  }

  return { notifications, markSeen };
}
