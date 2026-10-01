/**
 * PayAI payment policy for SDK actions that move funds to third parties.
 *
 * Before this, an SDK action (e.g. split_payment) reached a signer without
 * the compliance/risk engine the single-recipient send path runs. This module
 * puts every declared outflow (Action.outflows) through the SAME engine —
 * nothing is re-implemented here:
 *
 *   runValidation (lib/payment/engine.ts) — PER RECIPIENT: OFAC/denylist
 *     sanctions screen, recipient resolvable (zero address fails), asset,
 *     network. Any hard failure blocks the whole action.
 *   assessRisk    (lib/payment/engine.ts) — on the TOTAL, so splitting a large
 *     payment into many small ones can't step under the amount thresholds.
 *   capFor        (lib/agent/brain.ts)    — the per-payment agent cap, on the
 *     total, for MON and the configured stablecoin (the assets it's defined
 *     for).
 *
 * The gate mirrors /api/agent exactly: compliance "rejected" blocks; risk is
 * reported (score + level) and a medium/high level becomes a warning on the
 * card, as it does for a send.
 *
 * Money stays in base units everywhere. The engine's PaymentRequest takes a
 * number amount, so a display-precision Number is derived ONLY to feed its
 * risk thresholds — it never flows back into any amount that is built,
 * signed, or recorded.
 *
 * Server-only.
 */
import "server-only";
import { formatUnits } from "viem";
import type { ActionOutflow } from "./types";

const NATIVE = "0x0000000000000000000000000000000000000000";

export interface PolicyResult {
  allowed: boolean;
  /** Why the action is blocked, when it is. */
  reason?: string;
  warnings: string[];
  riskScore: number;
  riskLevel: "low" | "medium" | "high";
  /** The worst per-recipient compliance status. */
  compliance: "approved" | "review" | "rejected";
}

export async function enforcePaymentPolicy(outflows: readonly ActionOutflow[]): Promise<PolicyResult> {
  const { runValidation, assessRisk } = await import("@/lib/payment/engine");
  const { ensureSanctionsLoaded } = await import("@/lib/payment/sanctions");
  const { capFor } = await import("@/lib/agent/brain");
  await ensureSanctionsLoaded();

  const warnings: string[] = [];
  let compliance: PolicyResult["compliance"] = "approved";
  if (outflows.length === 0) {
    return { allowed: true, warnings, riskScore: 0, riskLevel: "low", compliance };
  }

  // Display-only numbers for the engine's thresholds (see file doc).
  const displayAmount = (units: bigint, decimals: number) => Number(formatUnits(units, decimals));

  for (const o of outflows) {
    const isNative = o.token.toLowerCase() === NATIVE;
    const result = runValidation({
      action: "send_payment",
      amount: displayAmount(o.amountUnits, o.decimals),
      token: isNative ? "MON" : o.symbol,
      tokenAddress: isNative ? null : o.token,
      recipient: o.recipient,
      purpose: null,
      network: "monad",
    });
    if (result.status === "rejected") {
      const failed = result.checks.filter((c) => !c.passed && c.severity === "hard").map((c) => c.detail).join(" ");
      return {
        allowed: false,
        reason: `Recipient ${o.recipient} failed a mandatory check. ${failed}`.trim(),
        warnings, riskScore: 100, riskLevel: "high", compliance: "rejected",
      };
    }
    if (result.status === "review") compliance = "review";
  }

  // Aggregate: one asset per action (an SDK split carries a single token).
  const first = outflows[0];
  const totalUnits = outflows.reduce((s, o) => s + o.amountUnits, 0n);
  const total = displayAmount(totalUnits, first.decimals);
  const isNative = first.token.toLowerCase() === NATIVE;

  let isStable = false;
  try {
    const { getStablecoin } = await import("@/lib/monad/config");
    isStable = getStablecoin().address.toLowerCase() === first.token.toLowerCase();
  } catch { /* stablecoin not configured — no stablecoin cap applies */ }
  if (isNative || isStable) {
    const cap = capFor(isNative ? "MON" : "USDC");
    if (total > cap) {
      return {
        allowed: false,
        reason: `The total exceeds the current limit of ${cap.toLocaleString()} ${isNative ? "MON" : first.symbol} per payment.`,
        warnings, riskScore: 100, riskLevel: "high", compliance,
      };
    }
  }

  const risk = assessRisk({
    action: "send_payment",
    amount: total,
    token: isNative ? "MON" : first.symbol,
    tokenAddress: isNative ? null : first.token,
    recipient: first.recipient,
    purpose: null,
    network: "monad",
  });
  if (compliance === "review") warnings.push("Flagged for review: a transfer this size should state a purpose.");
  if (risk.level !== "low") warnings.push(`Risk ${risk.score}/100 (${risk.level}).`);
  return { allowed: true, warnings, riskScore: risk.score, riskLevel: risk.level, compliance };
}
