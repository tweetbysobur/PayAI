/**
 * PayAI SDK — validation. The security core of Phase 1.
 *
 * Three checks live here, all fail-closed, all running BEFORE anything could
 * reach a signer:
 *
 *   resolveExecutable()  — the request names a real, registered action, at
 *                          the exact version it was quoted against, on the
 *                          chain that's actually active, with a fresh quote.
 *   validateInputs()     — LAYER A: every parameter matches the action's
 *                          declared inputSchema. No unknown fields, no
 *                          missing required fields, no unsafe coercion.
 *   validateSteps()      — LAYER B: every unsigned step an action's build()
 *                          returned targets an address inside BOTH the
 *                          action's and the protocol's allowlists. One bad
 *                          target rejects the WHOLE action.
 *
 * None of these functions signs, broadcasts, quotes, or builds anything.
 * They take already-produced values and either pass them through or reject.
 * That is deliberate: validation must be a pure gate the execution path
 * calls, never something with the power to execute on its own.
 *
 * Layer B is the invariant that makes a third-party action safe to run at
 * all. build()'s code is not trusted — its OUTPUT is checked. A build() that
 * is buggy, or actively malicious, and returns a step pointing at an
 * attacker's contract is caught here, because the check runs on the returned
 * tx.to, not on any promise the action made about itself. It mirrors, off
 * chain, what contracts/contracts/PayAITradeExecutor.sol enforces on chain
 * with its owner-gated market allowlist.
 */
import { decodeFunctionData } from "viem";
import { toBaseUnits } from "@/lib/monad/verify";
import { isAddress } from "@/lib/payees/directory";
import type {
  Action, ActionInputItem, ActionInputSchema, ActionInputs, ActionInputValue, ExecutionRequest, ListInputField,
  ProtocolAdapter, ScalarInputField, UnsignedActionStep,
} from "./types";
import { getAction, getProtocol, listActionVersions } from "./registry";

export type SdkErrorCode =
  | "PROTOCOL_NOT_CONFIGURED"
  | "ACTION_NOT_FOUND"
  | "VERSION_MISMATCH"
  | "CHAIN_MISMATCH"
  | "QUOTE_STALE"
  | "QUOTE_REQUIRED"
  | "SCHEMA_VALIDATION_FAILED"
  | "UNKNOWN_PARAMETER"
  | "TARGET_NOT_ALLOWLISTED"
  | "APPROVAL_INVALID";

export interface ValidationOk<T> { ok: true; value: T }
export interface ValidationErr { ok: false; code: SdkErrorCode; message: string }
export type ValidationResult<T> = ValidationOk<T> | ValidationErr;

const ok = <T>(value: T): ValidationOk<T> => ({ ok: true, value });
const err = (code: SdkErrorCode, message: string): ValidationErr => ({ ok: false, code, message });

const DEFAULT_STRING_MAX = 200;

/** How stale a quote may be before execution refuses it. Generous enough for
 *  a human to read a preview and click confirm; short enough that a quote
 *  left open for minutes is re-fetched, not executed against. Mirrors the
 *  spirit of lib/monad/tradeQuote.ts's isMaterialChange freshness handling. */
export const QUOTE_MAX_AGE_MS = 90_000;

/**
 * Resolves a request to the exact registered action it names, or the precise
 * reason it can't be executed. Order matters — each check assumes the earlier
 * ones passed:
 *   1. protocol registered at all?           → PROTOCOL_NOT_CONFIGURED
 *   2. action id known under that protocol?   → ACTION_NOT_FOUND
 *   3. that action at THIS version?            → VERSION_MISMATCH
 *   4. active chain matches the request+action → CHAIN_MISMATCH
 *   5. quote still fresh?                       → QUOTE_STALE
 *
 * `activeChainId` is passed in (from getNetwork()/getChain() at the call
 * site) rather than read here, so this module stays free of server-only
 * imports and trivially unit-testable.
 */
export function resolveExecutable(
  request: ExecutionRequest, activeChainId: number, now: number = Date.now(),
): ValidationResult<{ action: Action; protocol: ProtocolAdapter }> {
  const protocol = getProtocol(request.protocolId);
  if (!protocol) return err("PROTOCOL_NOT_CONFIGURED", `Protocol "${request.protocolId}" is not registered.`);

  const action = getAction(request.protocolId, request.actionId, request.version);
  if (!action) {
    const otherVersions = listActionVersions(request.protocolId, request.actionId);
    if (otherVersions.length === 0) {
      return err("ACTION_NOT_FOUND", `Protocol "${request.protocolId}" has no action "${request.actionId}".`);
    }
    return err("VERSION_MISMATCH", `Action "${request.protocolId}/${request.actionId}" exists, but not at version "${request.version}". This request must be re-quoted against a current version before it can execute.`);
  }

  // The request's own chainId, the action's pinned chainId, and the chain the
  // app is actually pointed at must all agree. Any disagreement is refused —
  // a request quoted for one chain must never execute on another.
  if (request.chainId !== action.chainId || request.chainId !== activeChainId) {
    return err("CHAIN_MISMATCH", `This action runs on chain ${action.chainId}; the request/active chain is ${request.chainId}/${activeChainId}.`);
  }

  if (!Number.isFinite(request.quotedAt) || now - request.quotedAt > QUOTE_MAX_AGE_MS || request.quotedAt > now + 5_000) {
    return err("QUOTE_STALE", "This quote is too old (or its timestamp is invalid) to execute against — please re-quote.");
  }

  return ok({ action, protocol });
}

// ---------------------------------------------------------------------------
// LAYER A — input validation
// ---------------------------------------------------------------------------

/** A positive integer in base units: digits only, no sign, no leading zero,
 *  no decimal point, no exponent, no whitespace — and at most uint256. */
const UNITS_RE = /^[1-9][0-9]{0,77}$/;
const UINT256_MAX = (1n << 256n) - 1n;

function validateOneField(name: string, field: ScalarInputField, raw: unknown): ValidationErr | null {
  // Scalar fields take strings only — a list (or anything else) where a
  // string belongs is a type mismatch, never coerced.
  if (raw !== undefined && typeof raw !== "string") {
    return err("SCHEMA_VALIDATION_FAILED", `"${name}" must be a single value.`);
  }
  // A required field's value must be genuinely present. An empty/whitespace
  // string is "absent", not a valid value, for every type.
  const value = raw?.trim() ?? "";
  if (value === "") {
    return field.required ? err("SCHEMA_VALIDATION_FAILED", `"${name}" is required.`) : null;
  }

  switch (field.type) {
    case "amount": {
      // Shape first: a finite, strictly-positive decimal, never exponential
      // (viem's parseUnits rejects exponential outright — see verify.ts).
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0 || /e/i.test(value)) {
        return err("SCHEMA_VALIDATION_FAILED", `"${name}" must be a positive decimal amount.`);
      }
      // If a precision was declared, confirm the value is actually
      // representable at it using the app's OWN decimal helper — no second
      // amount parser. toBaseUnits rounds like parseUnits, so a value with
      // more precision than the token has is fine; a value that produces
      // zero base units (below the precision floor) is not a real amount.
      if (field.decimals != null) {
        let units: bigint;
        try {
          units = toBaseUnits(n, field.decimals);
        } catch {
          return err("SCHEMA_VALIDATION_FAILED", `"${name}" is not a valid amount at ${field.decimals} decimals.`);
        }
        if (units <= 0n) return err("SCHEMA_VALIDATION_FAILED", `"${name}" is below the smallest representable amount at ${field.decimals} decimals.`);
      }
      return null;
    }
    case "units": {
      // Exact integer base units. Never touches Number(): the regex fixes the
      // shape and BigInt bounds it, so there is no float anywhere on this path.
      if (!UNITS_RE.test(value) || BigInt(value) > UINT256_MAX) {
        return err("SCHEMA_VALIDATION_FAILED", `"${name}" must be a positive whole number of base units.`);
      }
      return null;
    }
    case "token":
    case "address": {
      // Both are on-chain addresses to us (a "token" is its contract address —
      // the contract-address-is-truth rule from lib/monad/tokenIntelligence;
      // a bare symbol is never accepted here). Reuses the app's own isAddress.
      if (!isAddress(value)) return err("SCHEMA_VALIDATION_FAILED", `"${name}" must be a valid 0x address.`);
      return null;
    }
    case "number": {
      if (!Number.isFinite(Number(value)) || /e/i.test(value)) {
        return err("SCHEMA_VALIDATION_FAILED", `"${name}" must be a finite number.`);
      }
      return null;
    }
    case "boolean": {
      if (value !== "true" && value !== "false") {
        return err("SCHEMA_VALIDATION_FAILED", `"${name}" must be exactly "true" or "false".`);
      }
      return null;
    }
    case "string": {
      const max = field.maxLength ?? DEFAULT_STRING_MAX;
      if (value.length > max) return err("SCHEMA_VALIDATION_FAILED", `"${name}" exceeds its ${max}-character limit.`);
      return null;
    }
    default: {
      // Exhaustiveness guard: a new ActionInputField["type"] that forgot a
      // case lands here and fails closed, never silently passing unchecked.
      return err("SCHEMA_VALIDATION_FAILED", `"${name}" has an unsupported field type.`);
    }
  }
}

/**
 * LAYER A. Validates every parameter against the schema, and — strictly —
 * rejects any parameter the schema does NOT declare. Unknown fields fail
 * closed (UNKNOWN_PARAMETER): a parameter the action never asked for has no
 * validation rule, so accepting it would be accepting an unchecked value,
 * which is exactly the hole this layer exists to close.
 *
 * Returns the trimmed, validated inputs on success — the same string map,
 * normalized — so the caller passes THESE to quote()/build(), never the raw
 * unchecked originals.
 */
export function validateInputs(schema: ActionInputSchema, inputs: ActionInputs): ValidationResult<ActionInputs> {
  if (inputs === null || typeof inputs !== "object" || Array.isArray(inputs)) {
    return err("SCHEMA_VALIDATION_FAILED", "Inputs must be an object.");
  }
  for (const provided of Object.keys(inputs)) {
    if (!Object.prototype.hasOwnProperty.call(schema, provided)) {
      return err("UNKNOWN_PARAMETER", `Unexpected parameter "${provided}" — this action does not accept it.`);
    }
  }
  const cleaned: Record<string, ActionInputValue> = {};
  for (const [name, field] of Object.entries(schema)) {
    const raw = (inputs as Record<string, unknown>)[name];
    if (field.type === "list") {
      const list = validateList(name, field, raw);
      if (!list.ok) return list;
      if (list.value.length > 0) cleaned[name] = list.value;
      continue;
    }
    const problem = validateOneField(name, field, raw);
    if (problem) return problem;
    const trimmed = typeof raw === "string" ? raw.trim() : "";
    if (trimmed !== "") cleaned[name] = trimmed;
  }
  return ok(cleaned);
}

/**
 * A list input: an array of plain objects, length within [minItems,
 * maxItems], each item with EXACTLY the declared keys (an unknown key in any
 * item fails the whole input, same rule as a top-level unknown parameter),
 * each value checked by the scalar rules. Returns trimmed copies — never the
 * caller's objects.
 */
function validateList(name: string, field: ListInputField, raw: unknown): ValidationResult<readonly ActionInputItem[]> {
  if (raw === undefined || raw === "") {
    return field.required ? err("SCHEMA_VALIDATION_FAILED", `"${name}" is required.`) : ok([]);
  }
  if (!Array.isArray(raw)) return err("SCHEMA_VALIDATION_FAILED", `"${name}" must be a list.`);
  if (raw.length < field.minItems || raw.length > field.maxItems) {
    return err("SCHEMA_VALIDATION_FAILED", `"${name}" must have between ${field.minItems} and ${field.maxItems} entries.`);
  }
  const out: ActionInputItem[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item: unknown = raw[i];
    const where = `${name}[${i}]`;
    if (item === null || typeof item !== "object" || Array.isArray(item) || Object.getPrototypeOf(item) !== Object.prototype) {
      return err("SCHEMA_VALIDATION_FAILED", `"${where}" must be an object.`);
    }
    for (const key of Object.keys(item)) {
      if (!Object.prototype.hasOwnProperty.call(field.items, key)) {
        return err("UNKNOWN_PARAMETER", `Unexpected field "${where}.${key}".`);
      }
    }
    const cleanedItem: Record<string, string> = {};
    for (const [key, itemField] of Object.entries(field.items)) {
      const v = (item as Record<string, unknown>)[key];
      const problem = validateOneField(`${where}.${key}`, itemField, v);
      if (problem) return problem;
      const trimmed = typeof v === "string" ? v.trim() : "";
      if (trimmed !== "") cleanedItem[key] = trimmed;
    }
    out.push(cleanedItem);
  }
  return ok(out);
}

// ---------------------------------------------------------------------------
// LAYER B — output target validation (the hard security invariant)
// ---------------------------------------------------------------------------

/**
 * LAYER B. Every step's `tx.to` must appear in BOTH the action's and the
 * protocol's allowlists. A single step outside either set rejects the ENTIRE
 * set of steps — never "execute the valid ones and skip the bad one", which
 * would let a malicious build() smuggle a hostile call through by burying it
 * among legitimate ones.
 *
 * Case-insensitive (addresses compared lowercased) so a checksum-cased vs.
 * lowercased mismatch never causes a legitimate target to be wrongly
 * rejected — the ONLY normalization applied; nothing here trusts, rewrites,
 * or "fixes" a step in any other way.
 *
 * Deliberately re-derives both allowlists from the passed action/protocol on
 * every call rather than caching them, so it always reflects exactly what was
 * registered — and takes the allowlists as arguments rather than re-reading
 * the registry, so a caller can never accidentally validate against a
 * different action than the one whose steps it is checking.
 */
export function validateSteps(
  steps: readonly UnsignedActionStep[], action: Action, protocol: ProtocolAdapter,
): ValidationResult<readonly UnsignedActionStep[]> {
  if (steps.length === 0) {
    return err("TARGET_NOT_ALLOWLISTED", "This action produced no transaction steps to execute.");
  }
  const actionTargets = new Set(action.allowedTargets.map((a) => a.toLowerCase()));
  const protocolTargets = new Set(protocol.allowedTargets.map((a) => a.toLowerCase()));

  for (const step of steps) {
    const to = (step.tx?.to as string | undefined)?.toLowerCase();
    if (!to || !isAddress(step.tx?.to as string)) {
      return err("TARGET_NOT_ALLOWLISTED", `A "${step.kind}" step has a missing or malformed target address.`);
    }

    // An "approve" step legitimately targets the user's TOKEN (an arbitrary
    // address, never in the allowlist), so it can't be validated by tx.to like
    // an action step. It's validated by proving the calldata is exactly an
    // approve() whose SPENDER is an allowlisted canonical contract — see
    // validateApprovalStep. Everything else (the real action calls) must target
    // the allowlist as before.
    if (step.kind === "approve") {
      const approvalProblem = validateApprovalStep(step, actionTargets, protocolTargets);
      if (approvalProblem) return approvalProblem;
      continue;
    }

    if (!actionTargets.has(to)) {
      return err("TARGET_NOT_ALLOWLISTED", `Step "${step.label}" targets ${step.tx.to}, which is not in this action's allowlist. The action is rejected in full.`);
    }
    if (!protocolTargets.has(to)) {
      return err("TARGET_NOT_ALLOWLISTED", `Step "${step.label}" targets ${step.tx.to}, which is not in the protocol's allowlist. The action is rejected in full.`);
    }
  }
  return ok(steps);
}

/** The ERC-20 `approve(address,uint256)` selector, and the EXACT hex length of
 *  a well-formed call to it: "0x" + 4-byte selector + two 32-byte words. Any
 *  other length means trailing bytes, wrong arity, or a different function
 *  (permit/approveAndCall/increaseAllowance) — all rejected. */
const APPROVE_SELECTOR = "0x095ea7b3";
const APPROVE_CALLDATA_LEN = 2 + 8 + 64 + 64; // 138
const MAX_UINT256 = (1n << 256n) - 1n;
const APPROVE_ABI = [{
  type: "function", name: "approve", stateMutability: "nonpayable",
  inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }],
}] as const;

/**
 * LAYER B for an "approve" step. The transaction target (tx.to) is the user's
 * chosen ERC-20 token — deliberately NOT allowlisted, because tokens are
 * user-selected assets. Security comes entirely from proving the allowance can
 * only ever go to a canonical, allowlisted PayAI contract, for a bounded
 * amount, via exactly the standard approve() and nothing else. Fail-closed:
 *
 *   1. carries an `approval` declaration (an approve step without it is rejected);
 *   2. carries no native value (an allowance never sends MON);
 *   3. calldata is EXACTLY approve(address,uint256): right selector, exact
 *      length (no trailing bytes, no permit/increaseAllowance/approveAndCall);
 *   4. the decoded spender/amount and tx.to match the `approval` declaration
 *      EXACTLY — build()'s calldata can't diverge from what it declares;
 *   5. the spender is in BOTH the action's and the protocol's allowlist — the
 *      theft-critical invariant: allowance can reach only a canonical PayAI
 *      contract, never an attacker, router, zero, or unrelated protocol;
 *   6. the amount is strictly positive and NOT unlimited (uint256 max).
 *
 * The declaration's own token/amount are the action's to compute from
 * validated inputs; this proves the on-chain calldata is exactly that and
 * nothing broader.
 */
function validateApprovalStep(
  step: UnsignedActionStep, actionTargets: Set<string>, protocolTargets: Set<string>,
): ValidationErr | null {
  const meta = step.approval;
  if (!meta) {
    return err("APPROVAL_INVALID", `Approve step "${step.label}" is missing its approval declaration and is rejected.`);
  }
  if (step.tx.value !== "0") {
    return err("APPROVAL_INVALID", `Approve step "${step.label}" must carry no native value.`);
  }
  if (!isAddress(meta.token) || !isAddress(meta.spender)) {
    return err("APPROVAL_INVALID", `Approve step "${step.label}" has a malformed token or spender.`);
  }
  // tx.to is the token the approval is sent to; it must be exactly the declared
  // token (which the action derived from the user's validated `token` input).
  if (step.tx.to.toLowerCase() !== meta.token.toLowerCase()) {
    return err("APPROVAL_INVALID", `Approve step "${step.label}" is sent to ${step.tx.to}, not the declared token ${meta.token}.`);
  }

  const data = step.tx.data;
  if (typeof data !== "string" || data.slice(0, 10).toLowerCase() !== APPROVE_SELECTOR) {
    return err("APPROVAL_INVALID", `Approve step "${step.label}" is not an approve(address,uint256) call.`);
  }
  if (data.length !== APPROVE_CALLDATA_LEN) {
    return err("APPROVAL_INVALID", `Approve step "${step.label}" has malformed approve calldata (unexpected length — trailing bytes or wrong arity).`);
  }

  let decodedSpender: string;
  let decodedAmount: bigint;
  try {
    const decoded = decodeFunctionData({ abi: APPROVE_ABI, data: data as `0x${string}` });
    if (decoded.functionName !== "approve") throw new Error("not approve");
    [decodedSpender, decodedAmount] = decoded.args as unknown as [string, bigint];
  } catch {
    return err("APPROVAL_INVALID", `Approve step "${step.label}" has undecodable approve calldata.`);
  }

  // The calldata must match the declaration exactly — spender, amount, and
  // (already checked) the token target.
  if (decodedSpender.toLowerCase() !== meta.spender.toLowerCase()) {
    return err("APPROVAL_INVALID", `Approve step "${step.label}" calldata spender ${decodedSpender} does not match the declared spender ${meta.spender}.`);
  }
  let metaAmount: bigint;
  try {
    metaAmount = BigInt(meta.amount);
  } catch {
    return err("APPROVAL_INVALID", `Approve step "${step.label}" has a non-integer declared amount.`);
  }
  if (decodedAmount !== metaAmount) {
    return err("APPROVAL_INVALID", `Approve step "${step.label}" calldata amount ${decodedAmount} does not match the declared amount ${metaAmount}.`);
  }

  // THE theft-critical check: the spender must be a canonical, allowlisted
  // contract — in BOTH the action's and the protocol's allowlist.
  const spender = decodedSpender.toLowerCase();
  if (!actionTargets.has(spender) || !protocolTargets.has(spender)) {
    return err("APPROVAL_INVALID", `Approve step "${step.label}" grants allowance to ${decodedSpender}, which is not an allowlisted spender. The action is rejected in full.`);
  }

  // A positive, bounded allowance only — never zero, never unlimited.
  if (decodedAmount <= 0n) {
    return err("APPROVAL_INVALID", `Approve step "${step.label}" must approve a positive amount.`);
  }
  if (decodedAmount === MAX_UINT256) {
    return err("APPROVAL_INVALID", `Approve step "${step.label}" requests an unlimited approval, which is not allowed.`);
  }

  return null;
}

/** Convenience wrapper for the full pre-execution gate a caller runs in
 *  order: resolve → validate inputs. Does NOT call build()/validateSteps —
 *  those run only after the caller has produced steps, so Layer B stays
 *  physically after step-building in the call sequence, never before. */
export function validateForQuote(
  request: ExecutionRequest, activeChainId: number, now: number = Date.now(),
): ValidationResult<{ action: Action; protocol: ProtocolAdapter; inputs: ActionInputs }> {
  const resolved = resolveExecutable(request, activeChainId, now);
  if (!resolved.ok) return resolved;
  const inputs = validateInputs(resolved.value.action.inputSchema, request.inputs);
  if (!inputs.ok) return inputs;
  return ok({ action: resolved.value.action, protocol: resolved.value.protocol, inputs: inputs.value });
}
