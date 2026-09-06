/**
 * PayAI fee math — pure functions, zero env access, safe to import from
 * CLIENT code. This is the piece of the fee engine that genuinely has no
 * business being server-only: `fee = amount * rate` is just arithmetic.
 *
 * What IS server-only (see lib/payment/feeEngine.ts) is knowing the current
 * `rate` in the first place — that comes from process.env, which does not
 * exist in a browser bundle. The split exists because a naive
 * "mark the whole fee module server-only" fix breaks any UI that needs to
 * show a LIVE fee estimate as the user types, before anything has executed
 * (the AI confirmation screen's "Estimated Fees" line, and the Automation/
 * Bulk Payment creation wizards' fee preview) — that estimate can't come
 * from a prior execution's response, because nothing has executed yet.
 *
 * The fix: the server is still the only source of truth for the CURRENT fee
 * rate (see GET /api/fees, backed by feeEngine.ts's FEE_CONFIG), but once a
 * client has fetched that rate, computing `calculateFeeFromConfig(rate, amount)`
 * locally on every keystroke is exactly the kind of pure, side-effect-free
 * math that's fine anywhere.
 */

export type FeeFeature = "send_payment" | "swap" | "wallet_automation" | "reserved_funds";

export type FeeKind = "percentage" | "fixed";

export interface FeeConfig {
  kind: FeeKind;
  /** Percentage: basis points (100 = 1%). Fixed: a flat amount in the payment's own token. */
  value: number;
}

export interface FeeBreakdown {
  feature: FeeFeature;
  /** The amount the user typed/approved — never modified by this module. */
  amount: number;
  /** Platform fee, same units as amount. Zero during beta. */
  fee: number;
  /** amount - fee. Equals amount while fee is zero. */
  net: number;
  /** True while the configured fee for this feature is zero (the beta state). */
  isFree: boolean;
  /** What to actually print in a UI: "Free during Beta" while zero, else the formatted fee. */
  label: string;
}

export function calculateFeeFromConfig(cfg: FeeConfig, feature: FeeFeature, amount: number): FeeBreakdown {
  const safeAmount = Number.isFinite(amount) && amount > 0 ? amount : 0;
  const fee = cfg.value <= 0 ? 0
    : cfg.kind === "percentage" ? (safeAmount * cfg.value) / 10_000
    : Math.min(cfg.value, safeAmount); // a flat fee can never exceed the payment itself
  const isFree = fee <= 0;
  return {
    feature,
    amount: safeAmount,
    fee,
    net: safeAmount - fee,
    isFree,
    label: isFree ? "Free during Beta" : String(fee),
  };
}

export interface Receipt {
  feature: FeeFeature;
  token: string;
  paymentAmount: number;
  platformFee: FeeBreakdown;
  gasFee: string | null;
  totalCost: string;
  status: string;
  txHash?: string;
  explorerUrl?: string;
  at: number;
}

/** A single, consistent receipt shape for Send Payment, Swap, and every
 *  automation mode — payment amount, platform fee, gas fee, total cost,
 *  and status, so every "what did this cost me" screen agrees. */
export function buildReceiptFromConfig(cfg: FeeConfig, input: {
  feature: FeeFeature;
  amount: number;
  token: string;
  gasFee?: string | null;
  status: string;
  txHash?: string;
  explorerUrl?: string;
}): Receipt {
  const platformFee = calculateFeeFromConfig(cfg, input.feature, input.amount);
  // Gas is always paid in native MON, regardless of what the payment itself
  // moves — summing it into a single figure only makes sense when the
  // payment token IS MON. For USDC (or anything else), gas is a separate
  // currency and must be shown as its own line, never folded into one number.
  const inNativeToken = input.token.toUpperCase() === "MON";
  const gasNum = input.gasFee ? Number(input.gasFee) : 0;
  const totalCost = inNativeToken
    ? `${platformFee.amount + platformFee.fee + (Number.isFinite(gasNum) ? gasNum : 0)} ${input.token}`
    : input.gasFee
      ? `${platformFee.amount + platformFee.fee} ${input.token} + ${input.gasFee} MON gas`
      : `${platformFee.amount + platformFee.fee} ${input.token}`;
  return {
    feature: input.feature,
    token: input.token,
    paymentAmount: input.amount,
    platformFee,
    gasFee: input.gasFee ?? null,
    totalCost,
    status: input.status,
    txHash: input.txHash,
    explorerUrl: input.explorerUrl,
    at: Date.now(),
  };
}

/** The shape GET /api/fees returns — every feature's current rate, safe to
 *  expose publicly (rates, not secrets). Fetch once per session; a fee rate
 *  changes rarely enough that this doesn't need to be re-fetched per keystroke. */
export type FeeConfigResponse = Record<FeeFeature, FeeConfig>;

/** A config to fall back to before the real one has loaded, or if the fetch
 *  fails — all zero, matching the honest "beta" default. Never a guessed
 *  non-zero number: if the real config can't be reached, showing "free"
 *  understates what a user might pay, but showing a GUESSED fee could
 *  overstate or misstate it just as easily. Zero is the only default that's
 *  never a fabricated claim about what something costs. */
export const ZERO_FEE_CONFIG: FeeConfigResponse = {
  send_payment: { kind: "percentage", value: 0 },
  swap: { kind: "percentage", value: 0 },
  wallet_automation: { kind: "percentage", value: 0 },
  reserved_funds: { kind: "percentage", value: 0 },
};
