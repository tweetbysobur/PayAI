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

/**
 * Where a fee figure comes from:
 *  - "verified":   read from the settling contract's own on-chain event
 *                  (FeeCollected), or proven zero because the transaction
 *                  went through no PayAI fee contract at all;
 *  - "estimated":  computed from PayAI's CONFIGURED rate (env) — a preview,
 *                  never proof of what was charged;
 *  - "unverified": a PayAI fee contract was involved but its fee couldn't be
 *                  established from the transaction (e.g. no FeeCollected).
 */
export type FeeStatus = "verified" | "estimated" | "unverified";
/** How the fee related to the amount: added on top, taken out of it, or none. */
export type FeeBasis = "on_top" | "deducted" | "none" | "unknown";

export interface FeeBreakdown {
  feature: FeeFeature;
  /** The amount the user typed/approved — never modified by this module. */
  amount: number;
  /** Platform fee, same units as amount. Only authoritative when status is "verified". */
  fee: number;
  /** What the recipient receives (amount − fee when the fee was deducted). */
  net: number;
  /** True ONLY for a verified zero fee — never because a configured rate is 0. */
  isFree: boolean;
  /** What to print in a UI. Says "estimated" / "not verified" when it is. */
  label: string;
  /** Where `fee` comes from (see FeeStatus). Absent on old payloads. */
  status?: FeeStatus;
  basis?: FeeBasis;
}

/** An ESTIMATE from PayAI's configured rate — a preview, not a charge. A zero
 *  configured rate is not proof that nothing is charged (the contracts charge
 *  their own on-chain rate), so it is never labelled "free". */
export function calculateFeeFromConfig(cfg: FeeConfig, feature: FeeFeature, amount: number): FeeBreakdown {
  const safeAmount = Number.isFinite(amount) && amount > 0 ? amount : 0;
  const fee = cfg.value <= 0 ? 0
    : cfg.kind === "percentage" ? (safeAmount * cfg.value) / 10_000
    : cfg.value; // a flat fee, on top
  return {
    feature,
    amount: safeAmount,
    fee,
    net: safeAmount,
    isFree: false,
    label: fee > 0 ? `≈${fee} (estimated)` : "Not verified (no fee estimate configured)",
    status: "estimated",
    basis: "unknown",
  };
}

/**
 * What a settled transaction proves about PayAI's fee — supplied by the
 * caller from the transaction itself, never from configuration:
 *  - collected:  the settling contract's FeeCollected event (V2 contracts emit
 *                it on every payment, including a zero fee), with whether it
 *                was added on top of the amount or deducted from it;
 *  - none:       the transaction went through no PayAI fee contract (e.g. a
 *                direct wallet transfer), so no PayAI fee was charged;
 *  - unverified: a PayAI fee contract was involved but no fee event was found;
 *  - estimate:   nothing settled on-chain (e.g. simulation) — show the
 *                configured estimate, labelled as one.
 */
export type FeeEvidence =
  | { kind: "collected"; feeUnits: bigint; decimals: number; basis: "on_top" | "deducted" }
  | { kind: "none"; received?: { units: bigint; decimals: number } }
  | { kind: "unverified" }
  | { kind: "estimate"; reason?: string };

/** Exact decimal string of base units (no float rounding). */
function unitsToString(units: bigint, decimals: number): string {
  const neg = units < 0n;
  const s = (neg ? -units : units).toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = decimals > 0 ? s.slice(s.length - decimals).replace(/0+$/, "") : "";
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** A decimal amount → base units, exactly (null when it has more precision
 *  than `decimals` or isn't a plain number). */
function amountToUnits(amount: number, decimals: number): bigint | null {
  if (!Number.isFinite(amount) || amount < 0) return null;
  const str = amount.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 });
  const m = /^(\d+)(?:\.(\d+))?$/.exec(str);
  if (!m) return null;
  const frac = m[2] ?? "";
  if (frac.length > decimals && /[1-9]/.test(frac.slice(decimals))) return null;
  return BigInt(m[1] + frac.slice(0, decimals).padEnd(decimals, "0"));
}

/** Gas arrives either bare ("0.0004") or with its unit ("0.0004 MON"); the
 *  receipt always carries the bare number (the UI adds "MON"). */
function bareGas(gasFee: string | null | undefined): string | null {
  if (!gasFee) return null;
  const t = gasFee.trim().replace(/\s*MON$/i, "");
  return t && Number.isFinite(Number(t)) ? t : null;
}

export interface Receipt {
  feature: FeeFeature;
  token: string;
  paymentAmount: number;
  platformFee: FeeBreakdown;
  gasFee: string | null;
  totalCost: string;
  /** Where the platform fee figure comes from (mirrors platformFee.status). */
  feeStatus?: FeeStatus;
  /** What the recipient received, exact, when the fee is verified; else null. */
  recipientReceives?: string | null;
  status: string;
  txHash?: string;
  explorerUrl?: string;
  at: number;
}

/** A single, consistent receipt shape for Send Payment, Swap, and every
 *  automation mode — payment amount, platform fee, gas fee, total cost,
 *  and status, so every "what did this cost me" screen agrees.
 *
 *  The platform fee is VERIFIED only from `feeEvidence` (the transaction's
 *  own data). Without evidence it is an ESTIMATE from `cfg`, labelled as one —
 *  a configured rate is never presented as what was charged. */
export function buildReceiptFromConfig(cfg: FeeConfig, input: {
  feature: FeeFeature;
  amount: number;
  token: string;
  gasFee?: string | null;
  status: string;
  txHash?: string;
  explorerUrl?: string;
  /** What the settled transaction proves about the fee. Absent = estimate. */
  feeEvidence?: FeeEvidence;
}): Receipt {
  const ev: FeeEvidence = input.feeEvidence ?? { kind: "estimate" };
  const token = input.token;
  const gas = bareGas(input.gasFee);
  const inNativeToken = token.toUpperCase() === "MON";
  const gasNum = gas ? Number(gas) : 0;
  // Exact figures keep gas as its own line (it is paid in MON, separately).
  const withGas = (total: string): string => (gas ? `${total} ${token} + ${gas} MON gas` : `${total} ${token}`);

  let platformFee: FeeBreakdown;
  let totalCost: string;
  let recipientReceives: string | null = null;

  if (ev.kind === "collected") {
    const amountUnits = amountToUnits(input.amount, ev.decimals);
    const feeStr = unitsToString(ev.feeUnits, ev.decimals);
    const feeNum = Number(feeStr);
    const zero = ev.feeUnits === 0n;
    if (amountUnits !== null) {
      const net = ev.basis === "on_top" ? amountUnits : amountUnits - ev.feeUnits;
      const total = ev.basis === "on_top" ? amountUnits + ev.feeUnits : amountUnits;
      recipientReceives = `${unitsToString(net, ev.decimals)} ${token}`;
      totalCost = withGas(unitsToString(total, ev.decimals));
    } else {
      totalCost = withGas(`${input.amount}${ev.basis === "on_top" && !zero ? ` + ${feeStr}` : ""}`);
    }
    platformFee = {
      feature: input.feature, amount: input.amount, fee: feeNum,
      net: ev.basis === "on_top" ? input.amount : Number(recipientReceives?.split(" ")[0] ?? input.amount - feeNum),
      isFree: zero,
      label: zero ? "None — verified on-chain" : `${feeStr} ${token}${ev.basis === "deducted" ? " (deducted from the payment)" : ""} — verified on-chain`,
      status: "verified", basis: zero ? "none" : ev.basis,
    };
  } else if (ev.kind === "none") {
    // What actually moved (e.g. a native overpayment) when known; else the amount.
    const actual = ev.received ? unitsToString(ev.received.units, ev.received.decimals) : String(input.amount);
    recipientReceives = `${actual} ${token}`;
    platformFee = {
      feature: input.feature, amount: input.amount, fee: 0, net: Number(actual), isFree: true,
      label: "None — this payment didn't go through a PayAI fee contract", status: "verified", basis: "none",
    };
    totalCost = inNativeToken && gas
      ? (ev.received ? `${actual} ${token} + ${gas} MON gas` : `${input.amount + gasNum} ${token}`)
      : withGas(actual);
  } else if (ev.kind === "unverified") {
    platformFee = {
      feature: input.feature, amount: input.amount, fee: 0, net: input.amount, isFree: false,
      label: "Not verified — check the transaction on the explorer", status: "unverified", basis: "unknown",
    };
    totalCost = `${withGas(String(input.amount))} + PayAI fee (not verified)`;
  } else {
    const est = calculateFeeFromConfig(cfg, input.feature, input.amount);
    platformFee = ev.reason ? { ...est, label: `${est.label} — ${ev.reason}` } : est;
    // Same arithmetic as before for an estimate; marked "≈" when it includes one.
    const sum = est.amount + est.fee;
    totalCost = inNativeToken
      ? `${est.fee > 0 ? "≈" : ""}${sum + (Number.isFinite(gasNum) ? gasNum : 0)} ${token}`
      : gas
        ? `${est.fee > 0 ? "≈" : ""}${sum} ${token} + ${gas} MON gas`
        : `${est.fee > 0 ? "≈" : ""}${sum} ${token}`;
  }

  return {
    feature: input.feature,
    token,
    paymentAmount: input.amount,
    platformFee,
    gasFee: gas,
    totalCost,
    feeStatus: platformFee.status,
    recipientReceives,
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
