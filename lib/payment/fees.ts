/**
 * Platform fee calculation — shared by Send Payment, Wallet Automation, and
 * Reserved Funds so every review screen and receipt agrees on the same
 * number.
 *
 * Currently ZERO. Set `PLATFORM_FEE_BPS` (basis points, 100 = 1%) when the
 * platform is ready to charge a fee. The math and UI already handle any
 * value correctly, so turning it on later is a config change here, not a
 * rebuild — but it does NOT move funds anywhere: no execution path forwards
 * a fee to a treasury address today. Wiring an on-chain fee split (e.g. a
 * fee recipient in PaymentExecutor/AutomationVault) is a separate, deliberate
 * step for whenever a non-zero fee is actually turned on.
 */
export const PLATFORM_FEE_BPS = Number(process.env.PLATFORM_FEE_BPS ?? "0");

export interface FeeBreakdown {
  /** The amount the user typed/approved — never modified. */
  amount: number;
  /** Platform fee in the same units as `amount`. Zero today. */
  fee: number;
  /** What actually reaches the recipient: amount - fee. Equals `amount` while the fee is zero. */
  net: number;
  /** The fee rate as a percentage, for display (e.g. "0%", "0.5%"). */
  feePct: number;
}

export function calculateFee(amount: number): FeeBreakdown {
  const safeAmount = Number.isFinite(amount) && amount > 0 ? amount : 0;
  const fee = PLATFORM_FEE_BPS > 0 ? (safeAmount * PLATFORM_FEE_BPS) / 10_000 : 0;
  return { amount: safeAmount, fee, net: safeAmount - fee, feePct: PLATFORM_FEE_BPS / 100 };
}
