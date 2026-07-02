import { describe, it, expect } from "vitest";
import {
  amountError,
  recipientError,
  addressError,
  isValidAmount,
  isValidRecipient,
  isValidAddress,
} from "@/lib/validation";

const ADDR = "0x1234567890abcdef1234567890abcdef12345678";

describe("amountError", () => {
  it("accepts empty input (no error until submit)", () => {
    expect(amountError("")).toBeNull();
    expect(amountError("   ")).toBeNull();
  });
  it("rejects non-numeric input", () => {
    expect(amountError("abc")).toMatch(/valid amount/i);
    expect(amountError("1.2.3")).toMatch(/valid amount/i);
  });
  it("rejects zero and negatives", () => {
    expect(amountError("0")).toMatch(/greater than 0/i);
  });
  it("accepts valid decimals", () => {
    expect(amountError("10")).toBeNull();
    expect(amountError("0.5")).toBeNull();
  });
});

describe("recipientError", () => {
  it("accepts a 0x address", () => {
    expect(recipientError(ADDR)).toBeNull();
  });
  it("accepts a .nad / .nads domain", () => {
    expect(recipientError("alex.nads")).toBeNull();
    expect(recipientError("bob.nad")).toBeNull();
  });
  it("rejects gibberish", () => {
    expect(recipientError("not a wallet")).toMatch(/wallet address/i);
  });
});

describe("addressError (strict)", () => {
  it("accepts a valid address", () => {
    expect(addressError(ADDR)).toBeNull();
  });
  it("rejects a domain (strict address only)", () => {
    expect(addressError("alex.nads")).toMatch(/valid wallet address/i);
  });
  it("rejects a truncated address", () => {
    expect(addressError("0x1234")).toMatch(/valid wallet address/i);
  });
});

describe("boolean helpers", () => {
  it("isValidAmount", () => {
    expect(isValidAmount("5")).toBe(true);
    expect(isValidAmount("0")).toBe(false);
    expect(isValidAmount("x")).toBe(false);
  });
  it("isValidRecipient", () => {
    expect(isValidRecipient(ADDR)).toBe(true);
    expect(isValidRecipient("alex.nads")).toBe(true);
    expect(isValidRecipient("nope")).toBe(false);
  });
  it("isValidAddress", () => {
    expect(isValidAddress(ADDR)).toBe(true);
    expect(isValidAddress("alex.nads")).toBe(false);
  });
});
