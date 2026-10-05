/**
 * The durable Plan Store (Phase 2C, Stage 3A).
 *
 * Persists a planned intent as IMMUTABLE facts — never as mutable state:
 *
 *   veripay:plan:<planId>                              PlanCore
 *   veripay:plan:<planId>:approved                     approval
 *   veripay:plan:<planId>:node:<nodeId>:quote:<n>      quote attempt n (1…8)
 *   veripay:plan:<planId>:node:<nodeId>:tx             submitted transaction
 *   veripay:plan:<planId>:node:<nodeId>:result         confirmed/reverted/unverified result
 *   veripay:plan:<planId>:node:<nodeId>:intent:<slot>      signing intent n (1…8; before the final signature)
 *   veripay:plan:<planId>:node:<nodeId>:release:<quoteId>  release of that signing attempt
 *   veripay:plan:<planId>:abandoned                    abandonment
 *   veripay:plans:by-wallet:<wallet>                   best-effort index (sorted set)
 *
 * Every fact is written once (SET NX EX). An existing key is read back,
 * strictly parsed and compared: identical → idempotent; different →
 * CONFLICT; unparseable → CORRUPT. Nothing is ever overwritten, repaired or
 * deleted. Progress (node/plan state, current step) is DERIVED from the facts
 * by ./state.ts.
 *
 * A stored plan is never trusted as stored. The validator's provenance is
 * per-process (a WeakSet), so loading re-runs the whole trusted path on the
 * stored draft — validateIntentGraph → planIntent → assertPlanMatchesGraph —
 * and refuses (CORRUPT) unless planId, graphHash, wallet, chain, step order
 * and pins all match what was stored. A registry/action change that makes
 * the draft invalid fails the same way.
 *
 * Lifetimes: a plan expires 7 days after creation (expiresAt); every fact
 * lives exactly until expiresAt (never a shorter fixed TTL — a confirmed node
 * must never read back as pending while its plan lives). The core record and
 * its index entry alone are RETAINED a further PLAN_RETENTION_GRACE_SECONDS,
 * so the owner of an expired plan reads EXPIRED rather than NOT_FOUND
 * (readPlanCore checks ownership first, so no one else learns it exists).
 * Approval is possible only until approveBy (createdAt + 30 minutes).
 *
 * Storage: getRedis() (KV) when configured. In production without KV every
 * call is UNAVAILABLE — durable plans never fall back to process memory.
 * Development/test use an in-memory store with the same write-once, TTL and
 * strict-read semantics.
 *
 * Never signs, broadcasts, executes, builds calldata or calls an LLM. Quote
 * tokens are never stored — only their SHA-256.
 *
 * Server-only.
 */
import "server-only";
import { createHash } from "node:crypto";
import { isAddress } from "viem";
import { getRedis } from "@/lib/platform/kv";
import { isVerifiedOutputValue } from "@/lib/sdk/settlement";
import type { VerifiedOutputValue } from "@/lib/sdk/types";
import { PlanError, type PlanErrorCode } from "./errors";
import { assertPlanMatchesGraph, assertSessionWallet, canonicalize, planIntent } from "./planner";
import { recipientKey } from "./resolve";
import type {
  AbandonFact, ApprovalFact, NodeFacts, PlanFacts, PlanShape, QuoteFact, ReleaseFact, ReleaseReason, ResultFact, ResultStatus,
  SigningIntentFact, TxFact,
} from "./state";
import { unresolvedIntent } from "./state";
import { INTENT_CHAIN_ID, type ExecutionPlan, type InputValue, type RecipientValue, type ValidatedIntentGraph } from "./types";
import { isValidatedIntentGraph, validateIntentGraph } from "./validate";

export const PLAN_TTL_SECONDS = 7 * 24 * 60 * 60;
/** How long the core record (and its index entry) is kept past expiresAt —
 *  only so an expired plan reads as EXPIRED to its owner. Facts aren't kept. */
export const PLAN_RETENTION_GRACE_SECONDS = 24 * 60 * 60;
export const APPROVAL_WINDOW_MS = 30 * 60 * 1000;
export const MAX_QUOTE_ATTEMPTS = 8;
/** Release timing (Stage 5C-2e), from the intent's server-recorded intentAt:
 *  a wallet rejection is recorded within this window; an owner's "not sent"
 *  attestation only from its end. */
export const RELEASE_WINDOW_MS = 10 * 60 * 1000;
const PLAN_TTL_MS = PLAN_TTL_SECONDS * 1000;

const PLAN_ID_RE = /^plan_[0-9a-f]{32}$/;
const NODE_ID_RE = /^[a-z][a-z0-9_-]{0,15}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const QUOTE_ID_RE = /^[0-9a-f]{32}$/;
const TX_HASH_RE = /^0x[0-9a-f]{64}$/;
const LOWER_ADDR_RE = /^0x[0-9a-f]{40}$/;
const ZERO = "0x0000000000000000000000000000000000000000";
const MAX_QUOTE_TOKEN_LENGTH = 2048;

const fail = (code: PlanErrorCode, message: string, nodeId?: string): never => { throw new PlanError(code, message, nodeId); };

/* ── Keys ──────────────────────────────────────────────────────────────── */

function checkPlanId(planId: string): string {
  if (typeof planId !== "string" || !PLAN_ID_RE.test(planId)) fail("NOT_FOUND", "No such plan.");
  return planId;
}
function checkNodeId(nodeId: string): string {
  if (typeof nodeId !== "string" || !NODE_ID_RE.test(nodeId)) fail("INVALID_NODE", "No such step in this plan.");
  return nodeId;
}
function checkQuoteId(quoteId: string, nodeId: string): string {
  if (typeof quoteId !== "string" || !QUOTE_ID_RE.test(quoteId)) fail("INVALID_PLAN", "Invalid quote.", nodeId);
  return quoteId;
}
export const planKeys = {
  core: (planId: string) => `veripay:plan:${checkPlanId(planId)}`,
  approved: (planId: string) => `veripay:plan:${checkPlanId(planId)}:approved`,
  abandoned: (planId: string) => `veripay:plan:${checkPlanId(planId)}:abandoned`,
  quote: (planId: string, nodeId: string, n: number) => {
    if (!Number.isInteger(n) || n < 1 || n > MAX_QUOTE_ATTEMPTS) fail("INVALID_PLAN", "Invalid quote attempt.", nodeId);
    return `veripay:plan:${checkPlanId(planId)}:node:${checkNodeId(nodeId)}:quote:${n}`;
  },
  tx: (planId: string, nodeId: string) => `veripay:plan:${checkPlanId(planId)}:node:${checkNodeId(nodeId)}:tx`,
  result: (planId: string, nodeId: string) => `veripay:plan:${checkPlanId(planId)}:node:${checkNodeId(nodeId)}:result`,
  /** Per NODE, not per quote: concurrent intents for different quotes compete
   *  for the same slot, so at most one can be written (SET NX). */
  intent: (planId: string, nodeId: string, slot: number) => {
    if (!Number.isInteger(slot) || slot < 1 || slot > MAX_QUOTE_ATTEMPTS) fail("INVALID_PLAN", "Invalid signing slot.", nodeId);
    return `veripay:plan:${checkPlanId(planId)}:node:${checkNodeId(nodeId)}:intent:${slot}`;
  },
  release: (planId: string, nodeId: string, quoteId: string) =>
    `veripay:plan:${checkPlanId(planId)}:node:${checkNodeId(nodeId)}:release:${checkQuoteId(quoteId, nodeId)}`,
  byWallet: (wallet: string) => {
    if (typeof wallet !== "string" || !LOWER_ADDR_RE.test(wallet)) fail("NOT_FOUND", "No such wallet.");
    return `veripay:plans:by-wallet:${wallet}`;
  },
};

/* ── Backend: KV, or (outside production) an equivalent in-memory store ── */

interface Backend {
  /** The stored value (JSON-decoded), or null when absent/expired. */
  get(key: string): Promise<unknown>;
  /** Insert-if-absent with a TTL, atomically. True when this call wrote it. */
  insert(key: string, value: unknown, ttlSeconds: number): Promise<boolean>;
  indexAdd(key: string, member: string, score: number, ttlSeconds: number): Promise<void>;
  indexMembers(key: string): Promise<string[]>;
}

type MemEntry = { json: string; expiresAt: number };
type MemIndex = { members: Map<string, number>; expiresAt: number };
const g = globalThis as unknown as { __payaiPlanStore?: { kv: Map<string, MemEntry>; idx: Map<string, MemIndex> } };
const mem = (g.__payaiPlanStore ??= { kv: new Map(), idx: new Map() });

const memBackend: Backend = {
  async get(key) {
    const e = mem.kv.get(key);
    if (!e) return null;
    if (e.expiresAt <= Date.now()) { mem.kv.delete(key); return null; }
    try { return JSON.parse(e.json); } catch { return e.json; }
  },
  async insert(key, value, ttlSeconds) {
    const e = mem.kv.get(key);
    if (e && e.expiresAt > Date.now()) return false;
    mem.kv.set(key, { json: JSON.stringify(value), expiresAt: Date.now() + ttlSeconds * 1000 });
    return true;
  },
  async indexAdd(key, member, score, ttlSeconds) {
    let i = mem.idx.get(key);
    if (!i || i.expiresAt <= Date.now()) { i = { members: new Map(), expiresAt: 0 }; mem.idx.set(key, i); }
    i.members.set(member, score);
    i.expiresAt = Date.now() + ttlSeconds * 1000;
  },
  async indexMembers(key) {
    const i = mem.idx.get(key);
    if (!i || i.expiresAt <= Date.now()) return [];
    return [...i.members.entries()].sort((a, b) => a[1] - b[1]).map(([m]) => m);
  },
};

async function backend(): Promise<Backend> {
  const r = await getRedis();
  if (r) {
    return {
      get: (key) => r.get(key),
      insert: async (key, value, ttlSeconds) => !!(await r.set(key, value, { nx: true, ex: ttlSeconds })),
      indexAdd: async (key, member, score, ttlSeconds) => {
        await r.zadd(key, { score, member });
        await r.expire(key, ttlSeconds);
      },
      indexMembers: (key) => r.zrange(key, 0, Number.MAX_SAFE_INTEGER, { byScore: true }),
    };
  }
  if (process.env.NODE_ENV === "production") fail("UNAVAILABLE", "Plans are unavailable right now.");
  return memBackend;
}

/** Test-only: clear the in-memory store. */
export function __resetPlanStoreForTests(): void {
  mem.kv.clear();
  mem.idx.clear();
}
/** Test-only: put a raw value at a key in the in-memory store (to exercise
 *  corrupt/conflicting data). Never used by application code. */
export function __putRawForTests(key: string, raw: string, ttlSeconds = PLAN_TTL_SECONDS): void {
  mem.kv.set(key, { json: raw, expiresAt: Date.now() + ttlSeconds * 1000 });
}

/* ── Strict parsing ────────────────────────────────────────────────────── */

const isPlain = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(o).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
const isTime = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const isStr = (v: unknown, re: RegExp): v is string => typeof v === "string" && re.test(v);
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export interface PlanCore {
  v: 1;
  planId: string;
  graphHash: string;
  /** Lowercase. */
  wallet: string;
  chainId: typeof INTENT_CHAIN_ID;
  /** The validated graph's structural content in validator-accepted draft
   *  form (status "draft", every node state pending). Untrusted until
   *  rehydrated. */
  draft: Record<string, unknown>;
  /** recipientKey(.nad/payee recipient) → lowercase address, pinned when the
   *  plan was created; authoritative for this plan. */
  pins: Readonly<Record<string, string>>;
  stepOrder: readonly string[];
  createdAt: number;
  approveBy: number;
  expiresAt: number;
}

const CORE_KEYS = ["v", "planId", "graphHash", "wallet", "chainId", "draft", "pins", "stepOrder", "createdAt", "approveBy", "expiresAt"] as const;

export function parsePlanCore(raw: unknown): PlanCore | null {
  if (!isPlain(raw) || !exactKeys(raw, CORE_KEYS)) return null;
  const r = raw;
  if (r.v !== 1 || !isStr(r.planId, PLAN_ID_RE) || !isStr(r.graphHash, HEX64_RE) || !isStr(r.wallet, LOWER_ADDR_RE)) return null;
  if (r.chainId !== INTENT_CHAIN_ID || !isPlain(r.draft)) return null;
  if (!isPlain(r.pins)) return null;
  for (const [k, a] of Object.entries(r.pins)) {
    if (k.length === 0 || k.length > 200 || !isStr(a, LOWER_ADDR_RE) || a === ZERO) return null;
  }
  if (!Array.isArray(r.stepOrder) || r.stepOrder.length === 0 || !r.stepOrder.every((s) => isStr(s, NODE_ID_RE))) return null;
  if (new Set(r.stepOrder).size !== r.stepOrder.length) return null;
  if (!isTime(r.createdAt) || r.approveBy !== r.createdAt + APPROVAL_WINDOW_MS || r.expiresAt !== r.createdAt + PLAN_TTL_MS) return null;
  return copy(r) as unknown as PlanCore;
}

function parseApproval(raw: unknown, planId: string): ApprovalFact | null {
  if (!isPlain(raw) || !exactKeys(raw, ["planId", "graphHash", "wallet", "approvedAt"])) return null;
  if (raw.planId !== planId || !isStr(raw.graphHash, HEX64_RE) || !isStr(raw.wallet, LOWER_ADDR_RE) || !isTime(raw.approvedAt)) return null;
  return copy(raw) as unknown as ApprovalFact;
}
function parseAbandon(raw: unknown, planId: string): AbandonFact | null {
  if (!isPlain(raw) || !exactKeys(raw, ["planId", "wallet", "abandonedAt"])) return null;
  if (raw.planId !== planId || !isStr(raw.wallet, LOWER_ADDR_RE) || !isTime(raw.abandonedAt)) return null;
  return copy(raw) as unknown as AbandonFact;
}
function parseQuote(raw: unknown, planId: string, nodeId: string, attempt: number): QuoteFact | null {
  if (!isPlain(raw) || !exactKeys(raw, ["planId", "nodeId", "attempt", "quoteId", "quoteTokenHash", "inputsHash", "termsHash", "quotedAt", "recordedAt"])) return null;
  if (raw.planId !== planId || raw.nodeId !== nodeId || raw.attempt !== attempt) return null;
  if (!isStr(raw.quoteId, QUOTE_ID_RE) || !isStr(raw.quoteTokenHash, HEX64_RE) || !isStr(raw.inputsHash, HEX64_RE) || !isStr(raw.termsHash, HEX64_RE)) return null;
  if (!isTime(raw.quotedAt) || !isTime(raw.recordedAt)) return null;
  return copy(raw) as unknown as QuoteFact;
}
function parseTx(raw: unknown, planId: string, nodeId: string): TxFact | null {
  if (!isPlain(raw) || !exactKeys(raw, ["planId", "nodeId", "quoteId", "txHash", "wallet", "submittedAt"])) return null;
  if (raw.planId !== planId || raw.nodeId !== nodeId) return null;
  if (!isStr(raw.quoteId, QUOTE_ID_RE) || !isStr(raw.txHash, TX_HASH_RE) || !isStr(raw.wallet, LOWER_ADDR_RE) || !isTime(raw.submittedAt)) return null;
  return copy(raw) as unknown as TxFact;
}
function parseIntent(raw: unknown, planId: string, nodeId: string): SigningIntentFact | null {
  if (!isPlain(raw) || !exactKeys(raw, ["planId", "nodeId", "quoteId", "attempt", "wallet", "intentAt", "buildDigest"])) return null;
  if (raw.planId !== planId || raw.nodeId !== nodeId || !isStr(raw.quoteId, QUOTE_ID_RE)) return null;
  if (!Number.isInteger(raw.attempt) || (raw.attempt as number) < 1 || (raw.attempt as number) > MAX_QUOTE_ATTEMPTS) return null;
  if (!isStr(raw.wallet, LOWER_ADDR_RE) || !isTime(raw.intentAt) || !isStr(raw.buildDigest, HEX64_RE)) return null;
  return copy(raw) as unknown as SigningIntentFact;
}
const RELEASE_REASONS: readonly ReleaseReason[] = ["wallet_rejected", "user_attested_not_sent"];
function parseRelease(raw: unknown, planId: string, nodeId: string, quoteId: string): ReleaseFact | null {
  if (!isPlain(raw) || !exactKeys(raw, ["planId", "nodeId", "quoteId", "wallet", "reason", "releasedAt"])) return null;
  if (raw.planId !== planId || raw.nodeId !== nodeId || raw.quoteId !== quoteId) return null;
  if (!isStr(raw.wallet, LOWER_ADDR_RE) || !isTime(raw.releasedAt)) return null;
  if (typeof raw.reason !== "string" || !RELEASE_REASONS.includes(raw.reason as ReleaseReason)) return null;
  return copy(raw) as unknown as ReleaseFact;
}
const RESULT_STATUSES: readonly ResultStatus[] = ["confirmed", "reverted", "unverified"];
function parseOutputs(v: unknown): Record<string, VerifiedOutputValue> | null | undefined {
  if (v === null) return null;
  if (!isPlain(v) || Object.keys(v).length === 0) return undefined;
  for (const [k, o] of Object.entries(v)) if (k.length === 0 || k.length > 64 || !isVerifiedOutputValue(o)) return undefined;
  return copy(v) as Record<string, VerifiedOutputValue>;
}
function parseResult(raw: unknown, planId: string, nodeId: string): ResultFact | null {
  if (!isPlain(raw) || !exactKeys(raw, ["planId", "nodeId", "quoteId", "txHash", "status", "outputs", "recordedAt"])) return null;
  if (raw.planId !== planId || raw.nodeId !== nodeId) return null;
  if (!isStr(raw.quoteId, QUOTE_ID_RE) || !isStr(raw.txHash, TX_HASH_RE) || !isTime(raw.recordedAt)) return null;
  if (typeof raw.status !== "string" || !RESULT_STATUSES.includes(raw.status as ResultStatus)) return null;
  const outputs = parseOutputs(raw.outputs);
  if (outputs === undefined) return null;
  if (raw.status === "reverted" && outputs !== null) return null;
  return copy(raw) as unknown as ResultFact;
}

/* ── Write-once ────────────────────────────────────────────────────────── */

/** Insert `record` once. If the key exists: identical (per `same`) →
 *  the stored record; different → CONFLICT; unparseable → CORRUPT. */
async function writeOnce<T>(
  key: string, record: T, ttlSeconds: number,
  parse: (raw: unknown) => T | null, same: (a: T, b: T) => boolean, nodeId?: string,
): Promise<{ record: T; created: boolean }> {
  const be = await backend();
  for (let i = 0; i < 2; i++) {
    if (await be.insert(key, record, ttlSeconds)) return { record: copy(record), created: true };
    const raw = await be.get(key);
    if (raw === null || raw === undefined) continue; // expired between the two calls — try once more
    const existing = parse(raw);
    if (!existing) return fail("CORRUPT", "A stored plan record is invalid.", nodeId);
    if (!same(existing, record)) return fail("CONFLICT", "This plan already has a different record here.", nodeId);
    return { record: existing, created: false };
  }
  return fail("CONFLICT", "This plan record changed while it was being written.", nodeId);
}

const sameBy = <T>(fields: readonly (keyof T)[]) => (a: T, b: T) =>
  fields.every((f) => canonicalize(a[f] as unknown) === canonicalize(b[f] as unknown));

/** Seconds until the plan's expiresAt (≥ 1), or EXPIRED. */
function remainingTtl(core: PlanCore, now: number): number {
  const s = Math.ceil((core.expiresAt - now) / 1000);
  if (s <= 0) fail("EXPIRED", "This plan has expired.");
  return s;
}

/* ── Pins ──────────────────────────────────────────────────────────────── */

function recipientsOf(inputs: Readonly<Record<string, InputValue>>): RecipientValue[] {
  const out: RecipientValue[] = [];
  for (const v of Object.values(inputs)) {
    if (v.kind === "recipient") out.push(v);
    else if (v.kind === "list") for (const item of v.items) for (const iv of Object.values(item)) if (iv.kind === "recipient") out.push(iv);
  }
  return out;
}

/** The pin keys a graph needs: every .nad / payee recipient (a typed 0x
 *  address needs none — it is used as written). */
export function requiredPinKeys(graph: Pick<ValidatedIntentGraph, "nodes">): string[] {
  const keys = new Set<string>();
  for (const n of graph.nodes) for (const r of recipientsOf(n.inputs)) if (r.source !== "address") keys.add(recipientKey(r));
  return [...keys].sort();
}

function checkPins(pins: unknown, required: string[], code: PlanErrorCode): Record<string, string> {
  if (!isPlain(pins)) return fail(code, "Recipients must be resolved before planning.");
  const keys = Object.keys(pins).sort();
  if (keys.length !== required.length || keys.some((k, i) => k !== required[i])) {
    return fail(code, "The resolved recipients don't match the intent's recipients.");
  }
  const out: Record<string, string> = {};
  for (const k of keys) {
    const a = pins[k];
    if (typeof a !== "string" || !isAddress(a, { strict: false }) || a.toLowerCase() === ZERO) {
      return fail(code, "A resolved recipient address is invalid.");
    }
    out[k] = a.toLowerCase();
  }
  return out;
}

/* ── Create ────────────────────────────────────────────────────────────── */

export interface StoreContext {
  /** The authenticated session's wallet. */
  sessionWallet: string | null | undefined;
  /** getChain().id at the call site. */
  activeChainId: number;
  /** Defaults to Date.now(). */
  now?: number;
}

/** The validated graph's structural content in the draft form the validator
 *  accepts — runtime state reset (it is excluded from graphHash anyway). */
function draftOf(graph: ValidatedIntentGraph): Record<string, unknown> {
  return copy({
    id: graph.id, version: graph.version, chainId: graph.chainId, wallet: graph.wallet,
    source: graph.source, status: "draft",
    nodes: graph.nodes.map((n) => ({
      nodeId: n.nodeId, ref: n.ref, inputs: n.inputs, dependsOn: n.dependsOn,
      validation: { state: "pending" }, execution: { state: "pending" }, verification: { state: "pending" },
    })),
  });
}

const coreIdentity = (c: PlanCore) => canonicalize({
  planId: c.planId, graphHash: c.graphHash, wallet: c.wallet, chainId: c.chainId, draft: c.draft, pins: c.pins, stepOrder: c.stepOrder,
});

/**
 * Persist a plan from a graph the validator produced and the plan
 * planIntent made from it, with the server-resolved pins for its .nad/payee
 * recipients. Creating the same plan again returns the stored one (its
 * original timestamps); a different plan under the same id is CONFLICT.
 */
export async function createPlan(
  graph: ValidatedIntentGraph, plan: ExecutionPlan, pins: Readonly<Record<string, string>>, ctx: StoreContext,
): Promise<{ core: PlanCore; created: boolean }> {
  if (!isValidatedIntentGraph(graph)) fail("UNVALIDATED_GRAPH", "Only an intent that passed validation can be stored.");
  assertPlanMatchesGraph(plan, graph);
  assertSessionWallet(plan.wallet, ctx.sessionWallet);
  if (plan.chainId !== INTENT_CHAIN_ID) fail("INVALID_PLAN", "Wrong chain.");
  const now = ctx.now ?? Date.now();
  const core: PlanCore = {
    v: 1,
    planId: plan.planId,
    graphHash: plan.graphHash,
    wallet: plan.wallet.toLowerCase(),
    chainId: INTENT_CHAIN_ID,
    draft: draftOf(graph),
    pins: checkPins(pins, requiredPinKeys(graph), "RECIPIENT_UNRESOLVED"),
    stepOrder: plan.steps.map((s) => s.nodeId),
    createdAt: now,
    approveBy: now + APPROVAL_WINDOW_MS,
    expiresAt: now + PLAN_TTL_MS,
  };
  if (!parsePlanCore(core)) fail("INVALID_PLAN", "This plan can't be stored.");
  const res = await writeOnce(planKeys.core(core.planId), core, PLAN_TTL_SECONDS + PLAN_RETENTION_GRACE_SECONDS, parsePlanCore, (a, b) => coreIdentity(a) === coreIdentity(b));
  if (res.record.expiresAt <= now) fail("EXPIRED", "This plan has expired.");
  // Best effort: the index is never the source of truth.
  try {
    const be = await backend();
    await be.indexAdd(planKeys.byWallet(core.wallet), core.planId, res.record.createdAt, PLAN_TTL_SECONDS + PLAN_RETENTION_GRACE_SECONDS);
  } catch { /* ignored */ }
  return { core: res.record, created: res.created };
}

/* ── Load + rehydrate ──────────────────────────────────────────────────── */

/** The stored core for this session's wallet. Another wallet's plan reads
 *  as NOT_FOUND (its existence isn't disclosed). */
export async function readPlanCore(planId: string, ctx: Pick<StoreContext, "sessionWallet" | "now">): Promise<PlanCore> {
  const be = await backend();
  const raw = await be.get(planKeys.core(planId));
  if (raw === null || raw === undefined) return fail("NOT_FOUND", "No such plan.");
  const core = parsePlanCore(raw);
  if (!core || core.planId !== planId) return fail("CORRUPT", "This plan's stored record is invalid.");
  if (typeof ctx.sessionWallet !== "string" || ctx.sessionWallet.toLowerCase() !== core.wallet) return fail("NOT_FOUND", "No such plan.");
  if ((ctx.now ?? Date.now()) >= core.expiresAt) return fail("EXPIRED", "This plan has expired.");
  return core;
}

/**
 * Re-establish trust in a stored core: re-validate its draft, re-plan it,
 * and require every stored structural fact to match. Never mutates storage.
 */
export function rehydratePlan(core: PlanCore, ctx: Pick<StoreContext, "activeChainId" | "now">): { graph: ValidatedIntentGraph; plan: ExecutionPlan } {
  const corrupt = (): never => fail("CORRUPT", "This plan's stored record is invalid.");
  const v = validateIntentGraph(core.draft, { sessionWallet: core.wallet, activeChainId: ctx.activeChainId, now: ctx.now });
  if (!v.ok) return corrupt();
  let plan: ExecutionPlan;
  try {
    plan = planIntent(v.value, { sessionWallet: core.wallet });
    assertPlanMatchesGraph(plan, v.value);
  } catch {
    return corrupt();
  }
  const steps = plan.steps.map((s) => s.nodeId);
  if (
    plan.planId !== core.planId || plan.graphHash !== core.graphHash || plan.wallet.toLowerCase() !== core.wallet ||
    plan.chainId !== core.chainId || core.chainId !== INTENT_CHAIN_ID ||
    steps.length !== core.stepOrder.length || steps.some((id, i) => id !== core.stepOrder[i])
  ) return corrupt();
  try {
    checkPins(core.pins, requiredPinKeys(v.value), "CORRUPT");
  } catch {
    return corrupt();
  }
  return { graph: v.value, plan };
}

export interface LoadedPlan {
  core: PlanCore;
  /** Trusted again: produced by the validator / planner in this process. */
  graph: ValidatedIntentGraph;
  plan: ExecutionPlan;
  facts: PlanFacts;
  shape: PlanShape;
}

/** Load, rehydrate and read every fact of a plan this session owns. */
export async function loadPlan(planId: string, ctx: StoreContext): Promise<LoadedPlan> {
  const core = await readPlanCore(planId, ctx);
  const { graph, plan } = rehydratePlan(core, ctx);
  const facts = await readFacts(core);
  const dependsOn: Record<string, string[]> = {};
  for (const s of plan.steps) dependsOn[s.nodeId] = [...s.dependsOn];
  return { core, graph, plan, facts, shape: { stepOrder: [...core.stepOrder], dependsOn } };
}

async function readFacts(core: PlanCore): Promise<PlanFacts> {
  const be = await backend();
  const read = async <T>(key: string, parse: (raw: unknown) => T | null, nodeId?: string): Promise<T | null> => {
    const raw = await be.get(key);
    if (raw === null || raw === undefined) return null;
    const v = parse(raw);
    if (!v) return fail("CORRUPT", "A stored plan record is invalid.", nodeId);
    return v;
  };
  const id = core.planId;
  const approval = await read(planKeys.approved(id), (r) => parseApproval(r, id));
  if (approval && (approval.graphHash !== core.graphHash || approval.wallet !== core.wallet)) fail("CORRUPT", "A stored plan record is invalid.");
  const abandoned = await read(planKeys.abandoned(id), (r) => parseAbandon(r, id));
  if (abandoned && abandoned.wallet !== core.wallet) fail("CORRUPT", "A stored plan record is invalid.");
  const nodes: Record<string, NodeFacts> = {};
  for (const nodeId of core.stepOrder) {
    const quotes: QuoteFact[] = [];
    for (let n = 1; n <= MAX_QUOTE_ATTEMPTS; n++) {
      const q = await read(planKeys.quote(id, nodeId, n), (r) => parseQuote(r, id, nodeId, n), nodeId);
      if (!q) break;
      quotes.push(q);
    }
    const tx = await read(planKeys.tx(id, nodeId), (r) => parseTx(r, id, nodeId), nodeId);
    if (tx && (tx.wallet !== core.wallet || !quotes.some((q) => q.quoteId === tx.quoteId))) fail("CORRUPT", "A stored plan record is invalid.", nodeId);
    const result = await read(planKeys.result(id, nodeId), (r) => parseResult(r, id, nodeId), nodeId);
    if (result && (!tx || result.txHash !== tx.txHash || result.quoteId !== tx.quoteId)) fail("CORRUPT", "A stored plan record is invalid.", nodeId);
    // Signing intents, slot by slot (1, 2, …): each for one of this node's
    // own quotes (at its attempt), each quote at most once.
    const intents: SigningIntentFact[] = [];
    for (let n = 1; n <= MAX_QUOTE_ATTEMPTS; n++) {
      const intent = await read(planKeys.intent(id, nodeId, n), (r) => parseIntent(r, id, nodeId), nodeId);
      if (!intent) break;
      const q = quotes.find((x) => x.quoteId === intent.quoteId);
      if (!q || intent.attempt !== q.attempt || intent.wallet !== core.wallet || intents.some((i) => i.quoteId === intent.quoteId)) {
        fail("CORRUPT", "A stored plan record is invalid.", nodeId);
      }
      intents.push(intent);
    }
    // A release only ever follows its quote's intent.
    const releases: ReleaseFact[] = [];
    for (const q of quotes) {
      const release = await read(planKeys.release(id, nodeId, q.quoteId), (r) => parseRelease(r, id, nodeId, q.quoteId), nodeId);
      if (!release) continue;
      if (release.wallet !== core.wallet || !intents.some((i) => i.quoteId === q.quoteId)) fail("CORRUPT", "A stored plan record is invalid.", nodeId);
      releases.push(release);
    }
    // A later slot is only ever written once every earlier intent is resolved.
    const resolved = (i: SigningIntentFact) => (tx !== null && tx.quoteId === i.quoteId) || releases.some((r) => r.quoteId === i.quoteId);
    if (intents.slice(0, -1).some((i) => !resolved(i))) fail("CORRUPT", "A stored plan record is invalid.", nodeId);
    nodes[nodeId] = { quotes, tx, result, intents, releases };
  }
  return { approval, abandoned, nodes };
}

function stepOf(loaded: LoadedPlan, nodeId: string) {
  const step = loaded.plan.steps.find((s) => s.nodeId === nodeId);
  if (!step) return fail("INVALID_NODE", "No such step in this plan.", nodeId);
  return step;
}

/* ── Facts ─────────────────────────────────────────────────────────────── */

/** Approve, once, within the approval window; never on an abandoned plan. */
export async function approvePlan(planId: string, ctx: StoreContext): Promise<ApprovalFact> {
  const loaded = await loadPlan(planId, ctx);
  const now = ctx.now ?? Date.now();
  const { core, facts } = loaded;
  const record: ApprovalFact = { planId, graphHash: core.graphHash, wallet: core.wallet, approvedAt: now };
  const same = sameBy<ApprovalFact>(["planId", "graphHash", "wallet"]);
  if (facts.approval) {
    if (!same(facts.approval, record)) fail("CONFLICT", "This plan already has a different approval.");
    return facts.approval;
  }
  if (facts.abandoned) fail("NOT_APPROVABLE", "This plan was abandoned.");
  if (now > core.approveBy) fail("NOT_APPROVABLE", "This plan can no longer be approved — plan it again.");
  return (await writeOnce(planKeys.approved(planId), record, remainingTtl(core, now), (r) => parseApproval(r, planId), same)).record;
}

/** Abandon, once. Existing facts stay; submitted transactions may still
 *  record their transaction/result. */
export async function abandonPlan(planId: string, ctx: StoreContext): Promise<AbandonFact> {
  const { core } = await loadPlan(planId, ctx);
  const now = ctx.now ?? Date.now();
  const record: AbandonFact = { planId, wallet: core.wallet, abandonedAt: now };
  return (await writeOnce(planKeys.abandoned(planId), record, remainingTtl(core, now), (r) => parseAbandon(r, planId), sameBy<AbandonFact>(["planId", "wallet"]))).record;
}

export interface QuoteInput {
  /** 1-based; attempt n > 1 requires attempt n − 1 (see nextQuoteAttempt). */
  attempt: number;
  quoteId: string;
  /** The quote token as issued — hashed here, never stored. */
  quoteToken: string;
  inputsHash: string;
  termsHash: string;
  quotedAt: number;
}

/** The attempt number the next quote for this node takes. */
export function nextQuoteAttempt(loaded: LoadedPlan, nodeId: string): number {
  stepOf(loaded, nodeId);
  return loaded.facts.nodes[nodeId].quotes.length + 1;
}

export async function recordQuote(planId: string, nodeId: string, input: QuoteInput, ctx: StoreContext): Promise<QuoteFact> {
  checkNodeId(nodeId);
  const loaded = await loadPlan(planId, ctx);
  stepOf(loaded, nodeId);
  const now = ctx.now ?? Date.now();
  if (loaded.facts.abandoned) fail("CONFLICT", "This plan was abandoned.", nodeId);
  const n = input.attempt;
  if (Number.isInteger(n) && n > MAX_QUOTE_ATTEMPTS) fail("CONFLICT", "This step has reached its maximum number of quotes.", nodeId);
  if (!Number.isInteger(n) || n < 1) fail("INVALID_PLAN", "Invalid quote attempt.", nodeId);
  if (n > loaded.facts.nodes[nodeId].quotes.length + 1) fail("INVALID_PLAN", "Quote attempts are numbered in order.", nodeId);
  if (!isStr(input.quoteId, QUOTE_ID_RE) || !isStr(input.inputsHash, HEX64_RE) || !isStr(input.termsHash, HEX64_RE) || !isTime(input.quotedAt)) {
    fail("INVALID_PLAN", "Invalid quote.", nodeId);
  }
  if (typeof input.quoteToken !== "string" || input.quoteToken.length === 0 || input.quoteToken.length > MAX_QUOTE_TOKEN_LENGTH) fail("INVALID_PLAN", "Invalid quote.", nodeId);
  const record: QuoteFact = {
    planId, nodeId, attempt: n, quoteId: input.quoteId,
    quoteTokenHash: createHash("sha256").update(input.quoteToken, "utf8").digest("hex"),
    inputsHash: input.inputsHash, termsHash: input.termsHash, quotedAt: input.quotedAt, recordedAt: now,
  };
  const same = sameBy<QuoteFact>(["planId", "nodeId", "attempt", "quoteId", "quoteTokenHash", "inputsHash", "termsHash", "quotedAt"]);
  return (await writeOnce(planKeys.quote(planId, nodeId, n), record, remainingTtl(loaded.core, now), (r) => parseQuote(r, planId, nodeId, n), same, nodeId)).record;
}

/** Record that a transaction for one of this node's quotes was submitted.
 *  Submission only — it proves nothing about confirmation. */
export async function recordTx(planId: string, nodeId: string, input: { quoteId: string; txHash: string }, ctx: StoreContext): Promise<TxFact> {
  checkNodeId(nodeId);
  const loaded = await loadPlan(planId, ctx);
  stepOf(loaded, nodeId);
  const now = ctx.now ?? Date.now();
  if (!isStr(input.quoteId, QUOTE_ID_RE)) fail("INVALID_PLAN", "Invalid quote.", nodeId);
  if (typeof input.txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(input.txHash)) fail("INVALID_PLAN", "Invalid transaction hash.", nodeId);
  if (!loaded.facts.nodes[nodeId].quotes.some((q) => q.quoteId === input.quoteId)) fail("NOT_FOUND", "No such quote for this step.", nodeId);
  const record: TxFact = { planId, nodeId, quoteId: input.quoteId, txHash: input.txHash.toLowerCase(), wallet: loaded.core.wallet, submittedAt: now };
  const same = sameBy<TxFact>(["planId", "nodeId", "quoteId", "txHash", "wallet"]);
  return (await writeOnce(planKeys.tx(planId, nodeId), record, remainingTtl(loaded.core, now), (r) => parseTx(r, planId, nodeId), same, nodeId)).record;
}

/**
 * Record, BEFORE the final action of a quote attempt is requested from the
 * wallet, that it may be signed (Stage 5C-2d). Write-once per node + quote.
 * The wallet comes from the stored plan; intentAt from the server clock; the
 * build digest from the caller (the Plan Service, from the SDK build record).
 * Refused unless the plan is approved and not abandoned, the quote is the
 * node's LATEST attempt, no transaction is recorded for the node, and no
 * other signing attempt on the node is unresolved.
 */
export async function recordSigningIntent(
  planId: string, nodeId: string, input: { quoteId: string; buildDigest: string }, ctx: StoreContext,
): Promise<SigningIntentFact> {
  checkNodeId(nodeId);
  const loaded = await loadPlan(planId, ctx);
  stepOf(loaded, nodeId);
  const now = ctx.now ?? Date.now();
  if (!isStr(input?.quoteId, QUOTE_ID_RE)) fail("INVALID_PLAN", "Invalid quote.", nodeId);
  if (!isStr(input?.buildDigest, HEX64_RE)) fail("INVALID_PLAN", "Invalid build.", nodeId);
  const f = loaded.facts.nodes[nodeId];
  if (!loaded.facts.approval) fail("NOT_APPROVED", "Approve this plan first.", nodeId);
  if (loaded.facts.abandoned) fail("CONFLICT", "This plan was abandoned.", nodeId);
  const latest = f.quotes.at(-1);
  if (!latest || latest.quoteId !== input.quoteId) {
    if (!f.quotes.some((q) => q.quoteId === input.quoteId)) fail("NOT_FOUND", "No such quote for this step.", nodeId);
    fail("CONFLICT", "That isn't this step's latest quote.", nodeId);
  }
  if (f.tx) fail("CONFLICT", "A transaction is already recorded for this step.", nodeId);
  // The slot: this quote's own (a repeat is idempotent), else the next one —
  // allowed only when every earlier intent is resolved. Two callers that read
  // the same facts compute the SAME slot, and SET NX lets only one write it;
  // the other gets CONFLICT and must not sign.
  const own = f.intents.findIndex((i) => i.quoteId === input.quoteId);
  let slot: number;
  if (own >= 0) {
    slot = own + 1;
  } else {
    if (unresolvedIntent(f)) fail("SIGNATURE_UNRESOLVED", "An earlier signature for this step is unresolved.", nodeId);
    slot = f.intents.length + 1;
    if (slot > MAX_QUOTE_ATTEMPTS) fail("CONFLICT", "This step has no signing attempts left.", nodeId);
  }
  const record: SigningIntentFact = {
    planId, nodeId, quoteId: input.quoteId, attempt: latest!.attempt, wallet: loaded.core.wallet, intentAt: now, buildDigest: input.buildDigest,
  };
  const same = sameBy<SigningIntentFact>(["planId", "nodeId", "quoteId", "attempt", "wallet", "buildDigest"]);
  return (await writeOnce(planKeys.intent(planId, nodeId, slot), record, remainingTtl(loaded.core, now), (r) => parseIntent(r, planId, nodeId), same, nodeId)).record;
}

/**
 * Record that the owner released a signing attempt: its final action was
 * not sent. Write-once per node + quote. Requires that attempt's intent and
 * no transaction recorded for it. Leaves the intent in place, and never
 * prevents recordTx for that quote — chain evidence wins.
 */
export async function recordRelease(
  planId: string, nodeId: string, input: { quoteId: string; reason: ReleaseReason }, ctx: StoreContext,
): Promise<ReleaseFact> {
  checkNodeId(nodeId);
  const loaded = await loadPlan(planId, ctx);
  stepOf(loaded, nodeId);
  const now = ctx.now ?? Date.now();
  if (!isStr(input?.quoteId, QUOTE_ID_RE)) fail("INVALID_PLAN", "Invalid quote.", nodeId);
  if (typeof input.reason !== "string" || !RELEASE_REASONS.includes(input.reason)) fail("INVALID_PLAN", "Invalid release reason.", nodeId);
  const f = loaded.facts.nodes[nodeId];
  const intent = f.intents.find((i) => i.quoteId === input.quoteId);
  if (!intent) return fail("NOT_FOUND", "No signing attempt for that quote.", nodeId);
  if (f.tx && f.tx.quoteId === input.quoteId) fail("CONFLICT", "A transaction is already recorded for that quote.", nodeId);
  // Write-once first: the same release again is idempotent at any time.
  const existing = f.releases.find((r) => r.quoteId === input.quoteId);
  if (existing) {
    if (existing.reason !== input.reason || existing.wallet !== loaded.core.wallet) fail("CONFLICT", "This signing attempt was already released differently.", nodeId);
    return existing;
  }
  // Timing, by the server's clock against the stored intentAt — never a
  // client's. A wallet rejection is immediate; "not sent" needs time for a
  // pending transaction to show up first.
  const windowEnd = intent.intentAt + RELEASE_WINDOW_MS;
  if (input.reason === "wallet_rejected" && now > windowEnd) {
    fail("CONFLICT", "A wallet rejection can only be recorded right after the signature was requested.", nodeId);
  }
  if (input.reason === "user_attested_not_sent" && now < windowEnd) {
    fail("STEP_NOT_READY", "Check your wallet's activity — this can be confirmed 10 minutes after the signature was requested.", nodeId);
  }
  const record: ReleaseFact = { planId, nodeId, quoteId: input.quoteId, wallet: loaded.core.wallet, reason: input.reason, releasedAt: now };
  const same = sameBy<ReleaseFact>(["planId", "nodeId", "quoteId", "wallet", "reason"]);
  return (await writeOnce(planKeys.release(planId, nodeId, input.quoteId), record, remainingTtl(loaded.core, now), (r) => parseRelease(r, planId, nodeId, input.quoteId), same, nodeId)).record;
}

export interface ResultInput {
  quoteId: string;
  txHash: string;
  status: ResultStatus;
  outputs: Readonly<Record<string, VerifiedOutputValue>> | null;
}

/**
 * Record a node's settled outcome — to be populated by the server from SDK
 * records (Stage 3B), never from a client. A "confirmed" result that lacks
 * any output a later step needs is stored as "unverified": it can't feed the
 * plan, so it isn't presented as complete.
 */
export async function recordResult(planId: string, nodeId: string, input: ResultInput, ctx: StoreContext): Promise<ResultFact> {
  checkNodeId(nodeId);
  const loaded = await loadPlan(planId, ctx);
  const step = stepOf(loaded, nodeId);
  const now = ctx.now ?? Date.now();
  const tx = loaded.facts.nodes[nodeId].tx;
  if (!tx) return fail("NOT_FOUND", "This step has no submitted transaction.", nodeId);
  const txHash = typeof input.txHash === "string" ? input.txHash.toLowerCase() : "";
  if (input.quoteId !== tx.quoteId || txHash !== tx.txHash) fail("CONFLICT", "This result isn't for this step's transaction.", nodeId);
  if (!RESULT_STATUSES.includes(input.status)) fail("INVALID_PLAN", "Invalid result status.", nodeId);
  const outputs = parseOutputs(input.outputs);
  if (outputs === undefined) fail("INVALID_PLAN", "Invalid result outputs.", nodeId);
  if (input.status === "reverted" && outputs !== null) fail("INVALID_PLAN", "A reverted step has no outputs.", nodeId);
  let status = input.status;
  if (status === "confirmed" && step.outputsNeeded.some((o) => !outputs || !Object.prototype.hasOwnProperty.call(outputs, o))) status = "unverified";
  const record: ResultFact = { planId, nodeId, quoteId: tx.quoteId, txHash: tx.txHash, status, outputs: outputs ?? null, recordedAt: now };
  const same = sameBy<ResultFact>(["planId", "nodeId", "quoteId", "txHash", "status", "outputs"]);
  return (await writeOnce(planKeys.result(planId, nodeId), record, remainingTtl(loaded.core, now), (r) => parseResult(r, planId, nodeId), same, nodeId)).record;
}

/* ── Wallet index ──────────────────────────────────────────────────────── */

/**
 * The live plans a wallet owns, newest first. Candidates come from the
 * best-effort index; each is loaded from its canonical key, strictly parsed
 * and checked against the wallet — stale, corrupt, expired or mismatched
 * entries are skipped. Never trusted on the index alone.
 */
export async function listPlansForWallet(wallet: string, ctx: Pick<StoreContext, "now"> = {}): Promise<PlanCore[]> {
  if (typeof wallet !== "string" || !isAddress(wallet, { strict: false })) return [];
  const w = wallet.toLowerCase();
  const now = ctx.now ?? Date.now();
  const be = await backend();
  let ids: string[];
  try {
    ids = await be.indexMembers(planKeys.byWallet(w));
  } catch {
    return [];
  }
  const out: PlanCore[] = [];
  for (const id of ids) {
    if (typeof id !== "string" || !PLAN_ID_RE.test(id)) continue;
    try {
      const core = parsePlanCore(await be.get(planKeys.core(id)));
      if (core && core.planId === id && core.wallet === w && now < core.expiresAt) out.push(core);
    } catch { /* skipped */ }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}
