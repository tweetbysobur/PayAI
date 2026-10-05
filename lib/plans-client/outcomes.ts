/**
 * Run outcome classification (Phase 2C, Stage 5C-2c): what a finished run
 * means for the user's money and for what may safely happen next.
 *
 *   classifyOutcome(outcome)  → OutcomeClass
 *   classifyRunError(error)   → OutcomeClass  (run() rejected: always unknown)
 *
 *   runner → RunOutcome → classifyOutcome (here) → UI presentation (later)
 *
 * Machine-readable only: no copy is produced here, and the runner's
 * `message` is never read. Classification keys on `kind` and `code`, plus
 * the facts the outcome carries (txHash, journaled, approval hashes).
 *
 * Re-running a plan always re-reads the server and this browser's journal
 * first, so a transaction either of them holds is reconciled, never signed
 * again ("resume"). The danger is a transaction that may exist but that
 * neither holds — that is never classified as safe to retry.
 *
 * Hard invariant (enforced at the end, whatever the table says): an outcome
 * carrying a transaction hash, or whose transaction state is anything but
 * "none"/"approvals_only", is NEVER SAFE_TO_RETRY. Anything unrecognised
 * fails closed to UNKNOWN_TRANSACTION_STATE.
 *
 * Pure: no I/O, no globals.
 */
import { HASH_RE } from "./journal";
import type { RunOutcome, RunOutcomeKind } from "./runner";

export type OutcomeCategory =
  | "success" | "lock" | "wallet" | "quote" | "build" | "execution"
  | "settlement" | "recovery" | "storage" | "plan" | "network" | "internal";

/** What is known about the step's final transaction. */
export type OutcomeTxState =
  /** No final transaction from this run (nor approvals). */
  | "none"
  /** Only approval transactions were (or may have been) sent. */
  | "approvals_only"
  /** A final transaction may have been sent; nothing reliable records it. */
  | "uncertain"
  /** A final transaction was sent but neither journaled nor recorded. */
  | "sent_unrecorded"
  /** Sent and saved in this browser's journal, not yet recorded by PayAI. */
  | "journaled"
  /** Recorded by PayAI. */
  | "recorded";

export type OutcomeRetry =
  | "SAFE_TO_RETRY"
  | "SAFE_TO_RESUME"
  | "USER_ACTION_REQUIRED"
  | "DO_NOT_RETRY"
  | "UNKNOWN_TRANSACTION_STATE";

export type OutcomeAction =
  | "none" | "wait" | "use_other_tab" | "unsupported_browser" | "reconnect_grant"
  | "unlock_wallet" | "switch_wallet" | "switch_network" | "approve_plan" | "fix_storage"
  | "review_again" | "wait_for_approval" | "check_wallet_activity" | "new_plan" | "contact_support";

export interface OutcomeClass {
  kind: RunOutcomeKind;
  code: string | null;
  category: OutcomeCategory;
  tx: OutcomeTxState;
  /** The final transaction's hash — only when well formed. */
  txHash: string | null;
  retry: OutcomeRetry;
  action: OutcomeAction;
  /** Where running the plan again is safe: anywhere, only in this browser
   *  (its journal holds the evidence), or nowhere until the user has checked. */
  resumeScope: "any" | "this_browser" | "none";
  /** True when running again can't make progress without something else changing. */
  terminal: boolean;
}

/** Every outcome kind's category. A Record, so a new kind fails to compile here. */
export const KIND_CATEGORY: Readonly<Record<RunOutcomeKind, OutcomeCategory>> = {
  completed: "success",
  already_running: "lock",
  lock_unavailable: "lock",
  signature_unresolved: "recovery",
  aborted: "execution",
  grant_required: "wallet",
  wallet_mismatch: "wallet",
  wrong_network: "wallet",
  wallet_locked: "wallet",
  journal_unavailable: "storage",
  not_approved: "plan",
  expired: "plan",
  abandoned: "plan",
  not_found: "plan",
  step_not_ready: "plan",
  quote_refused: "quote",
  conflict: "execution",
  bind_failed: "quote",
  quote_declined: "quote",
  build_refused: "build",
  build_invalid: "build",
  wallet_rejected: "wallet",
  wallet_error: "wallet",
  approval_failed: "wallet",
  tx_unrecorded: "recovery",
  confirm_rejected: "settlement",
  reverted: "settlement",
  unverified: "settlement",
  stalled: "settlement",
  rate_limited: "network",
  unavailable: "network",
  server_error: "network",
  plan_error: "plan",
  invalid_response: "internal",
  network_error: "network",
};

/** Kinds the runner produces from a Plan API failure — also while settling a
 *  step whose transaction is already recorded (then they carry its hash). */
const PLAN_FAILURE_KINDS: ReadonlySet<RunOutcomeKind> = new Set<RunOutcomeKind>([
  "network_error", "grant_required", "rate_limited", "expired", "not_approved", "step_not_ready",
  "quote_refused", "conflict", "not_found", "unavailable", "server_error", "plan_error",
]);

/** Plan failures that are permanent for a sent-but-unrecorded transaction
 *  (Stage 5C-2f): the plan can't record it any more. Exactly these. */
const PERMANENT_PLAN_CODES: ReadonlySet<string> = new Set(["EXPIRED", "NOT_FOUND", "INVALID_PLAN", "INVALID_NODE", "CORRUPT"]);

type Shape = Omit<OutcomeClass, "kind" | "code" | "txHash">;

const UNKNOWN: Shape = {
  category: "internal", tx: "uncertain", retry: "UNKNOWN_TRANSACTION_STATE",
  action: "check_wallet_activity", resumeScope: "none", terminal: true,
};

const has = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);

export function classifyOutcome(outcome: RunOutcome): OutcomeClass {
  if (outcome === null || typeof outcome !== "object" || typeof outcome.kind !== "string" || !has(KIND_CATEGORY, outcome.kind)) {
    return { kind: "invalid_response", code: "MALFORMED_OUTCOME", txHash: null, ...UNKNOWN };
  }
  const kind = outcome.kind;
  const rawCode = typeof outcome.code === "string" ? outcome.code : null;
  // A wallet mismatch on the server is reported exactly like a missing plan.
  const code = kind === "not_found" && rawCode === "WALLET_MISMATCH" ? "NOT_FOUND" : rawCode;
  const rawHash: unknown = outcome.txHash;
  const hasHash = rawHash !== null && rawHash !== undefined;
  const txHash = typeof rawHash === "string" && HASH_RE.test(rawHash) ? rawHash : null;
  const approvals = Array.isArray(outcome.approvalTxHashes) && outcome.approvalTxHashes.length > 0;

  const shape = classify(kind, code, outcome, hasHash, approvals);
  return { kind, code, txHash, ...enforce(shape, hasHash) };
}

/** run() rejected instead of returning an outcome: nothing is known. */
export function classifyRunError(error: unknown): OutcomeClass {
  void error; // never inspected or exposed
  return { kind: "invalid_response", code: "RUN_ERROR", txHash: null, ...UNKNOWN };
}

/** The hard invariant, applied last: a fresh retry only with no transaction at stake. */
function enforce(s: Shape, hasHash: boolean): Shape {
  if (s.retry !== "SAFE_TO_RETRY") return s;
  if (!hasHash && (s.tx === "none" || s.tx === "approvals_only")) return s;
  return { ...UNKNOWN, category: s.category };
}

function classify(kind: RunOutcomeKind, code: string | null, o: RunOutcome, hasHash: boolean, approvals: boolean): Shape {
  const category = KIND_CATEGORY[kind];
  const before: OutcomeTxState = approvals ? "approvals_only" : "none";
  const make = (retry: OutcomeRetry, action: OutcomeAction, s: Partial<Shape> = {}): Shape => ({
    category, tx: before, retry, action,
    resumeScope: retry === "DO_NOT_RETRY" || retry === "UNKNOWN_TRANSACTION_STATE" ? "none" : "any",
    terminal: retry === "DO_NOT_RETRY" || retry === "UNKNOWN_TRANSACTION_STATE",
    ...s,
  });

  // A recorded journal conflict: two transactions for one step.
  if (kind === "conflict" && code === "JOURNAL_CONFLICT") {
    return make("UNKNOWN_TRANSACTION_STATE", "check_wallet_activity", { category: "recovery", tx: "uncertain" });
  }
  // A Plan API failure while settling a step PayAI has already recorded:
  // re-running settles it — never signs it again.
  if (hasHash && PLAN_FAILURE_KINDS.has(kind)) {
    const action: OutcomeAction =
      kind === "grant_required" ? "reconnect_grant"
      : kind === "network_error" || kind === "rate_limited" || kind === "unavailable" || kind === "server_error" ? "wait"
      : "contact_support";
    return make("SAFE_TO_RESUME", action, { category: "settlement", tx: "recorded" });
  }

  switch (kind) {
    case "completed":
      return make("DO_NOT_RETRY", "none", { tx: "recorded" });

    case "already_running":
      return code === "LOCK_HELD"
        ? make("USER_ACTION_REQUIRED", "use_other_tab", { resumeScope: "none" })
        : make("USER_ACTION_REQUIRED", "wait", { resumeScope: "none" });
    case "lock_unavailable":
      return make("DO_NOT_RETRY", "unsupported_browser");

    case "signature_unresolved":
      // A final signature may have been sent and nothing records it. The
      // server refuses new quotes until it's recorded or released.
      return make("UNKNOWN_TRANSACTION_STATE", "check_wallet_activity", { tx: "uncertain" });

    case "aborted":
      // With a hash: stopped while settling a recorded step. Without: every
      // abort point is before the final signature.
      return hasHash
        ? make("SAFE_TO_RESUME", "none", { category: "settlement", tx: "recorded" })
        : make("SAFE_TO_RETRY", "none");

    case "grant_required": return make("USER_ACTION_REQUIRED", "reconnect_grant");
    case "wallet_locked": return make("USER_ACTION_REQUIRED", "unlock_wallet");
    case "wallet_mismatch": return make("USER_ACTION_REQUIRED", "switch_wallet");
    case "wrong_network": return make("USER_ACTION_REQUIRED", "switch_network");

    case "journal_unavailable":
      // The journal can't be read, so a sent-but-unrecorded transaction can't be ruled out.
      return make("USER_ACTION_REQUIRED", "fix_storage", { tx: "uncertain", resumeScope: "this_browser" });

    case "not_approved": return make("USER_ACTION_REQUIRED", "approve_plan");
    case "expired":
    case "not_found":
      // Stage 5C-2g: once a plan expires (or can't be found) its facts are
      // gone, so a transaction sent for it can no longer be ruled out — never
      // suggest a new plan, which could pay twice. Check the wallet first.
      return make("DO_NOT_RETRY", "check_wallet_activity");
    case "abandoned":
    case "quote_refused":
      return make("DO_NOT_RETRY", "new_plan");
    case "step_not_ready": return make("SAFE_TO_RETRY", "wait");

    case "conflict":
      if (code === "TX_ALREADY_RECORDED") return make("SAFE_TO_RESUME", "none", { tx: "recorded" });
      // Re-quoted or changed elsewhere: another device may be signing this step.
      return make("USER_ACTION_REQUIRED", "check_wallet_activity", { resumeScope: "none" });

    case "bind_failed": return make("SAFE_TO_RETRY", "review_again");
    case "quote_declined": return make("SAFE_TO_RETRY", "review_again");

    case "build_refused":
      switch (code) {
        case "QUOTE_STALE": case "QUOTE_CHANGED": case "FEE_TERMS_CHANGED": case "QUOTE_REQUIRED":
          return make("SAFE_TO_RETRY", "review_again");
        case "ALREADY_BUILT": // built elsewhere: another tab or device may be signing it
          return make("USER_ACTION_REQUIRED", "check_wallet_activity", { resumeScope: "none" });
        case "POLICY_BLOCKED": case "TARGET_NOT_ALLOWLISTED": case "INVALID_INPUT":
          return make("DO_NOT_RETRY", "new_plan");
        default:
          return make("DO_NOT_RETRY", "contact_support");
      }
    case "build_invalid": return make("DO_NOT_RETRY", "contact_support");

    case "wallet_rejected":
      if (code === "REJECTED_CODE") return make("SAFE_TO_RETRY", "none");
      // Only the wording said "rejected": not proof that nothing was sent.
      return make("USER_ACTION_REQUIRED", "check_wallet_activity", { tx: "uncertain", resumeScope: "none" });
    case "wallet_error":
      if (code === "APPROVAL_SEND_FAILED" || code === "APPROVAL_HASH_INVALID") {
        // The final action was never signed; an approval may have been sent.
        return make("USER_ACTION_REQUIRED", "check_wallet_activity", { tx: "approvals_only" });
      }
      // The final action may have been broadcast, and nothing records it.
      return make("UNKNOWN_TRANSACTION_STATE", "check_wallet_activity", { category: "execution", tx: "uncertain" });
    case "approval_failed":
      if (code === "APPROVAL_REVERTED") return make("SAFE_TO_RETRY", "none", { tx: "approvals_only" });
      if (code === "APPROVAL_TIMEOUT") return make("USER_ACTION_REQUIRED", "wait_for_approval", { tx: "approvals_only" });
      return make("USER_ACTION_REQUIRED", "check_wallet_activity", { tx: "approvals_only", resumeScope: "none" });

    case "tx_unrecorded":
      // The transaction was sent, but the plan can no longer record it (it
      // expired, is gone, or is unreadable): resuming can't succeed, and a
      // new plan could pay twice. The user must check their wallet first.
      if (o.journaled === true && code !== null && PERMANENT_PLAN_CODES.has(code)) {
        return make("USER_ACTION_REQUIRED", "check_wallet_activity", { tx: "journaled", resumeScope: "this_browser" });
      }
      if (o.journaled === true) return make("SAFE_TO_RESUME", "none", { tx: "journaled", resumeScope: "this_browser" });
      // Sent, but not saved anywhere: running again could send it twice.
      return make("DO_NOT_RETRY", "check_wallet_activity", { category: "execution", tx: "sent_unrecorded" });

    case "confirm_rejected": return make("DO_NOT_RETRY", "contact_support", { tx: "recorded" });
    case "reverted": return make("DO_NOT_RETRY", "new_plan", { tx: "recorded" });
    case "unverified": return make("DO_NOT_RETRY", "contact_support", { tx: "recorded" });
    case "stalled": return make("SAFE_TO_RESUME", "wait", { tx: "recorded" });

    case "rate_limited":
    case "unavailable":
    case "server_error":
    case "network_error":
      return make("SAFE_TO_RETRY", "wait");
    case "plan_error": return make("DO_NOT_RETRY", "contact_support");

    case "invalid_response":
      // Unexpected data: the transaction state can't be established.
      return make("UNKNOWN_TRANSACTION_STATE", "contact_support", { tx: "uncertain" });

    default:
      return UNKNOWN; // fail closed
  }
}
