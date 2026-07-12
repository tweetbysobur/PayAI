/**
 * PayAI Fee Engine — a self-contained module the execution engine never has
 * to import or know about. Every feature (Send Payment, Swap, Wallet
 * Automation, Reserved Funds) asks this module "what would this cost?"
 * BEFORE execution, purely to calculate and display a number. Execution
 * itself (lib/payment/engine.ts, lib/monad/contracts.ts, the AutomationVault
 * calls) never imports this file and never has its money-moving logic
 * touched by it — that separation is deliberate: turning fees on later is a
 * config change in THIS file, never a change to how funds move.
 *
 * BETA: every fee below is zero. Nothing here routes money anywhere; the
 * treasury address is read only for display/audit purposes (so a receipt
 * can show where a fee *would* go), never passed into a transfer today.
 * Turning on a real fee later still requires a second, deliberate step:
 * wiring that non-zero amount into an actual on-chain transfer (a contract
 * fee split, or a second app-level transfer to the treasury). This module
 * intentionally does not do that itself, so a config change alone can never
 * accidentally move funds.
 */

export type FeeFeature = "send_payment" | "swap" | "wallet_automation" | "reserved_funds";

type FeeKind = "percentage" | "fixed";

interface FeeConfig {
  kind: FeeKind;
  /** Percentage: basis points (100 = 1%). Fixed: a flat amount in the payment's own token. */
  value: number;
}

/** One env var per feature so any of them can be priced independently,
 *  without redeploying the others. All default to 0 during beta.
 *    PAYAI_FEE_SEND_PAYMENT_BPS / _FIXED
 *    PAYAI_FEE_SWAP_BPS / _FIXED
 *    PAYAI_FEE_WALLET_AUTOMATION_BPS / _FIXED
 *    PAYAI_FEE_RESERVED_FUNDS_BPS / _FIXED
 *  If both a _BPS and _FIXED are set for the same feature, percentage wins
 *  (fixed is meant for a flat "$0.10 per swap"-style fee with no percentage set). */
function readFeeConfig(feature: FeeFeature): FeeConfig {
  const envKey = feature.toUpperCase();
  const bps = Number(process.env[`PAYAI_FEE_${envKey}_BPS`] ?? "0");
  if (bps > 0) return { kind: "percentage", value: bps };
  const fixed = Number(process.env[`PAYAI_FEE_${envKey}_FIXED`] ?? "0");
  if (fixed > 0) return { kind: "fixed", value: fixed };
  return { kind: "percentage", value: 0 };
}

export const FEE_CONFIG: Record<FeeFeature, FeeConfig> = {
  send_payment: readFeeConfig("send_payment"),
  swap: readFeeConfig("swap"),
  wallet_automation: readFeeConfig("wallet_automation"),
  reserved_funds: readFeeConfig("reserved_funds"),
};

/** Where a non-zero fee would be sent. Not used to move funds today — see
 *  the module doc comment. Null until explicitly configured. */
export function getTreasuryAddress(): `0x${string}` | null {
  const addr = process.env.PAYAI_TREASURY_ADDRESS?.trim();
  return addr && /^0x[0-9a-fA-F]{40}$/.test(addr) ? (addr as `0x${string}`) : null;
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

export function calculateFee(feature: FeeFeature, amount: number): FeeBreakdown {
  const safeAmount = Number.isFinite(amount) && amount > 0 ? amount : 0;
  const cfg = FEE_CONFIG[feature];
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
export function buildReceipt(input: {
  feature: FeeFeature;
  amount: number;
  token: string;
  gasFee?: string | null;
  status: string;
  txHash?: string;
  explorerUrl?: string;
}): Receipt {
  const platformFee = calculateFee(input.feature, input.amount);
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
