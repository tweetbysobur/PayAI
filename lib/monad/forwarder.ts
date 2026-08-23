/**
 * PayAIForwarder client helpers — the ABI, unsigned-transaction builders, and
 * the on-chain event decoder for interactive, user-signed payments routed
 * through PayAI's own contract (see contracts/PayAIForwarder.sol and the Step
 * 8.1 report).
 *
 * These are pure builders/decoders: nothing here holds a key, signs, or
 * broadcasts. The user's own wallet signs whatever unsigned tx is built here,
 * exactly like the existing direct-transfer path — this only changes the tx's
 * `to`/`data` so the payment gains a PayAI on-chain footprint.
 *
 * Gated by config.forwarderPaymentsEnabled(): with the forwarder address unset
 * (production today), none of this is reached and payments keep using the
 * existing direct path.
 *
 * Server-only.
 */
import "server-only";
import { encodeFunctionData, decodeEventLog, parseEther, parseUnits, keccak256, toBytes, type Address, type Hash } from "viem";
import { toParseableAmount } from "./verify";

/** Trimmed to exactly the two typed payment functions + the canonical event.
 *  No arbitrary-call surface exists on the contract, so none can be encoded. */
export const PAYAI_FORWARDER_ABI = [
  {
    type: "function",
    name: "forwardPaymentNative",
    stateMutability: "payable",
    inputs: [
      { name: "recipient", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "ref", type: "bytes32" },
    ],
    outputs: [{ name: "id", type: "uint256" }],
  },
  {
    type: "function",
    name: "forwardPayment",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "recipient", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "ref", type: "bytes32" },
    ],
    outputs: [{ name: "id", type: "uint256" }],
  },
  {
    type: "event",
    name: "PaymentForwarded",
    inputs: [
      { name: "id", type: "uint256", indexed: true },
      { name: "payer", type: "address", indexed: true },
      { name: "recipient", type: "address", indexed: true },
      { name: "token", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
      { name: "ref", type: "bytes32", indexed: false },
    ],
  },
] as const;

/** A `ref` is an opaque bytes32 correlation id (never secret) — kept short and
 *  deterministic so the same logical payment maps to a stable value. Empty
 *  string → the zero ref, which the contract accepts. */
export function toRef(value: string | null | undefined): `0x${string}` {
  const s = (value ?? "").trim();
  if (!s) return `0x${"0".repeat(64)}`;
  // Deterministic, fixed-width, non-secret — just a correlation id.
  return keccak256(toBytes(s));
}

export interface ForwarderUnsignedTx {
  to: Address;
  data: `0x${string}`;
  value: string;
  from: Address;
}

/**
 * Build the unsigned native-MON forwarding tx:
 *   User -> PayAIForwarder.forwardPaymentNative(recipient, amount, ref){value: amount}
 * The user is the payer (from = walletAddress); the contract forwards the full
 * value to `recipient`. `amount` is a human MON string.
 */
export function buildForwardNativeTx(
  forwarder: Address,
  walletAddress: Address,
  recipient: Address,
  amount: number,
  ref: string | null | undefined,
): ForwarderUnsignedTx {
  // toParseableAmount, not String() — a sub-1e-6 MON amount stringifies to
  // exponential notation, which parseEther rejects (same guard as the existing
  // direct-transfer build path this replaces).
  const amountWei = parseEther(toParseableAmount(amount, 18));
  const data = encodeFunctionData({
    abi: PAYAI_FORWARDER_ABI,
    functionName: "forwardPaymentNative",
    args: [recipient, amountWei, toRef(ref)],
  });
  return { to: forwarder, data, value: `0x${amountWei.toString(16)}`, from: walletAddress };
}

/**
 * Build the unsigned ERC-20 forwarding tx (the SWAP part of a potential
 * approve-then-forward pair — the approval is a separate step):
 *   User -> PayAIForwarder.forwardPayment(token, recipient, amount, ref)
 * `amount` is a human string in the token's own units.
 */
export function buildForwardErc20Tx(
  forwarder: Address,
  walletAddress: Address,
  token: Address,
  recipient: Address,
  amount: number,
  decimals: number,
  ref: string | null | undefined,
): ForwarderUnsignedTx {
  const amountUnits = parseUnits(toParseableAmount(amount, decimals), decimals);
  const data = encodeFunctionData({
    abi: PAYAI_FORWARDER_ABI,
    functionName: "forwardPayment",
    args: [token, recipient, amountUnits, toRef(ref)],
  });
  return { to: forwarder, data, value: "0x0", from: walletAddress };
}

export interface DecodedPaymentForwarded {
  id: bigint;
  payer: Address;
  recipient: Address;
  token: Address;
  amount: bigint;
  ref: `0x${string}`;
}

/**
 * Find and decode the single PaymentForwarded event emitted by `forwarder` in a
 * receipt's logs — the source of truth for result verification (never trust the
 * client's reported amounts). Returns null when no matching event is present,
 * which the caller MUST treat as "not a verified PayAI payment", not success.
 */
export function decodePaymentForwarded(
  logs: readonly { address: string; topics: readonly `0x${string}`[]; data: `0x${string}` }[],
  forwarder: Address,
): DecodedPaymentForwarded | null {
  const want = forwarder.toLowerCase();
  for (const log of logs) {
    if (log.address.toLowerCase() !== want) continue;
    try {
      const decoded = decodeEventLog({
        abi: PAYAI_FORWARDER_ABI,
        data: log.data,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
        eventName: "PaymentForwarded",
      });
      const a = decoded.args as unknown as DecodedPaymentForwarded;
      return { id: a.id, payer: a.payer, recipient: a.recipient, token: a.token, amount: a.amount, ref: a.ref };
    } catch {
      // A non-PaymentForwarded log from the same address (there are none today)
      // — skip rather than fail the whole verification.
      continue;
    }
  }
  return null;
}

export type { Hash };
