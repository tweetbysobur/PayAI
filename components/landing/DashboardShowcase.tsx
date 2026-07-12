"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight, Receipt, ShieldCheck } from "lucide-react";
import { VolumeInline } from "@/components/TokenLogo";

interface PlatformActivity {
  totalPayments: number;
  volumeByToken: Record<string, number>;
  compliance: { approved: number; rejected: number; review: number; blocked: number; approvalRate: number };
  trend: { date: string; revenue: number; count: number }[];
}

/** Real, live platform totals — not mock illustration. One public,
 *  aggregate-only fetch (/api/platform-stats), polled so the numbers keep
 *  climbing as the product is actually used. */
export function DashboardShowcase() {
  const [activity, setActivity] = useState<PlatformActivity | null>(null);

  useEffect(() => {
    const load = () => fetch("/api/platform-stats").then((r) => r.json()).then(setActivity).catch(() => {});
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, 20000);
    return () => clearInterval(t);
  }, []);

  const hasVolume = activity && Object.values(activity.volumeByToken).some((v) => v > 0);
  const approvalPct = activity ? Math.round(activity.compliance.approvalRate * 100) : null;
  const trend = activity?.trend ?? [];
  const maxRev = Math.max(1, ...trend.map((t) => t.revenue));

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-panel shadow-2xl">
      <div className="flex items-center gap-2 border-b border-border bg-background px-4 py-2.5">
        <span className="h-2 w-2 rounded-full bg-border" />
        <span className="h-2 w-2 rounded-full bg-border" />
        <span className="h-2 w-2 rounded-full bg-border" />
        <div className="ml-2 flex items-center gap-1.5 rounded-full border border-border bg-panel px-2 py-0.5 text-[10px] text-muted-foreground">
          usepayai.xyz/dashboard
        </div>
      </div>

      <div className="space-y-3 p-5">
        <div className="grid grid-cols-3 gap-3">
          {[
            { icon: ArrowUpRight, label: "Volume", value: hasVolume ? <VolumeInline byToken={activity!.volumeByToken} size={11} /> : "—" },
            { icon: Receipt, label: "Payments", value: activity ? activity.totalPayments.toLocaleString() : "—" },
            { icon: ShieldCheck, label: "Approval", value: approvalPct != null ? `${approvalPct}%` : "—" },
          ].map((k) => (
            <div key={k.label} className="rounded-xl border border-border bg-gradient-to-b from-primary/[0.05] to-transparent p-3">
              <div className="mb-2 flex h-7 w-7 items-center justify-center rounded-lg bg-primary/12 text-primary"><k.icon size={13} /></div>
              <div className="text-xs font-semibold leading-tight text-foreground">{k.value}</div>
              <div className="mt-1 text-[10px] text-muted-foreground">{k.label}</div>
            </div>
          ))}
        </div>
        <div className="rounded-xl border border-border bg-gradient-to-b from-primary/[0.05] to-transparent p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">Payment volume · 7d</span>
            <span className="flex items-center gap-1 text-[10px] text-primary"><span className="h-1.5 w-1.5 rounded-full bg-primary" /> live</span>
          </div>
          <div className="flex h-24 items-end gap-1.5">
            {trend.length === 0
              ? Array.from({ length: 7 }).map((_, i) => <div key={i} className="flex-1 rounded-t bg-input" style={{ height: "6%" }} />)
              : trend.map((t) => (
                  <div key={t.date} className="flex flex-1 flex-col items-center gap-1.5">
                    <div className="w-full rounded-t bg-gradient-to-t from-primary/40 to-primary transition-all duration-500" style={{ height: `${Math.max(6, (t.revenue / maxRev) * 100)}%` }} />
                    <span className="text-[9px] text-muted-foreground/70">{t.date.slice(5)}</span>
                  </div>
                ))}
          </div>
        </div>
      </div>
    </div>
  );
}
