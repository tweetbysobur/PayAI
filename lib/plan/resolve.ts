/**
 * resolveStepInputs — one plan step's concrete inputs, from what ACTUALLY
 * happened (Phase 2C, Stage 1).
 *
 * Pure: no network, no chain reads, no signing, no LLM. Everything it needs
 * is passed in, and everything passed in is checked:
 *   - the plan must be one planIntent produced, for exactly this graph;
 *   - a bound value comes only from a dependency's VERIFIED confirmed output,
 *     of the type and ERC-20 the validator proved — never a quote, never
 *     native MON;
 *   - a .nad / payee recipient needs an address the server already pinned
 *     (lib/payees/resolve.ts at the call site) — it is never resolved here;
 *   - a remainder is exact BigInt arithmetic: > 0, ≤ uint256, never rounded.
 *     For an action whose fee is charged on top (Action.feePolicy), it is the
 *     LARGEST amount R for which the whole step — the other amounts plus R,
 *     plus floor(total * feeBps / 10000) — still fits in what was confirmed.
 *     feeBps must come from the authoritative fee read (lib/sdk/fees.ts);
 *     without it the remainder is refused, never priced at a guessed rate.
 *
 * The output is SDK ActionInputs, which the action's own quote/build and
 * every existing SDK gate (Layer A, policy, allowlists) still check.
 */
import "server-only";
import { getAddress, isAddress, type Address } from "viem";
import { MAX_PLATFORM_FEE_BPS } from "@/lib/sdk/fees";
import type { ActionInputs } from "@/lib/sdk/types";
import { PlanError } from "./errors";
import { assertPlanMatchesGraph, assertSessionWallet } from "./planner";
import type {
  ConfirmedOutputValue, ExecutionPlan, PlanExpectation, PlanStep, RecipientValue, ScalarInputValue, ValidatedIntentGraph,
} from "./types";

export const MAX_UINT256 = (1n << 256n) - 1n;
const UNITS_RE = /^(0|[1-9][0-9]*)$/;
const MINUS_RE = /^[1-9][0-9]{0,77}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const ZERO = "0x0000000000000000000000000000000000000000";

/** nodeId → output name → the verified value. A node that confirmed with no
 *  outputs is present with an empty record. */
export type ConfirmedOutputs = Readonly<Record<string, Readonly<Record<string, ConfirmedOutputValue>>>>;

export interface ResolveStepInput {
  plan: ExecutionPlan;
  graph: ValidatedIntentGraph;
  nodeId: string;
  /** The authenticated session's wallet. */
  sessionWallet: string | null | undefined;
  confirmed: ConfirmedOutputs;
  /** recipientKey(r) → the address the SERVER resolved and pinned. */
  recipients?: Readonly<Record<string, string>>;
  /** The live platform fee rate (lib/sdk/fees.ts readPlatformFeeTerms).
   *  Required only for a remainder in a fee-on-top step. */
  feeBps?: number;
}

/** How a .nad / payee recipient is looked up in `recipients`. */
export function recipientKey(r: Pick<RecipientValue, "source" | "display">): string {
  return `${r.source}:${r.display.trim().toLowerCase()}`;
}

export function resolveStepInputs(args: ResolveStepInput): ActionInputs {
  const { plan, graph, nodeId } = args;
  assertPlanMatchesGraph(plan, graph);
  assertSessionWallet(plan.wallet, args.sessionWallet);
  const step = plan.steps.find((s) => s.nodeId === nodeId);
  if (!step) throw new PlanError("INVALID_PLAN", `"${nodeId}" is not a step of this plan.`, nodeId);

  for (const dep of step.dependsOn) {
    if (!own(args.confirmed, dep)) throw new PlanError("OUTPUT_NOT_CONFIRMED", `"${dep}" hasn't confirmed yet.`, nodeId);
  }

  const r = new Resolver(args, step);
  const out: Record<string, string | Record<string, string>[]> = {};
  for (const [name, v] of Object.entries(step.inputs)) {
    if (v.kind === "list") {
      out[name] = r.list(name, v.items);
    } else {
      out[name] = r.scalar(name, v, null);
    }
  }
  return Object.freeze(Object.fromEntries(Object.entries(out).map(([k, v]) =>
    [k, typeof v === "string" ? v : Object.freeze(v.map((i) => Object.freeze(i)))])));
}

/**
 * The largest R > 0 with  (fixed + R) + floor((fixed + R) * feeBps / 10000) ≤ available,
 * or null when even R = 1 doesn't fit. Exact integer arithmetic; f(T) =
 * T + floor(T*b/10000) is non-decreasing, so the estimate is corrected by
 * stepping to the exact boundary.
 */
export function feeInclusiveRemainder(available: bigint, fixed: bigint, feeBps: number): bigint | null {
  const b = BigInt(feeBps);
  const total = (t: bigint) => t + (t * b) / 10000n;
  let t = (available * 10000n) / (10000n + b);
  while (total(t + 1n) <= available) t += 1n;
  while (t > 0n && total(t) > available) t -= 1n;
  const rem = t - fixed;
  return rem > 0n ? rem : null;
}

/* ── Internals ──────────────────────────────────────────────────────────── */

class Resolver {
  constructor(private readonly a: ResolveStepInput, private readonly step: PlanStep) {}

  list(name: string, items: readonly Record<string, ScalarInputValue>[]): Record<string, string>[] {
    // Resolve everything but the (single) remainder first; the remainder's
    // terms are checked against the other items' resolved amounts.
    const resolved = items.map((item, j) => {
      const o: Record<string, string> = {};
      for (const [k, v] of Object.entries(item)) if (v.kind !== "remainder") o[k] = this.scalar(`${name}[${j}].${k}`, v, null);
      return o;
    });
    items.forEach((item, j) => {
      for (const [k, v] of Object.entries(item)) {
        if (v.kind !== "remainder") continue;
        const others = resolved.filter((_, x) => x !== j).map((o) => o[k]);
        resolved[j][k] = this.scalar(`${name}[${j}].${k}`, v, others);
      }
    });
    // Keep each item's keys in written order.
    return items.map((item, j) => Object.fromEntries(Object.keys(item).map((k) => [k, resolved[j][k]])));
  }

  /** `siblings`: for a remainder inside a list, the other items' amounts in
   *  the same field; null for a top-level input. */
  scalar(path: string, v: ScalarInputValue, siblings: (string | undefined)[] | null): string {
    switch (v.kind) {
      case "literal":
        return v.value;
      case "recipient":
        return this.recipient(path, v);
      case "output": {
        const c = this.confirmedValue(path, v.node, v.output);
        if (typeof c === "bigint" && c === 0n) this.fail("INVALID_CONFIRMED_VALUE", "A confirmed amount of zero can't be passed on.", path);
        return typeof c === "bigint" ? c.toString() : c;
      }
      case "remainder":
        return this.remainder(path, v, siblings).toString();
      default:
        return this.fail("INVALID_PLAN", "Unknown input kind.", path);
    }
  }

  private remainder(path: string, v: Extract<ScalarInputValue, { kind: "remainder" }>, siblings: (string | undefined)[] | null): bigint {
    if (!Array.isArray(v.minus) || v.minus.length === 0 || !v.minus.every((m) => typeof m === "string" && MINUS_RE.test(m))) {
      this.fail("INVALID_REMAINDER", "A remainder subtracts exact, positive base-unit amounts.", path);
    }
    const fixed = v.minus.reduce((s, m) => s + BigInt(m), 0n);
    if (fixed > MAX_UINT256) this.fail("REMAINDER_OVERFLOW", "The amounts subtracted exceed uint256.", path);

    if (siblings !== null) {
      // "The rest" of a list: what it subtracts must be exactly what the
      // other items pay, so the step's total is fixed + R and nothing else.
      if (siblings.some((s) => s === undefined || !UNITS_RE.test(s))) {
        this.fail("INVALID_REMAINDER", "Every other item needs an exact amount for the rest to be computed.", path);
      }
      const others = siblings.reduce((s, x) => s + BigInt(x as string), 0n);
      if (others !== fixed) this.fail("INVALID_REMAINDER", "The remainder's deductions don't match the other amounts in this step.", path);
    }

    const available = this.confirmedValue(path, v.node, v.output);
    if (typeof available !== "bigint") return this.fail("INVALID_CONFIRMED_VALUE", "A remainder needs a confirmed amount.", path);

    if (this.step.feePolicy?.mode === "on_top") {
      if (siblings === null) {
        this.fail("INVALID_REMAINDER", "With the fee charged on top, a remainder must be one item of a list.", path);
      }
      const bps = this.a.feeBps;
      if (bps === undefined || typeof bps !== "number" || !Number.isInteger(bps) || bps < 0 || bps > MAX_PLATFORM_FEE_BPS) {
        this.fail("FEE_TERMS_UNAVAILABLE", "PayAI's fee rate is needed to compute the rest, and isn't available.", path);
      }
      const rem = feeInclusiveRemainder(available, fixed, bps as number);
      if (rem === null) return this.fail("REMAINDER_UNDERFLOW", "Nothing is left after the other amounts and the platform fee.", path);
      return rem;
    }

    const rem = available - fixed;
    if (rem <= 0n) this.fail("REMAINDER_UNDERFLOW", "Nothing is left after the other amounts.", path);
    return rem;
  }

  /** A verified confirmed output of the type and ERC-20 the validator proved:
   *  bigint for "units", a checksummed address for "token". */
  private confirmedValue(path: string, node: string, output: string): bigint | Address {
    if (!this.step.dependsOn.includes(node)) this.fail("INVALID_PLAN", `"${node}" isn't a dependency of this step.`, path);
    const proven = this.expectation(path, node, output);
    const prod = own(this.a.confirmed, node);
    if (!prod) this.fail("OUTPUT_NOT_CONFIRMED", `"${node}" hasn't confirmed yet.`, path);
    const c = own(prod as Record<string, unknown>, output) as ConfirmedOutputValue | undefined;
    if (c === undefined) this.fail("UNKNOWN_OUTPUT", `"${node}" confirmed without an output "${output}".`, path);
    const cv = c as ConfirmedOutputValue;
    if (typeof cv !== "object" || cv === null || cv.verified !== true) {
      this.fail("OUTPUT_NOT_VERIFIED", `"${node}.${output}" wasn't verified on-chain.`, path);
    }
    if (cv.type !== proven.type) this.fail("INVALID_CONFIRMED_VALUE", `"${node}.${output}" isn't a ${proven.type} value.`, path);

    if (proven.type === "units") {
      if (typeof cv.value !== "string" || !UNITS_RE.test(cv.value) || BigInt(cv.value) > MAX_UINT256) {
        this.fail("INVALID_CONFIRMED_VALUE", `"${node}.${output}" isn't an exact uint256 amount.`, path);
      }
      this.checkToken(path, cv.token, proven);
      return BigInt(cv.value);
    }
    this.checkToken(path, cv.value, proven);
    if (cv.token !== undefined) this.checkToken(path, cv.token, proven);
    return getAddress(cv.value);
  }

  private checkToken(path: string, token: unknown, proven: PlanExpectation) {
    if (typeof token !== "string") return this.fail("INVALID_CONFIRMED_VALUE", "The confirmed output doesn't say which token it is.", path);
    const t = token.trim().toLowerCase();
    if (t === "" || t === ZERO) this.fail("NATIVE_OUTPUT_NOT_BINDABLE", "A native MON output can't be passed to a later step.", path);
    if (!ADDRESS_RE.test(t)) this.fail("INVALID_CONFIRMED_VALUE", "The confirmed token isn't an address.", path);
    if (t !== proven.token) this.fail("TOKEN_MISMATCH", "The confirmed output is in a different token than planned.", path);
  }

  private expectation(path: string, node: string, output: string): PlanExpectation {
    const e = this.step.expects.find((x) => x.path === path && x.node === node && x.output === output);
    const proven = this.a.graph.boundOutputs[node]?.[output];
    if (!e || !proven || e.type !== proven.type || e.token !== proven.token) {
      return this.fail("INVALID_PLAN", `No proven binding for ${node}.${output}.`, path);
    }
    return e;
  }

  private recipient(path: string, v: RecipientValue): string {
    if (v.source === "address") {
      if (typeof v.address !== "string" || !isAddress(v.address, { strict: false }) || v.address.toLowerCase() === ZERO) {
        this.fail("RECIPIENT_UNRESOLVED", "Invalid recipient address.", path);
      }
      return getAddress(v.address as string);
    }
    const pinned = own(this.a.recipients ?? {}, recipientKey(v));
    if (typeof pinned !== "string" || !isAddress(pinned, { strict: false }) || pinned.toLowerCase() === ZERO) {
      return this.fail("RECIPIENT_UNRESOLVED", `"${v.display}" hasn't been resolved to an address by PayAI.`, path);
    }
    return getAddress(pinned);
  }

  private fail(code: ConstructorParameters<typeof PlanError>[0], message: string, path: string): never {
    throw new PlanError(code, message, this.step.nodeId, path);
  }
}

/** Own-property lookup only — "__proto__", "toString" etc. never resolve. */
function own<T>(o: Readonly<Record<string, T>> | null | undefined, k: string): T | undefined {
  if (o === null || typeof o !== "object") return undefined;
  return Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
}
