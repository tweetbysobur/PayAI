/**
 * PayAI's fee is charged ON TOP of what the user asked to move: the amount a
 * user asks to send, trade or automate arrives / is swapped IN FULL, and the
 * fee is debited from their balance in addition.
 *
 * Every PayAI fee contract (PayAIForwarderV2, PayAITradeExecutorV2,
 * PaymentExecutorV2, AutomationVaultV2) takes its fee OUT of the gross amount
 * it is handed:  fee = floor(gross × bps / 10000),  net = gross − fee.
 * No contract changes: PayAI hands each contract the smallest gross whose net
 * is exactly the user's amount. This module is that one computation, in
 * integer base units, so every builder, check and screen agrees to the unit.
 *
 * Pure; no imports; safe in the browser.
 */

/** The contracts' own cap (1%). */
export const MAX_FEE_BPS = 100;

function check(bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_FEE_BPS) throw new RangeError("Invalid fee rate.");
  return BigInt(bps);
}

/** floor(gross × bps / 10000) — exactly the contracts' fee. */
export function feeOfGross(gross: bigint, bps: number): bigint {
  return (gross * check(bps)) / 10000n;
}

/**
 * The smallest gross g with g − floor(g × bps / 10000) === net. One always
 * exists: as g grows by 1, that net grows by 0 or 1, so it takes every value.
 */
export function grossForNet(net: bigint, bps: number): bigint {
  const b = check(bps);
  if (net < 0n) throw new RangeError("Negative amount.");
  if (b === 0n || net === 0n) return net;
  const netOf = (g: bigint) => g - (g * b) / 10000n;
  // Upper bound: ceil(net × 10000 / (10000 − bps)) always delivers ≥ net.
  let g = (net * 10000n + (10000n - b) - 1n) / (10000n - b);
  while (netOf(g) > net) g -= 1n; // never more than a step or two
  while (g > 0n && netOf(g - 1n) >= net) g -= 1n;
  if (netOf(g) !== net) throw new Error("Fee arithmetic failed.");
  return g;
}

export interface FeeOnTop {
  /** What the user asked to move — delivered / swapped in full. */
  net: bigint;
  /** PayAI's fee, on top. */
  fee: bigint;
  /** What leaves the user's balance (net + fee) — what the contract is handed. */
  gross: bigint;
}

export function feeOnTop(net: bigint, bps: number): FeeOnTop {
  const gross = grossForNet(net, bps);
  return { net, fee: gross - net, gross };
}

/**
 * The largest net whose gross fits in `available` — "the most you can send
 * with this balance". 0n when even the smallest amount doesn't fit.
 */
export function maxNetFor(available: bigint, bps: number): bigint {
  const b = check(bps);
  if (available <= 0n) return 0n;
  // Spending all of `available` as gross delivers exactly its net.
  return available - (available * b) / 10000n;
}

/* ── Decimal-string helpers (exact; no floating point) ─────────────────── */

const DEC_RE = /^(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

/** "1.5" → base units at `decimals`. Extra precision beyond `decimals` is
 *  refused (null), never silently rounded. */
export function toUnits(amount: string, decimals: number): bigint | null {
  const m = DEC_RE.exec(amount.trim());
  if (!m || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  const frac = m[2] ?? "";
  if (frac.length > decimals && /[1-9]/.test(frac.slice(decimals))) return null;
  return BigInt(m[1] + frac.slice(0, decimals).padEnd(decimals, "0"));
}

/** Base units → shortest exact decimal string. */
export function fromUnits(units: bigint, decimals: number): string {
  const neg = units < 0n;
  const s = (neg ? -units : units).toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/** Percent text for a bps rate: 25 → "0.25%". */
export function bpsPercent(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}
