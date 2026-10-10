/**
 * What a settled payment PROVES about PayAI's fee, turned into the receipt's
 * FeeEvidence (lib/payment/feeMath.ts). Only transaction data goes in —
 * decoded events and how the payment settled — never a configured rate.
 *
 * Both V2 fee contracts (PayAIForwarderV2, PaymentExecutorV2) emit
 * FeeCollected for EVERY payment, including a zero fee. So a FeeCollected is
 * a verified fee (zero or not); a missing one on a fee contract is
 * "unverified", never assumed to be zero.
 *
 * Pure (viem's event-selector hashing only); no I/O.
 */
import { toEventSelector } from "viem";
import type { FeeEvidence } from "./feeMath";
import type { TransactionResult } from "./types";

/** The custodial path (POST /api/agent, the platform's agent wallet). That
 *  path settles through PaymentExecutor WITHOUT the fee on top, so the
 *  contract takes the fee out of the amount ("deducted"). */
export function feeEvidenceFromExecution(tx: Pick<TransactionResult, "settledVia" | "feeCollected" | "mode">): FeeEvidence {
  if (tx.mode === "simulation" || tx.settledVia === "simulation") {
    return { kind: "estimate", reason: "simulation, nothing was charged" };
  }
  if (tx.settledVia === "direct") return { kind: "none" };
  if (tx.settledVia === "executor" && tx.feeCollected) {
    let feeUnits: bigint;
    try {
      feeUnits = BigInt(tx.feeCollected.feeUnits);
    } catch {
      return { kind: "unverified" };
    }
    if (feeUnits < 0n || !Number.isInteger(tx.feeCollected.decimals)) return { kind: "unverified" };
    return { kind: "collected", feeUnits, decimals: tx.feeCollected.decimals, basis: "deducted" };
  }
  // Executor without a FeeCollected, a vault release, or an unknown route.
  return { kind: "unverified" };
}

/** A payment the user-signed path (POST /api/agent/confirm) verified via the
 *  configured PayAIForwarder's PaymentForwarded. `feeEvent` comes from
 *  verifyForwardedNet: only "collected" (the forwarder's own FeeCollected for
 *  this payment) is a verified fee; "absent" is never presented as one. */
export function feeEvidenceFromForward(forward: {
  fee: bigint;
  feeOnTop: boolean;
  feeEvent: "collected" | "absent";
  decimals: number;
}): FeeEvidence {
  if (forward.feeEvent !== "collected") return { kind: "unverified" };
  return { kind: "collected", feeUnits: forward.fee, decimals: forward.decimals, basis: forward.feeOnTop ? "on_top" : "deducted" };
}

/* ── Direct (non-forwarder) transfers on the user-signed path ─────────────── */

/** Event signatures that mean a PayAI fee contract took part in a transaction,
 *  wherever they were emitted from: the forwarder's PaymentForwarded, the
 *  forwarder/executor FeeCollected, the vault's FeeCollected and the
 *  executor's PaymentExecuted. */
export const PAYAI_FEE_EVENT_TOPICS: readonly string[] = [
  "event PaymentForwarded(uint256 indexed id, address indexed payer, address indexed recipient, address token, uint256 amount, bytes32 ref)",
  "event FeeCollected(uint256 indexed id, address token, uint256 feeAmount, address treasury)",
  "event FeeCollected(bytes32 indexed automationId, bytes32 indexed requestId, address token, uint256 feeAmount, address treasury)",
  "event PaymentExecuted(uint256 indexed id, address indexed agent, address indexed merchant, address token, uint256 amount, uint16 riskScore, bytes32 aiDecisionHash, bytes32 ref, bytes32 requestId)",
].map((sig) => toEventSelector(sig).toLowerCase());

const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

interface LogLike { address: string; topics: readonly string[]; data: string }

const lc = (a: string | null | undefined) => (a ?? "").toLowerCase();
const topicAddr = (t: string | undefined) => (t ? `0x${t.slice(-40)}`.toLowerCase() : "");

/** True when any log was emitted by a known PayAI fee contract, or carries a
 *  PayAI fee-contract event signature from any address. */
export function hasPayAIFeeEvidence(logs: readonly LogLike[], feeContracts: readonly (string | null | undefined)[]): boolean {
  const known = new Set(feeContracts.filter((a): a is string => !!a).map(lc));
  return logs.some((l) => known.has(lc(l.address)) || PAYAI_FEE_EVENT_TOPICS.includes(lc(l.topics[0])));
}

/**
 * Fee evidence for an ERC-20 payment the confirm route accepted on its
 * direct-transfer branch. A verified zero fee ("none") ONLY when all hold:
 *   - the transaction targeted the token contract itself;
 *   - a Transfer of that token FROM the user's wallet TO the recipient for
 *     at least the requested amount is in the logs;
 *   - no log comes from a known PayAI fee contract and none carries a PayAI
 *     fee-event signature.
 * Anything else — e.g. a forwarded payment reaching this branch because the
 * configured forwarder is missing or was rotated (its USDC Transfer looks
 * just like a direct one), a helper contract, or a transfer from another
 * sender — is "unverified". This decides the receipt label only; what the
 * route accepts is unchanged.
 *
 * The amount received is the value of THE Transfer from the wallet to the
 * recipient — the route accepts an overpayment, so the receipt reports what
 * actually moved. It must be the only such Transfer in the transaction: with
 * several, which one is "the payment" is ambiguous, so nothing is claimed.
 */
export function directErc20FeeEvidence(i: {
  txTo: string | null | undefined;
  token: string;
  /** The token's decimals, for the amount received. */
  decimals: number;
  wallet: string;
  recipient: string;
  minAmount: bigint;
  logs: readonly LogLike[];
  feeContracts: readonly (string | null | undefined)[];
}): FeeEvidence {
  if (lc(i.txTo) !== lc(i.token)) return { kind: "unverified" };
  if (hasPayAIFeeEvidence(i.logs, i.feeContracts)) return { kind: "unverified" };
  // Every Transfer of this token from the wallet to the recipient — any amount.
  const payments = i.logs.filter((l) =>
    lc(l.address) === lc(i.token) && lc(l.topics[0]) === ERC20_TRANSFER_TOPIC &&
    topicAddr(l.topics[1]) === lc(i.wallet) && topicAddr(l.topics[2]) === lc(i.recipient));
  if (payments.length !== 1) return { kind: "unverified" }; // none, or ambiguous
  let units: bigint;
  try {
    units = BigInt(payments[0].data);
  } catch {
    return { kind: "unverified" };
  }
  if (units < i.minAmount) return { kind: "unverified" };
  return { kind: "none", received: { units, decimals: i.decimals } };
}

/**
 * Fee evidence for a native MON payment the confirm route accepted on its
 * direct branch (the transaction itself went to the recipient). A verified
 * zero fee with the ACTUAL value received — the route accepts an overpayment,
 * so the receipt reports what was sent, not what was requested. Unverified
 * if a PayAI fee contract is the recipient or shows up in the logs.
 */
export function directNativeFeeEvidence(i: {
  txTo: string | null | undefined;
  recipient: string;
  value: bigint;
  logs: readonly LogLike[];
  feeContracts: readonly (string | null | undefined)[];
}): FeeEvidence {
  if (lc(i.txTo) !== lc(i.recipient)) return { kind: "unverified" };
  if (hasPayAIFeeEvidence(i.logs, i.feeContracts)) return { kind: "unverified" };
  if (i.feeContracts.some((a) => a && lc(a) === lc(i.recipient))) return { kind: "unverified" };
  return { kind: "none", received: { units: i.value, decimals: 18 } };
}
