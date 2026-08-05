"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useSync, syncAgo } from "@/lib/hooks/useSync";

/**
 * The dashboard's one refresh control.
 *
 * It refreshes everything registered with the sync provider — balances,
 * portfolio, token balances, automation status, recent activity,
 * notifications, pending transactions, upcoming executions — rather than
 * whatever the current page happens to own.
 *
 * Disabled while syncing, so a user cannot queue five rounds of requests by
 * tapping five times, and the freshness line ticks on its own so "12 seconds
 * ago" does not sit there claiming to be true a minute later.
 */
export function SyncButton({ className = "" }: { className?: string }) {
  const { sync, syncing, lastSyncedAt } = useSync();
  const [, tick] = useState(0);

  // Re-render once a second only while there is a timestamp to age. Idle
  // pages cost nothing.
  useEffect(() => {
    if (lastSyncedAt == null) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [lastSyncedAt]);

  return (
    <div className={`flex items-center gap-2.5 ${className}`}>
      <span className="hidden text-xs text-muted-foreground sm:inline" aria-live="polite">
        {syncing ? "Syncing…" : syncAgo(lastSyncedAt)}
      </span>
      <button
        onClick={() => { void sync(); }}
        disabled={syncing}
        aria-label={syncing ? "Syncing" : "Refresh everything"}
        title="Refresh balances, portfolio, automations and activity"
        className="inline-flex items-center gap-1.5 rounded-full border border-border bg-panel px-3 py-1.5 text-xs font-medium text-foreground transition hover:border-primary/40 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <RefreshCw size={13} className={syncing ? "animate-spin" : "text-muted-foreground"} />
        <span className="hidden sm:inline">{syncing ? "Syncing" : "Refresh"}</span>
      </button>
    </div>
  );
}
