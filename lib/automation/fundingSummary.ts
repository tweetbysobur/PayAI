/**
 * The words the automation creator shows for what a schedule will cost —
 * payment per run, PayAI's fee per run, and the total approved or reserved.
 *
 * Display only. It formats the SAME exact base-unit figures the creator signs
 * (lib/payment/feeOnTop.ts, gross × runs); it never computes a fee of its own.
 * Every figure is the exact decimal string of those units, so the line always
 * reconciles: payments × (payment + fee) = total, with nothing rounded away
 * (a 0.00025 USDC fee is shown as 0.00025, not 0.0003).
 *
 * Pure; no imports beyond the formatter; safe in the browser.
 */
import { fromUnits } from "@/lib/payment/feeOnTop";

export interface FundingSummaryInput {
  /** What the recipient receives per run, in base units. */
  net: bigint;
  /** PayAI's fee per run (on top), in base units. */
  fee: bigint;
  /** net + fee: what each run takes from the approval or reservation. */
  gross: bigint;
  decimals: number;
  symbol: string;
  /** Number of runs for a bounded schedule; null when open-ended. */
  occurrences: number | null;
  mode: "wallet" | "reserved";
}

export interface FundingSummary {
  perPayment: string;
  feePerPayment: string;
  perRunTotal: string;
  /** Exact total approved (wallet) or reserved now (reserved); null for an
   *  open-ended wallet automation, which approves an estimate. */
  total: string | null;
  /** The one-sentence summary shown above the review. */
  line: string;
}

export function fundingSummary(i: FundingSummaryInput): FundingSummary {
  const amt = (u: bigint) => `${fromUnits(u, i.decimals)} ${i.symbol}`;
  const perPayment = amt(i.net);
  const feePerPayment = amt(i.fee);
  const perRunTotal = amt(i.gross);
  const each = `${perPayment} + ${feePerPayment} PayAI fee`;

  if (i.occurrences != null) {
    const n = i.occurrences;
    const total = amt(i.gross * BigInt(n));
    const verb = i.mode === "reserved" ? "reserved up front" : "authorized";
    return {
      perPayment, feePerPayment, perRunTotal, total,
      line: `${n} payment${n === 1 ? "" : "s"} × (${each}) = ${total} total ${verb}.`,
    };
  }
  if (i.mode === "reserved") {
    return {
      perPayment, feePerPayment, perRunTotal, total: perRunTotal,
      line: `Ongoing — no fixed total. Reserved Funds sets aside only the next payment: ${each} = ${perRunTotal}. Add an end date or count to reserve the full run up front.`,
    };
  }
  return {
    perPayment, feePerPayment, perRunTotal, total: null,
    line: `Ongoing — no fixed total. Each payment is ${each} = ${perRunTotal}. You authorize about a year at a time and re-approve later — funds only move at each run.`,
  };
}
