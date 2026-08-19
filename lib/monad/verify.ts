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
 * Convert a human amount to a token's base units, exactly.
 *
 * This used to be `BigInt(Math.round(amount * 10 ** decimals))`, on the stated
 * assumption that amounts were "bounded by the app's per-tx cap and token
 * decimals ≤ 6 for stablecoins, so the product stays well within Number's
 * safe-integer range". That assumption does not hold: 18-decimal MON goes
 * through here, and 10**18 alone is already two orders of magnitude past
 * Number.MAX_SAFE_INTEGER, so the multiply happens in floating point and the
 * result is wrong for ordinary amounts — 1.1 became 1100000000000000128 wei
 * instead of 1100000000000000000, 999.999 was off by 32768 wei.
 *
 * That is not cosmetic. The automation vault reserves funds with viem's exact
 * parseUnits and released them with this function, so the release amount could
 * come out ABOVE the reserved balance and trip the
 * "INSUFFICIENT_RESERVED_FUNDS" guard — a Reserved-Funds automation for 1.1 MON
 * simply refused to execute.
 *
 * The conversion is now done on the decimal string, so no float is ever
 * multiplied. It is deliberately plain string arithmetic rather than a viem
 * import: this module is dependency-free on purpose (see the file header) so it
 * stays unit-testable against fixtures. Equivalence with parseUnits, including
 * its round-half-up on digits past `decimals`, is pinned by a fuzz test in
 * test/verify.test.ts that runs both side by side.
 */
export function toBaseUnits(amount: number, decimals: number): bigint {
  const s = toParseableAmount(amount, decimals);
  const negative = s.startsWith("-");
  const [intRaw, fracRaw = ""] = (negative ? s.slice(1) : s).split(".");
  const frac = fracRaw.slice(0, decimals).padEnd(decimals, "0");
  let units = BigInt((intRaw || "0") + frac);
  // Digits beyond the token's precision round half up, matching parseUnits.
  const dropped = fracRaw.slice(decimals);
  if (dropped && Number(dropped[0]) >= 5) units += 1n;
  return negative ? -units : units;
}

/**
 * A JS number as a plain decimal string, safe to hand to viem's
 * parseEther/parseUnits — which parse text, not numbers, and throw outright
 * ("not a valid decimal number") on whatever `String()`/`.toString()`
 * produces for very small values. Number.prototype.toString() switches to
 * exponential notation below 1e-6 (`String(0.0000001)` is `"1e-7"`, not
 * `"0.0000001"`), so every parseEther(amount.toString())-shaped call is one
 * sub-micro-unit amount away from crashing an otherwise-valid request.
 * toFixed(decimals) never emits exponential notation, so it's the fix for
 * exactly that case.
 *
 * It is NOT used unconditionally, though, because toFixed has a problem of its
 * own at 18 decimals: it prints the float's true binary value rather than the
 * decimal the user meant. `(1.1).toFixed(18)` is "1.100000000000000089", which
 * parses to 1100000000000000089 wei — 89 wei of pure float noise attached to
 * every ordinary amount. `String(1.1)` is "1.1", which parses to exactly
 * 1100000000000000000.
 *
 * So the plain string representation is used whenever it is well-formed, and
 * toFixed only rescues the exponential case it was introduced for. That is the
 * same "only reformat when it actually looks exponential" rule
 * normalizeDecimalString below already applies to strings arriving from
 * upstream, now applied consistently to numbers too. parseUnits tolerates more
 * fraction digits than the token has (it rounds), so passing the exact string
 * through is safe even when it carries more precision than `decimals`.
 */
export function toParseableAmount(amount: number, decimals: number): string {
  const s = String(amount);
  return /e/i.test(s) ? amount.toFixed(decimals) : s;
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
