/**
 * Token amounts for people to read on review and receipt screens.
 *
 * Exact amounts carry up to 18 decimals ("0.10025062656641604 MON" — a fee
 * grossed up on 0.1 MON). Nobody reads that, and on a phone it pushes
 * everything else off the row. These helpers cut an amount to a readable
 * number of decimals with decimal-string arithmetic (never a float), and the
 * direction of the rounding is chosen by what the number means:
 *
 *  - "up"   for what you pay (a total, a fee): never show less than leaves
 *           the wallet.
 *  - "down" for what you get (received, minimum received): never promise
 *           more than arrives.
 *  - "nearest" for everything else.
 *
 * The exact value is always still available to the screen (as a tooltip) —
 * this only changes what is printed. Pure; no I/O.
 */

export type Rounding = "up" | "down" | "nearest";

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/** Groups the integer part with commas: 12345 → 12,345. */
function group(int: string): string {
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * A decimal string (no sign, no exponent) cut to at most `maxDecimals`
 * fractional digits, trailing zeros removed. Amounts below the smallest
 * printable step stay visible instead of collapsing to 0: "< 0.000001" when
 * rounding down or to nearest, the step itself when rounding up.
 * Anything that isn't a plain decimal is returned unchanged.
 */
export function formatDecimal(value: string, opts: { maxDecimals?: number; round?: Rounding; grouping?: boolean } = {}): string {
  const maxDecimals = opts.maxDecimals ?? 6;
  const round = opts.round ?? "nearest";
  const grouping = opts.grouping ?? true;
  const m = DECIMAL.exec(value.trim());
  if (!m) return value;
  const int = m[1].replace(/^0+(?=\d)/, "");
  const frac = m[2] ?? "";

  if (frac.length <= maxDecimals) {
    const f = frac.replace(/0+$/, "");
    return `${grouping ? group(int) : int}${f ? `.${f}` : ""}`;
  }

  const kept = frac.slice(0, maxDecimals);
  const rest = frac.slice(maxDecimals);
  const restNonZero = /[1-9]/.test(rest);
  const bumpUp = round === "up" ? restNonZero : round === "nearest" ? rest[0] >= "5" : false;

  // Scaled integer arithmetic on the kept digits: int.kept as one BigInt.
  let scaled = BigInt(int + kept);
  if (bumpUp) scaled += 1n;
  if (scaled === 0n) {
    const step = `0.${"0".repeat(Math.max(0, maxDecimals - 1))}1`;
    return round === "up" ? step : `< ${step}`;
  }
  const digits = scaled.toString().padStart(maxDecimals + 1, "0");
  const outInt = digits.slice(0, digits.length - maxDecimals);
  const outFrac = digits.slice(digits.length - maxDecimals).replace(/0+$/, "");
  return `${grouping ? group(outInt) : outInt}${outFrac ? `.${outFrac}` : ""}`;
}

/** Every number inside a piece of text ("0.10025062656641604 MON",
 *  "12.5 USDC + 0.0021 MON gas") cut the same way. Words are left alone. */
export function formatAmountText(text: string, opts: { maxDecimals?: number; round?: Rounding } = {}): string {
  return text.replace(/\d+\.\d+|\d{4,}/g, (n) => formatDecimal(n, opts));
}

/** How a review/receipt row should round, from its label. */
export function roundingForLabel(label: string): Rounding {
  const l = label.toLowerCase();
  if (/receive|received|at least|minimum|get\b/.test(l)) return "down";
  if (/pay|total|fee|cost|spend|from your balance/.test(l)) return "up";
  return "nearest";
}
