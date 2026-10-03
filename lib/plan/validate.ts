/**
 * Deterministic validation of an Intent IR draft (lib/plan/types.ts).
 *
 *   validateIntentGraph(raw, ctx) → ValidatedIntentGraph | IntentError
 *
 * `raw` is treated as UNTRUSTED (it may come from a client or an LLM-assisted
 * adapter), so nothing relies on TypeScript types: every object is checked
 * for exactly its allowed keys at runtime, and keys that would smuggle in
 * execution details (to, data, spender, autoExecute, …) are refused by name.
 *
 * Reuses — never re-implements — PayAI's existing rules:
 *   - SDK registry + resolveExecutable: the action exists, at that exact
 *     version, on this chain (lib/sdk/validate.ts);
 *   - Layer A validateInputs: every literal against the action's own schema;
 *   - output declarations (lib/plan/outputs.ts): what can feed what;
 *   - recipient provenance (lib/payees/directory.ts recipientAppearsIn) and
 *     the .nad / payee shapes the resolver accepts.
 *
 * Pure apart from reading the in-memory SDK registry: no network, no chain
 * reads, no transaction building, no signing, no LLM. Recipient RESOLUTION
 * (.nad / payee → address) is deliberately not done here — it stays
 * server-authoritative in the planner, through lib/payees/resolve.ts.
 *
 * Returns the first violation found, in a fixed order, so the same draft
 * always fails the same way.
 */
import "server-only";
import { getAddress, isAddress, type Address } from "viem";
import { recipientAppearsIn } from "@/lib/payees/directory";
import { isDomainName } from "@/lib/monad/domain-resolver";
import { resolveExecutable, validateInputs } from "@/lib/sdk/validate";
import type { Action, ActionInputs, ActionInputValue, ListInputField, ScalarInputField } from "@/lib/sdk/types";
import type { IntentError, IntentErrorCode, IntentValidationResult } from "./errors";
import { canBind, normalizeToken, staticDenomination, staticErc20 } from "./outputs";
import {
  INTENT_CHAIN_ID, INTENT_IR_VERSION, MAX_INTENT_NODES,
  type ActionNode, type BoundOutput, type InputValue, type IntentGraph, type PlanFeePolicy, type ValidatedIntentGraph,
} from "./types";

export interface IntentValidationContext {
  /** The authenticated session's wallet. Required — there is no validation
   *  (and no execution) without a session identity. */
  sessionWallet: string | null | undefined;
  /** The chain the app is pointed at (getChain().id at the call site). */
  activeChainId: number;
  /** For registry resolution only; defaults to Date.now(). */
  now?: number;
}

/** Keys that would carry execution details, permissions or control flow.
 *  None is ever valid anywhere in an Intent IR. */
const FORBIDDEN_KEYS = new Set([
  "to", "target", "data", "calldata", "callData", "abi", "selector", "method", "function",
  "spender", "approval", "approve", "allowance", "permit",
  "autoExecute", "auto_execute", "autoexecute", "skipValidation", "skip_validation", "force", "execute",
  "tx", "txs", "steps", "transaction", "gas", "gasLimit", "nonce", "privateKey", "signer", "signature",
  "chain", "network", "rpc",
]);

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const NODE_ID_RE = /^[a-z][a-z0-9_-]{0,15}$/;
const UNITS_RE = /^[1-9][0-9]{0,77}$/;
const PAYEE_RE = /^[a-z][a-z0-9_-]{0,31}$/i;
const CONTROL_RE = /[\u0000-\u001F\u007F]/;
const ZERO = "0x0000000000000000000000000000000000000000";
/** Stand-ins used ONLY to run Layer A on a node whose bound/unresolved
 *  values aren't known yet; they never leave this function. */
const PLACEHOLDER_ADDRESS = "0x00000000000000000000000000000000000000a1";
const PLACEHOLDER_UNITS = "1";

class Fail extends Error {
  constructor(public readonly err: IntentError) { super(err.message); }
}
const fail = (code: IntentErrorCode, message: string, path: string, nodeId?: string): never => {
  throw new Fail({ code, message, path, ...(nodeId ? { nodeId } : {}) });
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/** Exactly these keys (optional ones may be absent); forbidden keys by name. */
function checkKeys(obj: Record<string, unknown>, allowed: readonly string[], path: string, nodeId?: string) {
  for (const k of Object.keys(obj)) {
    if (FORBIDDEN_KEYS.has(k)) fail("FORBIDDEN_FIELD", `"${k}" is not allowed in an intent.`, `${path}.${k}`, nodeId);
    if (!allowed.includes(k)) fail("MALFORMED", `Unexpected field "${k}".`, `${path}.${k}`, nodeId);
  }
}

function str(v: unknown, path: string, max: number, nodeId?: string): string {
  if (typeof v !== "string" || v.length === 0 || v.length > max || CONTROL_RE.test(v)) {
    fail("MALFORMED", `Expected a non-empty string of at most ${max} characters.`, path, nodeId);
  }
  return v as string;
}

/** Every graph this module has returned, by identity. The planner accepts
 *  nothing else — a structurally identical object built anywhere else is not
 *  in here. WeakSet: holds nothing alive. */
const VALIDATED = new WeakSet<object>();

/** True only for a graph validateIntentGraph itself returned. */
export function isValidatedIntentGraph(g: unknown): g is ValidatedIntentGraph {
  return typeof g === "object" && g !== null && VALIDATED.has(g);
}

export function validateIntentGraph(raw: unknown, ctx: IntentValidationContext): IntentValidationResult<ValidatedIntentGraph> {
  try {
    const value = validate(raw, ctx);
    VALIDATED.add(value);
    return { ok: true, value };
  } catch (e) {
    if (e instanceof Fail) return { ok: false, error: e.err };
    throw e;
  }
}

function validate(raw: unknown, ctx: IntentValidationContext): ValidatedIntentGraph {
  // ── Session identity first: nothing is valid without one. ──
  if (typeof ctx.sessionWallet !== "string" || !isAddress(ctx.sessionWallet, { strict: false })) {
    fail("NO_SESSION", "An authenticated wallet is required.", "$");
  }
  const session = getAddress(ctx.sessionWallet as string);

  // ── Graph shape. ──
  if (!isPlainObject(raw)) fail("MALFORMED", "An intent must be an object.", "$");
  const g = raw as Record<string, unknown>;
  checkKeys(g, ["id", "version", "chainId", "wallet", "nodes", "source", "status"], "$");
  if (g.version !== INTENT_IR_VERSION) fail("UNSUPPORTED_VERSION", `Intent IR version must be ${INTENT_IR_VERSION}.`, "$.version");
  if (typeof g.id !== "string" || !ID_RE.test(g.id)) fail("MALFORMED", "Invalid intent id.", "$.id");
  if (g.status !== "draft") fail("NOT_A_DRAFT", "Only a draft intent can be validated.", "$.status");

  if (typeof g.chainId !== "number" || g.chainId !== INTENT_CHAIN_ID || g.chainId !== ctx.activeChainId) {
    fail("WRONG_CHAIN", `The Intent Engine runs on Monad mainnet (chain ${INTENT_CHAIN_ID}) only.`, "$.chainId");
  }
  if (typeof g.wallet !== "string" || !isAddress(g.wallet, { strict: false })) fail("MALFORMED", "Invalid wallet.", "$.wallet");
  if ((g.wallet as string).toLowerCase() !== session.toLowerCase()) {
    fail("WALLET_MISMATCH", "The intent's wallet must be the signed-in wallet.", "$.wallet");
  }

  if (!isPlainObject(g.source)) fail("MALFORMED", "Missing source.", "$.source");
  const src = g.source as Record<string, unknown>;
  checkKeys(src, ["text", "adapter", "adapterVersion"], "$.source");
  const sourceText = str(src.text, "$.source.text", 1000);
  if (src.adapter !== "deterministic" && src.adapter !== "llm") fail("MALFORMED", "Unknown adapter.", "$.source.adapter");
  str(src.adapterVersion, "$.source.adapterVersion", 32);

  // ── Nodes: count, ids, draft state. ──
  if (!Array.isArray(g.nodes)) fail("MALFORMED", "nodes must be a list.", "$.nodes");
  const rawNodes = g.nodes as unknown[];
  if (rawNodes.length === 0 || rawNodes.length > MAX_INTENT_NODES) {
    fail("NODE_COUNT", `An intent has 1 to ${MAX_INTENT_NODES} actions.`, "$.nodes");
  }
  const nodes = rawNodes.map((n, i) => checkNodeShape(n, `$.nodes[${i}]`));
  const ids = new Set<string>();
  for (let i = 0; i < nodes.length; i++) {
    if (ids.has(nodes[i].nodeId)) fail("DUPLICATE_NODE_ID", `Duplicate node id "${nodes[i].nodeId}".`, `$.nodes[${i}].nodeId`, nodes[i].nodeId);
    ids.add(nodes[i].nodeId);
  }

  // ── Dependencies: exist, not self, acyclic. ──
  nodes.forEach((n, i) => {
    const seen = new Set<string>();
    n.dependsOn.forEach((d, j) => {
      const p = `$.nodes[${i}].dependsOn[${j}]`;
      if (d === n.nodeId) fail("SELF_DEPENDENCY", `"${d}" can't depend on itself.`, p, n.nodeId);
      if (!ids.has(d)) fail("UNKNOWN_DEPENDENCY", `"${d}" is not a node in this intent.`, p, n.nodeId);
      if (seen.has(d)) fail("MALFORMED", `"${d}" is listed twice.`, p, n.nodeId);
      seen.add(d);
    });
  });
  const order = topologicalOrder(nodes);

  // ── Each node: registry, inputs, bindings, recipients. ──
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const actions = new Map<string, Action>();
  for (const id of order) {
    const n = byId.get(id)!;
    const i = nodes.indexOf(n);
    actions.set(id, resolveAction(n, i, session, ctx));
  }
  const bound: Bound = new Map();
  for (const id of order) {
    const n = byId.get(id)!;
    validateNodeInputs(n, nodes.indexOf(n), actions, byId, sourceText, bound);
  }

  // Fee policy comes from the resolved action's own metadata — never from
  // recognising an action by name.
  const feePolicies: Record<string, PlanFeePolicy> = {};
  for (const id of order) {
    const policy = actions.get(id)!.feePolicy;
    if (policy === undefined) continue;
    if (!isPlainObject(policy) || policy.mode !== "on_top" || Object.keys(policy).length !== 1) {
      fail("MALFORMED", "This action declares a fee policy PayAI doesn't support.", `$.nodes[${nodes.indexOf(byId.get(id)!)}].ref`, id);
    }
    feePolicies[id] = { mode: "on_top" };
  }
  const boundOutputs: Record<string, Record<string, BoundOutput>> = {};
  for (const id of order) {
    const outs = bound.get(id);
    if (!outs) continue;
    boundOutputs[id] = {};
    for (const name of [...outs.keys()].sort()) boundOutputs[id][name] = outs.get(name)!;
  }

  // A fresh, deep-frozen copy: nothing in it is shared with `raw`, so the
  // caller's draft can change afterwards without changing what was validated.
  const validated: ValidatedIntentGraph = deepFreeze(plainCopy({
    id: g.id as string,
    version: INTENT_IR_VERSION,
    chainId: INTENT_CHAIN_ID,
    wallet: session,
    source: { text: sourceText, adapter: src.adapter as "deterministic" | "llm", adapterVersion: src.adapterVersion as string },
    status: "draft",
    nodes: nodes.map((n) => ({ ...n, validation: { state: "valid" } })),
    order,
    boundOutputs,
    feePolicies,
  }) as ValidatedIntentGraph);
  return validated;
}

/** What validation proved about each bound producer output. */
type Bound = Map<string, Map<string, BoundOutput>>;

/** Deep copy of JSON-shaped data (plain objects, arrays, primitives), with
 *  object keys sorted so the same graph always has the same shape, however
 *  the draft happened to order its keys. */
function plainCopy(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(plainCopy);
  if (v !== null && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) if (x !== undefined) o[k] = plainCopy(x);
    return o;
  }
  return v;
}

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === "object" && !Object.isFrozen(v)) {
    for (const x of Object.values(v as object)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
}

/* ── Shapes ─────────────────────────────────────────────────────────────── */

function checkNodeShape(raw: unknown, path: string): ActionNode {
  if (!isPlainObject(raw)) fail("MALFORMED", "A node must be an object.", path);
  const n = raw as Record<string, unknown>;
  const nodeId = typeof n.nodeId === "string" ? n.nodeId : undefined;
  checkKeys(n, ["nodeId", "ref", "inputs", "dependsOn", "validation", "execution", "verification"], path, nodeId);
  if (!nodeId || !NODE_ID_RE.test(nodeId)) fail("MALFORMED", "Invalid node id.", `${path}.nodeId`);

  if (!isPlainObject(n.ref)) fail("MALFORMED", "Missing action reference.", `${path}.ref`, nodeId);
  const ref = n.ref as Record<string, unknown>;
  checkKeys(ref, ["protocolId", "actionId", "version"], `${path}.ref`, nodeId);
  const protocolId = str(ref.protocolId, `${path}.ref.protocolId`, 64, nodeId);
  const actionId = str(ref.actionId, `${path}.ref.actionId`, 64, nodeId);
  const version = str(ref.version, `${path}.ref.version`, 32, nodeId);

  if (!isPlainObject(n.inputs)) fail("MALFORMED", "inputs must be an object.", `${path}.inputs`, nodeId);
  if (!Array.isArray(n.dependsOn) || !(n.dependsOn as unknown[]).every((d) => typeof d === "string")) {
    fail("MALFORMED", "dependsOn must be a list of node ids.", `${path}.dependsOn`, nodeId);
  }

  // A draft can't arrive claiming progress: every state is pending, no hashes,
  // no confirmed values — those are produced by PayAI, never supplied.
  const pendingOnly = (v: unknown, key: string, allowed: string[]) => {
    if (!isPlainObject(v)) fail("MALFORMED", `Missing ${key}.`, `${path}.${key}`, nodeId);
    const o = v as Record<string, unknown>;
    checkKeys(o, allowed, `${path}.${key}`, nodeId);
    if (o.state !== "pending" || Object.keys(o).length !== 1) fail("NOT_A_DRAFT", `A draft node's ${key} must be pending.`, `${path}.${key}`, nodeId);
  };
  pendingOnly(n.validation, "validation", ["state", "code"]);
  pendingOnly(n.execution, "execution", ["state", "approvalHash", "txHash"]);
  pendingOnly(n.verification, "verification", ["state", "confirmed", "outputs"]);

  return {
    nodeId: nodeId as string,
    ref: { protocolId, actionId, version },
    inputs: n.inputs as Record<string, InputValue>,
    dependsOn: [...(n.dependsOn as string[])],
    validation: { state: "pending" },
    execution: { state: "pending" },
    verification: { state: "pending" },
  };
}

/* ── Graph order ────────────────────────────────────────────────────────── */

/** Kahn's algorithm, ties broken by written order — deterministic. */
function topologicalOrder(nodes: ActionNode[]): string[] {
  const indegree = new Map(nodes.map((n) => [n.nodeId, n.dependsOn.length]));
  const order: string[] = [];
  const done = new Set<string>();
  while (order.length < nodes.length) {
    const next = nodes.find((n) => !done.has(n.nodeId) && indegree.get(n.nodeId) === 0);
    if (!next) {
      const stuck = nodes.find((n) => !done.has(n.nodeId))!;
      fail("CYCLE", "The actions depend on each other in a cycle.", "$.nodes", stuck.nodeId);
    }
    order.push(next!.nodeId);
    done.add(next!.nodeId);
    for (const n of nodes) if (n.dependsOn.includes(next!.nodeId)) indegree.set(n.nodeId, (indegree.get(n.nodeId) ?? 0) - 1);
  }
  return order;
}

/* ── Registry ───────────────────────────────────────────────────────────── */

function resolveAction(n: ActionNode, i: number, session: Address, ctx: IntentValidationContext): Action {
  // The existing gate, unchanged: registered protocol, known action, EXACT
  // version, request chain == action chain == active chain. There is no
  // quote at intent time, so quotedAt is "now" (freshness is enforced later,
  // at build, by the quote token).
  const now = ctx.now ?? Date.now();
  const r = resolveExecutable({
    protocolId: n.ref.protocolId, actionId: n.ref.actionId, version: n.ref.version,
    inputs: {}, walletAddress: session, chainId: INTENT_CHAIN_ID, quotedAt: now,
  }, ctx.activeChainId, now);
  if (!r.ok) {
    const code = r.code as IntentErrorCode;
    fail(["PROTOCOL_NOT_CONFIGURED", "ACTION_NOT_FOUND", "VERSION_MISMATCH", "CHAIN_MISMATCH"].includes(r.code) ? code : "MALFORMED", r.message, `$.nodes[${i}].ref`, n.nodeId);
  }
  return (r as { ok: true; value: { action: Action } }).value.action;
}

/* ── Inputs ─────────────────────────────────────────────────────────────── */

function validateNodeInputs(
  n: ActionNode, i: number, actions: Map<string, Action>, byId: Map<string, ActionNode>, sourceText: string, bound: Bound,
) {
  const action = actions.get(n.nodeId)!;
  const schema = action.inputSchema;
  const base = `$.nodes[${i}].inputs`;
  const candidate: Record<string, ActionInputValue> = {};

  for (const [name, value] of Object.entries(n.inputs)) {
    const path = `${base}.${name}`;
    if (FORBIDDEN_KEYS.has(name)) fail("FORBIDDEN_FIELD", `"${name}" is not allowed in an intent.`, path, n.nodeId);
    if (!Object.prototype.hasOwnProperty.call(schema, name)) {
      fail("UNKNOWN_INPUT", `${action.protocolId}/${action.actionId} has no input "${name}".`, path, n.nodeId);
    }
    const field = schema[name];
    if (field.type === "list") {
      candidate[name] = checkList(value, field, path, n, actions, byId, sourceText, bound);
    } else {
      candidate[name] = checkScalar(value, field, path, n, actions, byId, sourceText, bound);
    }
  }

  // Layer A, exactly as build will run it, on literals + typed placeholders.
  const layerA = validateInputs(schema, candidate as ActionInputs);
  if (!layerA.ok) {
    fail(layerA.code === "UNKNOWN_PARAMETER" ? "UNKNOWN_INPUT" : "INVALID_INPUT", layerA.message, base, n.nodeId);
  }
}

function checkList(
  value: unknown, field: ListInputField, path: string, n: ActionNode,
  actions: Map<string, Action>, byId: Map<string, ActionNode>, sourceText: string, bound: Bound,
): ActionInputValue {
  if (!isPlainObject(value) || value.kind !== "list") fail("INVALID_BINDING", "This input takes a list.", path, n.nodeId);
  const v = value as Record<string, unknown>;
  checkKeys(v, ["kind", "items"], path, n.nodeId);
  if (!Array.isArray(v.items)) fail("MALFORMED", "items must be a list.", `${path}.items`, n.nodeId);
  let remainders = 0;
  return (v.items as unknown[]).map((item, j) => {
    const ip = `${path}[${j}]`;
    if (!isPlainObject(item)) fail("MALFORMED", "Each item must be an object.", ip, n.nodeId);
    const out: Record<string, string> = {};
    for (const [k, iv] of Object.entries(item as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(k)) fail("FORBIDDEN_FIELD", `"${k}" is not allowed in an intent.`, `${ip}.${k}`, n.nodeId);
      if (!Object.prototype.hasOwnProperty.call(field.items, k)) fail("UNKNOWN_INPUT", `List items have no field "${k}".`, `${ip}.${k}`, n.nodeId);
      if (isPlainObject(iv) && iv.kind === "remainder" && ++remainders > 1) {
        fail("INVALID_BINDING", "Only one item can receive the remainder.", `${ip}.${k}`, n.nodeId);
      }
      out[k] = checkScalar(iv, field.items[k], `${ip}.${k}`, n, actions, byId, sourceText, bound);
    }
    return out;
  });
}

/** Validates one scalar value against its field and returns the string Layer
 *  A should see (the literal, or a typed placeholder for a bound/unresolved
 *  value). */
function checkScalar(
  value: unknown, field: ScalarInputField, path: string, n: ActionNode,
  actions: Map<string, Action>, byId: Map<string, ActionNode>, sourceText: string, bound: Bound,
): string {
  if (!isPlainObject(value) || typeof value.kind !== "string") fail("MALFORMED", "Each input must be a typed value.", path, n.nodeId);
  const v = value as Record<string, unknown> & { kind: string };

  switch (v.kind) {
    case "literal": {
      checkKeys(v, ["kind", "value"], path, n.nodeId);
      if (field.type === "address") {
        fail("INVALID_RECIPIENT", "An address input must be a recipient, so its provenance can be checked.", path, n.nodeId);
      }
      if (typeof v.value !== "string" || v.value.length > 200 || CONTROL_RE.test(v.value)) fail("MALFORMED", "Invalid literal.", path, n.nodeId);
      return v.value as string;
    }
    case "recipient": {
      checkKeys(v, ["kind", "display", "source", "address"], path, n.nodeId);
      if (field.type !== "address") fail("INVALID_BINDING", "Only an address input can take a recipient.", path, n.nodeId);
      return checkRecipient(v, path, n, sourceText);
    }
    case "output":
    case "remainder": {
      checkKeys(v, v.kind === "output" ? ["kind", "node", "output"] : ["kind", "node", "output", "minus"], path, n.nodeId);
      const producerId = str(v.node, `${path}.node`, 16, n.nodeId);
      const outputName = str(v.output, `${path}.output`, 64, n.nodeId);
      const producer = byId.get(producerId);
      if (!producer) fail("UNKNOWN_DEPENDENCY", `"${producerId}" is not a node in this intent.`, `${path}.node`, n.nodeId);
      if (producerId === n.nodeId) fail("SELF_DEPENDENCY", "A node can't consume its own output.", `${path}.node`, n.nodeId);
      if (!n.dependsOn.includes(producerId)) {
        fail("UNDECLARED_DEPENDENCY", `This input uses "${producerId}", which must be listed in dependsOn.`, `${path}.node`, n.nodeId);
      }
      if (v.kind === "remainder" && field.type !== "units") fail("INVALID_BINDING", "A remainder can only fill an amount.", path, n.nodeId);
      const bind = canBind(actions.get(producerId)!, outputName, field.type);
      if (!bind.ok) fail(bind.code, bind.message, `${path}.output`, n.nodeId);
      const decl = (bind as { ok: true; declaration: import("@/lib/sdk/types").ActionOutputDeclaration }).declaration;

      if (v.kind === "remainder") {
        if (!Array.isArray(v.minus) || v.minus.length === 0 || v.minus.length > 9 || !v.minus.every((m) => typeof m === "string" && UNITS_RE.test(m))) {
          fail("INVALID_BINDING", "A remainder subtracts 1–9 exact base-unit amounts.", `${path}.minus`, n.nodeId);
        }
      }

      const literalOf = (node: ActionNode) => (input: string): string | null | undefined => {
        const iv = node.inputs[input];
        if (iv === undefined) return undefined;
        return isPlainObject(iv) && iv.kind === "literal" && typeof iv.value === "string" ? iv.value : null;
      };

      // Output binding is ERC-20-only: the bound amount's token (or the bound
      // token itself) must be provably an ERC-20 from the producer's literal
      // inputs. Native MON, an undeclared denomination, or one that is itself
      // bound is refused — never resolved later.
      const erc20 = staticErc20(decl, literalOf(producer!));
      if (erc20 === null) {
        fail("NATIVE_OUTPUT_NOT_BINDABLE", "Only an output that is known to be an ERC-20 token can be passed to a later step (native MON can't be).", `${path}.output`, n.nodeId);
      }
      if (!bound.has(producerId)) bound.set(producerId, new Map());
      bound.get(producerId)!.set(outputName, { type: decl.type as "units" | "token", token: erc20 as string });

      // Token compatibility, when both sides are known statically.
      if (decl.type === "units" && Object.prototype.hasOwnProperty.call(actions.get(n.nodeId)!.inputSchema, "token")) {
        const produced = staticDenomination(decl, literalOf(producer!));
        const consumedRaw = literalOf(n)("token");
        const consumed = consumedRaw === undefined ? "" : consumedRaw === null ? null : normalizeToken(consumedRaw);
        if (produced !== null && consumed !== null && produced !== consumed) {
          fail("TOKEN_MISMATCH", "This amount is in a different token from the one this action pays.", path, n.nodeId);
        }
      }
      return field.type === "token" ? PLACEHOLDER_ADDRESS : PLACEHOLDER_UNITS;
    }
    case "list":
      return fail("INVALID_BINDING", "This input doesn't take a list.", path, n.nodeId);
    default:
      return fail("MALFORMED", `Unknown value kind "${v.kind}".`, path, n.nodeId);
  }
}

/**
 * Recipient provenance (Phase 0 rules): whatever the adapter — LLM included
 * — says the recipient is must appear in what the USER wrote, and only a
 * literal 0x address may arrive with an address. .nad names and payee names
 * arrive unresolved; the server resolves them later.
 */
function checkRecipient(v: Record<string, unknown>, path: string, n: ActionNode, sourceText: string): string {
  const display = str(v.display, `${path}.display`, 128, n.nodeId);
  if (!recipientAppearsIn(display, [sourceText])) {
    fail("RECIPIENT_PROVENANCE", `"${display}" doesn't appear in the request.`, `${path}.display`, n.nodeId);
  }
  switch (v.source) {
    case "address": {
      const a = v.address;
      if (typeof a !== "string" || !isAddress(a, { strict: false }) || a.toLowerCase() === ZERO) {
        fail("INVALID_RECIPIENT", "A recipient address must be a valid, non-zero 0x address.", `${path}.address`, n.nodeId);
      }
      if ((a as string).toLowerCase() !== display.toLowerCase()) {
        fail("RECIPIENT_PROVENANCE", "The recipient address must be exactly the address in the request.", `${path}.address`, n.nodeId);
      }
      return getAddress(a as string);
    }
    case "nad":
      if (!isDomainName(display)) fail("INVALID_RECIPIENT", `"${display}" is not a .nad name.`, `${path}.display`, n.nodeId);
      if (v.address !== undefined) fail("RECIPIENT_PROVENANCE", "A .nad name is resolved by PayAI, not supplied.", `${path}.address`, n.nodeId);
      return PLACEHOLDER_ADDRESS;
    case "payee":
      if (!PAYEE_RE.test(display)) fail("INVALID_RECIPIENT", `"${display}" is not a payee name.`, `${path}.display`, n.nodeId);
      if (v.address !== undefined) fail("RECIPIENT_PROVENANCE", "A payee is resolved by PayAI, not supplied.", `${path}.address`, n.nodeId);
      return PLACEHOLDER_ADDRESS;
    default:
      return fail("INVALID_RECIPIENT", "Unknown recipient source.", `${path}.source`, n.nodeId);
  }
}

export type { IntentGraph };
