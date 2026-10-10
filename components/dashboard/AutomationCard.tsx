"use client";

/**
 * One automation, as the Automations page lists it: what it does, who it
 * pays, how often, its status, the next run, the last result, and the
 * actions valid for its state. Everything shown comes from the automation's
 * own recorded fields and runs — "Not run yet" until something has actually
 * run, never an invented success rate.
 *
 * Extracted from app/dashboard/automations/page.tsx so it can be tested with
 * fixtures (test/automation-card.test.ts); the page and its detail modal use
 * these exactly as before.
 */
import type { ReactNode } from "react";
import { Copy, Eye, Lock, Pause, Pencil, Play, SkipForward, Trash2, Wallet, X, Zap } from "lucide-react";
import { TokenLogo } from "@/components/TokenLogo";
import { StatusIndicator } from "@/components/dashboard/primitives";
import { findTemplate } from "@/lib/automation/templates";
import { cadenceLabel, money, short, type Automation, type Status } from "@/components/dashboard/automationShared";

/** Real per-recipient totals across every run this automation has fired,
 *  computed only from recorded recipientResults — never fabricated. */
export function bulkStats(a: Automation) {
  const allResults = a.runs.flatMap((r) => r.recipientResults ?? []);
  const successful = allResults.filter((r) => r.decision === "executed");
  const failed = allResults.filter((r) => r.decision !== "executed");
  const totalDistributed = successful.reduce((s, r) => s + r.amount, 0);
  const recipientCount = a.recipients?.length ?? 0;
  // "Remaining" only makes sense for a bounded (once / after_count / until_date)
  // schedule — an ongoing bulk payment has no fixed total to count down from.
  const remaining = a.cadence === "once" ? Math.max(0, recipientCount - successful.length) : null;
  return { recipientCount, successful: successful.length, failed: failed.length, totalDistributed, remaining };
}

export const STATUS_TONE: Record<Status, "neutral" | "success" | "warning" | "danger" | "primary"> = {
  active: "success", scheduled: "primary", executing: "primary", paused: "neutral", completed: "success", cancelled: "neutral", failed: "danger",
};

/**
 * A finer-grained status LABEL layered on top of the real persisted `status`
 * field, purely for display — never changes any gating logic elsewhere
 * (button visibility, execution eligibility, etc. all still key off the real
 * `status`). "Retrying" and "Waiting" are both derived from fields that
 * already exist and are real (failureCount, nextRun) — never a fabricated
 * state with no backing.
 *
 * "Refunding" / "Refunded" (Mini Sprint Part 1) are the same kind of derived
 * label, specific to Reserved Funds, driven by the EXPLICIT
 * reserveRefundStatus rather than just checking whether a tx hash is
 * present — "nothing owed" (the reservation was fully spent through
 * legitimate runs) and "something is owed and the refund hasn't landed" both
 * look identical if you only check for an empty txHash, and showing
 * "refunding" for the former would be a false alarm. reserveRefundStatus is
 * absent only on rows created before this field existed (never shown as
 * "refunding" — same "absence means predates this concept" rule as every
 * other optional field added after existing data).
 */
export function displayStatus(a: Automation): { label: string; tone: "neutral" | "success" | "warning" | "danger" | "primary" } {
  if (a.status === "active" && a.failureCount > 0) return { label: "retrying", tone: "warning" };
  if ((a.status === "active" || a.status === "scheduled") && a.nextRun > Date.now()) return { label: "waiting", tone: "primary" };
  const isTerminal = a.status === "cancelled" || a.status === "failed" || a.status === "completed";
  if (a.fundingMode === "reserved" && isTerminal && a.reserveRefundStatus) {
    if (a.reserveRefundStatus === "refunded") return { label: "refunded", tone: "success" };
    if (a.reserveRefundStatus === "pending") return { label: "refunding", tone: "neutral" };
    // "none" — nothing was ever owed back, fall through to the plain status label.
  }
  return { label: a.status, tone: STATUS_TONE[a.status] };
}

const fmt = (ts: number) => new Date(ts).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** A real, usable next-run time — a missing or invalid one is not shown as a date. */
export function hasNextRun(a: Pick<Automation, "nextRun">): boolean {
  return typeof a.nextRun === "number" && Number.isFinite(a.nextRun) && a.nextRun > 0;
}

/** The newest recorded run, in words — or "Not run yet" when there is none. */
export function lastResult(a: Pick<Automation, "runs">): { label: string; tone: string } {
  const last = a.runs[0]; // newest first (schedules.ts prepends each run)
  if (!last) return { label: "Not run yet", tone: "text-muted-foreground" };
  const word = last.decision === "executed" ? "Sent" : last.decision === "partial" ? "Partly sent" : last.decision === "needs_review" ? "Needs review" : last.decision === "blocked" ? "Blocked" : "Failed";
  const tone = last.decision === "executed" ? "text-foreground" : last.decision === "partial" || last.decision === "needs_review" ? "text-warning" : "text-danger";
  return { label: `${word} · ${new Date(last.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`, tone };
}

export function AutomationCard({ automation, busy, onAction, onView, onEdit, onDuplicate }: {
  automation: Automation; busy: boolean;
  onAction: (id: string, action: "pause" | "resume" | "cancel" | "delete" | "skip_next" | "execute_now") => void;
  onView: () => void; onEdit: () => void; onDuplicate: () => void;
}) {
  const template = automation.templateId ? findTemplate(automation.templateId) : undefined;
  const isBulk = !!automation.recipients?.length;
  const bulk = isBulk ? bulkStats(automation) : null;
  const status = displayStatus(automation);
  const live = automation.status === "active" || automation.status === "scheduled" || automation.status === "executing";
  // Completed and cancelled automations can only be inspected, duplicated or
  // deleted — no edit, pause, resume, run-now, skip or cancel.
  const finished = automation.status === "completed" || automation.status === "cancelled";
  const last = lastResult(automation);
  const nextRun = hasNextRun(automation) ? fmt(automation.nextRun) : null;
  return (
    <div className="rounded-lg border border-border bg-panel">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 pt-4">
        <div className="min-w-0 flex-1 basis-56">
          <p className="break-words text-sm font-semibold text-foreground">{automation.purpose ?? automation.memo ?? "Automation"}</p>
          <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-1.5 text-foreground"><TokenLogo token={automation.token} size={13} /> {money(automation.amount, automation.token)}{isBulk && " total"}</span>
            <span>→</span>
            <span className={`min-w-0 break-all ${isBulk || automation.domain ? "" : "font-mono text-xs"}`}>{isBulk && bulk ? `${bulk.recipientCount} recipients` : automation.domain ?? short(automation.recipient)}</span>
            <span aria-hidden>·</span>
            <span>{cadenceLabel(automation)}</span>
          </p>
          {template && <p className="mt-1 text-xs text-muted-foreground/80">From the {template.name} template</p>}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <StatusIndicator tone={status.tone === "primary" ? "neutral" : status.tone} label={status.label.charAt(0).toUpperCase() + status.label.slice(1)} />
          {automation.fundingMode && (
            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
              {automation.fundingMode === "reserved" ? <><Lock size={10} /> Reserved funds</> : <><Wallet size={10} /> From your wallet</>}
            </span>
          )}
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 px-4 text-xs sm:grid-cols-3">
        <div className="min-w-0">
          <dt className="text-muted-foreground">Next run</dt>
          <dd className="mt-0.5 truncate tabular-nums text-foreground">{!live ? "—" : nextRun ?? "Not scheduled"}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-muted-foreground">Last result</dt>
          <dd className={`mt-0.5 truncate ${last.tone}`}>{last.label}</dd>
        </div>
        {isBulk && bulk && (
          <div className="min-w-0">
            <dt className="text-muted-foreground">Paid / failed</dt>
            <dd className="mt-0.5 truncate tabular-nums text-foreground">{bulk.successful} / {bulk.failed}{bulk.remaining != null ? ` · ${bulk.remaining} left` : ""}</dd>
          </div>
        )}
      </dl>
      {automation.lastError && (automation.status === "failed" || automation.failureCount > 0) && (
        <p className="mx-4 mt-3 rounded-md border border-danger/30 px-3 py-2 text-xs text-danger">{automation.lastError}</p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-1 border-t border-border px-2 py-1.5">
        <button type="button" onClick={onView} disabled={busy} className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-input disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><Eye size={13} /> Details</button>
        {!isBulk && !finished && <button type="button" onClick={onEdit} disabled={busy} className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-input disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><Pencil size={13} /> Edit</button>}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-0.5">
          {finished ? null : automation.status === "paused" || automation.status === "failed" ? (
            <IconAction label="Resume" onClick={() => onAction(automation.id, "resume")} disabled={busy}><Play size={14} /></IconAction>
          ) : (
            <IconAction label="Pause" onClick={() => onAction(automation.id, "pause")} disabled={busy}><Pause size={14} /></IconAction>
          )}
          {(automation.status === "active" || automation.status === "scheduled") && (
            <>
              <IconAction label="Execute Now" onClick={() => onAction(automation.id, "execute_now")} disabled={busy}><Zap size={14} /></IconAction>
              <IconAction label="Skip Next" onClick={() => onAction(automation.id, "skip_next")} disabled={busy}><SkipForward size={14} /></IconAction>
            </>
          )}
          <IconAction label={isBulk ? "Duplicate (not supported for bulk payments yet)" : "Duplicate"} onClick={onDuplicate} disabled={busy || isBulk}><Copy size={14} /></IconAction>
          {!finished && <IconAction label="Cancel" onClick={() => onAction(automation.id, "cancel")} disabled={busy}><X size={14} /></IconAction>}
          <IconAction label="Delete" danger onClick={() => onAction(automation.id, "delete")} disabled={busy}><Trash2 size={14} /></IconAction>
        </div>
      </div>
    </div>
  );
}

function IconAction({ label, onClick, disabled, danger, children }: { label: string; onClick: () => void; disabled?: boolean; danger?: boolean; children: ReactNode }) {
  return (
    <button type="button" title={label} aria-label={label} onClick={onClick} disabled={disabled}
      className={`rounded-lg p-2 transition-colors disabled:opacity-40 ${danger ? "text-muted-foreground hover:bg-danger/10 hover:text-danger" : "text-muted-foreground hover:bg-input hover:text-foreground"}`}>
      {children}
    </button>
  );
}
