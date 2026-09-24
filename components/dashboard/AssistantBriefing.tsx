"use client";

import { useEffect, useState } from "react";
import { motion } from "motion/react";
import {
  AlertTriangle, ArrowLeftRight, ArrowUpRight, Bell, Clock3, Coins, Landmark,
  Repeat, Users, Wallet,
} from "lucide-react";
import { Skeleton } from "@/components/ui";
import { useWalletService as useWallet } from "@/lib/wallet-service/WalletServiceContext";
import { useWalletBalances } from "@/lib/hooks/useWalletBalances";

/**
 * What the assistant knows when you open it.
 *
 * A chatbot opens empty and waits to be told everything. A payment operator
 * opens already knowing the state of the desk — whose wallet this is, what it
 * holds, what is scheduled, what needs attention — and the same conversation
 * reads completely differently for it.
 *
 * The greeting adapts to that state rather than reciting one line at everyone:
 * someone with a payment due in two hours is told so, and someone who has
 * never sent anything is not congratulated on their operation.
 *
 * Every figure here is real and scoped to the connected wallet. Where a number
 * isn't known, it is left out — an operator that invents a balance is worse
 * than one that admits it hasn't checked.
 */

export interface AssistantContext {
  known: boolean;
  /** Either figure may be null on its own — a deployment without USDC
   *  configured still knows its MON balance, and hiding both because one is
   *  missing throws away a fact the user has. */
  balance: { mon: number | null; usdc: number | null } | null;
  linkedWallets: { address: string; label: string }[];
  automations: {
    live: number;
    total: number;
    needsAttention: number;
    next: { id: string; at: number; amount: number; token: string; recipient: string } | null;
  };
  activity: { settledPayments: number; recentSwaps: { at: number; summary: string }[] };
  notifications: { recent: number };
  templates: { id: string; name: string }[];
}

/** The operations this desk actually performs. Each is a real starting point,
 *  not a canned phrase — every one lands in a flow that already exists. */
export const OPERATOR_ACTIONS: { label: string; icon: typeof Wallet; prompt?: string; href?: string }[] = [
  { label: "Create Automation", icon: Repeat, href: "/dashboard/automations" },
  { label: "Send Payment", icon: ArrowUpRight, prompt: "send " },
  { label: "Swap Tokens", icon: ArrowLeftRight, prompt: "swap 1 MON to USDC" },
  { label: "Schedule Payroll", icon: Users, href: "/dashboard/automations?template=payroll" },
  { label: "Run Distribution", icon: Coins, href: "/dashboard/automations?template=distribution" },
  { label: "Check Upcoming Payments", icon: Clock3, href: "/dashboard/automations" },
  { label: "Review Treasury", icon: Landmark, href: "/dashboard/wallets" },
];

function whenAgo(at: number): string {
  const mins = Math.round((at - Date.now()) / 60_000);
  if (mins <= 0) return "due now";
  if (mins < 60) return `in ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

const money = (n: number, token: string) =>
  `${n.toLocaleString(undefined, { maximumFractionDigits: token === "MON" ? 4 : 2 })} ${token}`;

/** The one line at the top. Says the most useful true thing available. */
export function greeting(ctx: AssistantContext | null): { title: string; detail: string } {
  if (!ctx?.known) {
    return {
      title: "Welcome to PayAI.",
      detail: "Connect a wallet and I can set up payments and automations for you.",
    };
  }
  if (ctx.automations.needsAttention > 0) {
    const n = ctx.automations.needsAttention;
    return {
      title: "Welcome back.",
      detail: `${n} automation${n === 1 ? "" : "s"} ${n === 1 ? "needs" : "need"} your attention.`,
    };
  }
  if (ctx.automations.next) {
    const next = ctx.automations.next;
    return {
      title: "Welcome back.",
      detail: `Next payment: ${money(next.amount, next.token)} to ${next.recipient} ${whenAgo(next.at)}.`,
    };
  }
  if (ctx.automations.live > 0) {
    return {
      title: "Welcome back.",
      detail: `${ctx.automations.live} automation${ctx.automations.live === 1 ? "" : "s"} running. What would you like to automate today?`,
    };
  }
  return {
    title: "Welcome back.",
    detail: "What would you like to automate today?",
  };
}

export function useAssistantContext(): { ctx: AssistantContext | null; loading: boolean } {
  const wallet = useWallet();
  // Balances come from the hook the dashboard already runs, not from the
  // briefing endpoint: a chain read there would gate every other fact behind
  // the slowest one, and the browser has these numbers anyway.
  const balances = useWalletBalances(wallet.readAddress, wallet.isLocked);
  const [ctx, setCtx] = useState<AssistantContext | null>(null);
  const [loading, setLoading] = useState(true);
  const address = wallet.readAddress;

  useEffect(() => {
    if (!address) { setCtx(null); setLoading(false); return; }
    let cancelled = false;
    setLoading(true);
    fetch(`/api/assistant/context?wallet=${address}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!cancelled) setCtx(j); })
      .catch(() => { if (!cancelled) setCtx(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [address]);

  const withBalance: AssistantContext | null = ctx
    ? {
        ...ctx,
        balance:
          balances.mon != null || balances.usdc != null
            ? {
                mon: balances.mon != null ? Number(balances.mon) : null,
                usdc: balances.usdc != null ? Number(balances.usdc) : null,
              }
            : null,
      }
    : null;

  return { ctx: withBalance, loading };
}

/** The briefing itself — greeting, what it knows, and what it can do. */
export function AssistantBriefing({
  ctx,
  loading,
  onPrompt,
}: {
  ctx: AssistantContext | null;
  loading: boolean;
  onPrompt: (prompt: string) => void;
}) {
  const { title, detail } = greeting(ctx);

  return (
    <div>
      <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
        <p className="text-sm font-semibold text-foreground">{title}</p>
        {loading && !ctx ? (
          <Skeleton className="mt-1 h-3 w-56" />
        ) : (
          <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>
        )}
      </motion.div>

      {/* What it already knows. Only facts that exist — an empty account shows
          nothing here rather than a row of zeroes dressed up as a summary. */}
      {ctx?.known && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {ctx.balance && (
            <Fact
              icon={Wallet}
              label={[
                ctx.balance.mon != null ? money(ctx.balance.mon, "MON") : null,
                ctx.balance.usdc != null ? money(ctx.balance.usdc, "USDC") : null,
              ].filter(Boolean).join(" · ")}
            />
          )}
          {ctx.automations.live > 0 && (
            <Fact icon={Repeat} label={`${ctx.automations.live} running`} />
          )}
          {ctx.automations.needsAttention > 0 && (
            <Fact icon={AlertTriangle} label={`${ctx.automations.needsAttention} need attention`} tone="warning" />
          )}
          {ctx.notifications.recent > 0 && (
            <Fact icon={Bell} label={`${ctx.notifications.recent} today`} />
          )}
          {ctx.linkedWallets.length > 0 && (
            <Fact icon={Wallet} label={`${ctx.linkedWallets.length + 1} wallets`} />
          )}
          {ctx.activity.recentSwaps.length > 0 && (
            <Fact icon={ArrowLeftRight} label={`${ctx.activity.recentSwaps.length} recent swap${ctx.activity.recentSwaps.length === 1 ? "" : "s"}`} />
          )}
        </div>
      )}

      <p className="mb-2 mt-4 px-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
        What would you like to do
      </p>
      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {OPERATOR_ACTIONS.map((action, i) => {
          const Icon = action.icon;
          const body = (
            <>
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary-ink">
                <Icon size={14} />
              </span>
              <span className="truncate text-xs font-medium text-foreground">{action.label}</span>
            </>
          );
          const className =
            "flex items-center gap-2.5 rounded-lg border border-border px-2.5 py-2 text-left transition hover:border-primary/40 hover:bg-input/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
          return (
            <motion.div
              key={action.label}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.03 * i, duration: 0.2 }}
            >
              {action.href ? (
                <a href={action.href} className={className}>{body}</a>
              ) : (
                <button onClick={() => onPrompt(action.prompt ?? "")} className={`w-full ${className}`}>{body}</button>
              )}
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

function Fact({
  icon: Icon,
  label,
  tone = "neutral",
}: {
  icon: typeof Wallet;
  label: string;
  tone?: "neutral" | "warning";
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
        tone === "warning"
          ? "border-warning/30 bg-warning/10 text-warning"
          : "border-border text-muted-foreground"
      }`}
    >
      <Icon size={10} /> {label}
    </span>
  );
}
