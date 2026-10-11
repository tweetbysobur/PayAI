import type { Operation } from "./types";

/**
 * Which failed Ask PayAI cards may offer "Try again".
 *
 * "Try again" re-runs the request from scratch — a NEW approval and a NEW
 * wallet signature. That is only safe when the earlier attempt provably moved
 * nothing: it never broadcast, or its transaction definitively reverted
 * on-chain. When a transaction may have reached the chain (broadcast but not
 * confirmed, confirmation failed, status unknown, an interrupted signature,
 * one hop of a multi-hop trade done), a retry is how someone pays twice — so
 * those cards get no retry, and anything not listed here is refused by
 * default.
 *
 * Each code below is set only where the code establishes nothing moved:
 *   NOT_SENT           the failing step never broadcast (rejected/threw first)
 *   REVERTED           the confirm route saw the transaction mined AND reverted
 *   APPROVAL_NOT_SENT  the approval was never signed; the payment never sent
 *   APPROVAL_REVERTED  the approval reverted; the payment was never signed
 *   APPROVAL_FAILED    a protocol action's approval reverted; nothing settled
 *   USER_CANCELLED     cancelled on a preview/ready card, before any signature
 *   NO_WALLET          wallet disconnected before signing began
 *   QUOTE_EXPIRED      refused before signing (stale quote)
 *   WRONG_NETWORK      refused before signing
 *   BUILD_FAILED       the transaction was never built, so never signed
 *
 * Deliberately NOT retryable: UNCONFIRMED, CONFIRM_FAILED, INTERRUPTED,
 * PARTIAL_MULTI_HOP, SUPERSEDED (an updated card already replaces it), and
 * any error with no code or a code not listed here.
 */
export const RETRYABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  "NOT_SENT",
  "REVERTED",
  "APPROVAL_NOT_SENT",
  "APPROVAL_REVERTED",
  "APPROVAL_FAILED",
  "USER_CANCELLED",
  "NO_WALLET",
  "QUOTE_EXPIRED",
  "WRONG_NETWORK",
  "BUILD_FAILED",
]);

/** True only for a failed card whose error code is on the allow-list. */
export function isSafeToRetry(op: Pick<Operation, "status" | "error">): boolean {
  return op.status === "error" && !!op.error?.code && RETRYABLE_ERROR_CODES.has(op.error.code);
}
