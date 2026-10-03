/**
 * Intent IR validation error codes. Every rejection carries one code and a
 * path (where in the graph), so callers — and tests — can tell exactly which
 * rule refused a draft.
 */
export type IntentErrorCode =
  | "MALFORMED"            // wrong type / shape / missing field
  | "FORBIDDEN_FIELD"      // a key the IR never allows (to, data, spender, autoExecute, …)
  | "UNSUPPORTED_VERSION"  // IR version
  | "NO_SESSION"           // no authenticated wallet to validate against
  | "WALLET_MISMATCH"
  | "WRONG_CHAIN"
  | "NOT_A_DRAFT"          // a submitted graph claiming progress it can't have
  | "NODE_COUNT"           // 0 nodes, or more than MAX_INTENT_NODES
  | "DUPLICATE_NODE_ID"
  | "UNKNOWN_DEPENDENCY"
  | "SELF_DEPENDENCY"
  | "CYCLE"
  | "UNDECLARED_DEPENDENCY" // a binding to a node not listed in dependsOn
  | "PROTOCOL_NOT_CONFIGURED" | "ACTION_NOT_FOUND" | "VERSION_MISMATCH" | "CHAIN_MISMATCH" // from the SDK registry
  | "UNKNOWN_INPUT"
  | "INVALID_INPUT"        // fails the action's own Layer A rules
  | "INVALID_BINDING"      // wrong value kind for the field, or a bad remainder
  | "UNKNOWN_OUTPUT"       // producer doesn't declare that output
  | "OUTPUT_TYPE_MISMATCH"
  | "TOKEN_MISMATCH"
  | "NATIVE_OUTPUT_NOT_BINDABLE" // the output isn't provably an ERC-20 (native MON, or unknown until execution)
  | "INVALID_RECIPIENT"
  | "RECIPIENT_PROVENANCE";

export interface IntentError {
  code: IntentErrorCode;
  message: string;
  /** e.g. "nodes[1].inputs.recipients[0].amount" */
  path: string;
  nodeId?: string;
}

export type IntentValidationResult<T> = { ok: true; value: T } | { ok: false; error: IntentError };

/**
 * Planner / resolver error codes (Phase 2C). Separate from IntentErrorCode:
 * these are raised AFTER validation — by the planner refusing a graph it
 * didn't get from the validator, or by resolveStepInputs refusing to turn a
 * step into concrete inputs from what was actually confirmed.
 */
export type PlanErrorCode =
  | "UNVALIDATED_GRAPH"          // not a graph validateIntentGraph returned
  | "INVALID_PLAN"               // not a plan planIntent returned, or an unknown step
  | "GRAPH_MUTATION"             // the graph no longer matches the plan's graphHash
  | "WALLET_MISMATCH"            // plan/graph wallet isn't the authenticated session's
  | "OUTPUT_NOT_CONFIRMED"       // a dependency hasn't confirmed
  | "UNKNOWN_OUTPUT"             // the producer confirmed without that output
  | "OUTPUT_NOT_VERIFIED"        // the output wasn't verified on-chain
  | "INVALID_CONFIRMED_VALUE"    // wrong type / format / range
  | "TOKEN_MISMATCH"             // a different ERC-20 from the one proven at validation
  | "NATIVE_OUTPUT_NOT_BINDABLE" // the confirmed output is native MON
  | "INVALID_REMAINDER"          // a remainder whose terms don't add up
  | "REMAINDER_UNDERFLOW"        // nothing (or less than nothing) is left
  | "REMAINDER_OVERFLOW"         // beyond uint256
  | "FEE_TERMS_UNAVAILABLE"      // a fee-on-top remainder without authoritative feeBps
  | "RECIPIENT_UNRESOLVED"       // a .nad / payee without a server-pinned address
  // Plan Store (Phase 2C Stage 3A):
  | "UNAVAILABLE"                // production without usable KV — never falls back to memory
  | "NOT_FOUND"                  // no such plan/fact (also: a plan the session's wallet doesn't own)
  | "CONFLICT"                   // an immutable fact already exists with different content
  | "CORRUPT"                    // a stored record fails strict validation or rehydration
  | "EXPIRED"                    // the plan is past its lifetime
  | "NOT_APPROVABLE"             // approval after approveBy, or on an abandoned plan
  | "INVALID_NODE";              // a nodeId that isn't a step of the stored plan

export class PlanError extends Error {
  constructor(
    public readonly code: PlanErrorCode,
    message: string,
    public readonly nodeId?: string,
    public readonly path?: string,
  ) {
    super(message);
    this.name = "PlanError";
  }
}
