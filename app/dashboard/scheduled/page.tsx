"use client";

import { useCallback, useEffect, useState } from "react";
import { motion } from "motion/react";
import { CalendarClock, X, ArrowUpRight, ExternalLink, Repeat, CheckCircle2, Ban } from "lucide-react";
import { Badge, Button, Card } from "@/components/ui";

interface ScheduleRun { at: number; txHash?: string; explorerUrl?: string; decision: string; detail?: string }
interface Schedule {
  id: string; amount: number; token: string; recipient: string; domain?: string | null;
  cadence: "once" | "daily" | "weekly" | "monthly"; nextRun: number;
  status: "upcoming" | "completed" | "cancelled"; createdAt: number; runs: ScheduleRun[]; memo?: string;
}

const short = (s?: string | null) => (s ? `${s.slice(0, 6)}…${s.slice(-4)}` : "—");
const CADENCE_LABEL: Record<Schedule["cadence"], string> = { once: "One-time", daily: "Daily", weekly: "Weekly", monthly: "Monthly" };

function whenLabel(ms: number): string {
  const diff = ms - Date.now();
  if (diff <= 0) return "due now";
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `in ${hrs}h`;
  const days = Math.round(hrs / 24);
  return days <= 30 ? `in ${days}d` : new Date(ms).toLocaleDateString();
}

export default function ScheduledPage() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/schedule").then((r) => r.json()).then((j) => setSchedules(j.schedules ?? [])).finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function cancel(id: string) {
    setBusy(id);
    try {
      await fetch(`/api/schedule?id=${id}`, { method: "DELETE" });
      load();
    } finally {
      setBusy(null);
    }
  }

  const upcoming = schedules.filter((s) => s.status === "upcoming");
  const completed = schedules.filter((s) => s.status === "completed");
  const cancelled = schedules.filter((s) => s.status === "cancelled");

  const STATS = [
    { label: "Upcoming", value: upcoming.length, icon: CalendarClock, tone: "text-primary" },
    { label: "Completed", value: completed.length, icon: CheckCircle2, tone: "text-success" },
    { label: "Cancelled", value: cancelled.length, icon: Ban, tone: "text-muted-foreground" },
  ];

  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="mb-1 text-2xl font-semibold text-foreground">Scheduled Payments</h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Recurring and future-dated payments that settle automatically on Monad Mainnet when due.
      </p>

      <div className="mb-6 grid grid-cols-3 gap-3">
        {STATS.map((s) => (
          <Card key={s.label} className="!p-4">
            <div className="flex items-center gap-2 text-xs text-muted-foreground"><s.icon size={14} className={s.tone} /> {s.label}</div>
            <p className="mt-1.5 text-2xl font-semibold tracking-tight text-foreground [font-variant-numeric:tabular-nums]">{s.value}</p>
          </Card>
        ))}
      </div>

      {loading ? (
        <Card><p className="text-sm text-muted-foreground">Loading…</p></Card>
      ) : schedules.length === 0 ? (
        <Card className="text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/12 text-primary">
            <CalendarClock size={22} />
          </div>
          <p className="text-sm font-medium text-foreground">No scheduled payments yet</p>
          <p className="mx-auto mt-1.5 max-w-md text-sm text-muted-foreground">
            Create one in seconds with Ask PayAI (⌘K). For example:
          </p>
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            {["schedule 10 USDC to alex.nads every Friday", "pay 5 MON to alice.nad on 2026-07-01", "send 2 USDC to bob monthly"].map((ex) => (
              <code key={ex} className="rounded-md border border-border bg-input px-2.5 py-1 text-xs text-muted-foreground">{ex}</code>
            ))}
          </div>
        </Card>
      ) : (
        <div className="space-y-6">
          {upcoming.length > 0 && (
            <Section title="Upcoming">
              {upcoming.map((s) => (
                <ScheduleRow key={s.id} s={s} onCancel={() => cancel(s.id)} busy={busy === s.id} />
              ))}
            </Section>
          )}
          {completed.length > 0 && (
            <Section title="Completed">
              {completed.map((s) => <ScheduleRow key={s.id} s={s} />)}
            </Section>
          )}
          {cancelled.length > 0 && (
            <Section title="Cancelled">
              {cancelled.map((s) => <ScheduleRow key={s.id} s={s} />)}
            </Section>
          )}
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="mb-2.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h2>
      <div className="space-y-2.5">{children}</div>
    </div>
  );
}

function ScheduleRow({ s, onCancel, busy }: { s: Schedule; onCancel?: () => void; busy?: boolean }) {
  const lastRun = s.runs[0];
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: "easeOut" }}
      className="rounded-lg border border-border bg-panel p-4"
    >
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary">
          {s.cadence === "once" ? <ArrowUpRight size={18} /> : <Repeat size={18} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold text-foreground [font-variant-numeric:tabular-nums]">{s.amount} {s.token}</p>
            <span className="text-muted-foreground">→</span>
            <p className="truncate font-mono text-xs text-foreground">{s.domain ?? short(s.recipient)}</p>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {CADENCE_LABEL[s.cadence]}
            {s.status === "upcoming" && <> · next {whenLabel(s.nextRun)} ({new Date(s.nextRun).toLocaleString()})</>}
            {s.runs.length > 0 && <> · {s.runs.length} run{s.runs.length === 1 ? "" : "s"}</>}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge tone={s.status === "upcoming" ? "primary" : s.status === "completed" ? "success" : "neutral"}>{s.status}</Badge>
          {onCancel && (
            <Button variant="secondary" className="!px-2 !py-1.5 text-xs" onClick={onCancel} disabled={busy} title="Cancel schedule">
              <X size={13} />
            </Button>
          )}
        </div>
      </div>
      {lastRun?.explorerUrl && (
        <a href={lastRun.explorerUrl} target="_blank" rel="noreferrer" className="mt-2.5 inline-flex items-center gap-1.5 border-t border-border pt-2.5 font-mono text-xs text-primary hover:underline">
          Last run: {short(lastRun.txHash)} <ExternalLink size={11} />
        </a>
      )}
    </motion.div>
  );
}
