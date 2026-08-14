/**
 * Ask PayAI Phase 2 — the "intent validation" layer for send_payment.
 *
 * Turns a raw-text SendPaymentCandidate into either a clarifying question or
 * a complete SendPaymentIntent. This is the only place allowed to decide a
 * field is "good enough" to submit — it never guesses a missing amount or
 * recipient, never defaults an unstated asset, never lets a non-Monad
 * network slide through quietly.
 *
 * This is local, offline validation only (no network call). It exists to
 * produce the fast, friendly clarifying questions the task spec requires
 * ("How much USDC would you like to send?"). The authoritative checks —
 * recipient resolution, guardrail limits, compliance/sanctions, risk,
 * on-chain balance — still run server-side on the real /api/agent call that
 * follows a successful validation here (see orchestrator.ts). This layer
 * never replaces that; it only decides whether it's worth making the call.
 */
import { isValidAmount } from "@/lib/validation";
import type { SendPaymentCandidate, SendPaymentIntent, SupportedAsset } from "./types";

export type SendPaymentValidation =
  | { ok: true; intent: SendPaymentIntent }
  | { ok: false; question: string };

const SUPPORTED_ASSETS: SupportedAsset[] = ["MON", "USDC"];

export function validateSendPaymentCandidate(c: SendPaymentCandidate): SendPaymentValidation {
  if (c.networkText) {
    return { ok: false, question: "PayAI currently sends on Monad only — I can't send on another network." };
  }
  if (!c.amountText && !c.recipientText) {
    return { ok: false, question: "Who should this go to, and how much? For example: \"Send 50 USDC to 0x742d...91F.\"" };
  }
  if (!c.amountText) {
    return { ok: false, question: `How much ${c.assetText ?? ""} would you like to send?`.replace(/\s+/g, " ") };
  }
  if (!isValidAmount(c.amountText)) {
    return { ok: false, question: "That amount doesn't look right — enter a number greater than 0." };
  }
  if (!c.recipientText) {
    return { ok: false, question: `Who should receive the ${c.amountText}${c.assetText ? ` ${c.assetText}` : ""}?` };
  }
  if (!c.assetText) {
    return { ok: false, question: "Which token would you like to send — MON or USDC?" };
  }
  if (!SUPPORTED_ASSETS.includes(c.assetText as SupportedAsset)) {
    return { ok: false, question: `Ask PayAI currently supports MON and USDC only — ${c.assetText} isn't available yet.` };
  }

  return {
    ok: true,
    intent: {
      intent: "send_payment",
      asset: c.assetText as SupportedAsset,
      amount: c.amountText,
      recipient: c.recipientText,
      network: "monad",
    },
  };
}
