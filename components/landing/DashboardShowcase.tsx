"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight, Receipt, ShieldCheck } from "lucide-react";
import { VolumeStack } from "@/components/TokenLogo";

interface PlatformActivity {
  totalPayments: number;
  volumeByToken: Record<string, number>;
  compliance: { approved: number; rejected: number; review: number; blocked: number; approvalRate: number };
  trend: { date: string; revenue: number; count: number }[];
}

/** Real, live platform totals — not mock illustration. One public,
 *  aggregate-only fetch (/api/platform-stats), polled so the numbers keep
 *  climbing as the product is actually used. */
export function DashboardShowcase({ active = true }: { active?: boolean }) {
  const [activity, setActivity] = useState<PlatformActivity | null>(null);

  useEffect(() => {
    if (!active) return;
    const load = () => fetch("/api/platform-stats").then((r) => r.json()).then(setActivity).catch(() => {});
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, 20000);
    return () => clearInterval(t);
  }, [active]);

  const hasVolume = activity && Object.values(activity.volumeByToken).some((v) => v > 0);
  const approvalPct = activity ? Math.round(activity.compliance.approvalRate * 100) : null;
  const trend = activity?.trend ?? [];
  const maxRev = Math.max(1, ...trend.map((t) => t.revenue));

  return (
    <div className="overflow-hidden rounded-2xl surface-purple">
      <div className="flex items-center gap-2 border-b border-border bg-background px-4 py-2.5">
        <span className="h-2 w-2 rounded-full bg-border" />
        <span className="h-2 w-2 rounded-full bg-border" />
        <span className="h-2 w-2 rounded-full bg-border" />
        <div className="ml-2 flex items-center gap-1.5 rounded-full border border-border bg-panel px-2 py-0.5 text-[10px] text-muted-foreground">
          usepayai.xyz/dashboard
        </div>
      </div>

      {/* Hairline highlight along the top edge — the same premium-surface tell
          used on the platform metrics panel. */}
      <div aria-hidden className="h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />

      <div className="space-y-3 p-5">
        {/*
          Volume takes the full row on a phone and a third of it from `sm` up.

          Three equal columns at 390px leaves each card 92px wide — 68px of
          content once padding is off — and volume is the one metric here that
          carries a number AND a ticker AND more than one currency. Squeezed
          into 68px it either overflows the card (what it did) or truncates to
          "3…", which is worse: a figure nobody can read is not a metric. The
          two single-number cards fit that width comfortably, so they keep it.
        */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {[
            {
              icon: ArrowUpRight,
              label: "Volume",
              wide: true,
              value: hasVolume
                ? <VolumeStack byToken={activity!.volumeByToken} size={13} max={2} valueClassName="text-sm font-semibold" />
                : <span className="text-sm font-semibold text-foreground">—</span>,
            },
            {
              icon: Receipt,
              label: "Payments",
              value: <span className="text-sm font-semibold tabular-nums tracking-tight text-foreground">{activity ? activity.totalPayments.toLocaleString() : "—"}</span>,
            },
            {
              icon: ShieldCheck,
              label: "Approval",
              value: <span className="text-sm font-semibold tabular-nums tracking-tight text-foreground">{approvalPct != null ? `${approvalPct}%` : "—"}</span>,
            },
          ].map((k) => (
            // min-w-0: a grid column's default `min-width: auto` refuses to go
            // below its content, so without this the track simply widens and
            // the overflow moves rather than resolving.
            <div
              key={k.label}
              className={`min-w-0 rounded-xl border border-border bg-gradient-to-b from-primary/[0.06] to-transparent p-3 ring-1 ring-inset ring-glass/[0.03] ${k.wide ? "col-span-2 sm:col-span-1" : ""}`}
            >
              {/* Label left, icon right, figure below — the same shape as the
                  real dashboard's metric cards, since this is a preview of
                  them. It also leaves the figure the card's full width. */}
              <div className="flex items-center justify-between gap-2">
                <span className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground">{k.label}</span>
                <k.icon size={13} className="shrink-0 text-primary-ink" />
              </div>
              <div className="mt-2 min-w-0 leading-tight">{k.value}</div>
            </div>
          ))}
        </div>
        <div className="rounded-xl border border-border bg-gradient-to-b from-primary/[0.06] to-transparent p-3 ring-1 ring-inset ring-glass/[0.03]">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Payment volume · 7d</span>
            <span className="flex items-center gap-1.5 text-[10px] text-primary-ink">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-60" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-primary" />
              </span>
              live
            </span>
          </div>
          {/*
            Bars must be DIRECT children of this h-24 row for their percentage
            `height` to resolve against a real 96px, not 0. The previous
            structure nested each bar one level deeper, inside a flex column
            that also held its date label — but that column has no definite
            height of its own (items-end positions flex children, it does not
            stretch them), so every bar's percentage height resolved against
            nothing and rendered at 0px regardless of the real trend data.
            Labels now live in their own row underneath instead.
          */}
          <div className="relative flex h-24 items-end gap-1.5">
            {/* Baseline the bars sit on, so a near-zero day still reads as a
                day with almost nothing rather than a rendering gap. */}
            <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-border" />
            {trend.length === 0
              ? Array.from({ length: 7 }).map((_, i) => <div key={i} className="flex-1 rounded-t bg-input" style={{ height: "6%" }} />)
              : trend.map((t, i) => {
                  // The most recent day is the one a visitor is here to see;
                  // the rest are context and read at a lower weight.
                  const latest = i === trend.length - 1;
                  return (
                    <div
                      key={t.date}
                      className={`flex-1 rounded-t transition-all duration-500 ${latest ? "bg-gradient-to-t from-primary/60 to-primary shadow-[0_0_12px_-2px] shadow-primary/50" : "bg-gradient-to-t from-primary/25 to-primary/70"}`}
                      style={{ height: `${Math.max(6, (t.revenue / maxRev) * 100)}%` }}
                    />
                  );
                })}
          </div>
          {trend.length > 0 && (
            <div className="mt-2 flex gap-1.5">
              {trend.map((t, i) => (
                <span
                  key={t.date}
                  className={`flex-1 text-center text-[9px] tabular-nums ${i === trend.length - 1 ? "font-medium text-muted-foreground" : "text-muted-foreground/60"}`}
                >
                  {t.date.slice(5)}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
