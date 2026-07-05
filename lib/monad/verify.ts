/**
 * On-chain payment verification predicates — the pure core of "did this
 * payment actually happen?" Shared by every confirm route (/api/agent/confirm,
 * /api/links/[id]/confirm) so the highest-consequence logic in the app lives in
 * one tested place instead of being copy-pasted per route.
 *
 * These are intentionally dependency-free (no viem, no chain access): they take
 * already-fetched receipt/transaction data and decide whether it matches an
 * expected transfer. That's what makes them unit-testable with fixtures.
 */

/** keccak256("Transfer(address,address,uint256)") — the ERC20 Transfer topic. */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface ReceiptLog {
  address: string;
  topics: (string | undefined)[];
  data: string;
}

/**
 * True iff `logs` contains an ERC20 Transfer of at least `minAmount` base units
 * of `token` to `recipient`. Case-insensitive on addresses. Uses >= so an
 * overpayment still confirms, but an underpayment never does.
 */
export function hasErc20TransferTo(
  logs: ReceiptLog[],
  token: string,
  recipient: string,
  minAmount: bigint,
): boolean {
  const t = token.toLowerCase();
  const r = recipient.toLowerCase();
  return logs.some((log) => {
    if (log.address.toLowerCase() !== t) return false;
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) return false;
    const to = log.topics[2] ? `0x${log.topics[2].slice(-40)}`.toLowerCase() : "";
    if (to !== r) return false;
    try {
      return BigInt(log.data) >= minAmount;
    } catch {
      return false;
    }
  });
}

/**
 * True iff a native (MON) transaction sends at least `minAmount` wei to
 * `recipient`. The recipient/amount of a native transfer live on the tx itself
 * (to/value), not in a receipt log.
 */
export function isNativeTransferTo(
  tx: { to?: string | null; value: bigint },
  recipient: string,
  minAmount: bigint,
): boolean {
  return !!tx.to && tx.to.toLowerCase() === recipient.toLowerCase() && tx.value >= minAmount;
}

/**
 * Convert a human amount to a token's base units. Amounts here are bounded by
 * the app's per-tx cap and token decimals ≤ 6 for stablecoins, so the product
 * stays well within Number's safe-integer range.
 */
export function toBaseUnits(amount: number, decimals: number): bigint {
  return BigInt(Math.round(amount * 10 ** decimals));
}
