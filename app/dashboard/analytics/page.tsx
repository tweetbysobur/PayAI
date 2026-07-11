"use client";

import { useEffect, useState } from "react";
import { motion } from "motion/react";
import { Card } from "@/components/ui";
import { useWallet } from "@/lib/wallet/useWallet";
import { TokenLogo } from "@/components/TokenLogo";

interface Revenue { total: number; today: number; thisWeek: number; thisMonth: number; currency: string; settledCount: number; failedCount: number; successRate: number }
interface TrendPoint { date: string; revenue: number; count: number }
interface Insight { id: string; severity: string; title: string; detail: string; suggestion?: string }
interface TopCustomer { address: string; name?: string; totalPaid: number; paymentCount: number }
interface Analytics { revenue: Revenue; trend: TrendPoint[]; volume: { count: number; total: number }; topCustomers?: TopCustomer[]; insights?: Insight[] }

const short = (s?: string | null) => (s ? `${s.slice(0, 8)}…${s.slice(-6)}` : "—");

export default function AnalyticsPage() {
  const wallet = useWallet();
  const [a, setA] = useState<Analytics | null>(null);

  useEffect(() => {
    // Scoped to the connected wallet — a user's analytics reflect only their own payments.
    const headers = wallet.address ? { "x-wallet-address": wallet.address } : undefined;
    fetch("/api/analytics", { headers }).then((r) => r.json()).then(setA).catch(() => {});
  }, [wallet.address]);

  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="mb-1 text-2xl font-semibold text-foreground">Analytics</h1>
      <p className="mb-6 text-sm text-muted-foreground">Payment volume, settlement activity, and revenue trends.</p>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          { label: "Total revenue", value: a ? `${a.revenue.total.toFixed(2)} ${a.revenue.currency}` : "—", coin: true },
          { label: "This month", value: a ? `${a.revenue.thisMonth.toFixed(2)} ${a.revenue.currency}` : "—", coin: true },
          { label: "Success rate", value: a ? `${Math.round(a.revenue.successRate * 100)}%` : "—", coin: false },
          { label: "Settled / Failed", value: a ? `${a.revenue.settledCount} / ${a.revenue.failedCount}` : "—", coin: false },
        ].map((k) => (
          <Card key={k.label} className="p-4">
            <p className="flex items-center gap-1.5 text-xl font-semibold text-foreground">
              {k.coin && a && <TokenLogo token={a.revenue.currency} size={16} />}{k.value}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">{k.label}</p>
          </Card>
        ))}
      </div>

      <Card title="Revenue trend (7d)" className="mb-4">
        {a?.trend.length ? (
          <div className="flex h-40 items-end gap-2">
            {a.trend.map((t, i) => {
              const max = Math.max(1, ...a.trend.map((x) => x.revenue));
              return (
                <div key={t.date} className="group relative flex flex-1 flex-col items-center gap-1">
                  <div className="pointer-events-none absolute -top-7 hidden whitespace-nowrap rounded-md border border-border bg-panel px-2 py-1 text-[10px] text-foreground shadow-panel group-hover:block">
                    {t.revenue.toFixed(2)} ({t.count} tx)
                  </div>
                  <motion.div className="w-full max-w-10 rounded-t bg-primary/70 transition-colors group-hover:bg-primary" initial={{ height: 0 }} animate={{ height: `${Math.max(2, (t.revenue / max) * 130)}px` }} transition={{ delay: i * 0.05, duration: 0.4 }} />
                  <span className="text-[10px] text-muted-foreground/70">{t.date.slice(5)}</span>
                </div>
              );
            })}
          </div>
        ) : <p className="text-sm text-muted-foreground">No data yet.</p>}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Top customers">
          {a?.topCustomers?.length ? (
            <ul className="divide-y divide-border text-sm">
              {a.topCustomers.map((t) => (
                <li key={t.address} className="flex items-center justify-between py-2">
                  <span className="font-mono text-xs text-foreground">{t.name ?? short(t.address)}</span>
                  <span className="text-muted-foreground">{t.totalPaid.toFixed(2)} ({t.paymentCount}x)</span>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted-foreground">No data yet.</p>}
        </Card>

        <Card title="Insights">
          {a?.insights?.length ? (
            <ul className="space-y-3">
              {a.insights.map((ins) => (
                <li key={ins.id} className="rounded-lg border border-border bg-input/30 p-3">
                  <p className="text-sm font-medium text-foreground">{ins.title}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{ins.detail}</p>
                  {ins.suggestion && <p className="mt-1 text-xs text-primary">{ins.suggestion}</p>}
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted-foreground">Not enough data for insights yet.</p>}
        </Card>
      </div>
    </div>
  );
}
