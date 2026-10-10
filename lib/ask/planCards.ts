/**
 * Small in-memory caches behind Ask PayAI's plan cards, so the first render
 * needs no extra request.
 *
 *  - primePlan / takePrimed: the creation response (plan + server review),
 *    handed from the turn that created the plan to the card that shows it.
 *    Read once; after that the card always reads the server.
 *  - attachTiming / timingFor: the turn's latency marks (./timing.ts).
 *  - sendFeeBps: PayAI's published send fee rate (GET /api/fees — the
 *    sanctioned public source), fetched once per page load and reused. It is
 *    for an ESTIMATE shown before quoting; the exact fee is fixed by the
 *    quote the user confirms before anything is signed.
 */
import type { PlanReviewDTO } from "@/lib/plans-client/api";
import type { PlanViewDTO } from "@/lib/plans-client/runner";
import type { AskTiming } from "./timing";
import { feeOnTop, fromUnits, toUnits } from "@/lib/payment/feeOnTop";

export interface PlanCardData {
  plan: PlanViewDTO;
  review: PlanReviewDTO;
}

const primed = new Map<string, PlanCardData>();

export function primePlan(data: PlanCardData): void {
  primed.set(data.plan.planId, data);
  if (primed.size > 20) primed.delete(primed.keys().next().value as string);
}

export function takePrimed(planId: string): PlanCardData | null {
  const d = primed.get(planId) ?? null;
  primed.delete(planId);
  return d;
}

/* The latency marks of the turn that created a plan, so its card can record
 * "response_rendered" and "quote_ready" against the same turn. */
const timings = new Map<string, AskTiming>();

export function attachTiming(planId: string, t: AskTiming): void {
  timings.set(planId, t);
  if (timings.size > 20) timings.delete(timings.keys().next().value as string);
}

export function timingFor(planId: string): AskTiming | null {
  return timings.get(planId) ?? null;
}

let feeBps: Promise<number | null> | null = null;

/** The published send-payment fee in bps, or null when unknown. Cached. */
export function sendFeeBps(): Promise<number | null> {
  if (!feeBps) {
    feeBps = fetch("/api/fees", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { send_payment?: { kind?: unknown; value?: unknown } } | null) => {
        const f = j?.send_payment;
        return f && f.kind === "percentage" && typeof f.value === "number" && Number.isInteger(f.value) && f.value >= 0 && f.value <= 100 ? f.value : null;
      })
      .catch(() => null);
    // A failed read is retried on the next card rather than cached forever.
    void feeBps.then((v) => { if (v === null) feeBps = null; });
  }
  return feeBps;
}

/**
 * The estimate with PayAI's fee ON TOP (lib/payment/feeOnTop.ts) — exact
 * integer math, the same the server uses: the recipient receives the amount
 * in full and `total` leaves the wallet. Null when the amount can't be read.
 */
export function feeEstimate(amountDecimal: string, decimals: number, bps: number): { fee: string; total: string } | null {
  const units = toUnits(amountDecimal, decimals);
  if (units === null) return null;
  const f = feeOnTop(units, bps);
  return { fee: fromUnits(f.fee, decimals), total: fromUnits(f.gross, decimals) };
}
