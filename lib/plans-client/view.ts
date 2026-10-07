/**
 * What the Plans screen shows for a run, derived ONLY from the runner's
 * outcome and its classification (./outcomes.ts). Pure; no React.
 *
 * The rules the screen must never break, decided here so they are testable:
 *   - "Resume" is offered only when the classification says running again is
 *     safe: never when a transaction may be in flight or unrecorded
 *     (check_wallet_activity, UNKNOWN_TRANSACTION_STATE, DO_NOT_RETRY), never
 *     when running again can't help (terminal), never after completion.
 *   - "Start a new plan" is offered only when the classifier says new_plan —
 *     which it never does once any step has a live transaction (5C-2h).
 *   - Nothing here retries on its own; the user presses Resume, and the
 *     runner (lock, journal, signing intent) decides what happens next.
 */
import type { OutcomeAction, OutcomeClass } from "./outcomes";
import type { PlanViewDTO, RunnerPhase, RunOutcome } from "./runner";

export type ViewTone = "success" | "warning" | "danger" | "neutral";

export interface OutcomeView {
  planId: string;
  tone: ViewTone;
  title: string;
  /** The runner's own message for this outcome. */
  message: string;
  /** What the user should do, in words. */
  advice: string | null;
  /** Running the plan again is safe and may help. */
  canResume: boolean;
  /** Only when the classifier recommends a fresh plan. */
  showNewPlan: boolean;
  /** A transaction may exist: the user must check their wallet first. */
  checkWallet: boolean;
  /** The final transaction, when one is known (safe to show; it's public). */
  txHash: string | null;
  completed: boolean;
}

/** Actions after which pressing Resume is a reasonable next step. Everything
 *  else (check_wallet_activity, new_plan, contact_support, use_other_tab,
 *  unsupported_browser, fix_storage) is not. */
const RESUMABLE_ACTIONS: ReadonlySet<OutcomeAction> = new Set<OutcomeAction>([
  "none", "wait", "review_again", "reconnect_grant", "unlock_wallet", "switch_wallet", "switch_network", "approve_plan", "wait_for_approval",
]);

const ADVICE: Readonly<Record<OutcomeAction, string | null>> = {
  none: null,
  wait: "Wait a moment, then resume.",
  use_other_tab: "This plan is running in another tab or window. Finish it there.",
  unsupported_browser: "This browser can't run plans safely. Try an up-to-date browser.",
  reconnect_grant: "Unlock your wallet for PayAI, then resume.",
  unlock_wallet: "Connect or unlock your wallet, then resume.",
  switch_wallet: "Switch to the wallet this plan belongs to, then resume.",
  switch_network: "Switch your wallet to Monad, then resume.",
  approve_plan: "Approve the plan first.",
  fix_storage: "This browser can't keep a record of sent transactions (private mode or blocked storage). Use a normal window.",
  review_again: "Resume to get a fresh quote and review it again.",
  wait_for_approval: "Wait for the approval to confirm, then resume.",
  check_wallet_activity: "Check your wallet's activity before doing anything else. Don't send it again.",
  new_plan: "This plan can't continue. You can start a new plan.",
  contact_support: "This needs a closer look — contact PayAI support with the plan id.",
};

/** The final transaction was sent and PayAI hasn't recorded it. */
const SENT_NOT_RECORDED: ReadonlySet<OutcomeClass["tx"]> = new Set<OutcomeClass["tx"]>(["journaled", "sent_unrecorded", "uncertain"]);

export function describeOutcome(r: { outcome: RunOutcome; cls: OutcomeClass }): OutcomeView {
  const { outcome, cls } = r;
  const completed = cls.kind === "completed";
  // Stricter than the classifier on purpose: a journaled tx_unrecorded is
  // "safe to resume in this browser" there (replaying the journal records
  // the same hash and never re-sends), but the screen still asks the user to
  // check their wallet first rather than offering a one-click retry. Opening
  // the plan again later runs the same journal replay.
  const checkWallet = cls.action === "check_wallet_activity" || cls.retry === "UNKNOWN_TRANSACTION_STATE" || SENT_NOT_RECORDED.has(cls.tx);
  const canResume = !completed
    && !checkWallet
    && !cls.terminal
    && cls.resumeScope !== "none"
    && (cls.retry === "SAFE_TO_RETRY" || cls.retry === "SAFE_TO_RESUME" || cls.retry === "USER_ACTION_REQUIRED")
    && RESUMABLE_ACTIONS.has(cls.action);
  const tone: ViewTone = completed ? "success"
    : checkWallet ? "warning"
    : cls.retry === "DO_NOT_RETRY" ? "danger"
    : "neutral";
  const title = completed ? "Plan complete"
    : checkWallet ? "Check your wallet's activity"
    : cls.action === "new_plan" ? "This plan can't continue"
    : canResume ? "Paused"
    : "Stopped";
  return {
    planId: outcome.planId,
    tone, title,
    message: outcome.message,
    advice: completed ? null : ADVICE[cls.action],
    canResume,
    showNewPlan: !completed && cls.action === "new_plan",
    checkWallet,
    txHash: cls.txHash,
    completed,
  };
}

export function phaseLabel(phase: RunnerPhase): string {
  switch (phase) {
    case "quoting": return "Getting a quote…";
    case "binding": return "Checking the quote…";
    case "waiting_for_quote_review": return "Review the quote";
    case "building": return "Preparing the transaction…";
    case "waiting_for_wallet": return "Confirm in your wallet";
    case "waiting_for_receipt": return "Waiting for the network…";
    case "recording": return "Recording the transaction…";
    case "confirming": return "Verifying on-chain…";
    case "settling": return "Settling…";
    case "polling": return "Waiting for confirmation…";
    case "completed": return "Done";
    case "failed": return "Stopped";
  }
}

/** Approve is offered only for a plan the server says can be approved and
 *  whose every step its review describes faithfully. */
export function canApprove(plan: Pick<PlanViewDTO, "approvable" | "approved" | "abandoned" | "expired">, review: { reviewable: boolean } | null): boolean {
  return !!review && review.reviewable === true && plan.approvable === true && !plan.approved && !plan.abandoned && !plan.expired;
}

/**
 * Whether the screen offers Run (or Resume). Never while a run is active,
 * never for a plan that can't run, and — after an outcome in this session —
 * only when that outcome allows resuming. A plan opened fresh can always be
 * run: the runner itself refuses to sign again when a signature is
 * unresolved or a sent transaction is journaled.
 */
export function canStartRun(
  plan: Pick<PlanViewDTO, "planId" | "approved" | "abandoned" | "expired" | "state">,
  running: boolean,
  last: OutcomeView | null,
): boolean {
  if (running) return false;
  if (!plan.approved || plan.abandoned || plan.expired || plan.state === "completed") return false;
  if (last && last.planId === plan.planId) return last.canResume;
  return true;
}
