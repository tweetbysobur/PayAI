/**
 * PayAI's rules for which x402 payments its facilitator will verify or relay.
 *
 * The x402 SDK checks the signature, balance, nonce and time window. This
 * layer decides whether PayAI is WILLING to pay gas for the payment at all,
 * and it runs before the SDK touches the chain:
 *
 *   - x402 v2, scheme "exact", PayAI's one Monad network, USDC only
 *   - EIP-3009 payloads only (no Permit2 path, no gas-sponsoring extensions)
 *   - the signed requirements match the requirements the server sent
 *   - payTo is the calling merchant's own payout wallet
 *   - the authorization pays exactly payTo, exactly the amount
 *   - the amount is positive and under the per-payment cap
 *   - neither payer nor payee is sanctioned
 *   - the facilitator never relays a payment from or to itself
 *
 * Pure: no env, no I/O. Everything it needs is passed in, so every rule is
 * unit-tested directly.
 */
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

export type PolicyRejection =
  | "unsupported_version"
  | "unsupported_scheme"
  | "unsupported_network"
  | "unsupported_asset"
  | "unsupported_payload"
  | "requirements_mismatch"
  | "payee_not_merchant"
  | "recipient_mismatch"
  | "amount_mismatch"
  | "invalid_amount"
  | "amount_over_cap"
  | "sanctioned_address"
  | "facilitator_address";

export type PolicyResult =
  | { ok: true; payer: `0x${string}`; amountAtomic: bigint }
  | { ok: false; reason: PolicyRejection; message: string };

export interface PolicyInput {
  x402Version: unknown;
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
  /** The authenticated merchant's payout wallet. */
  merchantWallet: string;
  network: string;
  asset: string;
  maxAmountAtomic: bigint;
  facilitatorAddresses: readonly string[];
  isSanctioned: (address: string) => boolean;
}

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const UINT_RE = /^\d{1,78}$/;

const eqAddr = (a: unknown, b: unknown) =>
  typeof a === "string" && typeof b === "string" && ADDR_RE.test(a) && ADDR_RE.test(b) && a.toLowerCase() === b.toLowerCase();

function reject(reason: PolicyRejection, message: string): PolicyResult {
  return { ok: false, reason, message };
}

interface Eip3009Authorization {
  from: `0x${string}`;
  to: `0x${string}`;
  value: string;
}

/** The EIP-3009 authorization, or null for any other payload shape. Checked
 *  structurally so a malformed body can never reach the SDK as "EIP-3009". */
function eip3009Authorization(payload: unknown): Eip3009Authorization | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(p.signature)) return null;
  const a = p.authorization as Record<string, unknown> | undefined;
  if (!a || typeof a !== "object") return null;
  if (!ADDR_RE.test(String(a.from)) || !ADDR_RE.test(String(a.to))) return null;
  if (typeof a.value !== "string" || !UINT_RE.test(a.value)) return null;
  for (const k of ["validAfter", "validBefore"] as const) {
    if (typeof a[k] !== "string" || !UINT_RE.test(a[k] as string)) return null;
  }
  if (typeof a.nonce !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(a.nonce)) return null;
  return { from: a.from as `0x${string}`, to: a.to as `0x${string}`, value: a.value };
}

export function checkPaymentPolicy(input: PolicyInput): PolicyResult {
  const { paymentPayload: pp, paymentRequirements: req } = input;

  if (input.x402Version !== 2 || pp?.x402Version !== 2) {
    return reject("unsupported_version", "This facilitator accepts x402 version 2 only.");
  }
  if (!req || typeof req !== "object" || !pp.accepted || typeof pp.accepted !== "object") {
    return reject("requirements_mismatch", "Payment requirements are missing.");
  }
  if (req.scheme !== "exact") return reject("unsupported_scheme", "Only the exact scheme is supported.");
  if (req.network !== input.network) return reject("unsupported_network", `Only ${input.network} is supported.`);
  if (!eqAddr(req.asset, input.asset)) return reject("unsupported_asset", "Only USDC is supported.");

  // What the payer signed for must be what the server asked for. Otherwise a
  // payer could sign a cheaper requirement and have it checked against a
  // more expensive one, or the reverse.
  const acc = pp.accepted;
  if (
    acc.scheme !== req.scheme ||
    acc.network !== req.network ||
    !eqAddr(acc.asset, req.asset) ||
    !eqAddr(acc.payTo, req.payTo) ||
    String(acc.amount) !== String(req.amount)
  ) {
    return reject("requirements_mismatch", "The signed payment does not match the requested payment.");
  }

  if (!eqAddr(req.payTo, input.merchantWallet)) {
    return reject("payee_not_merchant", "payTo must be your PayAI payout wallet.");
  }

  const auth = eip3009Authorization(pp.payload);
  if (!auth) return reject("unsupported_payload", "Only EIP-3009 transferWithAuthorization payloads are supported.");
  if (!eqAddr(auth.to, req.payTo)) return reject("recipient_mismatch", "The authorization pays a different address than payTo.");

  if (typeof req.amount !== "string" || !UINT_RE.test(req.amount)) {
    return reject("invalid_amount", "The amount must be a whole number of USDC base units.");
  }
  const amount = BigInt(req.amount);
  if (amount <= 0n) return reject("invalid_amount", "The amount must be positive.");
  if (BigInt(auth.value) !== amount) return reject("amount_mismatch", "The authorization amount does not match the requested amount.");
  if (amount > input.maxAmountAtomic) return reject("amount_over_cap", "The amount is over this facilitator's per-payment cap.");

  if (input.isSanctioned(auth.from) || input.isSanctioned(req.payTo)) {
    return reject("sanctioned_address", "This payment can't be processed.");
  }
  if (input.facilitatorAddresses.some((f) => eqAddr(f, auth.from) || eqAddr(f, req.payTo))) {
    return reject("facilitator_address", "The facilitator wallet can't be a payer or payee.");
  }

  return { ok: true, payer: auth.from, amountAtomic: amount };
}
