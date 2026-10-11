/**
 * Per-path verification for POST /api/agent/confirm: did THIS mined
 * transaction carry out the payment the server approved?
 *
 * The approval (/api/agent's stored `unsignedTx`) says exactly what the wallet
 * was asked to sign. Each supported payment path below checks the mined
 * transaction against that record — target, sender, calldata, value — and then
 * against the receipt's events. Nothing here accepts a generic "a Transfer to
 * the recipient is somewhere in the logs": that matches transactions the
 * payer did not sign for this payment (an unrelated transfer, a helper
 * contract, a third party's Transfer event).
 *
 * Supported paths (chosen from the STORED transaction, never from the mined
 * one, so the mined transaction cannot pick its own verifier):
 *   direct-erc20       transfer(recipient, amount) sent to the token
 *   forwarder-erc20    PayAIForwarder.forwardPayment(...)
 *   forwarder-native   PayAIForwarder.forwardPaymentNative(...){value}
 *   direct-native      plain MON transfer to the recipient
 * Anything else is unsupported and rejected.
 *
 * Amounts: the direct paths accept an overpayment (>= the approved amount,
 * never less); the forwarder paths are exact (calldata is byte-identical to
 * the approval, the recipient's net equals the approved amount).
 *
 * This decides ACCEPTANCE only. What a receipt may say about the fee comes
 * from lib/payment/receiptEvidence.ts, separately.
 *
 * Pure: takes already-fetched data, no I/O.
 */
import { decodeFunctionData, encodeFunctionData, parseAbi, toEventSelector } from "viem";
import type { Address } from "viem";
import {
  PAYAI_FORWARDER_ABI,
  decodeFeeCollected,
  decodePaymentForwarded,
  verifyForwardedNet,
} from "@/lib/monad/forwarder";
import { TRANSFER_TOPIC } from "@/lib/monad/verify";

export type PaymentPath = "direct-erc20" | "forwarder-erc20" | "forwarder-native" | "direct-native";

/** What the wallet was asked to sign, as /api/agent stored it. */
export interface StoredTx { to: Address; data: `0x${string}`; value: bigint; from: Address }

export interface MinedTx { to?: string | null; from: string; input: string; value: bigint }
export interface LogLike { address: string; topics: readonly `0x${string}`[]; data: `0x${string}` }

export type Verdict<T = object> = ({ ok: true } & T) | { ok: false; reason: string };

/** The payment the approved intent describes, in on-chain terms. */
export interface ApprovedPayment {
  wallet: Address;
  recipient: Address;
  /** The token contract; ignored for native MON. */
  token: Address;
  /** The recipient's net amount in base units. */
  amountUnits: bigint;
}

const lc = (s: string | null | undefined) => (s ?? "").toLowerCase();
const same = (a: string | null | undefined, b: string | null | undefined) => lc(a) === lc(b);
const topicAddr = (t: string | undefined) => (t ? `0x${t.slice(-40)}` : "");
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const HEX = /^0x([0-9a-fA-F]{2})*$/;

const ERC20_TRANSFER_ABI = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);
const PAYMENT_FORWARDED_TOPIC = toEventSelector(
  "event PaymentForwarded(uint256 indexed id, address indexed payer, address indexed recipient, address token, uint256 amount, bytes32 ref)",
).toLowerCase();
const FEE_COLLECTED_TOPIC = toEventSelector(
  "event FeeCollected(uint256 indexed id, address token, uint256 feeAmount, address treasury)",
).toLowerCase();

/** Parse the stored `unsignedTx` strictly; null when it is not the shape the
 *  approval builders produce. */
export function readStoredTx(raw: unknown): StoredTx | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.to !== "string" || !ADDR.test(r.to)) return null;
  if (typeof r.from !== "string" || !ADDR.test(r.from)) return null;
  if (typeof r.data !== "string" || !HEX.test(r.data)) return null;
  if (typeof r.value !== "string" || !/^0x[0-9a-fA-F]+$/.test(r.value)) return null;
  return { to: r.to as Address, from: r.from as Address, data: r.data as `0x${string}`, value: BigInt(r.value) };
}

type ForwarderCall =
  | { fn: "forwardPayment"; token: Address; recipient: Address; amount: bigint; ref: `0x${string}` }
  | { fn: "forwardPaymentNative"; recipient: Address; amount: bigint; ref: `0x${string}` };

/** Decode forwarder calldata, requiring it to re-encode byte-for-byte (no
 *  trailing data, no non-canonical padding). */
function decodeForwarderCall(data: string): ForwarderCall | null {
  try {
    const d = decodeFunctionData({ abi: PAYAI_FORWARDER_ABI, data: data as `0x${string}` });
    if (d.functionName === "forwardPayment") {
      const [token, recipient, amount, ref] = d.args as readonly [Address, Address, bigint, `0x${string}`];
      const again = encodeFunctionData({ abi: PAYAI_FORWARDER_ABI, functionName: "forwardPayment", args: [token, recipient, amount, ref] });
      return again === lc(data) ? { fn: "forwardPayment", token, recipient, amount, ref } : null;
    }
    if (d.functionName === "forwardPaymentNative") {
      const [recipient, amount, ref] = d.args as readonly [Address, bigint, `0x${string}`];
      const again = encodeFunctionData({ abi: PAYAI_FORWARDER_ABI, functionName: "forwardPaymentNative", args: [recipient, amount, ref] });
      return again === lc(data) ? { fn: "forwardPaymentNative", recipient, amount, ref } : null;
    }
  } catch { /* not forwarder calldata */ }
  return null;
}

function decodeTransferCall(data: string): { to: Address; amount: bigint } | null {
  try {
    const d = decodeFunctionData({ abi: ERC20_TRANSFER_ABI, data: data as `0x${string}` });
    const [to, amount] = d.args as readonly [Address, bigint];
    const again = encodeFunctionData({ abi: ERC20_TRANSFER_ABI, functionName: "transfer", args: [to, amount] });
    return again === lc(data) ? { to, amount } : null;
  } catch {
    return null;
  }
}

/**
 * Which supported path the STORED approval is, or null when it is none of
 * them. Decided only from the stored transaction and the approved payment.
 */
export function classifyStoredTx(stored: StoredTx, p: ApprovedPayment, isNative: boolean): PaymentPath | null {
  if (isNative) {
    if (stored.data === "0x" && same(stored.to, p.recipient)) return "direct-native";
    return decodeForwarderCall(stored.data)?.fn === "forwardPaymentNative" ? "forwarder-native" : null;
  }
  if (decodeForwarderCall(stored.data)?.fn === "forwardPayment") return "forwarder-erc20";
  if (same(stored.to, p.token) && decodeTransferCall(stored.data)) return "direct-erc20";
  return null;
}

/** A mined transaction must come from the declared wallet and target `to`. */
function basicsOk(tx: MinedTx, stored: StoredTx, wallet: Address): string | null {
  if (!same(stored.from, wallet)) return "stored_sender_mismatch";
  if (!same(tx.from, wallet)) return "tx_sender_mismatch";
  if (!same(tx.to, stored.to)) return "tx_target_mismatch";
  return null;
}

/**
 * Direct ERC-20: the approved `transfer(recipient, amount)` sent to the token.
 *   - the stored approval is itself that transfer (target token, recipient,
 *     amount == the approved amount);
 *   - the mined tx targets the token, carries no value, and its calldata
 *     decodes (exactly) to transfer(recipient, amount >= approved);
 *   - the logs hold exactly ONE Transfer of that token from the wallet to the
 *     recipient, for exactly the calldata amount.
 * An overpayment passes; an underpayment, another recipient or another token
 * never does.
 */
export function verifyDirectErc20(tx: MinedTx, logs: readonly LogLike[], stored: StoredTx, p: ApprovedPayment): Verdict<{ received: bigint }> {
  const b = basicsOk(tx, stored, p.wallet);
  if (b) return { ok: false, reason: b };
  if (!same(stored.to, p.token)) return { ok: false, reason: "stored_target_not_token" };
  const storedCall = decodeTransferCall(stored.data);
  if (!storedCall || !same(storedCall.to, p.recipient) || storedCall.amount !== p.amountUnits) return { ok: false, reason: "stored_calldata_mismatch" };
  if (tx.value !== 0n) return { ok: false, reason: "unexpected_value" };
  const call = decodeTransferCall(tx.input);
  if (!call) return { ok: false, reason: "calldata_not_transfer" };
  if (!same(call.to, p.recipient)) return { ok: false, reason: "calldata_recipient_mismatch" };
  if (call.amount < p.amountUnits) return { ok: false, reason: "underpaid" };

  const transfers = logs.filter((l) =>
    same(l.address, p.token) && lc(l.topics[0]) === TRANSFER_TOPIC &&
    same(topicAddr(l.topics[1]), p.wallet) && same(topicAddr(l.topics[2]), p.recipient));
  if (transfers.length === 0) return { ok: false, reason: "no_transfer_event" };
  if (transfers.length > 1) return { ok: false, reason: "ambiguous_transfer_events" };
  let moved: bigint;
  try { moved = BigInt(transfers[0].data); } catch { return { ok: false, reason: "bad_transfer_event" }; }
  if (moved !== call.amount) return { ok: false, reason: "transfer_event_amount_mismatch" };
  return { ok: true, received: moved };
}

/**
 * Forwarded payment (ERC-20 or native MON) through the forwarder the approval
 * named. The mined tx must target THAT address — not "whatever forwarder is
 * configured now", so a payment approved before a forwarder rotation still
 * verifies — with calldata and value byte-identical to the approval. The
 * events must come from that same contract: exactly one PaymentForwarded
 * (payer, recipient, token, gross and ref as in the calldata), at most one
 * FeeCollected for its id, and the recipient's net must equal the approved
 * amount. A forwarder with no FeeCollected (V1, no fee) verifies; the fee is
 * then simply not proven (see feeEvidenceFromForward).
 */
export function verifyForwarded(
  tx: MinedTx, logs: readonly LogLike[], stored: StoredTx, p: ApprovedPayment, isNative: boolean,
): Verdict<{ fee: bigint; feeOnTop: boolean; feeEvent: "collected" | "absent" }> {
  const b = basicsOk(tx, stored, p.wallet);
  if (b) return { ok: false, reason: b };
  if (lc(tx.input) !== lc(stored.data)) return { ok: false, reason: "calldata_differs_from_approval" };
  if (tx.value !== stored.value) return { ok: false, reason: "value_differs_from_approval" };

  const call = decodeForwarderCall(stored.data);
  if (!call || (isNative ? call.fn !== "forwardPaymentNative" : call.fn !== "forwardPayment")) return { ok: false, reason: "stored_calldata_mismatch" };
  if (!same(call.recipient, p.recipient)) return { ok: false, reason: "stored_recipient_mismatch" };
  if (call.fn === "forwardPayment" && !same(call.token, p.token)) return { ok: false, reason: "stored_token_mismatch" };
  if (call.fn === "forwardPaymentNative" && stored.value !== call.amount) return { ok: false, reason: "stored_value_mismatch" };
  if (call.fn === "forwardPayment" && stored.value !== 0n) return { ok: false, reason: "stored_value_mismatch" };

  const forwarder = stored.to;
  const forwarded = logs.filter((l) => same(l.address, forwarder) && lc(l.topics[0]) === PAYMENT_FORWARDED_TOPIC);
  if (forwarded.length === 0) return { ok: false, reason: "no_forwarded_event" };
  if (forwarded.length > 1) return { ok: false, reason: "ambiguous_forwarded_events" };
  const ev = decodePaymentForwarded(logs, forwarder);
  if (!ev) return { ok: false, reason: "no_forwarded_event" };
  if (ev.amount !== call.amount || lc(ev.ref) !== lc(call.ref)) return { ok: false, reason: "event_differs_from_calldata" };

  const fees = logs.filter((l) => same(l.address, forwarder) && lc(l.topics[0]) === FEE_COLLECTED_TOPIC);
  if (fees.length > 1) return { ok: false, reason: "ambiguous_fee_events" };
  const fc = decodeFeeCollected(logs, forwarder, ev.id);

  const verdict = verifyForwardedNet(ev, fc, {
    payer: p.wallet,
    recipient: p.recipient,
    token: (isNative ? "0x0000000000000000000000000000000000000000" : p.token) as Address,
    amountUnits: p.amountUnits,
  });
  if (!verdict) return { ok: false, reason: "forwarded_event_mismatch" };
  return { ok: true, ...verdict };
}

/**
 * Native MON sent straight to the recipient: the stored approval is that
 * transfer (target recipient, empty calldata, value == approved amount); the
 * mined tx goes to the recipient with empty calldata and a value >= the
 * approved amount (an overpayment passes, an underpayment never does).
 */
export function verifyDirectNative(tx: MinedTx, stored: StoredTx, p: ApprovedPayment): Verdict<{ received: bigint }> {
  const b = basicsOk(tx, stored, p.wallet);
  if (b) return { ok: false, reason: b };
  if (!same(stored.to, p.recipient) || stored.data !== "0x" || stored.value !== p.amountUnits) return { ok: false, reason: "stored_calldata_mismatch" };
  if (lc(tx.input) !== "0x") return { ok: false, reason: "unexpected_calldata" };
  if (tx.value < p.amountUnits) return { ok: false, reason: "underpaid" };
  return { ok: true, received: tx.value };
}
