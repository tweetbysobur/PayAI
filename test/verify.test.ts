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

  it("truncates to the token's own decimal precision rather than throwing on extra digits", () => {
    expect(() => parseUnits(toParseableAmount(1.123456789, 6), 6)).not.toThrow();
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
