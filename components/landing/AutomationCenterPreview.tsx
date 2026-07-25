"use client";

import { motion } from "motion/react";
import { Wallet, Lock, Users, Repeat, Building2 } from "lucide-react";
import { Badge } from "@/components/ui";

/**
 * The hero visual for the "PayAI is a payment automation platform" reposition —
 * a real product screenshot of the Automation Center (same card language, same
 * status tones, as app/dashboard/automations/page.tsx), not concept art or an
 * illustration. Static, deliberately: this sells "automations run themselves,"
 * not "watch a carousel."
 */
const ROWS = [
  { title: "Monthly Payroll", status: "Active" as const, tone: "success" as const, detail: "Next Execution: Friday 10:00 UTC", mode: "Wallet Automation", icon: Wallet },
  { title: "Treasury Distribution", status: "Scheduled" as const, tone: "primary" as const, detail: "Tomorrow", mode: "Reserved Funds", icon: Lock },
  { title: "Community Rewards", status: "Executing" as const, tone: "warning" as const, detail: "250 Recipients", mode: null, icon: Users },
  { title: "Monthly Rent", status: "Active" as const, tone: "success" as const, detail: "1st of Every Month", mode: "Wallet Automation", icon: Repeat },
];

export function AutomationCenterPreview() {
  return (
    <motion.div
      whileHover={{ y: -4 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className="relative overflow-hidden rounded-2xl border border-border bg-panel/70 shadow-2xl shadow-black/20 backdrop-blur-xl"
    >
      {/* Ambient top glow — soft depth, not decoration */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-primary/10 to-transparent" />

      <div className="relative flex items-center justify-between border-b border-border px-5 py-4">
        <div className="flex items-center gap-2">
          <Building2 size={15} className="text-primary" />
          <p className="text-sm font-semibold text-foreground">Automation Center</p>
        </div>
        <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
          </span>
          Live
        </span>
      </div>

      <div className="divide-y divide-border">
        {ROWS.map((r, i) => (
          <motion.div
            key={r.title}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: i * 0.08, duration: 0.35, ease: "easeOut" }}
            className="flex items-center gap-3 px-5 py-4"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <r.icon size={15} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground">{r.title}</p>
              <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
                <span>{r.detail}</span>
                {r.mode && (
                  <>
                    <span className="text-muted-foreground/40">·</span>
                    <span>{r.mode}</span>
                  </>
                )}
              </div>
            </div>
            <Badge tone={r.tone}>
              {r.status === "Executing" && (
                <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current align-middle" />
              )}
              {r.status}
            </Badge>
          </motion.div>
        ))}
      </div>
    </motion.div>
  );
}
