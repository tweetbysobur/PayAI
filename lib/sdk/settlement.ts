/**
 * Shared shapes between the SDK build and confirm routes.
 *
 * build stores a BuildRecord under `sdk-build:<quoteId>` (lib/platform/
 * idempotency.ts's KV, with its in-memory fallback). confirm reads it back
 * and uses matchesBuiltTx() to prove a confirmed transaction is exactly the
 * one PayAI built for that quote — same wallet, same target, same calldata
 * (which for split_payment includes the per-build random `ref`), same value.
 *
 * What this does NOT give: exactly-once execution on-chain. If the user signs
 * the same built transaction twice, both land (the deployed contracts don't
 * enforce `ref` uniqueness); confirm records each real settlement once, by tx
 * hash. See app/api/ask/action/confirm/route.ts.
 *
 * Confirmed outputs (Phase 2C): after a verified success, confirm stores the
 * action's confirmedOutputs() — checked against its declarations here
 * (checkOutputsAgainstDeclaration) — under `sdk-outputs:<quoteId>`, written
 * ONCE (atomic SET NX EX, 24h) and never replaced. Temporary execution facts,
 * not history: Stage 3 copies them into durable plan results.
 */
import type { Action, VerifiedOutputValue } from "./types";

export interface BuildRecord {
  protocolId: string;
  actionId: string;
  version: string;
  /** Lowercased signer the steps were built for. */
  wallet: string;
  /** The final (settlement) step — the transaction confirm must match. */
  finalTx: { to: string; data: string; value: string };
  riskScore: number | null;
  compliance: string | null;
  /** The quote terms the steps were built on (e.g. split's fee rate,
   *  treasury and fee) — confirm uses them to tell the fee leg apart. */
  terms?: Readonly<Record<string, string>>;
  builtAt: number;
}

export const buildKey = (quoteId: string) => `sdk-build:${quoteId}`;
export const settleKey = (txHash: string) => `sdk-settle:${txHash.toLowerCase()}`;

/** True only when the mined transaction is byte-for-byte the built one. */
export function matchesBuiltTx(
  record: BuildRecord,
  tx: { from: string; to: string | null; input: string; value: bigint },
): boolean {
  if (!tx.to) return false;
  let builtValue: bigint;
  try {
    builtValue = BigInt(record.finalTx.value);
  } catch {
    return false;
  }
  return (
    tx.from.toLowerCase() === record.wallet &&
    tx.to.toLowerCase() === record.finalTx.to.toLowerCase() &&
    tx.input.toLowerCase() === record.finalTx.data.toLowerCase() &&
    tx.value === builtValue
  );
}

/* ── Confirmed outputs (Phase 2C Stage 2) ───────────────────────────────── */

const UINT256_MAX = (1n << 256n) - 1n;
const UNITS_RE = /^(0|[1-9][0-9]{0,77})$/;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const QUOTE_ID_RE = /^[0-9a-f]{32}$/;
const TX_HASH_RE = /^0x[0-9a-f]{64}$/;

const isUnits = (v: unknown): v is string => typeof v === "string" && UNITS_RE.test(v) && BigInt(v) <= UINT256_MAX;
/** Lowercase only — the canonical form; a checksummed address is refused,
 *  never silently normalized. The zero address (native MON) is well-formed. */
const isAddr = (v: unknown): v is string => typeof v === "string" && ADDRESS_RE.test(v);
const isPlain = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const exactKeys = (o: Record<string, unknown>, keys: string[]) =>
  Object.keys(o).length === keys.length && keys.every((k) => own(o, k));

/** One verified output value, by shape alone: exact keys, verified === true,
 *  well-formed value and token. No coercion. */
export function isVerifiedOutputValue(v: unknown): v is VerifiedOutputValue {
  if (!isPlain(v) || v.verified !== true) return false;
  switch (v.type) {
    case "units":
      return exactKeys(v, ["verified", "type", "value", "token"]) && isUnits(v.value) && isAddr(v.token);
    case "token":
      return exactKeys(v, ["verified", "type", "value"]) && isAddr(v.value);
    case "units[]":
      return exactKeys(v, ["verified", "type", "value", "token"]) && Array.isArray(v.value) &&
        v.value.length > 0 && v.value.every(isUnits) && isAddr(v.token);
    default:
      return false;
  }
}

export type OutputCheck = { ok: true; outputs: Readonly<Record<string, VerifiedOutputValue>> } | { ok: false; reason: string };

/**
 * A confirmedOutputs() result against the action's own declarations — the
 * whole set or nothing:
 *   - exactly the declared names (none missing, none extra);
 *   - each value's type is its declared type, and well-formed;
 *   - its token is the PROVEN denomination: the verified token of the input
 *     its declaration names (`denominatedIn`). A "token" output with no
 *     `denominatedIn` must equal the verified token of the same-named input.
 *     An output with no proven denomination is refused.
 */
export function checkOutputsAgainstDeclaration(action: Pick<Action, "outputs">, result: unknown): OutputCheck {
  const decls = action.outputs;
  if (!decls || Object.keys(decls).length === 0) return { ok: false, reason: "The action declares no outputs." };
  if (!isPlain(result) || !exactKeys(result, ["outputs", "denominations"])) return { ok: false, reason: "Malformed result." };
  const outputs = result.outputs;
  const denoms = result.denominations;
  if (!isPlain(outputs) || !isPlain(denoms)) return { ok: false, reason: "Malformed result." };
  for (const [k, t] of Object.entries(denoms)) if (!isAddr(t)) return { ok: false, reason: `Malformed denomination "${k}".` };

  const names = Object.keys(decls);
  if (!exactKeys(outputs, names)) return { ok: false, reason: "Outputs don't match the declared names." };
  const checked: Record<string, VerifiedOutputValue> = {};
  for (const name of names) {
    const decl = decls[name];
    const v = outputs[name];
    if (!isVerifiedOutputValue(v)) return { ok: false, reason: `Output "${name}" is malformed or unverified.` };
    if (v.type !== decl.type) return { ok: false, reason: `Output "${name}" is ${v.type}, declared ${decl.type}.` };
    const proven = decl.denominatedIn
      ? (own(denoms, decl.denominatedIn.input) ? denoms[decl.denominatedIn.input] : undefined)
      : (v.type === "token" && own(denoms, name) ? denoms[name] : undefined);
    if (typeof proven !== "string") return { ok: false, reason: `Output "${name}" has no proven denomination.` };
    const token = v.type === "token" ? v.value : v.token;
    if (token !== proven) return { ok: false, reason: `Output "${name}" is in a different token than was verified.` };
    checked[name] = v.type === "units[]" ? { ...v, value: [...v.value] } : { ...v };
  }
  return { ok: true, outputs: checked };
}

/* ── Write-once output records ─────────────────────────────────────────── */

/** Confirmed outputs are temporary execution facts: same 24h TTL as the SDK
 *  build/settle records (lib/platform/idempotency.ts). Stage 3 copies them
 *  into durable plan results. */
export const OUTPUTS_TTL_SECONDS = 24 * 60 * 60;
export const outputsKey = (quoteId: string) => `sdk-outputs:${quoteId}`;

export interface OutputRecord {
  quoteId: string;
  /** Lowercased. */
  txHash: string;
  /** Lowercased build-record wallet. */
  wallet: string;
  protocolId: string;
  actionId: string;
  version: string;
  outputs: Readonly<Record<string, VerifiedOutputValue>>;
  recordedAt: number;
}

/** Strict parse of a stored record; null for anything malformed. */
export function parseOutputRecord(raw: unknown): OutputRecord | null {
  if (!isPlain(raw) || !exactKeys(raw, ["quoteId", "txHash", "wallet", "protocolId", "actionId", "version", "outputs", "recordedAt"])) return null;
  const r = raw;
  if (typeof r.quoteId !== "string" || !QUOTE_ID_RE.test(r.quoteId)) return null;
  if (typeof r.txHash !== "string" || !TX_HASH_RE.test(r.txHash)) return null;
  if (!isAddr(r.wallet)) return null;
  for (const k of ["protocolId", "actionId", "version"] as const) {
    if (typeof r[k] !== "string" || (r[k] as string).length === 0 || (r[k] as string).length > 64) return null;
  }
  if (typeof r.recordedAt !== "number" || !Number.isSafeInteger(r.recordedAt) || r.recordedAt <= 0) return null;
  if (!isPlain(r.outputs) || Object.keys(r.outputs).length === 0) return null;
  const outputs: Record<string, VerifiedOutputValue> = {};
  for (const [k, v] of Object.entries(r.outputs)) {
    if (!isVerifiedOutputValue(v)) return null;
    outputs[k] = v.type === "units[]" ? { ...v, value: [...v.value] } : { ...v };
  }
  return {
    quoteId: r.quoteId, txHash: r.txHash, wallet: r.wallet,
    protocolId: r.protocolId as string, actionId: r.actionId as string, version: r.version as string,
    outputs, recordedAt: r.recordedAt,
  };
}

/** Who is asking about a quote's outputs — every field must match. */
export interface OutputRecordContext {
  quoteId: string;
  txHash: string;
  wallet: string;
  protocolId: string;
  actionId: string;
  version: string;
}

export type OutputRecordRead =
  | { status: "absent" }
  | { status: "recorded"; record: OutputRecord }                 // this exact tx
  | { status: "already_recorded_for_another_tx"; record: OutputRecord }
  | { status: "mismatch" }                                       // another wallet / action / quote
  | { status: "malformed" };

function classify(raw: unknown, ctx: OutputRecordContext): OutputRecordRead {
  if (raw === null || raw === undefined) return { status: "absent" };
  const rec = parseOutputRecord(raw);
  if (!rec) return { status: "malformed" };
  if (
    rec.quoteId !== ctx.quoteId || rec.wallet !== ctx.wallet.toLowerCase() ||
    rec.protocolId !== ctx.protocolId || rec.actionId !== ctx.actionId || rec.version !== ctx.version
  ) return { status: "mismatch" };
  if (rec.txHash !== ctx.txHash.toLowerCase()) return { status: "already_recorded_for_another_tx", record: rec };
  return { status: "recorded", record: rec };
}

// In-memory fallback, same insert-if-absent semantics (per warm instance, as
// lib/platform/idempotency.ts's fallback is).
const g = globalThis as unknown as { __payaiSdkOutputs?: Map<string, { value: unknown; expiresAt: number }> };
const mem = (g.__payaiSdkOutputs ??= new Map());
function memGet(key: string): unknown {
  const e = mem.get(key);
  if (!e) return null;
  if (e.expiresAt <= Date.now()) { mem.delete(key); return null; }
  return e.value;
}

/** Test-only. */
export function __resetOutputRecordsForTests(): void {
  mem.clear();
}

/** Read a quote's output record for this exact context. Never throws on bad
 *  data — a malformed record is reported, never trusted. */
export async function readOutputRecord(ctx: OutputRecordContext): Promise<OutputRecordRead> {
  const { getRedis } = await import("@/lib/platform/kv");
  const r = await getRedis();
  const raw = r ? await r.get(outputsKey(ctx.quoteId)) : memGet(outputsKey(ctx.quoteId));
  return classify(raw, ctx);
}

/**
 * Insert a quote's output record ONCE — one atomic SET NX EX (or the
 * in-memory equivalent). An existing record is never replaced: the result
 * classifies what is now stored relative to `record` (its own tx →
 * "recorded"; a different tx → "already_recorded_for_another_tx").
 */
export async function insertOutputRecordOnce(record: OutputRecord): Promise<OutputRecordRead> {
  const parsed = parseOutputRecord(record);
  if (!parsed) return { status: "malformed" };
  const ctx: OutputRecordContext = parsed;
  const key = outputsKey(parsed.quoteId);
  const { getRedis } = await import("@/lib/platform/kv");
  const r = await getRedis();
  if (r) {
    const set = await r.set(key, parsed, { nx: true, ex: OUTPUTS_TTL_SECONDS });
    if (set) return { status: "recorded", record: parsed };
    return classify(await r.get(key), ctx);
  }
  const existing = memGet(key);
  if (existing !== null) return classify(existing, ctx);
  mem.set(key, { value: JSON.parse(JSON.stringify(parsed)), expiresAt: Date.now() + OUTPUTS_TTL_SECONDS * 1000 });
  return { status: "recorded", record: parsed };
}
