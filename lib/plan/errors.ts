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
