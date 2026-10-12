import { describe, it, expect } from "vitest";
import { formatDecimal, formatAmountText, roundingForLabel } from "@/lib/format/tokenAmount";

describe("formatDecimal", () => {
  it("cuts a grossed-up fee total to 6 decimals, rounding up so it never understates", () => {
    expect(formatDecimal("0.10025062656641604", { round: "up" })).toBe("0.100251");
  });
  it("rounds down for amounts received", () => {
    expect(formatDecimal("0.10025062656641604", { round: "down" })).toBe("0.10025");
  });
  it("rounds to nearest by default", () => {
    expect(formatDecimal("1.2345675")).toBe("1.234568");
    expect(formatDecimal("1.2345674")).toBe("1.234567");
  });
  it("carries across the decimal point", () => {
    expect(formatDecimal("0.9999999", { round: "up" })).toBe("1");
    expect(formatDecimal("9.9999999")).toBe("10");
  });
  it("leaves short amounts alone and trims trailing zeros", () => {
    expect(formatDecimal("0.1")).toBe("0.1");
    expect(formatDecimal("5.500000")).toBe("5.5");
    expect(formatDecimal("20")).toBe("20");
  });
  it("groups thousands", () => {
    expect(formatDecimal("1234567.5")).toBe("1,234,567.5");
    expect(formatDecimal("1234567.5", { grouping: false })).toBe("1234567.5");
  });
  it("never collapses a real amount to 0", () => {
    expect(formatDecimal("0.0000000001", { round: "up" })).toBe("0.000001");
    expect(formatDecimal("0.0000000001")).toBe("< 0.000001");
    expect(formatDecimal("0.0000000001", { round: "down" })).toBe("< 0.000001");
  });
  it("returns anything that isn't a plain decimal unchanged", () => {
    expect(formatDecimal("—")).toBe("—");
    expect(formatDecimal("1e-7")).toBe("1e-7");
  });
});

describe("formatAmountText", () => {
  it("formats the numbers in a sentence and keeps the words", () => {
    expect(formatAmountText("0.10025062656641604 MON", { round: "up" })).toBe("0.100251 MON");
    expect(formatAmountText("12.5 USDC + 0.00210000001 MON gas", { round: "up" })).toBe("12.5 USDC + 0.002101 MON gas");
  });
  it("does not touch a percentage or short number", () => {
    expect(formatAmountText("0.25%")).toBe("0.25%");
  });
});

describe("roundingForLabel", () => {
  it("rounds what you pay up and what you get down", () => {
    expect(roundingForLabel("You pay")).toBe("up");
    expect(roundingForLabel("Total cost")).toBe("up");
    expect(roundingForLabel("PayAI fee")).toBe("up");
    expect(roundingForLabel("Recipient receives")).toBe("down");
    expect(roundingForLabel("At least")).toBe("down");
    expect(roundingForLabel("You receive")).toBe("down");
    expect(roundingForLabel("Price impact")).toBe("nearest");
  });
});
