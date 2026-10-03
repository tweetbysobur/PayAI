/**
 * PayAI Intent IR — the structured, LLM-independent representation of what a
 * user asked PayAI to do: one or more SDK actions, how they depend on each
 * other, and where each input comes from.
 *
 *   natural language → Intent Adapter (deterministic, or LLM-assisted)
 *                    → IntentGraph (draft)          ← this file
 *                    → validateIntentGraph()        ← lib/plan/validate.ts
 *                    → Planner → SDK actions → execution   (later phases)
 *
 * An adapter only ever produces a DRAFT. PayAI owns what makes a draft
 * acceptable: every action is resolved against the SDK registry, every input
 * against that action's own schema, every binding against the producer's
 * declared outputs, and every recipient against PayAI's provenance rules.
 *
 * What the IR deliberately cannot express (and validation rejects): a
 * transaction target, calldata, ABI, selector, value, spender or approval;
 * a chain or wallet other than PayAI's and the session's; an action that
 * isn't registered at an exact version; an "auto-execute" or "skip
 * validation" switch; a cycle; or more than MAX_INTENT_NODES actions.
 *
 * Nothing in this layer executes anything. Pure data + pure validation.
 */
import type { Address, Hex } from "viem";

export const INTENT_IR_VERSION = 1 as const;
/** The Intent Engine runs on Monad mainnet only. Not a cross-chain system. */
export const INTENT_CHAIN_ID = 143 as const;
/** Bounded on purpose: every node is at least one separately signed
 *  transaction, and the plan has to stay readable on one confirmation card. */
export const MAX_INTENT_NODES = 4;

export interface ActionRef {
  protocolId: string;
  actionId: string;
  /** Exact registered version — never a range, never "latest". */
  version: string;
}

/** A literal the user stated, already in the field's own format (amounts in
 *  exact base units, tokens as contract addresses). */
export interface LiteralValue { kind: "literal"; value: string }

/** The CONFIRMED value another node produces (resolved only after that node
 *  confirms on-chain; never a prediction). */
export interface OutputRef { kind: "output"; node: string; output: string }

/** A producer's confirmed amount minus literal amounts — e.g. "the rest".
 *  Not executable as-is: the planner resolves it to a concrete amount. */
export interface RemainderValue { kind: "remainder"; node: string; output: string; minus: string[] }

/**
 * A recipient as the USER wrote it. `display` must appear in the source text
 * (provenance). Resolution to an address is server-authoritative:
 *   - "address": `address` is the literal 0x address the user typed;
 *   - "nad" / "payee": `address` must be absent in a draft — the server's
 *     resolver (lib/payees/resolve.ts) fills it in, never an adapter.
 */
export interface RecipientValue {
  kind: "recipient";
  display: string;
  source: "address" | "nad" | "payee";
  address?: Address;
}

/** A list input (e.g. split_payment's `recipients`): flat items whose
 *  fields are themselves non-list values. */
export interface ListValue { kind: "list"; items: Record<string, ScalarInputValue>[] }

export type ScalarInputValue = LiteralValue | OutputRef | RemainderValue | RecipientValue;
export type InputValue = ScalarInputValue | ListValue;

export type NodeValidationState = "pending" | "valid" | "invalid";
export type NodeExecutionState = "pending" | "awaiting_signature" | "submitted" | "confirmed" | "reverted" | "skipped";
export type NodeVerificationState = "pending" | "verified" | "mismatch";

export interface ActionNode {
  nodeId: string;
  ref: ActionRef;
  inputs: Record<string, InputValue>;
  dependsOn: string[];
  validation: { state: NodeValidationState; code?: string };
  execution: { state: NodeExecutionState; approvalHash?: Hex; txHash?: Hex };
  verification: {
    state: NodeVerificationState;
    confirmed?: Record<string, string>;
    outputs?: Record<string, string>;
  };
}

export type IntentGraphStatus = "draft" | "planned" | "approved" | "running" | "completed" | "failed" | "partial";

export interface IntentGraph {
  id: string;
  version: typeof INTENT_IR_VERSION;
  chainId: number;
  /** Always the authenticated session's wallet — validation rejects any other. */
  wallet: Address;
  nodes: ActionNode[];
  source: { text: string; adapter: "deterministic" | "llm"; adapterVersion: string };
  status: IntentGraphStatus;
}

/** A producer output some later node binds to, with the ERC-20 it was proven
 *  to be (a "token" output) or be denominated in (a "units" output),
 *  lowercased. Native MON is never bindable, so `token` is always an ERC-20. */
export interface BoundOutput {
  type: "units" | "token";
  token: string;
}

/** The only fee policy the planner understands (from Action.feePolicy). */
export interface PlanFeePolicy {
  mode: "on_top";
}

/**
 * A graph that passed validateIntentGraph: every node valid, with a
 * deterministic execution order (dependencies first).
 *
 * Only the validator creates one. It is deep-frozen, shares no object with
 * the draft it came from, and is recorded by identity
 * (isValidatedIntentGraph) — a look-alike object built elsewhere is refused
 * by the planner at runtime, whatever its TypeScript type says.
 */
export interface ValidatedIntentGraph extends IntentGraph {
  order: string[];
  /** producer nodeId → output name → what the validator proved about it. */
  boundOutputs: Readonly<Record<string, Readonly<Record<string, Readonly<BoundOutput>>>>>;
  /** nodeId → fee policy, from the resolved action's metadata. Nodes whose
   *  action declares none are absent. */
  feePolicies: Readonly<Record<string, Readonly<PlanFeePolicy>>>;
}

/* ── Execution plan (Phase 2C) ─────────────────────────────────────────── */

/** One input position in a step that is filled from another node's output,
 *  and the token the validator proved that output to be. */
export interface PlanExpectation {
  /** e.g. "amount" or "recipients[1].amount". */
  path: string;
  node: string;
  output: string;
  type: "units" | "token";
  token: string;
}

/**
 * One step of an ExecutionPlan: WHICH action, at WHICH exact version, with
 * WHICH inputs (literals as written; output, remainder and .nad/payee
 * recipients still unresolved). Deliberately carries no transaction target,
 * calldata, value, signature, key or broadcast detail — those only ever come
 * from the action's own build(), later, behind the existing SDK gates.
 */
export interface PlanStep {
  nodeId: string;
  ref: ActionRef;
  inputs: Readonly<Record<string, InputValue>>;
  dependsOn: readonly string[];
  /** This step's outputs that later steps bind to (sorted). */
  outputsNeeded: readonly string[];
  /** Every bound input position, with its proven token. */
  expects: readonly PlanExpectation[];
  /** From the action's metadata; null when it declares none. */
  feePolicy: Readonly<PlanFeePolicy> | null;
}

export interface ExecutionPlan {
  /** "plan_" + 32 hex, derived from graphHash — the same graph always plans
   *  to the same id. */
  planId: string;
  /** SHA-256 (hex) of the graph's canonical serialization (planner.ts). */
  graphHash: string;
  wallet: Address;
  chainId: typeof INTENT_CHAIN_ID;
  /** In the validator's topological order. */
  steps: readonly PlanStep[];
}

/** A producer output as settlement VERIFIED it on-chain (never a quote). */
export interface ConfirmedOutputValue {
  verified: boolean;
  type: "units" | "token";
  /** Base units (decimal string) for "units"; a 0x address for "token". */
  value: string;
  /** For "units": the token the amount is in (0x address). */
  token?: string;
}
