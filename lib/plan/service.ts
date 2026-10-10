/**
 * The Plan Service (Phase 2C, Stage 3B): plan lifecycle orchestration and
 * authorization, between the (future, Stage 3C) API and the durable Plan
 * Store.
 *
 *   createPlan → approvePlan → [nextStep → quoteStep → bindQuote
 *     → (client builds, signs, sends, confirms via the existing SDK routes)
 *     → recordTx → settleStep]* ;  getPlan / listPlans / abandonPlan anytime
 *
 * Trust boundaries:
 *   - Identity: every call takes `auth.wallet`, the wallet the caller has
 *     ALREADY authenticated (Stage 3C verifies the wallet grant). This module
 *     never reads HTTP, cookies or a client-supplied wallet. Every operation
 *     after create goes through the store's loadPlan — rehydration plus its
 *     ownership check, so another wallet's plan reads as NOT_FOUND.
 *   - Structure: only the validator + planner, from the untrusted draft.
 *     Recipients (.nad / payee) are resolved and pinned HERE, server-side,
 *     before the plan is durable.
 *   - Quotes: only through the canonical SDK quote sequence
 *     (lib/sdk/preview.ts quoteAction) — the same validation, payment policy
 *     and quote token as the preview route. The token is returned once and
 *     never stored (the store keeps its SHA-256).
 *   - Settlement: only server-side records. The confirm route's stored
 *     verdict (sdk-settle:<txHash>) is keyed by transaction alone, so it is
 *     never enough to confirm a step: "confirmed" requires Stage 2's
 *     quote-bound output record (sdk-outputs:<quoteId>) for this exact
 *     quote, transaction, wallet and action. Anything less is "unverified".
 *
 * Progress is derived (lib/plan/state.ts), never stored. Plan gating is
 * advisory at build time: the SDK build/confirm routes are unchanged and
 * don't consult plans; the service records honest facts about what
 * happened.
 *
 * Never signs, broadcasts, builds a transaction, creates a wallet client,
 * holds keys, constructs calldata or calls an LLM.
 *
 * Server-only.
 */
import "server-only";
import { createHash } from "node:crypto";
import { PlanError } from "./errors";
import { planIntent } from "./planner";
import { recipientKey, resolveStepInputs } from "./resolve";
import {
  confirmedOutputsOf, currentStep, deriveNodeStates, derivePlanState, planExpiry, unresolvedIntent,
  type NodeState, type PlanState, type ReleaseReason, type ResultStatus,
} from "./state";
import * as store from "./store";
import type { ActionRef, InputValue, RecipientValue } from "./types";
import { validateIntentGraph } from "./validate";
import { reviewOf, type PlanReview, type ReviewConfig } from "./review";
import type { VerifiedOutputValue } from "@/lib/sdk/types";

/** The wallet the caller has authenticated (Stage 3C: the wallet grant). */
export interface PlanAuth {
  wallet: string;
}

export const LIST_PLANS_CAP = 20;
/** While the latest quote attempt has an SDK build younger than this and no
 *  recorded transaction, a new quote is refused — a signature may be in
 *  progress (see quoteStep). */
export const PENDING_BUILD_WINDOW_MS = 2 * 60 * 1000;
const ZERO = "0x0000000000000000000000000000000000000000";

const fail = (code: ConstructorParameters<typeof PlanError>[0], message: string, nodeId?: string): never => {
  throw new PlanError(code, message, nodeId);
};

async function context(auth: PlanAuth): Promise<store.StoreContext> {
  const { ensureBuiltinsRegistered } = await import("@/lib/sdk/bootstrap");
  const { getChain } = await import("@/lib/monad/config");
  ensureBuiltinsRegistered();
  return { sessionWallet: auth?.wallet, activeChainId: getChain().id };
}

/* ── Views (server-derived; never raw records) ─────────────────────────── */

export interface PlanNodeView {
  nodeId: string;
  ref: ActionRef;
  dependsOn: string[];
  state: NodeState;
  quoteAttempts: number;
  /**
   * The quote this node's execution is tied to, for recovery (e.g. calling
   * the SDK confirm route after a disconnect): the recorded transaction's
   * quote when there is one, else the latest quote attempt's, else null. A
   * random, non-secret id — never the quote token or any hash of it.
   */
  quoteId: string | null;
  txHash: string | null;
  result: { status: ResultStatus; outputs: Record<string, VerifiedOutputValue> | null } | null;
  /**
   * An unresolved signing attempt (Stage 5C-2d): its final action may have
   * been sent and nothing records the outcome. Only its quote id is shown.
   */
  signing: { quoteId: string } | null;
}

export interface PlanView {
  planId: string;
  state: PlanState;
  approved: boolean;
  abandoned: boolean;
  expired: boolean;
  approvable: boolean;
  createdAt: number;
  approveBy: number;
  expiresAt: number;
  currentStep: string | null;
  nodes: PlanNodeView[];
  /** The server-pinned recipients (recipientKey → address), for display. */
  recipients: Record<string, string>;
}

export interface PlanSummary {
  planId: string;
  /** The user's original request — inert text, for the list. */
  request: string;
  state: PlanState;
  /** Abandoned plans keep their facts; the list shows them as cancelled. */
  abandoned: boolean;
  /** A step's transaction is sent but not settled, or a signature for it may
   *  be pending — something may be on its way. */
  inFlight: boolean;
  currentStep: string | null;
  steps: number;
  createdAt: number;
  expiresAt: number;
}

function viewOf(l: store.LoadedPlan, now = Date.now()): PlanView {
  const states = deriveNodeStates(l.shape, l.facts);
  const exp = planExpiry(l.core, l.facts, now);
  return {
    planId: l.core.planId,
    state: derivePlanState(l.shape, l.facts),
    approved: !!l.facts.approval,
    abandoned: !!l.facts.abandoned,
    expired: exp.expired,
    approvable: exp.approvable && !l.facts.abandoned,
    createdAt: l.core.createdAt,
    approveBy: l.core.approveBy,
    expiresAt: l.core.expiresAt,
    currentStep: currentStep(l.shape, l.facts),
    nodes: l.plan.steps.map((s) => {
      const f = l.facts.nodes[s.nodeId];
      return {
        nodeId: s.nodeId,
        ref: { ...s.ref },
        dependsOn: [...s.dependsOn],
        state: states[s.nodeId],
        quoteAttempts: f.quotes.length,
        quoteId: f.tx?.quoteId ?? f.quotes.at(-1)?.quoteId ?? null,
        txHash: f.tx?.txHash ?? null,
        result: f.result ? { status: f.result.status, outputs: f.result.outputs ? JSON.parse(JSON.stringify(f.result.outputs)) : null } : null,
        signing: ((i) => (i ? { quoteId: i.quoteId } : null))(unresolvedIntent(f)),
      };
    }),
    recipients: { ...l.core.pins },
  };
}

/* ── Create / read ─────────────────────────────────────────────────────── */

function recipientsOf(inputs: Readonly<Record<string, InputValue>>): RecipientValue[] {
  const out: RecipientValue[] = [];
  for (const v of Object.values(inputs)) {
    if (v.kind === "recipient") out.push(v);
    else if (v.kind === "list") for (const item of v.items) for (const iv of Object.values(item)) if (iv.kind === "recipient") out.push(iv);
  }
  return out;
}

/**
 * Validate an UNTRUSTED draft for the authenticated wallet, plan it, resolve
 * and pin its .nad / payee recipients server-side, and store it. Nothing the
 * client sends is trusted as a plan id, hash, order, state, output, term or
 * pin — they are all derived here.
 */
export async function createPlan(auth: PlanAuth, draft: unknown): Promise<PlanView> {
  const ctx = await context(auth);
  const v = validateIntentGraph(draft, { sessionWallet: ctx.sessionWallet, activeChainId: ctx.activeChainId });
  if (!v.ok) throw new PlanError("INVALID_PLAN", v.error.message, v.error.nodeId, v.error.path);
  const graph = v.value;
  const plan = planIntent(graph, { sessionWallet: ctx.sessionWallet });

  const { resolveRecipientInput } = await import("@/lib/payees/resolve");
  const pins: Record<string, string> = {};
  for (const n of graph.nodes) {
    for (const r of recipientsOf(n.inputs)) {
      if (r.source === "address") continue; // typed 0x: used as written
      const key = recipientKey(r);
      if (Object.prototype.hasOwnProperty.call(pins, key)) continue;
      let res: Awaited<ReturnType<typeof resolveRecipientInput>>;
      try {
        res = await resolveRecipientInput(r.display);
      } catch {
        return fail("RECIPIENT_UNRESOLVED", `Couldn't resolve "${r.display}".`, n.nodeId);
      }
      if (!res.ok) return fail("RECIPIENT_UNRESOLVED", res.message, n.nodeId);
      if (res.source !== r.source) return fail("RECIPIENT_UNRESOLVED", `"${r.display}" isn't a ${r.source === "nad" ? ".nad name" : "known payee"}.`, n.nodeId);
      if (typeof res.address !== "string" || res.address.toLowerCase() === ZERO) return fail("RECIPIENT_UNRESOLVED", `"${r.display}" has no usable address.`, n.nodeId);
      pins[key] = res.address;
    }
  }

  const { core } = await store.createPlan(graph, plan, pins, ctx);
  return getPlan(auth, core.planId);
}

export async function getPlan(auth: PlanAuth, planId: string): Promise<PlanView> {
  const ctx = await context(auth);
  return viewOf(await store.loadPlan(planId, ctx));
}

/* ── Review (Stage 5B) ─────────────────────────────────────────────────── */

/** Server configuration for reviews: chain, token metadata and fee limits —
 *  all from existing config modules, never from the request. */
async function reviewConfig(): Promise<ReviewConfig> {
  const { getChain, getStablecoin } = await import("@/lib/monad/config");
  const { MAX_PLATFORM_FEE_BPS } = await import("@/lib/sdk/fees");
  const { DEFAULT_SLIPPAGE } = await import("@/lib/monad/swap");
  const chain = getChain();
  let stable: ReviewConfig["stable"] = null;
  try {
    const s = getStablecoin();
    stable = { address: s.address, symbol: s.symbol, decimals: s.decimals };
  } catch {
    stable = null; // no stablecoin configured: only MON can be described
  }
  return {
    chain: { id: chain.id, name: chain.name },
    monDecimals: chain.nativeCurrency.decimals,
    stable,
    maxPlatformFeeBps: MAX_PLATFORM_FEE_BPS,
    swapDefaultSlippageBps: Math.round(DEFAULT_SLIPPAGE * 10_000),
  };
}

/** The plan view and its server-derived review, from one load. */
export async function getPlanWithReview(auth: PlanAuth, planId: string): Promise<{ plan: PlanView; review: PlanReview }> {
  const ctx = await context(auth);
  const l = await store.loadPlan(planId, ctx);
  const now = Date.now();
  return { plan: viewOf(l, now), review: reviewOf(l, await reviewConfig(), now) };
}

/** The wallet's live plans, newest first, at most LIST_PLANS_CAP. Entries
 *  that don't load cleanly (stale, corrupt, foreign) are skipped. */
export async function listPlans(auth: PlanAuth): Promise<PlanSummary[]> {
  const ctx = await context(auth);
  if (typeof auth?.wallet !== "string") return [];
  const cores = await store.listPlansForWallet(auth.wallet);
  const summarize = async (c: (typeof cores)[number]): Promise<PlanSummary | null> => {
    try {
      const l = await store.loadPlan(c.planId, ctx);
      const nodeStates = deriveNodeStates(l.shape, l.facts);
      const inFlight = l.core.stepOrder.some((id) => nodeStates[id] === "submitted" || unresolvedIntent(l.facts.nodes[id]) !== null);
      return {
        planId: l.core.planId, request: l.graph.source.text, state: derivePlanState(l.shape, l.facts), abandoned: l.facts.abandoned !== null, inFlight,
        currentStep: currentStep(l.shape, l.facts),
        steps: l.core.stepOrder.length, createdAt: l.core.createdAt, expiresAt: l.core.expiresAt,
      };
    } catch {
      return null; // skipped
    }
  };
  // Newest first, at most LIST_PLANS_CAP that load cleanly — read a chunk at
  // a time (bounded concurrency) instead of one plan after another.
  const out: PlanSummary[] = [];
  for (let i = 0; i < cores.length && out.length < LIST_PLANS_CAP; i += LIST_PLANS_CAP) {
    const chunk = await store.mapBounded(cores.slice(i, i + LIST_PLANS_CAP), 4, summarize);
    for (const s of chunk) if (s && out.length < LIST_PLANS_CAP) out.push(s);
  }
  return out;
}

/* ── Approve / abandon ─────────────────────────────────────────────────── */

/** Approve within the window (store: NOT_APPROVABLE when late or abandoned;
 *  idempotent when repeated). Executes nothing. */
export async function approvePlan(auth: PlanAuth, planId: string): Promise<PlanView> {
  const ctx = await context(auth);
  // Only a plan whose every step can be shown faithfully may be approved —
  // decided here, from the stored plan; nothing from the client counts.
  const l = await store.loadPlan(planId, ctx);
  if (!reviewOf(l, await reviewConfig(), Date.now()).reviewable) {
    fail("NOT_APPROVABLE", "This plan includes a step PayAI can't show you in full, so it can't be approved.");
  }
  await store.approvePlan(planId, ctx);
  return getPlan(auth, planId);
}

/** Abandon (idempotent). Blocks further approvals and quotes; facts are kept
 *  and a transaction already sent may still be recorded and settled. */
export async function abandonPlan(auth: PlanAuth, planId: string): Promise<PlanView> {
  const ctx = await context(auth);
  await store.abandonPlan(planId, ctx);
  return getPlan(auth, planId);
}

/* ── Next step ─────────────────────────────────────────────────────────── */

export interface NextStep {
  nodeId: string;
  ref: ActionRef;
  state: NodeState;
  quotable: boolean;
  reason?: string;
}

function next(l: store.LoadedPlan): NextStep {
  if (!l.facts.approval) return fail("NOT_APPROVED", "Approve this plan first.");
  const id = currentStep(l.shape, l.facts);
  if (id === null) return fail("STEP_NOT_READY", "This plan has no step left to run.");
  const step = l.plan.steps.find((s) => s.nodeId === id);
  if (!step) return fail("INVALID_NODE", "No such step in this plan.", id);
  const states = deriveNodeStates(l.shape, l.facts);
  const state = states[id];
  const base = { nodeId: id, ref: { ...step.ref }, state };
  if (l.facts.abandoned) return { ...base, quotable: false, reason: "This plan was abandoned." };
  if (step.dependsOn.some((d) => states[d] !== "confirmed")) return { ...base, quotable: false, reason: "A step this one depends on hasn't confirmed." };
  if (state === "submitted") return { ...base, quotable: false, reason: "This step's transaction is waiting to settle." };
  if (state !== "pending" && state !== "awaiting_signature") return { ...base, quotable: false, reason: "This step has ended." };
  return { ...base, quotable: true };
}

/** The current step and whether it can be quoted now. Read-only. */
export async function nextStep(auth: PlanAuth, planId: string): Promise<NextStep> {
  const ctx = await context(auth);
  return next(await store.loadPlan(planId, ctx));
}

/** The node must be the quotable current step. */
function requireQuotable(l: store.LoadedPlan, nodeId: string): NextStep {
  if (!l.plan.steps.some((s) => s.nodeId === nodeId)) fail("INVALID_NODE", "No such step in this plan.", nodeId);
  const n = next(l);
  if (n.nodeId !== nodeId) fail("STEP_NOT_READY", "That isn't the plan's current step.", nodeId);
  if (!n.quotable) fail("STEP_NOT_READY", n.reason ?? "This step can't proceed.", nodeId);
  return n;
}

/* ── Quote / bind ──────────────────────────────────────────────────────── */

export interface StepQuote {
  nodeId: string;
  ref: ActionRef;
  attempt: number;
  quoteId: string;
  /** Returned ONCE — the store keeps only its SHA-256. The client presents it
   *  to bindQuote and to the existing build route. */
  quoteToken: string;
  inputs: Readonly<Record<string, unknown>>;
  summary: string;
  details: Readonly<Record<string, string>>;
  quotedAt: number;
  risk?: { score: number; level: string; compliance: string };
  warnings?: string[];
}

/**
 * Quote the current step: resolve its inputs from VERIFIED confirmed outputs,
 * the pinned recipients and (for a fee-on-top action) the live platform fee;
 * quote through the canonical SDK sequence; record the attempt. No retry: a
 * concurrent attempt for the same number loses with CONFLICT.
 */
export async function quoteStep(auth: PlanAuth, planId: string, nodeId: string): Promise<StepQuote> {
  const ctx = await context(auth);
  const l = await store.loadPlan(planId, ctx);
  requireQuotable(l, nodeId);
  const step = l.plan.steps.find((s) => s.nodeId === nodeId)!;

  // Pending-build guard: if the latest attempt was already BUILT (the SDK
  // build record exists) less than PENDING_BUILD_WINDOW_MS ago and no
  // transaction is recorded, a wallet may be about to sign it. Quoting again
  // would let a second runner build a second, independent transaction and
  // prompt the user to sign twice. Not a lock: it lapses once a transaction
  // is recorded (the step is then no longer quotable) or the window passes.
  // Unresolved-signature guard (Stage 5C-2d): a final signature for this
  // node may have been requested and nothing records whether it was sent.
  // Not time-based — it holds until a transaction is recorded for that quote
  // or the attempt is released. Quoting again could pay twice.
  if (unresolvedIntent(l.facts.nodes[nodeId])) {
    fail("SIGNATURE_UNRESOLVED", "A signature for this step may already have been sent. Check your wallet's activity before continuing.", nodeId);
  }

  const latest = l.facts.nodes[nodeId].quotes.at(-1);
  if (latest && !l.facts.nodes[nodeId].tx) {
    const { peekRequest } = await import("@/lib/platform/idempotency");
    const { buildKey } = await import("@/lib/sdk/settlement");
    const build = await peekRequest<unknown>(buildKey(latest.quoteId));
    if (build !== null && build !== undefined) {
      const now = Date.now();
      // A usable build time is a finite number not in the future. Anything
      // else (missing, non-number, NaN, future) is malformed and falls back to
      // the quote's own record time, so bad data can never extend the window.
      const validBuiltAt = isPlain(build) && typeof build.builtAt === "number" && Number.isFinite(build.builtAt) && build.builtAt <= now;
      const builtAt = validBuiltAt ? (build.builtAt as number) : latest.recordedAt;
      if (now - builtAt < PENDING_BUILD_WINDOW_MS) {
        fail("STEP_NOT_READY", "This step's last quote was just prepared for signing — finish or cancel that in your wallet, or try again shortly.", nodeId);
      }
    }
  }

  const attempt = store.nextQuoteAttempt(l, nodeId);
  if (attempt > store.MAX_QUOTE_ATTEMPTS) fail("CONFLICT", "This step has reached its maximum number of quotes.", nodeId);

  const { ActionInputError } = await import("@/lib/sdk/types");
  let feeBps: number | undefined;
  if (step.feePolicy?.mode === "on_top") {
    const { readPlatformFeeTerms } = await import("@/lib/sdk/fees");
    try {
      feeBps = (await readPlatformFeeTerms()).feeBps;
    } catch (e) {
      return fail("QUOTE_REFUSED", e instanceof ActionInputError ? e.message : "PayAI's fee terms are unavailable right now.", nodeId);
    }
  }

  const inputs = resolveStepInputs({
    plan: l.plan, graph: l.graph, nodeId, sessionWallet: ctx.sessionWallet,
    confirmed: confirmedOutputsOf(l.facts) as never, recipients: l.core.pins, feeBps,
  });

  const { quoteAction } = await import("@/lib/sdk/preview");
  let q: Awaited<ReturnType<typeof quoteAction>>;
  try {
    q = await quoteAction(step.ref, inputs);
  } catch (e) {
    if (e instanceof ActionInputError) return fail("QUOTE_REFUSED", e.message, nodeId);
    throw e;
  }
  if (!q.ok) return fail("QUOTE_REFUSED", q.message, nodeId);
  // The fee the remainder was computed with must be the fee the quote is
  // priced on — otherwise the amounts don't add up. Nothing is recorded.
  if (feeBps !== undefined && q.quote.terms?.feeBps !== String(feeBps)) {
    return fail("QUOTE_REFUSED", "PayAI's fee rate changed while quoting — try again.", nodeId);
  }

  const { inputsHash, termsHash } = await import("@/lib/sdk/quoteToken");
  await store.recordQuote(planId, nodeId, {
    attempt, quoteId: q.quoteId, quoteToken: q.quoteToken,
    inputsHash: inputsHash(q.inputs), termsHash: termsHash(q.quote.terms), quotedAt: q.quote.quotedAt,
  }, ctx);

  return {
    nodeId, ref: { ...step.ref }, attempt, quoteId: q.quoteId, quoteToken: q.quoteToken,
    inputs: q.inputs, summary: q.quote.summary, details: q.quote.details, quotedAt: q.quote.quotedAt,
    ...(q.policy ? { risk: { score: q.policy.riskScore, level: q.policy.riskLevel, compliance: q.policy.compliance }, warnings: q.policy.warnings } : {}),
  };
}

export interface BoundQuote {
  nodeId: string;
  ref: ActionRef;
  attempt: number;
  quoteId: string;
  quotedAt: number;
  /** quotedAt + the SDK's QUOTE_MAX_AGE_MS: build must happen before this. */
  freshUntil: number;
}

/**
 * Check that `quoteToken` is the token this service issued for the node's
 * LATEST quote attempt (by SHA-256 against the stored hash), that the quote
 * is still fresh by the SDK's own rule, and that the step is still the
 * quotable current step. Writes nothing — the quote attempt is the binding.
 */
export async function bindQuote(auth: PlanAuth, planId: string, nodeId: string, quoteToken: unknown): Promise<BoundQuote> {
  const ctx = await context(auth);
  const l = await store.loadPlan(planId, ctx);
  const n = requireQuotable(l, nodeId);
  const latest = l.facts.nodes[nodeId].quotes.at(-1);
  if (!latest) return fail("NOT_FOUND", "This step has no quote.", nodeId);
  if (typeof quoteToken !== "string" || quoteToken.length === 0 || quoteToken.length > 2048) return fail("NOT_FOUND", "That quote isn't this step's.", nodeId);
  const hash = createHash("sha256").update(quoteToken, "utf8").digest("hex");
  if (hash !== latest.quoteTokenHash) return fail("NOT_FOUND", "That quote isn't this step's latest quote.", nodeId);
  const { QUOTE_MAX_AGE_MS } = await import("@/lib/sdk/validate");
  const now = Date.now();
  if (now - latest.quotedAt > QUOTE_MAX_AGE_MS || latest.quotedAt > now + 5_000) return fail("EXPIRED", "This quote is too old — request a new one.", nodeId);
  return { nodeId, ref: n.ref, attempt: latest.attempt, quoteId: latest.quoteId, quotedAt: latest.quotedAt, freshUntil: latest.quotedAt + QUOTE_MAX_AGE_MS };
}

/* ── Transaction / settlement ──────────────────────────────────────────── */

const isPlain = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/**
 * Record that the step's transaction was SUBMITTED (never "confirmed"). The
 * quote must be one of the node's, and the SDK build record for it must
 * exist for this plan's wallet and this step's exact action and version —
 * proof the transaction was built for this quote by PayAI. Allowed on an
 * abandoned plan (the chain is authoritative), not on an expired one.
 */
export async function recordTx(auth: PlanAuth, planId: string, nodeId: string, input: { quoteId: unknown; txHash: unknown }): Promise<PlanView> {
  const ctx = await context(auth);
  const l = await store.loadPlan(planId, ctx);
  const step = l.plan.steps.find((s) => s.nodeId === nodeId);
  if (!step) return fail("INVALID_NODE", "No such step in this plan.", nodeId);
  if (!l.facts.approval) return fail("NOT_APPROVED", "Approve this plan first.", nodeId);
  const f = l.facts.nodes[nodeId];
  const quoteId = typeof input?.quoteId === "string" ? input.quoteId : "";
  const txHash = typeof input?.txHash === "string" ? input.txHash : "";

  if (!f.tx) {
    // Eligibility for a NEW submission: no result, every dependency confirmed.
    const states = deriveNodeStates(l.shape, l.facts);
    if (f.result || step.dependsOn.some((d) => states[d] !== "confirmed")) fail("STEP_NOT_READY", "This step can't take a transaction now.", nodeId);
  }
  if (!f.quotes.some((q) => q.quoteId === quoteId)) return fail("NOT_FOUND", "No such quote for this step.", nodeId);

  const { peekRequest } = await import("@/lib/platform/idempotency");
  const { buildKey } = await import("@/lib/sdk/settlement");
  const build = await peekRequest<unknown>(buildKey(quoteId));
  if (
    !isPlain(build) || build.wallet !== l.core.wallet ||
    build.protocolId !== step.ref.protocolId || build.actionId !== step.ref.actionId || build.version !== step.ref.version
  ) return fail("NOT_FOUND", "No matching prepared transaction for this quote.", nodeId);

  await store.recordTx(planId, nodeId, { quoteId, txHash }, ctx);
  return getPlan(auth, planId);
}

/** SHA-256 of a build record's final transaction (to, data, value), or null
 *  when the record has no usable final transaction. */
function buildDigestOf(build: Record<string, unknown>): string | null {
  const t = build.finalTx;
  if (!isPlain(t) || typeof t.to !== "string" || typeof t.data !== "string" || typeof t.value !== "string") return null;
  const canonical = JSON.stringify({ to: t.to.toLowerCase(), data: t.data.toLowerCase(), value: t.value });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Record the signing intent for the current step's latest quote (Stage
 * 5C-2d): called immediately BEFORE the final action is requested from the
 * wallet. The quote's SDK build record must exist for this plan's wallet and
 * this step's exact action; its final transaction is digested here. The
 * wallet comes from the plan, never the request. Until a transaction is
 * recorded for this quote or the attempt is released, the step can't be
 * quoted again (SIGNATURE_UNRESOLVED).
 */
export async function recordSigningIntent(auth: PlanAuth, planId: string, nodeId: string, input: { quoteId: unknown }): Promise<PlanView> {
  const ctx = await context(auth);
  const l = await store.loadPlan(planId, ctx);
  const step = l.plan.steps.find((s) => s.nodeId === nodeId);
  if (!step) return fail("INVALID_NODE", "No such step in this plan.", nodeId);
  if (!l.facts.approval) return fail("NOT_APPROVED", "Approve this plan first.", nodeId);
  if (l.facts.abandoned) return fail("STEP_NOT_READY", "This plan was abandoned.", nodeId);
  const states = deriveNodeStates(l.shape, l.facts);
  if (currentStep(l.shape, l.facts) !== nodeId || states[nodeId] !== "awaiting_signature") {
    return fail("STEP_NOT_READY", "That isn't the plan's current step.", nodeId);
  }
  const quoteId = typeof input?.quoteId === "string" ? input.quoteId : "";

  const { peekRequest } = await import("@/lib/platform/idempotency");
  const { buildKey } = await import("@/lib/sdk/settlement");
  const build = /^[0-9a-f]{32}$/.test(quoteId) ? await peekRequest<unknown>(buildKey(quoteId)) : null;
  if (
    !isPlain(build) || build.wallet !== l.core.wallet ||
    build.protocolId !== step.ref.protocolId || build.actionId !== step.ref.actionId || build.version !== step.ref.version
  ) return fail("NOT_FOUND", "No matching prepared transaction for this quote.", nodeId);
  const buildDigest = buildDigestOf(build);
  if (!buildDigest) return fail("NOT_FOUND", "No matching prepared transaction for this quote.", nodeId);

  await store.recordSigningIntent(planId, nodeId, { quoteId, buildDigest }, ctx);
  return getPlan(auth, planId);
}

const RELEASE_REASONS: readonly ReleaseReason[] = ["wallet_rejected", "user_attested_not_sent"];

/**
 * Release one signing attempt: the owner states its final action was not
 * sent (the wallet rejected it, or they checked). The intent stays; a
 * transaction for that quote can still be recorded later. Allowed on an
 * abandoned plan, not an expired one.
 */
export async function releaseAttempt(auth: PlanAuth, planId: string, nodeId: string, input: { quoteId: unknown; reason: unknown }): Promise<PlanView> {
  const ctx = await context(auth);
  const l = await store.loadPlan(planId, ctx);
  if (!l.plan.steps.some((s) => s.nodeId === nodeId)) return fail("INVALID_NODE", "No such step in this plan.", nodeId);
  const quoteId = typeof input?.quoteId === "string" ? input.quoteId : "";
  const reason = input?.reason;
  if (typeof reason !== "string" || !RELEASE_REASONS.includes(reason as ReleaseReason)) return fail("INVALID_PLAN", "Invalid release reason.", nodeId);
  await store.recordRelease(planId, nodeId, { quoteId, reason: reason as ReleaseReason }, ctx);
  return getPlan(auth, planId);
}

/**
 * Settle the step from server-side records only:
 *   1. the confirm route's stored verdict for the step's transaction
 *      (sdk-settle:<txHash>) — none yet → SETTLEMENT_PENDING, nothing written;
 *   2. reverted → "reverted"; any non-success → "unverified";
 *   3. success is only a CANDIDATE: "confirmed" requires Stage 2's output
 *      record for this exact quote, transaction, wallet and action
 *      (readOutputRecord → "recorded"), whose outputs are copied as-is.
 *      Otherwise "unverified" with no outputs — including every action
 *      without confirmedOutputs.
 * The store downgrades a confirmed result missing an output a later step
 * needs to "unverified". Idempotent once a result exists.
 */
export async function settleStep(auth: PlanAuth, planId: string, nodeId: string): Promise<PlanView> {
  const ctx = await context(auth);
  const l = await store.loadPlan(planId, ctx);
  const step = l.plan.steps.find((s) => s.nodeId === nodeId);
  if (!step) return fail("INVALID_NODE", "No such step in this plan.", nodeId);
  const f = l.facts.nodes[nodeId];
  if (!f.tx) return fail("NOT_FOUND", "This step has no submitted transaction.", nodeId);
  if (f.result) return viewOf(l);

  const { peekRequest } = await import("@/lib/platform/idempotency");
  const { settleKey, readOutputRecord } = await import("@/lib/sdk/settlement");
  const verdict = await peekRequest<unknown>(settleKey(f.tx.txHash));
  if (verdict === null || verdict === undefined) return fail("SETTLEMENT_PENDING", "This transaction hasn't been confirmed yet.", nodeId);

  let status: ResultStatus = "unverified";
  let outputs: Record<string, VerifiedOutputValue> | null = null;
  if (isPlain(verdict) && verdict.ok === false && verdict.reverted === true) {
    status = "reverted";
  } else if (isPlain(verdict) && verdict.ok === true && verdict.success === true) {
    const rec = await readOutputRecord({
      quoteId: f.tx.quoteId, txHash: f.tx.txHash, wallet: l.core.wallet,
      protocolId: step.ref.protocolId, actionId: step.ref.actionId, version: step.ref.version,
    });
    if (rec.status === "recorded") {
      status = "confirmed";
      outputs = JSON.parse(JSON.stringify(rec.record.outputs));
    }
  }

  await store.recordResult(planId, nodeId, { quoteId: f.tx.quoteId, txHash: f.tx.txHash, status, outputs }, ctx);
  return getPlan(auth, planId);
}
