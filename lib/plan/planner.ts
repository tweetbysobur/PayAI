/**
 * Deterministic Intent Planner (Phase 2C, Stage 1).
 *
 *   validateIntentGraph() → ValidatedIntentGraph → planIntent() → ExecutionPlan
 *
 * Turns a VALIDATED graph into an ordered list of steps — which action, at
 * which exact version, with which inputs, after which dependencies — and
 * nothing more. It accepts only a graph the validator itself returned
 * (checked by identity at runtime, not by type), keeps the validator's
 * topological order, and fingerprints the graph so a plan can't later be
 * paired with a different one (assertPlanMatchesGraph).
 *
 * The plan carries NO transaction target, calldata, value, signature, key
 * or broadcast detail. The planner never executes, signs, broadcasts, reads
 * the chain or calls an LLM; bound values are resolved later, from
 * confirmed outputs only, by resolveStepInputs (./resolve.ts).
 *
 * Pure: the same graph always yields the same plan (same planId too).
 */
import "server-only";
import { createHash } from "node:crypto";
import { PlanError } from "./errors";
import { isValidatedIntentGraph } from "./validate";
import {
  INTENT_CHAIN_ID,
  type ExecutionPlan, type InputValue, type PlanExpectation, type PlanStep, type ScalarInputValue, type ValidatedIntentGraph,
} from "./types";

/** Every plan planIntent has returned, by identity. */
const PLANS = new WeakSet<object>();

/** True only for a plan planIntent itself returned. */
export function isExecutionPlan(p: unknown): p is ExecutionPlan {
  return typeof p === "object" && p !== null && PLANS.has(p);
}

/* ── Canonical serialization + graph hash ───────────────────────────────── */

/**
 * Canonical JSON: object keys sorted (recursively, by code unit), array order
 * preserved, no whitespace. Only JSON data is accepted — anything else
 * (undefined in an array, a function, a non-finite number, a non-plain
 * object) is refused rather than silently dropped or coerced.
 */
export function canonicalize(v: unknown): string {
  if (v === null || typeof v === "string" || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new PlanError("INVALID_PLAN", "Can't serialize a non-finite number.");
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(",")}]`;
  if (typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(o[k])}`).join(",")}}`;
  }
  throw new PlanError("INVALID_PLAN", "Can't serialize a non-JSON value.");
}

/**
 * SHA-256 over what the user asked for and what validation fixed: id,
 * version, wallet, chain, source, node order, and each node's ref, inputs and
 * dependsOn. Runtime state (status, validation/execution/verification) is
 * excluded, so progress never changes a plan's identity.
 */
export function graphHash(graph: ValidatedIntentGraph): string {
  const body = {
    id: graph.id,
    version: graph.version,
    wallet: graph.wallet,
    chainId: graph.chainId,
    source: graph.source,
    order: graph.order,
    nodes: graph.nodes.map((n) => ({ nodeId: n.nodeId, ref: n.ref, inputs: n.inputs, dependsOn: n.dependsOn })),
  };
  return createHash("sha256").update(canonicalize(body), "utf8").digest("hex");
}

/* ── Planning ───────────────────────────────────────────────────────────── */

export interface PlanContext {
  /** The authenticated session's wallet — never a client-supplied value. */
  sessionWallet: string | null | undefined;
}

export function planIntent(graph: ValidatedIntentGraph, ctx: PlanContext): ExecutionPlan {
  if (!isValidatedIntentGraph(graph)) {
    throw new PlanError("UNVALIDATED_GRAPH", "Only an intent that passed validation can be planned.");
  }
  if (graph.chainId !== INTENT_CHAIN_ID) throw new PlanError("INVALID_PLAN", "Wrong chain.");
  assertSessionWallet(graph.wallet, ctx.sessionWallet);

  const hash = graphHash(graph);
  const byId = new Map(graph.nodes.map((n) => [n.nodeId, n]));

  // Which outputs each producer must report for later steps.
  const needed = new Map<string, Set<string>>();
  for (const n of graph.nodes) {
    for (const [, , v] of boundPositions(n.inputs)) {
      if (!needed.has(v.node)) needed.set(v.node, new Set());
      needed.get(v.node)!.add(v.output);
    }
  }

  const steps: PlanStep[] = graph.order.map((id) => {
    const n = byId.get(id);
    if (!n) throw new PlanError("INVALID_PLAN", `Order names an unknown node "${id}".`, id);
    const expects: PlanExpectation[] = [];
    for (const [path, , v] of boundPositions(n.inputs)) {
      const proven = graph.boundOutputs[v.node]?.[v.output];
      if (!proven) throw new PlanError("INVALID_PLAN", `No proven token for ${v.node}.${v.output}.`, id, path);
      expects.push({ path, node: v.node, output: v.output, type: proven.type, token: proven.token });
    }
    const policy = graph.feePolicies[id];
    return {
      nodeId: n.nodeId,
      ref: { protocolId: n.ref.protocolId, actionId: n.ref.actionId, version: n.ref.version },
      inputs: n.inputs,
      dependsOn: [...n.dependsOn],
      outputsNeeded: [...(needed.get(id) ?? [])].sort(),
      expects,
      feePolicy: policy ? { mode: policy.mode } : null,
    };
  });

  const plan: ExecutionPlan = deepFreeze({
    planId: `plan_${createHash("sha256").update(`payai-plan:v1:${hash}`, "utf8").digest("hex").slice(0, 32)}`,
    graphHash: hash,
    wallet: graph.wallet,
    chainId: INTENT_CHAIN_ID,
    steps,
  });
  PLANS.add(plan);
  return plan;
}

/**
 * Refuses a plan that planIntent didn't produce, or a graph that isn't the
 * one it was planned from: any change to what graphHash covers — or to the
 * wallet, chain or step order — is GRAPH_MUTATION.
 */
export function assertPlanMatchesGraph(plan: ExecutionPlan, graph: ValidatedIntentGraph): void {
  if (!isExecutionPlan(plan)) throw new PlanError("INVALID_PLAN", "Not a plan PayAI produced.");
  if (!isValidatedIntentGraph(graph)) throw new PlanError("UNVALIDATED_GRAPH", "Only an intent that passed validation can be checked.");
  const mismatch =
    graphHash(graph) !== plan.graphHash ||
    graph.wallet !== plan.wallet ||
    graph.chainId !== plan.chainId ||
    graph.order.length !== plan.steps.length ||
    graph.order.some((id, i) => plan.steps[i].nodeId !== id);
  if (mismatch) throw new PlanError("GRAPH_MUTATION", "This intent changed after it was planned.");
}

/** The plan's wallet must be the signed-in wallet — checked again at plan
 *  and resolve time, not only at validation. */
export function assertSessionWallet(wallet: string, sessionWallet: string | null | undefined): void {
  if (typeof sessionWallet !== "string" || sessionWallet.toLowerCase() !== wallet.toLowerCase()) {
    throw new PlanError("WALLET_MISMATCH", "This intent belongs to a different wallet than the signed-in one.");
  }
}

/* ── Helpers ────────────────────────────────────────────────────────────── */

type Bound = Extract<ScalarInputValue, { kind: "output" | "remainder" }>;

/** Every output/remainder position in a node's inputs, in written order:
 *  [path, input name, value]. */
export function boundPositions(inputs: Readonly<Record<string, InputValue>>): [string, string, Bound][] {
  const outp: [string, string, Bound][] = [];
  for (const [name, v] of Object.entries(inputs)) {
    if (v.kind === "list") {
      v.items.forEach((item, j) => {
        for (const [k, iv] of Object.entries(item)) {
          if (iv.kind === "output" || iv.kind === "remainder") outp.push([`${name}[${j}].${k}`, name, iv]);
        }
      });
    } else if (v.kind === "output" || v.kind === "remainder") {
      outp.push([name, name, v]);
    }
  }
  return outp;
}

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === "object" && !Object.isFrozen(v)) {
    for (const x of Object.values(v as object)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
}
