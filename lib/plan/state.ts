/**
 * Plan state, DERIVED — never stored (Phase 2C, Stage 3A).
 *
 * The Plan Store (./store.ts) keeps only immutable facts: the plan's core,
 * its approval, each node's quote attempts, transaction and result, and its
 * abandonment. Everything a caller asks about progress — each node's state,
 * the plan's state, which step is next — is a pure function of those facts,
 * so there is no mutable state that could ever contradict them.
 *
 * Pure: no I/O, no clock reads (the caller passes `now`), no execution.
 */
import type { VerifiedOutputValue } from "@/lib/sdk/types";
import type { ConfirmedOutputValue } from "./types";

/* ── Fact shapes (stored by ./store.ts) ────────────────────────────────── */

export interface ApprovalFact { planId: string; graphHash: string; wallet: string; approvedAt: number }

export interface QuoteFact {
  planId: string;
  nodeId: string;
  attempt: number;
  quoteId: string;
  /** SHA-256 (hex) of the quote token — the token itself is never stored. */
  quoteTokenHash: string;
  inputsHash: string;
  termsHash: string;
  quotedAt: number;
  recordedAt: number;
}

export interface TxFact { planId: string; nodeId: string; quoteId: string; txHash: string; wallet: string; submittedAt: number }

export type ResultStatus = "confirmed" | "reverted" | "unverified";

export interface ResultFact {
  planId: string;
  nodeId: string;
  quoteId: string;
  txHash: string;
  status: ResultStatus;
  outputs: Readonly<Record<string, VerifiedOutputValue>> | null;
  recordedAt: number;
}

export interface AbandonFact { planId: string; wallet: string; abandonedAt: number }

export interface NodeFacts {
  /** Attempts in order (1, 2, …). */
  quotes: readonly QuoteFact[];
  tx: TxFact | null;
  result: ResultFact | null;
}

export interface PlanFacts {
  approval: ApprovalFact | null;
  abandoned: AbandonFact | null;
  nodes: Readonly<Record<string, NodeFacts>>;
}

/** The structure state derivation needs: the validator's order and each
 *  node's dependencies (both from the stored, rehydrated plan). */
export interface PlanShape {
  stepOrder: readonly string[];
  dependsOn: Readonly<Record<string, readonly string[]>>;
}

/* ── Node state ────────────────────────────────────────────────────────── */

export type NodeState = "pending" | "awaiting_signature" | "submitted" | "confirmed" | "reverted" | "unverified" | "skipped";

const FAILED: ReadonlySet<NodeState> = new Set(["reverted", "unverified", "skipped"]);
const TERMINAL: ReadonlySet<NodeState> = new Set(["confirmed", "reverted", "unverified", "skipped"]);

const EMPTY: NodeFacts = { quotes: [], tx: null, result: null };

/**
 * Every node's state, in step order (dependencies first, so a failure
 * propagates to direct AND indirect dependents):
 *   1. a result → its status (confirmed / reverted / unverified);
 *   2. else a transaction → submitted (the chain may still settle it, even
 *      on an abandoned plan);
 *   3. else skipped, when any dependency is reverted / unverified / skipped,
 *      or the plan is abandoned;
 *   4. else awaiting_signature, when a quote exists on an approved plan;
 *   5. else pending.
 */
export function deriveNodeStates(shape: PlanShape, facts: PlanFacts): Record<string, NodeState> {
  const out: Record<string, NodeState> = {};
  for (const id of shape.stepOrder) out[id] = deriveOne(id, shape, facts, out);
  return out;
}

/** One node's state (derives its dependencies as needed). */
export function deriveNodeState(nodeId: string, shape: PlanShape, facts: PlanFacts): NodeState {
  const states = deriveNodeStates(shape, facts);
  if (!Object.prototype.hasOwnProperty.call(states, nodeId)) throw new Error(`Unknown node "${nodeId}".`);
  return states[nodeId];
}

function deriveOne(id: string, shape: PlanShape, facts: PlanFacts, done: Record<string, NodeState>): NodeState {
  const f = Object.prototype.hasOwnProperty.call(facts.nodes, id) ? facts.nodes[id] : EMPTY;
  if (f.result) return f.result.status;
  if (f.tx) return "submitted";
  const deps = shape.dependsOn[id] ?? [];
  // The step order is the validator's (dependencies first), so every
  // dependency is already derived here.
  if (deps.some((d) => FAILED.has(done[d]))) return "skipped";
  if (facts.abandoned) return "skipped";
  if (f.quotes.length > 0 && facts.approval) return "awaiting_signature";
  return "pending";
}

/* ── Plan state ────────────────────────────────────────────────────────── */

export type PlanState = "planned" | "approved" | "running" | "completed" | "failed" | "partial";

/**
 *   completed — every node confirmed;
 *   partial / failed — every node terminal, with / without a confirmed one;
 *   running — any node has a quote, transaction or result;
 *   approved — an approval exists;
 *   planned — otherwise.
 * Expiry is separate (planExpiry) and never changes this.
 */
export function derivePlanState(shape: PlanShape, facts: PlanFacts): PlanState {
  const states = deriveNodeStates(shape, facts);
  const all = shape.stepOrder.map((id) => states[id]);
  if (all.length > 0 && all.every((s) => s === "confirmed")) return "completed";
  if (all.length > 0 && all.every((s) => TERMINAL.has(s))) return all.includes("confirmed") ? "partial" : "failed";
  const touched = shape.stepOrder.some((id) => {
    const f = facts.nodes[id];
    return !!f && (f.quotes.length > 0 || !!f.tx || !!f.result);
  });
  if (touched) return "running";
  if (facts.approval) return "approved";
  return "planned";
}

/** The first step that is neither confirmed nor skipped, in the stored
 *  validator order; null when there is none. */
export function currentStep(shape: PlanShape, facts: PlanFacts): string | null {
  const states = deriveNodeStates(shape, facts);
  return shape.stepOrder.find((id) => states[id] !== "confirmed" && states[id] !== "skipped") ?? null;
}

/** Expiry, separate from state: past expiresAt the plan is expired; past
 *  approveBy without an approval it can no longer be approved. */
export function planExpiry(
  core: { approveBy: number; expiresAt: number }, facts: Pick<PlanFacts, "approval">, now: number,
): { expired: boolean; approvable: boolean } {
  const expired = now >= core.expiresAt;
  return { expired, approvable: !expired && !facts.approval && now <= core.approveBy };
}

/* ── Results → planner-compatible confirmed outputs ────────────────────── */

/** A units[] output: a real verified SDK result the Stage 1 planner can't
 *  bind (its resolver refuses any type but units/token). */
export type ListOutputValue = Extract<VerifiedOutputValue, { type: "units[]" }>;

export type PlannerConfirmedOutputs = Record<string, Record<string, ConfirmedOutputValue | ListOutputValue>>;

/**
 * Confirmed results' outputs, by node, in the shape resolveStepInputs takes
 * (lib/plan/resolve.ts ConfirmedOutputs). Only CONFIRMED results contribute;
 * values are copied exactly — verified stays true, integer strings, token
 * identity and the native zero address are preserved. units[] is kept as the
 * real SDK value it is (the resolver refuses to bind it).
 */
export function confirmedOutputsOf(facts: PlanFacts): PlannerConfirmedOutputs {
  const out: PlannerConfirmedOutputs = {};
  for (const [nodeId, f] of Object.entries(facts.nodes)) {
    if (f.result?.status !== "confirmed") continue;
    const node: Record<string, ConfirmedOutputValue | ListOutputValue> = {};
    for (const [name, v] of Object.entries(f.result.outputs ?? {})) {
      if (v.type === "units") node[name] = { verified: true, type: "units", value: v.value, token: v.token };
      else if (v.type === "token") node[name] = { verified: true, type: "token", value: v.value };
      else node[name] = { verified: true, type: "units[]", value: [...v.value], token: v.token };
    }
    out[nodeId] = node;
  }
  return out;
}
