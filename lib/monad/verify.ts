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

/**
 * A JS number as a plain decimal string, safe to hand to viem's
 * parseEther/parseUnits — which parse text, not numbers, and throw outright
 * ("not a valid decimal number") on whatever `String()`/`.toString()`
 * produces for very small values. Number.prototype.toString() switches to
 * exponential notation below 1e-6 (`String(0.0000001)` is `"1e-7"`, not
 * `"0.0000001"`), so every parseEther(amount.toString())-shaped call is one
 * sub-micro-unit amount away from crashing an otherwise-valid request.
 * toFixed(decimals) never emits exponential notation, so it's the fix at
 * every one of those call sites — not toBaseUnits/BigInt(Math.round(...))
 * above, which multiplies by 10**decimals in floating point first and would
 * silently lose precision on an 18-decimal MON amount anywhere near this
 * app's own per-transaction cap.
 */
export function toParseableAmount(amount: number, decimals: number): string {
  return amount.toFixed(decimals);
}

/**
 * Defensive counterpart for functions that already take a decimal STRING
 * (not a number) as their public API — e.g. Nad.Fun's/quoteUniswapDirect's
 * quoting calls, which accept a pre-formatted amount because their callers
 * sometimes have one ready-made. If that string came from `String()`/
 * `.toString()` on a computed number upstream (a percentage-of-balance or a
 * USD/price division, say), it can carry the same exponential-notation
 * problem toParseableAmount() guards against above, just one hop removed.
 * Only reformats when the string actually looks exponential — an
 * already-well-formed decimal string (the overwhelmingly common case) is
 * returned untouched, so this never trims legitimate extra precision a
 * caller had a reason to include.
 */
export function normalizeDecimalString(amount: string, decimals: number): string {
  if (!/e/i.test(amount)) return amount;
  const n = Number(amount);
  return Number.isFinite(n) ? n.toFixed(decimals) : amount;
}
