"use client";

import { motion } from "motion/react";

export type StepState = "pending" | "active" | "ok" | "warn" | "blocked";

export interface PipelineStep {
  key: string;
  label: string;
  state: StepState;
  detail?: string;
}

const DOT_CLASS: Record<StepState, string> = {
  pending: "bg-border text-muted-foreground",
  active: "bg-primary text-primary-foreground",
  ok: "bg-success text-primary-foreground",
  warn: "bg-warning text-primary-foreground",
  blocked: "bg-danger text-primary-foreground",
};

const LINE_CLASS: Record<StepState, string> = {
  pending: "bg-border",
  active: "bg-primary",
  ok: "bg-success",
  warn: "bg-warning",
  blocked: "bg-danger",
};

/**
 * Reusable verification pipeline — the single visual the whole product reuses
 * to show what the agent verified before money moved. This is the trust
 * artifact, not a decorative diagram: it must render in an honest idle state
 * before any request, then animate stage-by-stage as the backend resolves.
 */
export function PipelineStepper({ steps }: { steps: PipelineStep[] }) {
  return (
    <ol className="flex flex-col gap-0">
      {steps.map((step, i) => {
        const isLast = i === steps.length - 1;
        return (
          <li key={step.key} className="flex gap-3">
            <div className="flex flex-col items-center">
              <motion.span
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${DOT_CLASS[step.state]}`}
                initial={false}
                animate={{ scale: step.state === "active" ? [1, 1.12, 1] : 1 }}
                transition={{ duration: 0.6, repeat: step.state === "active" ? Infinity : 0 }}
              >
                {step.state === "ok" ? "✓" : step.state === "blocked" ? "✕" : step.state === "warn" ? "!" : i + 1}
              </motion.span>
              {!isLast && (
                <div className="relative h-8 w-px overflow-hidden bg-border">
                  <motion.div
                    className={`absolute inset-x-0 top-0 w-px ${LINE_CLASS[step.state]}`}
                    initial={{ height: 0 }}
                    animate={{ height: step.state === "pending" ? 0 : "100%" }}
                    transition={{ duration: 0.35, ease: "easeOut" }}
                  />
                </div>
              )}
            </div>
            <div className={`pb-6 ${isLast ? "pb-0" : ""}`}>
              <p className={`text-sm font-medium ${step.state === "pending" ? "text-muted-foreground" : "text-foreground"}`}>
                {step.label}
              </p>
              {step.detail && (
                <motion.p
                  initial={{ opacity: 0, y: -2 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.25 }}
                  className="mt-0.5 text-xs text-muted-foreground"
                >
                  {step.detail}
                </motion.p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
