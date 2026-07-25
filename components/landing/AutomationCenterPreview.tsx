"use client";

import { motion, useReducedMotion } from "motion/react";
import { Wallet, Lock, Users, Building2, Repeat, Receipt } from "lucide-react";

/**
 * The hero visual for the "PayAI is the Payment Automation Layer on Monad"
 * positioning — a product screenshot of the Automation Center, not concept
 * art. The product is the artwork: same card language, same row anatomy, and
 * the same execution-state colors as app/dashboard/automations/page.tsx.
 *
 * Status is carried by an icon-adjacent colored dot + a text label, never by
 * color alone — the same rule the dashboard follows, so a colorblind visitor
 * still reads "Executing" vs "Completed" from the words.
 *
 * Every row here is a shape the engine genuinely supports today (recurring
 * wallet-funded payroll, a reserved-funds treasury payout, a bulk
 * distribution with per-recipient progress, a completed vendor run, a
 * scheduled subscription renewal). Nothing shown is a capability PayAI
 * doesn't have.
 *
 * ── Swapping in future assets ────────────────────────────────────────────
 * ROWS is the single source of content for this preview. To replace it with
 * a real captured screenshot later, render an <Image> in place of the
 * <div className="divide-y"> block and keep the chrome above it — the
 * header, glow, and frame are independent of the row data.
 */

type ExecState = "executing" | "scheduled" | "active" | "completed";

/** Execution state → the scoped exec-* tokens from globals.css. Purple stays
 *  dominant: these tint a 6px dot and a hairline badge, nothing larger. */
const STATE: Record<ExecState, { label: string; dot: string; text: string; ring: string; pulse: boolean }> = {
  executing: { label: "Executing", dot: "bg-info", text: "text-info", ring: "border-info/30 bg-info/10", pulse: true },
  scheduled: { label: "Scheduled", dot: "bg-exec-scheduled", text: "text-exec-scheduled", ring: "border-exec-scheduled/30 bg-exec-scheduled/10", pulse: false },
  active: { label: "Active", dot: "bg-exec-success", text: "text-exec-success", ring: "border-exec-success/30 bg-exec-success/10", pulse: false },
  completed: { label: "Completed", dot: "bg-exec-success", text: "text-exec-success", ring: "border-exec-success/30 bg-exec-success/10", pulse: false },
};

interface Row {
  title: string;
  state: ExecState;
  detail: string;
  mode: string | null;
  icon: typeof Wallet;
  /** Bulk distributions only — drives the completed/total progress bar. */
  progress?: { done: number; total: number };
}

const ROWS: Row[] = [
  { title: "Monthly Payroll", state: "executing", detail: "Friday 10:00 UTC", mode: "Wallet Automation", icon: Wallet },
  { title: "Treasury Distribution", state: "scheduled", detail: "Tomorrow", mode: "Reserved Funds", icon: Lock },
  { title: "Community Rewards", state: "executing", detail: "248 / 250 completed", mode: "Bulk Payment", icon: Users, progress: { done: 248, total: 250 } },
  { title: "Vendor Payments", state: "completed", detail: "Settled on Monad", mode: "Wallet Automation", icon: Receipt },
  { title: "Subscription Renewal", state: "active", detail: "Next run 1 August", mode: "Wallet Automation", icon: Repeat },
];

export function AutomationCenterPreview() {
  const reduce = useReducedMotion();

  return (
    <motion.div
      whileHover={reduce ? undefined : { y: -4 }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      className="relative overflow-hidden rounded-2xl border border-border/80 bg-panel/70 shadow-2xl shadow-black/40 backdrop-blur-xl"
    >
      {/* Ambient top glow — depth, not decoration. */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-primary/10 to-transparent" />
      {/* Hairline highlight along the top edge, the glass-surface tell. */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />

      <div className="relative flex items-center justify-between border-b border-border/80 px-5 py-4 sm:px-6">
        <div className="flex items-center gap-2">
          <Building2 size={15} className="text-primary-ink" />
          <p className="text-sm font-semibold tracking-tight text-foreground">Automation Center</p>
        </div>
        <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <span className="relative flex h-2 w-2">
            {!reduce && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60" />}
            <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
          </span>
          Live
        </span>
      </div>

      <div className="divide-y divide-border/70">
        {ROWS.map((r, i) => {
          const s = STATE[r.state];
          const pct = r.progress ? Math.round((r.progress.done / r.progress.total) * 100) : null;
          return (
            <motion.div
              key={r.title}
              initial={reduce ? undefined : { opacity: 0, y: 6 }}
              animate={reduce ? undefined : { opacity: 1, y: 0 }}
              transition={{ delay: 0.1 + i * 0.07, duration: 0.4, ease: "easeOut" }}
              className="group flex items-center gap-3 px-5 py-4 transition-colors duration-200 hover:bg-white/[0.02] sm:gap-3.5 sm:px-6"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-primary/15 bg-primary/10 text-primary-ink transition-colors duration-200 group-hover:border-primary/30">
                <r.icon size={15} />
              </span>

              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium tracking-tight text-foreground">{r.title}</p>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
                  <span className="truncate">{r.detail}</span>
                  {r.mode && (
                    <>
                      <span aria-hidden className="text-muted-foreground/40">·</span>
                      <span className="truncate">{r.mode}</span>
                    </>
                  )}
                </div>
                {pct != null && (
                  <div className="mt-2 h-1 w-full max-w-[190px] overflow-hidden rounded-full bg-border/70">
                    <motion.div
                      className="h-full rounded-full bg-info"
                      initial={reduce ? { width: `${pct}%` } : { width: 0 }}
                      animate={{ width: `${pct}%` }}
                      transition={{ delay: 0.45, duration: 0.9, ease: "easeOut" }}
                    />
                  </div>
                )}
              </div>

              {/* Dot + label: state is never color-alone. */}
              <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${s.ring} ${s.text}`}>
                <span className="relative flex h-1.5 w-1.5">
                  {s.pulse && !reduce && <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${s.dot} opacity-70`} />}
                  <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${s.dot}`} />
                </span>
                {s.label}
              </span>
            </motion.div>
          );
        })}
      </div>
    </motion.div>
  );
}
