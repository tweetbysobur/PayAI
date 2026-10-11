"use client";

/**
 * One feed for everything that has happened.
 *
 * Activity was scattered across four surfaces that each knew about one kind of
 * event: payments in Transactions, automation runs behind each automation,
 * swaps only in the tx log, wallet movements only in the bell. "What happened
 * to my money this week?" had no page that could answer it, because no single
 * view had all the pieces.
 *
 * This merges the existing sources — no new recording, no duplicate store. Each
 * source already scopes itself to the connected wallet, so the merged feed
 * inherits that: you see your own activity and nobody else's.
 */
import { fetchHistory } from "@/lib/hooks/historyFetch";
import { useCallback, useEffect, useState } from "react";
import { useSyncRefresher } from "@/lib/hooks/useSync";
import { phraseSummary } from "@/lib/hooks/useAgentConsole";
import { walletEventHref, type WalletEventType } from "@/lib/wallet-service/types";

export type ActivityKind = "payment" | "automation" | "swap" | "refund" | "wallet" | "support";

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  at: number;
  title: string;
  detail: string;
  /** "ok" | "pending" | "failed" — how it turned out, or null when the event
   *  has no outcome (a wallet connecting, a ticket being opened). */
  status: "ok" | "pending" | "failed" | null;
  amount?: number | null;
  token?: string | null;
  txHash?: string;
  explorerUrl?: string;
  href?: string;
}

export type Period = "today" | "week" | "month" | "all";

const DAY = 86_400_000;
export const PERIOD_MS: Record<Period, number> = {
  today: DAY,
  week: 7 * DAY,
  month: 30 * DAY,
  all: Number.POSITIVE_INFINITY,
};

/** Payment decisions → an outcome the feed can colour. */
function paymentStatus(decision: string): ActivityItem["status"] {
  if (decision === "executed") return "ok";
  if (decision === "needs_review") return "pending";
  if (decision === "blocked" || decision === "refused" || decision === "error") return "failed";
  return null;
}

function walletKind(type: string): ActivityKind {
  if (type.startsWith("swap_")) return "swap";
  if (type === "refund_completed") return "refund";
  if (type.startsWith("automation_")) return "automation";
  return "wallet";
}

function walletStatus(type: string): ActivityItem["status"] {
  if (type.endsWith("_failed")) return "failed";
  if (type.endsWith("_completed") || type.endsWith("_executed") || type.endsWith("_received")) return "ok";
  return null;
}

export function useActivity(address: string | null, providerId?: string | null) {
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  useSyncRefresher(refresh);

  useEffect(() => {
    if (!address) { setItems([]); setLoading(false); return; }
    let cancelled = false;
    setLoading(true);

    const payments = fetchHistory(address)
      .then((j) =>
        ((j.history ?? []) as {
          at: number; decision: string; summary: string; amount: number | null;
          token: string; txHash?: string; explorerUrl?: string; action?: string;
        }[]).map((h): ActivityItem => ({
          id: h.txHash ?? `pay-${h.at}-${h.decision}`,
          // A swap is recorded in the same log as a payment but is not one —
          // filtering by "swap" has to find it here too, or the filter lies.
          kind: h.action === "swap" ? "swap" : "payment",
          at: h.at,
          title: h.action === "swap" ? "Swap" : "Payment",
          detail: phraseSummary(h.summary, h.decision),
          status: paymentStatus(h.decision),
          amount: h.amount,
          token: h.token,
          txHash: h.txHash,
          explorerUrl: h.explorerUrl,
          href: "/dashboard/transactions",
        })),
      )
      .catch(() => [] as ActivityItem[]);

    const walletEvents = fetch(
      `/api/wallet-events?wallet=${address}${providerId ? `&provider=${providerId}` : ""}`,
    )
      .then((r) => r.json())
      .then((j) =>
        ((j.events ?? []) as {
          id: string; type: string; at: number; title: string; detail: string;
          amount?: number | null; token?: string | null; txHash?: string; explorerUrl?: string;
        }[]).map((e): ActivityItem => ({
          id: e.id,
          kind: walletKind(e.type),
          at: e.at,
          title: e.title,
          detail: e.detail,
          status: walletStatus(e.type),
          amount: e.amount,
          token: e.token,
          txHash: e.txHash,
          explorerUrl: e.explorerUrl,
          // Same rule as the bell (useNotifications.ts): only wallet-identity
          // events actually belong on the Wallets page, which renders a
          // different data source (on-chain PaymentExecutor history) and has
          // never shown a deposit, swap, refund, or automation signature.
          href: walletEventHref(e.type as WalletEventType),
        })),
      )
      .catch(() => [] as ActivityItem[]);

    const automations = fetch(`/api/automation-events?wallet=${address}`)
      .then((r) => r.json())
      .then((j) =>
        ((j.events ?? []) as {
          id: string; type: string; at: number; title: string; detail: string;
          txHash?: string; explorerUrl?: string;
        }[]).map((e): ActivityItem => ({
          id: e.id,
          kind: "automation",
          at: e.at,
          title: e.title,
          detail: e.detail,
          status: e.type.includes("failed") ? "failed" : e.type.includes("executed") ? "ok" : null,
          txHash: e.txHash,
          explorerUrl: e.explorerUrl,
          href: "/dashboard/automations",
        })),
      )
      .catch(() => [] as ActivityItem[]);

    const tickets = fetch(`/api/support?wallet=${address}`)
      .then((r) => r.json())
      .then((j) =>
        ((j.tickets ?? []) as { id: string; category: string; description: string; createdAt: number }[]).map(
          (t): ActivityItem => ({
            id: t.id,
            kind: "support",
            at: t.createdAt,
            title: "Support request",
            detail: t.description,
            status: null,
            href: "/dashboard/help?tab=support",
          }),
        ),
      )
      .catch(() => [] as ActivityItem[]);

    Promise.all([payments, walletEvents, automations, tickets]).then((groups) => {
      if (cancelled) return;
      // De-duped on id: one on-chain event can legitimately reach this feed
      // through two sources (a swap is both a tx-log row and a notification),
      // and showing it twice would read as two things happening.
      const seen = new Map<string, ActivityItem>();
      for (const item of groups.flat()) {
        const key = item.txHash?.toLowerCase() ?? item.id;
        if (!seen.has(key)) seen.set(key, item);
      }
      setItems([...seen.values()].sort((a, b) => b.at - a.at));
      setLoading(false);
    });

    return () => { cancelled = true; };
  }, [address, providerId, nonce]);

  return { items, loading, refresh };
}

/** Filter the feed. Pure, so the filtering rules are testable on their own. */
export function filterActivity(
  items: ActivityItem[],
  opts: { period?: Period; kinds?: ActivityKind[]; query?: string; now?: number } = {},
): ActivityItem[] {
  const now = opts.now ?? Date.now();
  const window = PERIOD_MS[opts.period ?? "all"];
  const query = opts.query?.trim().toLowerCase() ?? "";
  const kinds = opts.kinds && opts.kinds.length > 0 ? new Set(opts.kinds) : null;

  return items.filter((i) => {
    if (now - i.at > window) return false;
    if (kinds && !kinds.has(i.kind)) return false;
    if (query) {
      const haystack = `${i.title} ${i.detail} ${i.token ?? ""} ${i.txHash ?? ""}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}
