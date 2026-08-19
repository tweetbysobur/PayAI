import { describe, it, expect } from "vitest";
import { parseEther, parseUnits } from "viem";
import { hasErc20TransferTo, isNativeTransferTo, normalizeDecimalString, toBaseUnits, toParseableAmount, TRANSFER_TOPIC, type ReceiptLog } from "@/lib/monad/verify";

const USDC = "0x2919eAbbef3A56d9975821031e2C2764BBB085da";
const RECIPIENT = "0xA7286aC0b5b9070C248D4CAFa8c068940e6C659D";
const OTHER = "0x1111111111111111111111111111111111111111";

// A well-formed ERC20 Transfer log: topic0 = Transfer, topic2 = padded `to`,
// data = amount as a 32-byte hex word.
function transferLog(token: string, to: string, amount: bigint): ReceiptLog {
  return {
    address: token,
    topics: [
      TRANSFER_TOPIC,
      `0x000000000000000000000000${"0".repeat(24)}`, // from (unused by matcher)
      `0x000000000000000000000000${to.slice(2).toLowerCase()}`,
    ],
    data: `0x${amount.toString(16).padStart(64, "0")}`,
  };
}

describe("toBaseUnits", () => {
  it("converts human amounts to base units", () => {
    expect(toBaseUnits(1, 6)).toBe(1_000_000n);
    expect(toBaseUnits(2.5, 6)).toBe(2_500_000n);
    expect(toBaseUnits(0.01, 6)).toBe(10_000n);
  });

  it("regression: an 18-decimal amount is exact, not float-mangled", () => {
    // This was BigInt(Math.round(amount * 10 ** decimals)). 10**18 is already
    // ~100x past Number.MAX_SAFE_INTEGER, so the multiply happened in floating
    // point: 1.1 came out as 1100000000000000128 wei, 999.999 was off by
    // 32768. The vault reserved funds with viem's exact parseUnits and
    // released them with this, so the release amount could land ABOVE the
    // reserved balance and trip INSUFFICIENT_RESERVED_FUNDS — a Reserved-Funds
    // automation for 1.1 MON refused to execute at all.
    expect(BigInt(Math.round(1.1 * 10 ** 18))).toBe(1_100_000_000_000_000_128n); // the old behavior
    expect(toBaseUnits(1.1, 18)).toBe(1_100_000_000_000_000_000n);
    expect(toBaseUnits(999.999, 18)).toBe(999_999_000_000_000_000_000n);
    expect(toBaseUnits(0.07, 18)).toBe(70_000_000_000_000_000n);
    expect(toBaseUnits(1234.5678, 18)).toBe(1_234_567_800_000_000_000_000n);
  });

  it("matches what the vault actually reserved, so a release can never exceed it", () => {
    // The deposit side (app/dashboard/automations) uses parseUnits on the same
    // amount. These two must agree exactly or the guard misfires.
    for (const amount of [1.1, 0.07, 12.34, 999.999, 1234.5678, 0.1]) {
      expect(toBaseUnits(amount, 18)).toBe(parseUnits(toParseableAmount(amount, 18), 18));
    }
  });

  it("agrees with viem's parseUnits across a fuzz sweep, including rounding past the token's precision", () => {
    // toBaseUnits is hand-rolled string arithmetic because lib/monad/verify.ts
    // is deliberately dependency-free (see its file header). This is what pins
    // that hand-rolled version to the real thing.
    let checked = 0;
    for (const decimals of [0, 2, 6, 8, 18]) {
      for (let i = 0; i < 400; i++) {
        const amount = Math.random() * 10 ** (i % 7);
        expect(toBaseUnits(amount, decimals)).toBe(parseUnits(toParseableAmount(amount, decimals), decimals));
        checked++;
      }
    }
    expect(checked).toBe(2000);
  });

  it("handles zero, integers and negatives", () => {
    expect(toBaseUnits(0, 18)).toBe(0n);
    expect(toBaseUnits(5, 18)).toBe(5_000_000_000_000_000_000n);
    expect(toBaseUnits(-1.1, 18)).toBe(-1_100_000_000_000_000_000n);
  });

  it("rounds half up past the token's precision, exactly as parseUnits does", () => {
    expect(toBaseUnits(1.5, 0)).toBe(2n);
    expect(toBaseUnits(1.4, 0)).toBe(1n);
    expect(toBaseUnits(1.1234565, 6)).toBe(1_123_457n);
  });
});

describe("toParseableAmount", () => {
  it("regression: a sub-1e-6 amount that String()/.toString() would render in exponential notation now parses cleanly", () => {
    // This is the exact failure the audit found: String(0.0000001) is
    // "1e-7", and viem's parseEther/parseUnits reject that outright with
    // "not a valid decimal number." toParseableAmount is the fix at every
    // parseEther(amount.toString())-shaped call site in the codebase.
    expect(String(0.0000001)).toBe("1e-7"); // documents the bug this guards against
    expect(() => parseEther(toParseableAmount(0.0000001, 18))).not.toThrow();
    expect(parseEther(toParseableAmount(0.0000001, 18))).toBe(100_000_000_000n);
  });

  it("round-trips a normal amount exactly", () => {
    expect(parseEther(toParseableAmount(1.5, 18))).toBe(parseEther("1.5"));
    expect(parseUnits(toParseableAmount(10, 6), 6)).toBe(parseUnits("10", 6));
  });

  it("passes through extra precision rather than throwing on it — parseUnits rounds what the token can't hold", () => {
    expect(() => parseUnits(toParseableAmount(1.123456789, 6), 6)).not.toThrow();
    expect(parseUnits(toParseableAmount(1.123456789, 6), 6)).toBe(1_123_457n);
  });

  it("regression: no longer smuggles float noise into an 18-decimal amount", () => {
    // toFixed(18) prints the float's true binary value, not the decimal the
    // user meant, so it attached junk wei to every ordinary amount:
    expect((1.1).toFixed(18)).toBe("1.100000000000000089"); // documents the bug
    // The plain string representation is well-formed here, so it is used as-is.
    expect(toParseableAmount(1.1, 18)).toBe("1.1");
    expect(parseEther(toParseableAmount(1.1, 18))).toBe(1_100_000_000_000_000_000n);
    expect(parseEther(toParseableAmount(999.999, 18))).toBe(999_999_000_000_000_000_000n);
  });

  it("still falls back to toFixed for the exponential case it exists to fix", () => {
    expect(toParseableAmount(0.0000001, 18)).not.toMatch(/e/i);
    expect(parseEther(toParseableAmount(0.0000001, 18))).toBe(100_000_000_000n);
  });
});

describe("normalizeDecimalString", () => {
  it("passes an already-well-formed decimal string through untouched, preserving full precision", () => {
    expect(normalizeDecimalString("1.123456789012345678", 18)).toBe("1.123456789012345678");
    expect(normalizeDecimalString("1.5", 18)).toBe("1.5");
  });

  it("regression: reformats a String(tinyNumber)-produced exponential string so parseUnits/parseEther no longer throw", () => {
    const asExponential = String(0.0000001); // "1e-7" — what a naive .toString() call upstream would have produced
    expect(() => parseEther(asExponential)).toThrow();
    expect(() => parseEther(normalizeDecimalString(asExponential, 18))).not.toThrow();
    expect(parseEther(normalizeDecimalString(asExponential, 18))).toBe(100_000_000_000n);
  });

  it("leaves a non-numeric or malformed string alone rather than silently swallowing it", () => {
    expect(normalizeDecimalString("not-a-number", 18)).toBe("not-a-number");
  });
});

describe("hasErc20TransferTo", () => {
  const wanted = toBaseUnits(10, 6); // 10 USDC

  it("accepts an exact-amount transfer to the recipient", () => {
    expect(hasErc20TransferTo([transferLog(USDC, RECIPIENT, wanted)], USDC, RECIPIENT, wanted)).toBe(true);
  });

  it("accepts an overpayment (>= wanted)", () => {
    expect(hasErc20TransferTo([transferLog(USDC, RECIPIENT, wanted + 1n)], USDC, RECIPIENT, wanted)).toBe(true);
  });

  it("rejects an underpayment", () => {
    expect(hasErc20TransferTo([transferLog(USDC, RECIPIENT, wanted - 1n)], USDC, RECIPIENT, wanted)).toBe(false);
  });

  it("rejects the wrong token contract", () => {
    expect(hasErc20TransferTo([transferLog(OTHER, RECIPIENT, wanted)], USDC, RECIPIENT, wanted)).toBe(false);
  });

  it("rejects a transfer to a different recipient", () => {
    expect(hasErc20TransferTo([transferLog(USDC, OTHER, wanted)], USDC, RECIPIENT, wanted)).toBe(false);
  });

  it("rejects a non-Transfer log (wrong topic)", () => {
    const log = transferLog(USDC, RECIPIENT, wanted);
    log.topics[0] = "0xdeadbeef";
    expect(hasErc20TransferTo([log], USDC, RECIPIENT, wanted)).toBe(false);
  });

  it("is case-insensitive on addresses", () => {
    expect(hasErc20TransferTo([transferLog(USDC.toLowerCase(), RECIPIENT.toLowerCase(), wanted)], USDC.toUpperCase().replace("0X", "0x"), RECIPIENT, wanted)).toBe(true);
  });

  it("finds the matching log among several", () => {
    const logs = [transferLog(OTHER, RECIPIENT, wanted), transferLog(USDC, OTHER, wanted), transferLog(USDC, RECIPIENT, wanted)];
    expect(hasErc20TransferTo(logs, USDC, RECIPIENT, wanted)).toBe(true);
  });

  it("returns false for no logs", () => {
    expect(hasErc20TransferTo([], USDC, RECIPIENT, wanted)).toBe(false);
  });
});

describe("isNativeTransferTo", () => {
  const wanted = 5_000_000_000_000_000_000n; // 5 MON in wei

  it("accepts an exact native transfer to the recipient", () => {
    expect(isNativeTransferTo({ to: RECIPIENT, value: wanted }, RECIPIENT, wanted)).toBe(true);
  });

  it("accepts an overpayment", () => {
    expect(isNativeTransferTo({ to: RECIPIENT, value: wanted + 1n }, RECIPIENT, wanted)).toBe(true);
  });

  it("rejects an underpayment", () => {
    expect(isNativeTransferTo({ to: RECIPIENT, value: wanted - 1n }, RECIPIENT, wanted)).toBe(false);
  });

  it("rejects a transfer to a different recipient", () => {
    expect(isNativeTransferTo({ to: OTHER, value: wanted }, RECIPIENT, wanted)).toBe(false);
  });

  it("rejects a contract-creation tx (no `to`)", () => {
    expect(isNativeTransferTo({ to: null, value: wanted }, RECIPIENT, wanted)).toBe(false);
  });
});
