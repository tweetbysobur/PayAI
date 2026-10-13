/**
 * One approval for a whole plan — the rules the plan card follows.
 *
 * The user reviews every action and taps Approve once. After that, a quote
 * that is clean goes straight on to signing; a quote the server flagged is
 * still shown for the user to accept or decline before anything is signed.
 * Swaps stay protected by the slippage limit shown at review, which the
 * transaction enforces on-chain (minimum received).
 *
 * Pure; no I/O.
 */
import type { QuoteProjection } from "./runner";

/** True when this quote must be shown before signing: it carries a warning
 *  (price impact, a changed amount, …) or a risk level other than low. */
export function quoteNeedsReview(q: Pick<QuoteProjection, "warnings" | "risk">): boolean {
  if (q.warnings && q.warnings.length > 0) return true;
  if (q.risk && q.risk.level !== "low") return true;
  return false;
}

/** The line under the Approve button. */
export function approvalHint(multi: boolean, passkey: boolean): string {
  if (passkey) {
    return multi
      ? "One passkey approval runs every action above, in order. You're only stopped if a quote changes in a way you should see."
      : "One passkey approval sends it. You're only stopped if the quote changes in a way you should see.";
  }
  return multi
    ? "One approval here, then your wallet confirms each transaction in order."
    : "Approve, then confirm in your wallet.";
}
