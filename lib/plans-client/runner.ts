/**
 * The Plan Runner (Phase 2C, Stage 4B): a headless, browser-side orchestrator
 * that drives one approved Plan, step by step, through the existing Plan API
 * and the existing SDK build / confirm routes — with every transaction signed
 * by the user's own connected wallet.
 *
 *   per step:  next → quote → bind → [confirmQuote → bind again] → build → pre-sign re-check
 *              → [approval → receipt]* → final action → journal → /tx
 *              → receipt → confirm → settle (bounded confirm/settle polling)
 *
 * The runner is an UNTRUSTED CLIENT. The server stays authoritative for every
 * rule (ownership, approval, current step, quote freshness, the Phase 4A
 * pending-build guard, build gates, on-chain verification, settlement). The
 * runner only sequences calls and refuses to go on when anything is off.
 *
 * Every capability is injected (ports below): the wallet, the Plan API, the
 * SDK routes, the grant lookup, the clock and the transaction journal. The
 * orchestration code makes no HTTP requests itself; the one HTTP adapter is
 * isolated at the bottom of this file.
 *
 * Never: holds or derives keys, signs anywhere but the injected wallet,
 * constructs or alters calldata, targets, values or fee terms (build steps are
 * passed to the wallet exactly as the build route returned them), approves or
 * abandons a plan, re-signs, rebroadcasts, or retries a rejected signature.
 * Approval transactions are never sent to the Plan API as the step's
 * transaction — only the final action's hash is.
 *
 * Browser-safe: no imports at all, no server modules, no environment reads.
 */

/* ══ DTOs (local mirrors of the Plan API's JSON; never server imports) ═════ */

export type NodeStateDTO = "pending" | "awaiting_signature" | "submitted" | "confirmed" | "reverted" | "unverified" | "skipped";
export type PlanStateDTO = "planned" | "approved" | "running" | "completed" | "failed" | "partial";
export type ResultStatusDTO = "confirmed" | "reverted" | "unverified";

export interface ActionRefDTO {
  protocolId: string;
  actionId: string;
  version: string;
}

export interface PlanNodeViewDTO {
  nodeId: string;
  ref: ActionRefDTO;
  dependsOn: readonly string[];
  state: NodeStateDTO;
  quoteAttempts: number;
  /** Phase 4A: the recorded transaction's quote, else the latest attempt's. */
  quoteId: string | null;
  txHash: string | null;
  result: { status: ResultStatusDTO; outputs: Readonly<Record<string, unknown>> | null } | null;
}

export interface PlanViewDTO {
  planId: string;
  state: PlanStateDTO;
  approved: boolean;
  abandoned: boolean;
  expired: boolean;
  approvable: boolean;
  createdAt: number;
  approveBy: number;
  expiresAt: number;
  currentStep: string | null;
  nodes: readonly PlanNodeViewDTO[];
  recipients: Readonly<Record<string, string>>;
}

export interface NextStepDTO {
  nodeId: string;
  ref: ActionRefDTO;
  state: NodeStateDTO;
  quotable: boolean;
  reason?: string;
}

export interface StepQuoteDTO {
  nodeId: string;
  ref: ActionRefDTO;
  attempt: number;
  quoteId: string;
  quoteToken: string;
  inputs: Readonly<Record<string, unknown>>;
  summary: string;
  details: Readonly<Record<string, string>>;
  quotedAt: number;
  risk?: { score: number; level: string; compliance: string };
  warnings?: string[];
}

export interface BoundQuoteDTO {
  nodeId: string;
  ref: ActionRefDTO;
  attempt: number;
  quoteId: string;
  quotedAt: number;
  freshUntil: number;
}

/**
 * What the user sees before deciding to go ahead with a quote (Stage 5C-1):
 * the server's own formatted summary and details, its risk/warnings when it
 * sent them, and the freshness window. Never the quote token or any hash.
 */
export interface QuoteProjection {
  nodeId: string;
  ref: ActionRefDTO;
  attempt: number;
  /** A random, non-secret id (already visible on the plan's node view). */
  quoteId: string;
  summary: string;
  details: Readonly<Record<string, string>>;
  quotedAt: number;
  /** The bound quote must be built before this (server-enforced). */
  freshUntil: number;
  risk?: { score: number; level: string; compliance: string };
  warnings?: readonly string[];
}

/** The only answers to a quote review. Anything else is not a "continue". */
export type QuoteDecision = "continue" | "decline";

export type RunnerPhase =
  | "quoting" | "binding" | "waiting_for_quote_review" | "building"
  | "waiting_for_wallet" | "waiting_for_receipt" | "recording"
  | "confirming" | "settling" | "polling" | "completed" | "failed";

/** A progress event — safe data only (no token, hash of a token, or calldata). */
export interface RunnerEvent {
  phase: RunnerPhase;
  planId: string;
  nodeId: string | null;
  /** A transaction hash already broadcast (approval or final action). */
  txHash?: string;
  /** Which signature a wallet / receipt wait is for. */
  signature?: "approval" | "action";
  /** For waiting_for_quote_review. */
  quote?: QuoteProjection;
  /** For polling: the wait before the next confirm/settle round. */
  delayMs?: number;
  /** For failed. */
  outcome?: { kind: RunOutcomeKind; code: string | null; status: number | null; message: string };
}

/** One unsigned step, exactly as the build route returns it. */
export interface BuildStepDTO {
  kind: "approve" | "action";
  label: string;
  tx: { to: string; data: string; value: string };
}

export interface BuildRequest {
  protocolId: string;
  actionId: string;
  version: string;
  inputs: Readonly<Record<string, unknown>>;
  walletAddress: string;
  quoteToken: string;
}

export interface ConfirmRequest {
  protocolId: string;
  actionId: string;
  version: string;
  txHash: string;
  walletAddress: string;
  quoteId: string;
}

/* ══ Ports ═════════════════════════════════════════════════════════════════ */

/** An HTTP-shaped reply. `status: 0` means no response arrived (network). */
export interface Reply {
  status: number;
  body: unknown;
}

/**
 * The user's own connected wallet. WalletServiceState satisfies this
 * structurally. Fields are read afresh at every check, so a caller holding a
 * changing React state can pass a getter (see PlanRunnerDeps.wallet).
 */
export interface RunnerWallet {
  address: string | null;
  chainId: number | null;
  isWrongNetwork?: boolean;
  sendTransaction(tx: { to: string; data?: string; value?: string }): Promise<string>;
  waitForReceipt(hash: string): Promise<unknown>;
}

/** The Plan API (app/api/plans/[planId]). No approve, no abandon. */
export interface PlanTransport {
  getPlan(planId: string): Promise<Reply>;
  next(planId: string): Promise<Reply>;
  quote(planId: string, nodeId: string): Promise<Reply>;
  bind(planId: string, nodeId: string, quoteToken: string): Promise<Reply>;
  tx(planId: string, nodeId: string, input: { quoteId: string; txHash: string }): Promise<Reply>;
  settle(planId: string, nodeId: string): Promise<Reply>;
}

/** The existing SDK routes (/api/ask/action/build and /confirm). */
export interface SdkTransport {
  build(req: BuildRequest): Promise<Reply>;
  confirm(req: ConfirmRequest): Promise<Reply>;
}

/** The address of this browser's current wallet grant, or null without one.
 *  Throws when it can't be determined (network). */
export interface GrantSource {
  currentAddress(): Promise<string | null>;
}

export interface Clock {
  now(): number;
  /** Resolves after `ms`; rejects if `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface JournalEntry {
  planId: string;
  nodeId: string;
  quoteId: string;
  txHash: string;
}

/**
 * REQUIRED. Durable (caller-provided) record of a broadcast final-action
 * transaction, written BEFORE the Plan API is told about it, so a crash
 * between broadcast and /tx can be recovered without signing again.
 */
export interface TxJournal {
  save(entry: JournalEntry): void | Promise<void>;
  load(planId: string): readonly JournalEntry[] | Promise<readonly JournalEntry[]>;
  clear(planId: string, nodeId: string): void | Promise<void>;
}

/** What an ExecutionLock did with a task. */
export type ExecutionLockResult<T> =
  | { status: "ran"; value: T }
  /** Another execution holds the lock for this wallet + plan. */
  | { status: "held" }
  /** The lock couldn't be established; the task did not run. */
  | { status: "unavailable" };

/**
 * REQUIRED (Stage 5C-2b). Cross-context exclusion for one wallet + plan:
 * runs `task` only while holding that lock, never waits for it, and runs the
 * task at most once. A task that throws rejects runExclusive with that error.
 * (lib/plans-client/locks.ts implements it with the Web Locks API.)
 */
export interface ExecutionLock {
  runExclusive<T>(scope: { wallet: string; planId: string }, task: () => Promise<T>): Promise<ExecutionLockResult<T>>;
}

export interface PlanRunnerDeps {
  /** The wallet, or a getter returning its current state. */
  wallet: RunnerWallet | (() => RunnerWallet | null);
  plans: PlanTransport;
  sdk: SdkTransport;
  grant: GrantSource;
  clock: Clock;
  journal: TxJournal;
  /** Held for the whole run, so no other tab drives this plan meanwhile. */
  lock: ExecutionLock;
  /** The chain every signature must happen on. */
  chainId: number;
  /**
   * Optional (Stage 5C-1): shown the projected quote after it is bound and
   * before anything is built. Only an explicit "continue" proceeds; "decline",
   * any other value, or a throw stops with quote_declined (nothing built or
   * signed). Without it, the runner behaves exactly as before.
   */
  confirmQuote?: (quote: QuoteProjection) => Promise<QuoteDecision>;
  /** Optional progress events. A throwing listener is ignored. */
  onEvent?: (event: RunnerEvent) => void;
}

/* ══ Outcomes ══════════════════════════════════════════════════════════════ */

export type RunOutcomeKind =
  | "completed"
  | "already_running"
  | "aborted"
  | "grant_required"
  | "wallet_mismatch"
  | "wrong_network"
  | "wallet_locked"
  | "journal_unavailable"
  | "lock_unavailable"
  | "not_approved"
  | "expired"
  | "abandoned"
  | "not_found"
  | "step_not_ready"
  | "quote_refused"
  | "conflict"
  | "bind_failed"
  | "quote_declined"
  | "build_refused"
  | "build_invalid"
  | "wallet_rejected"
  | "wallet_error"
  | "approval_failed"
  | "tx_unrecorded"
  | "confirm_rejected"
  | "reverted"
  | "unverified"
  | "stalled"
  | "rate_limited"
  | "unavailable"
  | "server_error"
  | "plan_error"
  | "invalid_response"
  | "network_error";

export interface RunOutcome {
  kind: RunOutcomeKind;
  planId: string;
  message: string;
  nodeId: string | null;
  quoteId: string | null;
  /** The final action's transaction, when one exists. */
  txHash: string | null;
  /** Approval transactions broadcast in this run (never Plan facts). */
  approvalTxHashes: readonly string[];
  /** The server's or wallet's code, when one was given. */
  code: string | null;
  /** The HTTP status, when the outcome came from a reply. */
  status: number | null;
  /** For tx_unrecorded: whether the hash is safely in the journal. */
  journaled: boolean | null;
  /** The last plan view the runner saw. */
  plan: PlanViewDTO | null;
}

export interface PlanRunner {
  run(planId: string, opts?: { signal?: AbortSignal }): Promise<RunOutcome>;
  readonly running: boolean;
}

export class PlanRunnerConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanRunnerConfigError";
  }
}

/* ══ Policy constants ══════════════════════════════════════════════════════ */

/** Waits between confirm/settle polls: 5s, 10s, 20s, 40s, 60s, then 60s. */
export const SETTLE_POLL_DELAYS_MS: readonly number[] = [5_000, 10_000, 20_000, 40_000, 60_000];
/** The whole confirm/settle phase of one step never starts new work past this. */
export const SETTLE_POLL_CAP_MS = 600_000;
/** More iterations than any plan can have steps (the IR allows 4). */
const MAX_ITERATIONS = 16;

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const DATA_RE = /^0x[0-9a-fA-F]*$/;
/** Fallback for wallets that reject without the EIP-1193 4001 code. Only the
 *  label of the stop depends on it — every wallet error stops the run. */
const REJECTION_RE = /user rejected|user denied|rejected by (the )?user|denied (transaction )?signature|request rejected|cancell?ed/i;

/* ══ Small helpers ═════════════════════════════════════════════════════════ */

const isPlain = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const NODE_STATES: readonly string[] = ["pending", "awaiting_signature", "submitted", "confirmed", "reverted", "unverified", "skipped"];
const PLAN_STATES: readonly string[] = ["planned", "approved", "running", "completed", "failed", "partial"];
const RESULT_STATES: readonly string[] = ["confirmed", "reverted", "unverified"];

function parseRef(v: unknown): ActionRefDTO | null {
  if (!isPlain(v) || !isStr(v.protocolId) || !isStr(v.actionId) || !isStr(v.version)) return null;
  return { protocolId: v.protocolId, actionId: v.actionId, version: v.version };
}

function parseNode(v: unknown): PlanNodeViewDTO | null {
  if (!isPlain(v) || !isStr(v.nodeId) || typeof v.state !== "string" || !NODE_STATES.includes(v.state)) return null;
  const ref = parseRef(v.ref);
  if (!ref) return null;
  if (v.quoteId !== null && !isStr(v.quoteId)) return null;
  if (v.txHash !== null && !isStr(v.txHash)) return null;
  let result: PlanNodeViewDTO["result"] = null;
  if (v.result !== null && v.result !== undefined) {
    if (!isPlain(v.result) || typeof v.result.status !== "string" || !RESULT_STATES.includes(v.result.status)) return null;
    result = {
      status: v.result.status as ResultStatusDTO,
      outputs: isPlain(v.result.outputs) ? (v.result.outputs as Record<string, unknown>) : null,
    };
  }
  return {
    nodeId: v.nodeId, ref, state: v.state as NodeStateDTO,
    dependsOn: Array.isArray(v.dependsOn) ? v.dependsOn.filter(isStr) : [],
    quoteAttempts: isNum(v.quoteAttempts) ? v.quoteAttempts : 0,
    quoteId: v.quoteId as string | null, txHash: v.txHash as string | null, result,
  };
}

function parsePlan(v: unknown): PlanViewDTO | null {
  if (!isPlain(v) || !isStr(v.planId) || typeof v.state !== "string" || !PLAN_STATES.includes(v.state)) return null;
  if (typeof v.approved !== "boolean" || typeof v.abandoned !== "boolean" || typeof v.expired !== "boolean") return null;
  if (v.currentStep !== null && !isStr(v.currentStep)) return null;
  if (!Array.isArray(v.nodes)) return null;
  const nodes: PlanNodeViewDTO[] = [];
  for (const n of v.nodes) {
    const p = parseNode(n);
    if (!p) return null;
    nodes.push(p);
  }
  return {
    planId: v.planId, state: v.state as PlanStateDTO, approved: v.approved, abandoned: v.abandoned, expired: v.expired,
    approvable: v.approvable === true,
    createdAt: isNum(v.createdAt) ? v.createdAt : 0, approveBy: isNum(v.approveBy) ? v.approveBy : 0, expiresAt: isNum(v.expiresAt) ? v.expiresAt : 0,
    currentStep: v.currentStep as string | null, nodes,
    recipients: isPlain(v.recipients) ? (v.recipients as Record<string, string>) : {},
  };
}

function parseNext(v: unknown): NextStepDTO | null {
  if (!isPlain(v) || !isStr(v.nodeId) || typeof v.quotable !== "boolean" || typeof v.state !== "string" || !NODE_STATES.includes(v.state)) return null;
  const ref = parseRef(v.ref);
  if (!ref) return null;
  return { nodeId: v.nodeId, ref, state: v.state as NodeStateDTO, quotable: v.quotable, ...(isStr(v.reason) ? { reason: v.reason } : {}) };
}

function parseQuote(v: unknown): StepQuoteDTO | null {
  if (!isPlain(v) || !isStr(v.nodeId) || !isStr(v.quoteId) || !isStr(v.quoteToken) || !isPlain(v.inputs) || !isNum(v.attempt)) return null;
  const ref = parseRef(v.ref);
  if (!ref) return null;
  return {
    nodeId: v.nodeId, ref, attempt: v.attempt, quoteId: v.quoteId, quoteToken: v.quoteToken,
    inputs: v.inputs as Record<string, unknown>,
    summary: typeof v.summary === "string" ? v.summary : "",
    details: isPlain(v.details) ? (v.details as Record<string, string>) : {},
    quotedAt: isNum(v.quotedAt) ? v.quotedAt : 0,
    ...(isPlain(v.risk) && isNum(v.risk.score) && typeof v.risk.level === "string" && typeof v.risk.compliance === "string"
      ? { risk: { score: v.risk.score, level: v.risk.level, compliance: v.risk.compliance } } : {}),
    ...(Array.isArray(v.warnings) && v.warnings.every((w) => typeof w === "string") ? { warnings: [...(v.warnings as string[])] } : {}),
  };
}

/** The user-facing projection of a bound quote — built field by field, so
 *  the quote token can never ride along. */
function projectQuote(q: StepQuoteDTO, bound: BoundQuoteDTO): QuoteProjection {
  return {
    nodeId: q.nodeId, ref: { ...q.ref }, attempt: q.attempt, quoteId: q.quoteId,
    summary: q.summary, details: { ...q.details },
    quotedAt: q.quotedAt, freshUntil: bound.freshUntil,
    ...(q.risk ? { risk: { ...q.risk } } : {}),
    ...(q.warnings ? { warnings: [...q.warnings] } : {}),
  };
}

function parseBound(v: unknown): BoundQuoteDTO | null {
  if (!isPlain(v) || !isStr(v.nodeId) || !isStr(v.quoteId) || !isNum(v.freshUntil)) return null;
  const ref = parseRef(v.ref);
  if (!ref) return null;
  return { nodeId: v.nodeId, ref, attempt: isNum(v.attempt) ? v.attempt : 0, quoteId: v.quoteId, quotedAt: isNum(v.quotedAt) ? v.quotedAt : 0, freshUntil: v.freshUntil };
}

/** The build route's steps, validated for shape and order: approvals only
 *  before the final step, which is the action. Null when anything is off. */
function parseSteps(v: unknown): BuildStepDTO[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out: BuildStepDTO[] = [];
  for (let i = 0; i < v.length; i++) {
    const s = v[i];
    const last = i === v.length - 1;
    if (!isPlain(s) || !isPlain(s.tx)) return null;
    if (last ? s.kind !== "action" : s.kind !== "approve") return null;
    const { to, data, value } = s.tx;
    if (typeof to !== "string" || !ADDR_RE.test(to) || typeof data !== "string" || !DATA_RE.test(data) || typeof value !== "string") return null;
    out.push({ kind: last ? "action" : "approve", label: typeof s.label === "string" ? s.label : "", tx: { to, data, value } });
  }
  return out;
}

const bodyCode = (b: unknown): string | null => (isPlain(b) && isStr(b.code) ? b.code : null);
const bodyMessage = (b: unknown): string | null => (isPlain(b) && isStr(b.message) ? b.message : null);

const QUOTE_ID_RE = /^[0-9a-f]{32}$/;

/** One journal entry, exactly as written by the runner — or null when any
 *  required field can't be established as-is (no coercion, no repair). */
function wellFormedEntry(v: unknown): JournalEntry | null {
  if (!isPlain(v)) return null;
  const { planId, nodeId, quoteId, txHash } = v;
  if (!isStr(planId) || !isStr(nodeId)) return null;
  if (typeof quoteId !== "string" || !QUOTE_ID_RE.test(quoteId)) return null;
  if (typeof txHash !== "string" || !HASH_RE.test(txHash)) return null;
  return { planId, nodeId, quoteId, txHash };
}

/**
 * The journal's entries for `planId`, or null when the journal can't be
 * trusted: load() didn't return an array, or any entry is malformed. A
 * malformed entry can't be proven to belong to another plan, so it is never
 * skipped. Well-formed entries for other plans are ignored.
 */
export function journalEntriesFor(planId: string, loaded: unknown): JournalEntry[] | null {
  if (!Array.isArray(loaded)) return null;
  const mine: JournalEntry[] = [];
  for (const raw of loaded) {
    const e = wellFormedEntry(raw);
    if (!e) return null;
    if (e.planId === planId) mine.push(e);
  }
  return mine;
}

/** EIP-1193 4001 (or ethers' ACTION_REJECTED), else the wording fallback. */
export function isUserRejection(e: unknown): boolean {
  let cur: unknown = e;
  for (let depth = 0; depth < 4 && cur !== null && cur !== undefined; depth++) {
    if (typeof cur === "string") return REJECTION_RE.test(cur);
    if (typeof cur !== "object") return false;
    const o = cur as { code?: unknown; message?: unknown; cause?: unknown };
    if (o.code === 4001 || o.code === "4001" || o.code === "ACTION_REJECTED") return true;
    if (typeof o.message === "string" && REJECTION_RE.test(o.message)) return true;
    cur = o.cause;
  }
  return false;
}

/** Explicit success only: viem's "success", or a raw 1 / 0x1. */
function receiptSucceeded(r: unknown): boolean {
  if (!isPlain(r)) return false;
  const s = r.status;
  return s === "success" || s === 1 || s === "0x1" || s === BigInt(1);
}

/** A confirm reply that carries a STORED verdict (success / reverted /
 *  unverified) — after one, only settle is needed. */
function confirmIsTerminal(r: Reply): boolean {
  if (r.status !== 200 || !isPlain(r.body)) return false;
  const b = r.body;
  return (b.ok === true && b.success === true) || b.reverted === true || b.verified === false;
}

function validateDeps(d: PlanRunnerDeps): void {
  if (!isPlain(d)) throw new PlanRunnerConfigError("Plan runner dependencies are required.");
  const fns = (o: unknown, names: string[]) => isPlain(o) && names.every((n) => typeof o[n] === "function");
  if (!fns(d.journal, ["save", "load", "clear"])) throw new PlanRunnerConfigError("A transaction journal (save, load, clear) is required.");
  if (!fns(d.lock, ["runExclusive"])) throw new PlanRunnerConfigError("An execution lock (runExclusive) is required.");
  if (typeof d.wallet !== "function" && !fns(d.wallet, ["sendTransaction", "waitForReceipt"])) throw new PlanRunnerConfigError("A wallet with sendTransaction and waitForReceipt is required.");
  if (!fns(d.plans, ["getPlan", "next", "quote", "bind", "tx", "settle"])) throw new PlanRunnerConfigError("A Plan API transport is required.");
  if (!fns(d.sdk, ["build", "confirm"])) throw new PlanRunnerConfigError("An SDK transport (build, confirm) is required.");
  if (!fns(d.grant, ["currentAddress"])) throw new PlanRunnerConfigError("A wallet grant source is required.");
  if (!fns(d.clock, ["now", "sleep"])) throw new PlanRunnerConfigError("A clock (now, sleep) is required.");
  if (!Number.isInteger(d.chainId) || d.chainId <= 0) throw new PlanRunnerConfigError("The expected chain id is required.");
  if (d.confirmQuote !== undefined && typeof d.confirmQuote !== "function") throw new PlanRunnerConfigError("confirmQuote must be a function.");
  if (d.onEvent !== undefined && typeof d.onEvent !== "function") throw new PlanRunnerConfigError("onEvent must be a function.");
}

const MESSAGES: Record<RunOutcomeKind, string> = {
  completed: "Every step of this plan confirmed.",
  already_running: "This plan is already running here.",
  aborted: "Stopped. Nothing further was sent.",
  grant_required: "Unlock your wallet for PayAI to run this plan.",
  wallet_mismatch: "The connected wallet isn't the one this plan belongs to.",
  wrong_network: "Switch your wallet to the right network to continue.",
  wallet_locked: "Connect or unlock your wallet to continue.",
  journal_unavailable: "Couldn't read this browser's record of sent transactions, so nothing was signed.",
  lock_unavailable: "This browser couldn't make sure the plan runs in only one tab, so nothing was run.",
  not_approved: "Approve this plan first.",
  expired: "This plan has expired.",
  abandoned: "This plan was abandoned.",
  not_found: "This plan or step wasn't found.",
  step_not_ready: "This step can't run right now.",
  quote_refused: "This step couldn't be quoted.",
  conflict: "This step changed while it was being prepared, so nothing was signed.",
  bind_failed: "This step's quote couldn't be confirmed — request a new one.",
  quote_declined: "The quote wasn't accepted, so nothing was prepared or signed.",
  build_refused: "This step's transaction couldn't be prepared.",
  build_invalid: "The prepared transaction wasn't what this step expected, so nothing was signed.",
  wallet_rejected: "You canceled the transaction in your wallet. Nothing was retried.",
  wallet_error: "Your wallet couldn't send the transaction. Nothing was retried.",
  approval_failed: "The token approval didn't confirm, so the step itself was not signed.",
  tx_unrecorded: "Your transaction was sent, but PayAI couldn't record it yet. Don't send it again — resume this plan to record it.",
  confirm_rejected: "PayAI couldn't verify this step's transaction.",
  reverted: "This step's transaction reverted on-chain.",
  unverified: "This step's transaction couldn't be verified, so the plan stopped.",
  stalled: "This step's transaction is still waiting to be confirmed. Resume later — don't send it again.",
  rate_limited: "Too many requests — try again in a moment.",
  unavailable: "Plans are unavailable right now. Try again in a moment.",
  server_error: "Something went wrong on PayAI's side. Try again in a moment.",
  plan_error: "This step can't run right now.",
  invalid_response: "PayAI returned something unexpected, so nothing further was done.",
  network_error: "Couldn't reach PayAI. Check your connection.",
};

/* ══ The runner ════════════════════════════════════════════════════════════ */

/** Internal: a step finished as confirmed — go on to the next one. */
const STEP_CONFIRMED = Symbol("step-confirmed");
type StepResult = RunOutcome | typeof STEP_CONFIRMED;

export function createPlanRunner(deps: PlanRunnerDeps): PlanRunner {
  validateDeps(deps);
  const { plans, sdk, grant, clock, journal } = deps;
  let active = false;

  /** Progress events: fire-and-forget; a listener can't affect the run. */
  const emit = (e: RunnerEvent): void => {
    if (!deps.onEvent) return;
    try {
      deps.onEvent(e);
    } catch { /* ignored */ }
  };

  const currentWallet = (): RunnerWallet | null => {
    try {
      return typeof deps.wallet === "function" ? deps.wallet() : deps.wallet;
    } catch {
      return null;
    }
  };

  /** Any port call: a throw becomes "no response" (status 0). */
  const call = async (fn: () => Promise<Reply>): Promise<Reply> => {
    try {
      const r = await fn();
      return isPlain(r) && typeof r.status === "number" ? r : { status: 0, body: null };
    } catch {
      return { status: 0, body: null };
    }
  };

  function runOnce(planId: string, signal: AbortSignal | undefined, lockWallet: string): Promise<RunOutcome> {
    let lastPlan: PlanViewDTO | null = null;
    const approvalTxHashes: string[] = [];

    const outcome = (kind: RunOutcomeKind, o: Partial<Omit<RunOutcome, "kind" | "planId">> = {}): RunOutcome => ({
      kind, planId,
      message: o.message ?? MESSAGES[kind],
      nodeId: o.nodeId ?? null, quoteId: o.quoteId ?? null, txHash: o.txHash ?? null,
      approvalTxHashes: [...approvalTxHashes],
      code: o.code ?? null, status: o.status ?? null, journaled: o.journaled ?? null,
      plan: o.plan ?? lastPlan,
    });

    /** A failed Plan API reply → its typed outcome (never retried). */
    const planFailure = (r: Reply, nodeId: string | null = null): RunOutcome => {
      const code = bodyCode(r.body);
      const base = { nodeId, code, status: r.status, ...(bodyMessage(r.body) ? { message: bodyMessage(r.body)! } : {}) };
      if (r.status === 0) return outcome("network_error", { nodeId, status: 0 });
      if (r.status === 401) return outcome("grant_required", base);
      if (r.status === 429) return outcome("rate_limited", base);
      switch (code) {
        case "EXPIRED": return outcome("expired", base);
        case "NOT_APPROVED":
        case "NOT_APPROVABLE": return outcome("not_approved", base);
        case "STEP_NOT_READY": return outcome("step_not_ready", base);
        case "QUOTE_REFUSED": return outcome("quote_refused", base);
        case "CONFLICT": return outcome("conflict", base);
        case "NOT_FOUND":
        case "WALLET_MISMATCH": return outcome("not_found", base);
        case "UNAVAILABLE": return outcome("unavailable", { ...base, message: MESSAGES.unavailable });
      }
      if (r.status === 410) return outcome("expired", base);
      if (r.status === 404) return outcome("not_found", base);
      if (r.status >= 500) return outcome("server_error", { ...base, message: MESSAGES.server_error });
      return outcome("plan_error", base);
    };

    /** Steps 1–3: a grant exists, it is the signing wallet's, and the wallet
     *  is usable on the expected chain. Returns the grant address. */
    const identity = async (): Promise<{ wallet: string } | RunOutcome> => {
      let addr: string | null;
      try {
        addr = await grant.currentAddress();
      } catch {
        return outcome("network_error");
      }
      if (typeof addr !== "string" || !ADDR_RE.test(addr)) return outcome("grant_required");
      const w = currentWallet();
      if (!w || typeof w.address !== "string" || !ADDR_RE.test(w.address)) return outcome("wallet_locked");
      if (w.address.toLowerCase() !== addr.toLowerCase()) return outcome("wallet_mismatch");
      if (w.isWrongNetwork === true || w.chainId !== deps.chainId) return outcome("wrong_network");
      return { wallet: addr.toLowerCase() };
    };

    const fetchPlan = async (): Promise<PlanViewDTO | RunOutcome> => {
      const r = await call(() => plans.getPlan(planId));
      if (r.status !== 200 || !isPlain(r.body) || r.body.ok !== true) return planFailure(r);
      const plan = parsePlan(r.body.plan);
      if (!plan || plan.planId !== planId) return outcome("invalid_response", { status: r.status });
      lastPlan = plan;
      return plan;
    };

    const aborted = () => signal?.aborted === true;

    /** A plan view from a successful reply (tx / settle), or null. */
    const planFrom = (r: Reply): PlanViewDTO | null => {
      if (r.status !== 200 || !isPlain(r.body) || r.body.ok !== true) return null;
      const p = parsePlan(r.body.plan);
      if (p && p.planId === planId) lastPlan = p;
      return p && p.planId === planId ? p : null;
    };

    /**
     * Confirm, then settle; while settlement is pending, wait 5/10/20/40/60s
     * then every 60s, re-running confirm (until it has stored a verdict)
     * before each settle. No new work starts once SETTLE_POLL_CAP_MS has
     * passed since the first confirm (by the injected clock): the step is
     * left submitted and reported "stalled". Never signs or sends anything.
     */
    const settleStep = async (node: { nodeId: string; ref: ActionRefDTO; quoteId: string; txHash: string }, wallet: string): Promise<StepResult> => {
      const ids = { nodeId: node.nodeId, quoteId: node.quoteId, txHash: node.txHash };
      const start = clock.now();
      let verdictStored = false;
      const overCap = () => clock.now() - start > SETTLE_POLL_CAP_MS;

      const tick = async (): Promise<StepResult | "pending"> => {
        if (!verdictStored) {
          emit({ phase: "confirming", planId, nodeId: node.nodeId, txHash: node.txHash });
          const c = await call(() => sdk.confirm({ ...node.ref, txHash: node.txHash, walletAddress: wallet, quoteId: node.quoteId }));
          if (confirmIsTerminal(c)) verdictStored = true;
          // A malformed confirm request can never succeed: stop, don't poll.
          else if (c.status === 400) return outcome("confirm_rejected", { ...ids, status: 400, code: bodyCode(c.body), ...(bodyMessage(c.body) ? { message: bodyMessage(c.body)! } : {}) });
          // Network, 409, 429, 502, … : no stored verdict yet — keep polling.
          if (!verdictStored && overCap()) return outcome("stalled", ids);
        }
        emit({ phase: "settling", planId, nodeId: node.nodeId, txHash: node.txHash });
        const s = await call(() => plans.settle(planId, node.nodeId));
        if (s.status === 200) {
          const plan = planFrom(s);
          if (!plan) return outcome("invalid_response", { ...ids, status: 200 });
          const n = plan.nodes.find((x) => x.nodeId === node.nodeId);
          if (!n) return outcome("invalid_response", { ...ids, status: 200 });
          if (n.result?.status === "confirmed") return STEP_CONFIRMED;
          if (n.result?.status === "reverted") return outcome("reverted", { ...ids, plan });
          if (n.result?.status === "unverified") return outcome("unverified", { ...ids, plan });
          return "pending";
        }
        // 202 SETTLEMENT_PENDING, or a transient failure: still pending.
        if (s.status === 202 || s.status === 0 || s.status === 429 || s.status === 502 || s.status === 503) return "pending";
        return planFailure(s, node.nodeId);
      };

      let r = await tick();
      for (let i = 0; r === "pending"; i++) {
        const delay = SETTLE_POLL_DELAYS_MS[Math.min(i, SETTLE_POLL_DELAYS_MS.length - 1)];
        if (clock.now() - start + delay > SETTLE_POLL_CAP_MS) return outcome("stalled", ids);
        if (aborted()) return outcome("aborted", ids);
        emit({ phase: "polling", planId, nodeId: node.nodeId, txHash: node.txHash, delayMs: delay });
        try {
          await clock.sleep(delay, signal);
        } catch {
          return outcome("aborted", ids);
        }
        if (aborted()) return outcome("aborted", ids);
        r = await tick();
      }
      return r;
    };

    /** Resume A: a journaled hash the Plan API doesn't have yet → /tx it.
     *  Never signs. Returns the refreshed plan, or a stop. */
    const recoverJournal = async (entries: readonly JournalEntry[], plan: PlanViewDTO): Promise<PlanViewDTO | RunOutcome> => {
      // Entries are already validated and narrowed to this plan.
      for (const e of entries) {
        const ids = { nodeId: e.nodeId, quoteId: e.quoteId, txHash: e.txHash };
        const node = plan.nodes.find((n) => n.nodeId === e.nodeId);
        if (!node) return outcome("invalid_response", { ...ids, message: "A saved transaction refers to a step this plan doesn't have." });
        if (node.txHash !== null) {
          if (node.txHash.toLowerCase() === e.txHash.toLowerCase()) {
            await Promise.resolve(journal.clear(planId, e.nodeId)).catch(() => {});
            continue;
          }
          // A DIFFERENT transaction is recorded for this step: two were sent.
          // Keep the journal; this needs the user's attention, not a retry.
          return outcome("conflict", { ...ids, message: "A different transaction is already recorded for this step. Check your wallet's activity — this saved transaction was kept." });
        }
        emit({ phase: "recording", planId, nodeId: e.nodeId, txHash: e.txHash });
        const r = await call(() => plans.tx(planId, e.nodeId, { quoteId: e.quoteId, txHash: e.txHash }));
        const updated = planFrom(r);
        if (!updated) return outcome("tx_unrecorded", { ...ids, journaled: true, status: r.status, code: bodyCode(r.body) });
        await Promise.resolve(journal.clear(planId, e.nodeId)).catch(() => {});
        plan = updated;
      }
      return plan;
    };

    /**
     * The check that must pass immediately before a signature: not aborted;
     * the plan (fetched now) still approved, not abandoned or expired; the
     * node still the current, awaiting-signature step with no transaction and
     * still on THIS runner's quote; the grant, wallet and network still valid
     * and unchanged. Returns the wallet as it is now (read through the getter).
     */
    const presignCheck = async (nodeId: string, quoteId: string, wallet: string): Promise<{ ok: true; signer: RunnerWallet } | { ok: false; outcome: RunOutcome }> => {
      const ids = { nodeId, quoteId };
      const stop = (o: RunOutcome) => ({ ok: false as const, outcome: o });
      if (aborted()) return stop(outcome("aborted", ids));
      const plan = await fetchPlan();
      if ("kind" in plan) return stop({ ...plan, nodeId, quoteId });
      if (plan.abandoned) return stop(outcome("abandoned", ids));
      if (plan.expired) return stop(outcome("expired", ids));
      if (!plan.approved) return stop(outcome("not_approved", ids));
      const node = plan.nodes.find((n) => n.nodeId === nodeId);
      if (!node) return stop(outcome("invalid_response", ids));
      if (node.txHash !== null) return stop(outcome("conflict", { ...ids, code: "TX_ALREADY_RECORDED", message: "A transaction is already recorded for this step, so nothing was signed." }));
      if (node.quoteId !== quoteId) return stop(outcome("conflict", { ...ids, code: "QUOTE_SUPERSEDED", message: "This step was re-quoted elsewhere, so nothing was signed." }));
      if (node.state !== "awaiting_signature" || plan.currentStep !== nodeId) return stop(outcome("step_not_ready", ids));
      const again = await identity();
      if ("kind" in again) return stop({ ...again, nodeId, quoteId });
      if (again.wallet !== wallet) return stop(outcome("wallet_mismatch", ids));
      const signer = currentWallet();
      if (!signer) return stop(outcome("wallet_locked", ids));
      return { ok: true, signer };
    };

    /** The quotable current step, from quote to a terminal settlement. */
    const executeStep = async (next: NextStepDTO, wallet: string): Promise<StepResult> => {
      const nodeId = next.nodeId;
      if (aborted()) return outcome("aborted", { nodeId });

      // 7. Quote.
      emit({ phase: "quoting", planId, nodeId });
      const q = await call(() => plans.quote(planId, nodeId));
      if (q.status !== 200 || !isPlain(q.body) || q.body.ok !== true) return planFailure(q, nodeId);
      const quote = parseQuote(q.body.quote);
      if (!quote || quote.nodeId !== nodeId) return outcome("invalid_response", { nodeId, status: q.status });
      const ids = { nodeId, quoteId: quote.quoteId };

      // 8. Bind the token to the step's latest attempt (and check freshness).
      // The server is authoritative: the token must still be this step's
      // latest attempt, still fresh, and the step still quotable.
      const bindNow = async (): Promise<{ ok: true; bound: BoundQuoteDTO } | { ok: false; outcome: RunOutcome }> => {
        const stop = (o: RunOutcome) => ({ ok: false as const, outcome: o });
        const b = await call(() => plans.bind(planId, nodeId, quote.quoteToken));
        if (b.status === 0) return stop(outcome("network_error", { ...ids, status: 0 }));
        if (b.status === 401) return stop(outcome("grant_required", { ...ids, status: 401 }));
        if (b.status === 429) return stop(outcome("rate_limited", { ...ids, status: 429 }));
        if (b.status !== 200 || !isPlain(b.body) || b.body.ok !== true) {
          return stop(outcome("bind_failed", { ...ids, status: b.status, code: bodyCode(b.body), ...(bodyMessage(b.body) ? { message: bodyMessage(b.body)! } : {}) }));
        }
        const bound = parseBound(b.body.bound);
        if (!bound || bound.quoteId !== quote.quoteId || bound.nodeId !== nodeId) return stop(outcome("bind_failed", { ...ids, status: 200, code: "QUOTE_MISMATCH" }));
        if (clock.now() >= bound.freshUntil) return stop(outcome("bind_failed", { ...ids, status: 200, code: "EXPIRED", message: "This quote went stale before it could be prepared — run the plan again." }));
        return { ok: true, bound };
      };
      emit({ phase: "binding", planId, nodeId });
      const firstBind = await bindNow();
      if (!firstBind.ok) return firstBind.outcome;
      if (aborted()) return outcome("aborted", ids);

      // 8b. The user's review of the quote (only when a reviewer is wired).
      // Nothing but an explicit "continue" goes on; afterwards the binding
      // is checked AGAIN by the server — the user may have taken a while.
      if (deps.confirmQuote) {
        const projection = projectQuote(quote, firstBind.bound);
        emit({ phase: "waiting_for_quote_review", planId, nodeId, quote: projectQuote(quote, firstBind.bound) });
        let decision: unknown;
        try {
          decision = await deps.confirmQuote(projection);
        } catch {
          return outcome("quote_declined", { ...ids, code: "CONFIRMATION_ERROR", message: "The quote review didn't complete, so nothing was prepared or signed." });
        }
        if (decision !== "continue") {
          return outcome("quote_declined", { ...ids, code: decision === "decline" ? "DECLINED" : "NO_DECISION" });
        }
        if (aborted()) return outcome("aborted", ids);
        const again = await bindNow();
        if (!again.ok) return again.outcome;
      }

      // 9–10. Build through the existing SDK route; judge by `ok`, not status.
      emit({ phase: "building", planId, nodeId });
      const built = await call(() => sdk.build({
        protocolId: quote.ref.protocolId, actionId: quote.ref.actionId, version: quote.ref.version,
        inputs: quote.inputs, walletAddress: wallet, quoteToken: quote.quoteToken,
      }));
      if (built.status === 0) return outcome("network_error", { ...ids, status: 0 });
      if (!isPlain(built.body) || built.body.ok !== true) {
        return outcome("build_refused", { ...ids, status: built.status, code: bodyCode(built.body), ...(bodyMessage(built.body) ? { message: bodyMessage(built.body)! } : {}) });
      }
      if (built.body.quoteId !== quote.quoteId) return outcome("build_invalid", { ...ids, status: built.status, code: "QUOTE_MISMATCH" });
      const steps = parseSteps(built.body.steps);
      if (!steps) return outcome("build_invalid", { ...ids, status: built.status, code: "MALFORMED_STEPS" });

      // 11. Immediately before any signature: re-check the plan and the wallet.
      const first = await presignCheck(nodeId, quote.quoteId, wallet);
      if (!first.ok) return first.outcome;
      let signer = first.signer;

      // Approvals first: each must be explicitly successful on-chain before
      // anything else is signed. Their hashes are never Plan facts.
      for (const step of steps.slice(0, -1)) {
        let hash: string;
        emit({ phase: "waiting_for_wallet", planId, nodeId, signature: "approval" });
        try {
          hash = await signer.sendTransaction({ ...step.tx });
        } catch (e) {
          return outcome(isUserRejection(e) ? "wallet_rejected" : "wallet_error", ids);
        }
        if (typeof hash !== "string" || !HASH_RE.test(hash)) return outcome("wallet_error", ids);
        approvalTxHashes.push(hash);
        let receipt: unknown;
        emit({ phase: "waiting_for_receipt", planId, nodeId, txHash: hash, signature: "approval" });
        try {
          receipt = await signer.waitForReceipt(hash);
        } catch {
          return outcome("approval_failed", { ...ids, code: "APPROVAL_TIMEOUT", message: "The token approval didn't confirm in time, so the step itself was not signed. Check your wallet's activity." });
        }
        if (!receiptSucceeded(receipt)) return outcome("approval_failed", { ...ids, code: "APPROVAL_REVERTED" });
      }

      // After approvals (which can take minutes: mining plus the user's time in
      // the wallet), run the whole pre-sign check again and take the wallet
      // afresh — the account, the network, the plan, or the server's
      // pending-build window may have changed meanwhile.
      if (steps.length > 1) {
        const again = await presignCheck(nodeId, quote.quoteId, wallet);
        if (!again.ok) return again.outcome;
        signer = again.signer; // never the snapshot from before the approvals
      }

      // The final action: sign once.
      const final = steps[steps.length - 1];
      let txHash: string;
      emit({ phase: "waiting_for_wallet", planId, nodeId, signature: "action" });
      try {
        txHash = await signer.sendTransaction({ ...final.tx });
      } catch (e) {
        return outcome(isUserRejection(e) ? "wallet_rejected" : "wallet_error", ids);
      }
      if (typeof txHash !== "string" || txHash.length === 0) return outcome("wallet_error", ids);
      const sent = { ...ids, txHash };

      // Journal BEFORE the Plan API hears of it; /tx only after it's saved.
      try {
        await journal.save({ planId, nodeId, quoteId: quote.quoteId, txHash });
      } catch {
        return outcome("tx_unrecorded", { ...sent, journaled: false, message: "Your transaction was sent, but it couldn't be saved or recorded. Don't send it again — keep this transaction hash." });
      }
      emit({ phase: "recording", planId, nodeId, txHash });
      const recorded = await call(() => plans.tx(planId, nodeId, { quoteId: quote.quoteId, txHash }));
      if (!planFrom(recorded)) return outcome("tx_unrecorded", { ...sent, journaled: true, status: recorded.status, code: bodyCode(recorded.body) });
      await Promise.resolve(journal.clear(planId, nodeId)).catch(() => {});

      // The client's own receipt wait is advisory: a revert or a timeout both
      // still go to confirm, which is authoritative.
      emit({ phase: "waiting_for_receipt", planId, nodeId, txHash, signature: "action" });
      try {
        await signer.waitForReceipt(txHash);
      } catch { /* confirm decides */ }

      return settleStep({ nodeId, ref: quote.ref, quoteId: quote.quoteId, txHash }, wallet);
    };

    const loop = async (): Promise<RunOutcome> => {
      for (let i = 0; i < MAX_ITERATIONS; i++) {
        if (aborted()) return outcome("aborted");
        const id = await identity();
        if ("kind" in id) return id;
        // The lock is for the wallet read before it was taken; a switch since
        // then would run this plan outside that lock.
        if (id.wallet !== lockWallet) return outcome("wallet_mismatch");

        let loaded: unknown;
        try {
          loaded = await journal.load(planId);
        } catch {
          return outcome("journal_unavailable");
        }
        // The journal is a safety boundary: anything that can't be read with
        // certainty stops the run before any quote, build or signature.
        const entries = journalEntriesFor(planId, loaded);
        if (!entries) return outcome("journal_unavailable", { message: "This browser's record of sent transactions is unreadable, so nothing was signed. Check your wallet's activity before continuing." });

        let plan = await fetchPlan();
        if ("kind" in plan) return plan;
        if (entries.length > 0) {
          plan = await recoverJournal(entries, plan);
          if ("kind" in plan) return plan;
        }

        if (plan.state === "completed") return outcome("completed", { plan });

        // Resume B: a submitted step settles first — no quote, build or signature.
        const submitted = plan.nodes.find((n) => n.state === "submitted");
        if (submitted) {
          if (!submitted.txHash || !submitted.quoteId) return outcome("invalid_response", { nodeId: submitted.nodeId });
          const r = await settleStep({ nodeId: submitted.nodeId, ref: submitted.ref, quoteId: submitted.quoteId, txHash: submitted.txHash }, id.wallet);
          if (r === STEP_CONFIRMED) continue;
          return r;
        }

        if (plan.state === "failed" || plan.state === "partial") {
          const ended = plan.nodes.find((n) => n.state === "reverted" || n.state === "unverified");
          if (ended) return outcome(ended.state as "reverted" | "unverified", { nodeId: ended.nodeId, quoteId: ended.quoteId, txHash: ended.txHash });
        }
        if (plan.abandoned) return outcome("abandoned");
        if (plan.expired) return outcome("expired");
        if (!plan.approved) return outcome("not_approved");
        if (plan.state === "failed" || plan.state === "partial") return outcome("step_not_ready");

        const n = await call(() => plans.next(planId));
        if (n.status !== 200 || !isPlain(n.body) || n.body.ok !== true) return planFailure(n);
        const next = parseNext(n.body.next);
        if (!next) return outcome("invalid_response", { status: n.status });
        if (!next.quotable) return outcome("step_not_ready", { nodeId: next.nodeId, ...(next.reason ? { message: next.reason } : {}) });

        const r = await executeStep(next, id.wallet);
        if (r === STEP_CONFIRMED) continue;
        return r;
      }
      return outcome("invalid_response", { message: "This plan didn't make progress as expected, so the runner stopped." });
    };

    return loop();
  }

  /** An outcome from before the plan loop started: nothing was called. */
  const before = (planId: string, kind: RunOutcomeKind, code: string | null = null, message = MESSAGES[kind]): RunOutcome => ({
    kind, planId, message, nodeId: null, quoteId: null, txHash: null,
    approvalTxHashes: [], code, status: null, journaled: null, plan: null,
  });

  /**
   * The whole plan loop — recovery, quotes, signatures, settlement — runs
   * inside the execution lock for the LOCAL wallet + plan. If the lock is
   * held elsewhere or can't be established, nothing at all is called: no
   * grant, journal, Plan API, build or wallet.
   */
  async function runLocked(planId: string, signal: AbortSignal | undefined): Promise<RunOutcome> {
    const w = currentWallet();
    if (!w || typeof w.address !== "string" || !ADDR_RE.test(w.address)) return before(planId, "wallet_locked");
    const lockWallet = w.address.toLowerCase();

    let started: Promise<RunOutcome> | null = null;
    const task = (): Promise<RunOutcome> => {
      if (started) return Promise.resolve(before(planId, "lock_unavailable", "LOCK_REENTERED")); // never twice
      started = runOnce(planId, signal, lockWallet);
      return started;
    };

    let res: unknown;
    try {
      res = await deps.lock.runExclusive({ wallet: lockWallet, planId }, task);
    } catch {
      res = null; // decided below by whether the task started
    }
    // Once the task has started, ITS outcome (or error) is the result — awaited
    // to the end, whatever the lock reported or threw.
    if (started) return started;
    if (isPlain(res) && res.status === "held") return before(planId, "already_running", "LOCK_HELD", "This plan is already running in another tab or window.");
    return before(planId, "lock_unavailable", "LOCK_UNAVAILABLE");
  }

  return {
    get running() {
      return active;
    },
    async run(planId, opts) {
      // A same-instance convenience guard only — the server's pending-build
      // guard and write-once facts are what actually prevent double execution.
      if (active) {
        return {
          kind: "already_running", planId, message: MESSAGES.already_running, nodeId: null, quoteId: null, txHash: null,
          approvalTxHashes: [], code: null, status: null, journaled: null, plan: null,
        };
      }
      active = true;
      try {
        const result = await runLocked(planId, opts?.signal);
        emit(result.kind === "completed"
          ? { phase: "completed", planId, nodeId: null }
          : { phase: "failed", planId, nodeId: result.nodeId, ...(result.txHash ? { txHash: result.txHash } : {}),
              outcome: { kind: result.kind, code: result.code, status: result.status, message: result.message } });
        return result;
      } finally {
        active = false;
      }
    },
  };
}

/** A real-time Clock (Date.now / setTimeout). */
export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(new Error("aborted"));
      const t = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
};

/* ══ HTTP transport adapter — the only code here that performs requests ═══ */

/** The subset of the platform request function the adapter uses. */
export type HttpFn = (
  url: string,
  init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string; credentials: "same-origin"; cache: "no-store" },
) => Promise<{ status: number; text(): Promise<string> }>;

/**
 * Plan API, SDK and grant ports over same-origin HTTP. The wallet grant is an
 * HttpOnly cookie the browser attaches itself; this adapter never sees it.
 * Network failures become `status: 0`.
 */
export function createHttpTransports(opts: { http?: HttpFn; baseUrl?: string } = {}): { plans: PlanTransport; sdk: SdkTransport; grant: GrantSource } {
  const httpImpl: HttpFn = opts.http ?? ((url, init) => globalThis.fetch(url, init));
  const base = opts.baseUrl ?? "";

  const send = async (method: "GET" | "POST", path: string, body?: unknown): Promise<Reply> => {
    let res: { status: number; text(): Promise<string> };
    try {
      res = await httpImpl(`${base}${path}`, {
        method,
        headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        credentials: "same-origin",
        cache: "no-store",
      });
    } catch {
      return { status: 0, body: null };
    }
    let parsed: unknown = null;
    try {
      const text = await res.text();
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed };
  };

  const planPath = (planId: string) => `/api/plans/${encodeURIComponent(planId)}`;
  const plans: PlanTransport = {
    getPlan: (planId) => send("GET", planPath(planId)),
    next: (planId) => send("POST", planPath(planId), { op: "next" }),
    quote: (planId, nodeId) => send("POST", planPath(planId), { op: "quote", nodeId }),
    bind: (planId, nodeId, quoteToken) => send("POST", planPath(planId), { op: "bind", nodeId, quoteToken }),
    tx: (planId, nodeId, input) => send("POST", planPath(planId), { op: "tx", nodeId, quoteId: input.quoteId, txHash: input.txHash }),
    settle: (planId, nodeId) => send("POST", planPath(planId), { op: "settle", nodeId }),
  };
  const sdk: SdkTransport = {
    build: (req) => send("POST", "/api/ask/action/build", {
      protocolId: req.protocolId, actionId: req.actionId, version: req.version,
      inputs: req.inputs, walletAddress: req.walletAddress, quoteToken: req.quoteToken,
    }),
    confirm: (req) => send("POST", "/api/ask/action/confirm", {
      protocolId: req.protocolId, actionId: req.actionId, version: req.version,
      txHash: req.txHash, walletAddress: req.walletAddress, quoteId: req.quoteId,
    }),
  };
  const grantSource: GrantSource = {
    async currentAddress() {
      const r = await send("GET", "/api/auth/wallet-grant");
      if (r.status === 0) throw new Error("network");
      return isPlain(r.body) && typeof r.body.address === "string" ? r.body.address.toLowerCase() : null;
    },
  };
  return { plans, sdk, grant: grantSource };
}
