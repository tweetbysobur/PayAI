"use client";

import { motion } from "motion/react";

const LEVEL_COLOR: Record<string, string> = {
  low: "var(--color-success)",
  medium: "var(--color-warning)",
  high: "var(--color-danger)",
};

/** Radial risk gauge — replaces a bare number with a glanceable proof of scoring. */
export function RiskGauge({ score, level }: { score: number; level: string }) {
  const r = 30;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, score)) / 100;
  const color = LEVEL_COLOR[level] ?? "var(--color-muted-foreground)";

  return (
    <div className="flex items-center gap-4">
      <div className="relative h-[72px] w-[72px] shrink-0">
        <svg width="72" height="72" viewBox="0 0 72 72" className="-rotate-90">
          <circle cx="36" cy="36" r={r} fill="none" stroke="var(--color-border)" strokeWidth="6" />
          <motion.circle
            cx="36" cy="36" r={r} fill="none" stroke={color} strokeWidth="6" strokeLinecap="round"
            strokeDasharray={c}
            initial={{ strokeDashoffset: c }}
            animate={{ strokeDashoffset: c - c * pct }}
            transition={{ duration: 0.6, ease: "easeOut" }}
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-lg font-semibold text-foreground">{score}</span>
          <span className="text-[10px] text-muted-foreground">/ 100</span>
        </div>
      </div>
      <div>
        <p className="text-sm font-medium capitalize text-foreground">{level} risk</p>
        <p className="text-xs text-muted-foreground">Scored by VeriGate</p>
      </div>
    </div>
  );
}
