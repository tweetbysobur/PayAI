/**
 * Ask PayAI Phase 2 — send_payment intent contract.
 *
 * This is the literal structured shape the task specifies: the AI layer
 * produces ONLY this object, never a direct instruction to move funds.
 * `SendPaymentCandidate` is what pure text extraction can observe — every
 * field stays null unless it is literally present in the user's words, never
 * guessed or defaulted. `validateSendPaymentCandidate` (see validate.ts) is
 * the only thing allowed to promote a candidate into a complete
 * `SendPaymentIntent`; every other path is a clarifying question.
 */

export type SupportedAsset = "MON" | "USDC";

/** The exact shape requested by the task spec: {"intent":"send_payment","asset":"USDC","amount":"50","recipient":"0x…","network":"monad"} */
export interface SendPaymentIntent {
  intent: "send_payment";
  asset: SupportedAsset;
  amount: string;
  recipient: string;
  network: "monad";
}

export interface SendPaymentCandidate {
  intent: "send_payment";
  /** Exact token substring the user typed, if any (e.g. "USDC"). */
  assetText: string | null;
  /** Exact numeric substring, if any (e.g. "50"). */
  amountText: string | null;
  /** Exact recipient-shaped substring — address, .nad domain, or the text
   *  after "to" — if any. Never resolved to an address here. */
  recipientText: string | null;
  /** A non-Monad network name, if one was explicitly mentioned. */
  networkText: string | null;
  rawText: string;
}
