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

/** A graph that passed validateIntentGraph: every node valid, with a
 *  deterministic execution order (dependencies first). */
export interface ValidatedIntentGraph extends IntentGraph {
  order: string[];
}
