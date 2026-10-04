/**
 * Plan review (Phase 2C, Stage 5B): "what exactly will happen if I approve
 * this?" — a projection of a STORED, re-validated plan.
 *
 *   reviewOf(loaded, config, now) → PlanReview
 *
 * Every field comes from the loaded plan (validated graph, stored order,
 * stored recipient pins, approval/abandon facts) and from server
 * configuration passed in by the caller (chain, token metadata, fee
 * policy limits). Nothing comes from the client, and nothing is derived from
 * the request text — `request` is carried as inert data only.
 *
 * Only the actions this stage understands are described (payai/swap@1.0.0,
 * payai/transfer@1.0.0, with MON or the configured stablecoin). Anything else
 * — another action or version, another token, a remainder — is reported as
 * an unsupported step and makes the plan NOT reviewable, which the Plan
 * Service treats as not approvable. This is not a second validator: the plan
 * was already validated and rehydrated; this only decides whether it can be
 * SHOWN faithfully.
 *
 * Amounts are exact (viem formatUnits on base-unit strings). An amount bound
 * to an earlier step's output is never given a number — it is unknown until
 * that step executes. Fees are described as rules with a known maximum where
 * one exists; nothing here reads live fees, quotes, resolves recipients or
 * touches the network.
 *
 * Server-only.
 */
import "server-only";
import { formatUnits, getAddress } from "viem";
import { recipientKey } from "./resolve";
import { planExpiry } from "./state";
import type { LoadedPlan } from "./store";
import type { ActionRef, InputValue } from "./types";

const ZERO = "0x0000000000000000000000000000000000000000";
const UNITS_RE = /^[1-9][0-9]*$/;
const BPS_RE = /^(0|[1-9][0-9]{0,4})$/;

/** Server configuration the review needs — passed in, never read here. */
export interface ReviewConfig {
  chain: { id: number; name: string };
  monDecimals: number;
  /** The configured stablecoin; null when none is configured. */
  stable: { address: string; symbol: string; decimals: number } | null;
  /** The highest platform fee the fee contracts allow (bps). */
  maxPlatformFeeBps: number;
  /** The swap engine's default slippage tolerance (bps). */
  swapDefaultSlippageBps: number;
}

export interface ReviewToken {
  symbol: string;
  /** null for native MON. */
  address: string | null;
}

export interface ReviewAmount {
  kind: "exact";
  /** Exact base units. */
  units: string;
  /** Exact decimal, e.g. "2.5". */
  decimal: string;
  symbol: string;
}

export interface ReviewOutputAmount {
  kind: "output";
  /** The step whose confirmed output this is. */
  fromStep: string;
  output: string;
  symbol: string;
  /** Unknown until that step has executed. */
  known: false;
}

export interface ReviewRecipient {
  /** What the user wrote. */
  display: string;
  source: "address" | "nad" | "payee";
  /** The address that will be paid: a typed address exactly as the stored
   *  plan holds it, or the address pinned when the plan was created (never
   *  re-resolved), checksummed for display. */
  address: string;
}

export type ReviewFee =
  | { rule: "deducted_from_amount"; maxBps: number }
  | { rule: "executor_fee_in_input_token"; maxBps: null };

interface ReviewStepBase {
  nodeId: string;
  /** 1-based position in execution order. */
  order: number;
  ref: ActionRef;
  dependsOn: string[];
}

export type ReviewStep =
  | (ReviewStepBase & {
      action: "swap";
      pay: ReviewAmount | ReviewOutputAmount;
      receiveToken: ReviewToken;
      /** The output is only known from a live quote, shown before signing. */
      receive: { known: false };
      slippageBps: number;
      slippageIsDefault: boolean;
      fee: ReviewFee;
    })
  | (ReviewStepBase & {
      action: "transfer";
      token: ReviewToken;
      amount: ReviewAmount | ReviewOutputAmount;
      recipient: ReviewRecipient;
      fee: ReviewFee;
    })
  | (ReviewStepBase & { action: "unsupported" });

export interface PlanReview {
  planId: string;
  /** The plan's wallet (checksummed). */
  wallet: string;
  chain: { id: number; name: string };
  /** The user's original request — inert text, never interpreted. */
  request: string;
  createdAt: number;
  approveBy: number;
  expiresAt: number;
  approved: boolean;
  approvable: boolean;
  abandoned: boolean;
  expired: boolean;
  steps: ReviewStep[];
  /** True only when every step is one this review describes faithfully. */
  reviewable: boolean;
}

const SWAP_REF: ActionRef = { protocolId: "payai", actionId: "swap", version: "1.0.0" };
const TRANSFER_REF: ActionRef = { protocolId: "payai", actionId: "transfer", version: "1.0.0" };
const sameRef = (a: ActionRef, b: ActionRef) => a.protocolId === b.protocolId && a.actionId === b.actionId && a.version === b.version;

/** A step that can't be described: the whole plan is then not reviewable. */
class Unsupported extends Error {}
const unsupported = (): never => { throw new Unsupported(); };

const own = (o: Readonly<Record<string, InputValue>>, k: string): InputValue | undefined =>
  Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;

export function reviewOf(l: LoadedPlan, config: ReviewConfig, now: number): PlanReview {
  const order = l.plan.steps.map((s) => s.nodeId);
  const position = (nodeId: string) => order.indexOf(nodeId) + 1;

  /** MON (absent / zero address) or the configured stablecoin; else unsupported. */
  const token = (v: InputValue | undefined): { t: ReviewToken; decimals: number } => {
    if (v === undefined) return { t: { symbol: "MON", address: null }, decimals: config.monDecimals };
    if (v.kind !== "literal") return unsupported();
    const a = v.value.trim().toLowerCase();
    if (a === ZERO) return { t: { symbol: "MON", address: null }, decimals: config.monDecimals };
    if (config.stable && a === config.stable.address.toLowerCase()) {
      return { t: { symbol: config.stable.symbol, address: getAddress(config.stable.address) }, decimals: config.stable.decimals };
    }
    return unsupported();
  };

  const amount = (v: InputValue | undefined, tk: { t: ReviewToken; decimals: number }): ReviewAmount | ReviewOutputAmount => {
    if (v?.kind === "literal" && UNITS_RE.test(v.value)) {
      return { kind: "exact", units: v.value, decimal: formatUnits(BigInt(v.value), tk.decimals), symbol: tk.t.symbol };
    }
    if (v?.kind === "output") return { kind: "output", fromStep: v.node, output: v.output, symbol: tk.t.symbol, known: false };
    // Remainders, lists, anything else: not described in this stage.
    return unsupported();
  };

  const recipient = (v: InputValue | undefined): ReviewRecipient => {
    if (v?.kind !== "recipient") return unsupported();
    const r = v;
    let address: string | undefined;
    if (r.source === "address") address = r.address;
    else {
      const pin = l.core.pins[recipientKey(r)];
      address = typeof pin === "string" ? pin : undefined;
    }
    if (typeof address !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(address) || address.toLowerCase() === ZERO) return unsupported();
    return { display: r.display, source: r.source, address: r.source === "address" ? address : getAddress(address) };
  };

  const onlyKeys = (inputs: Readonly<Record<string, InputValue>>, allowed: string[]) => {
    for (const k of Object.keys(inputs)) if (!allowed.includes(k)) unsupported();
  };

  let reviewable = true;
  const steps: ReviewStep[] = l.plan.steps.map((s): ReviewStep => {
    const base: ReviewStepBase = { nodeId: s.nodeId, order: position(s.nodeId), ref: { ...s.ref }, dependsOn: [...s.dependsOn] };
    try {
      if (sameRef(s.ref, SWAP_REF)) {
        onlyKeys(s.inputs, ["tokenIn", "tokenOut", "amountIn", "slippageBps"]);
        const tin = token(own(s.inputs, "tokenIn"));
        const tout = token(own(s.inputs, "tokenOut") ?? unsupported());
        if ((tin.t.address === null) === (tout.t.address === null)) unsupported();
        const slip = own(s.inputs, "slippageBps");
        if (slip !== undefined && (slip.kind !== "literal" || !BPS_RE.test(slip.value))) unsupported();
        return {
          ...base, action: "swap",
          pay: amount(own(s.inputs, "amountIn"), tin),
          receiveToken: tout.t,
          receive: { known: false },
          slippageBps: slip?.kind === "literal" ? Number(slip.value) : config.swapDefaultSlippageBps,
          slippageIsDefault: slip === undefined,
          fee: { rule: "executor_fee_in_input_token", maxBps: null },
        };
      }
      if (sameRef(s.ref, TRANSFER_REF)) {
        onlyKeys(s.inputs, ["recipient", "token", "amount"]);
        const tk = token(own(s.inputs, "token"));
        return {
          ...base, action: "transfer",
          token: tk.t,
          amount: amount(own(s.inputs, "amount"), tk),
          recipient: recipient(own(s.inputs, "recipient")),
          fee: { rule: "deducted_from_amount", maxBps: config.maxPlatformFeeBps },
        };
      }
      return unsupported();
    } catch (e) {
      if (!(e instanceof Unsupported)) throw e;
      reviewable = false;
      return { ...base, action: "unsupported" };
    }
  });

  const exp = planExpiry(l.core, l.facts, now);
  return {
    planId: l.core.planId,
    wallet: getAddress(l.core.wallet),
    chain: { id: config.chain.id, name: config.chain.name },
    request: l.graph.source.text,
    createdAt: l.core.createdAt,
    approveBy: l.core.approveBy,
    expiresAt: l.core.expiresAt,
    approved: !!l.facts.approval,
    approvable: exp.approvable && !l.facts.abandoned && reviewable,
    abandoned: !!l.facts.abandoned,
    expired: exp.expired,
    steps,
    reviewable,
  };
}
