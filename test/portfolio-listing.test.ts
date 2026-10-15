import { describe, it, expect } from "vitest";
import { isListed, looksLikeSpam, formatBalance, type Holding } from "@/lib/hooks/usePortfolio";

const h = (o: Partial<Holding>): Holding => ({
  address: "0x350035555E10d9AfAF1566AaebfCeD5BA6C27777", symbol: "CHOG", name: "Chog",
  decimals: 18, logoURI: null, verified: false, balance: 1000, valueUsd: 1.5, ...o,
} as Holding);
const NONE = { base: false, bought: false };

describe("which tokens the wallet lists", () => {
  it("a held memecoin with a market price is listed", () => {
    expect(isListed(h({}), NONE)).toBe(true);
  });
  it("a held memecoin with no price is listed only when bought through PayAI", () => {
    expect(isListed(h({ valueUsd: null }), NONE)).toBe(false);
    expect(isListed(h({ valueUsd: null }), { base: false, bought: true })).toBe(true);
  });
  it("a memecoin sold to zero, or with an unreadable balance, leaves the list", () => {
    expect(isListed(h({ balance: 0 }), { base: false, bought: true })).toBe(false);
    expect(isListed(h({ balance: null }), { base: false, bought: true })).toBe(false);
  });
  it("a verified token stays while its balance is unknown, and leaves at zero", () => {
    expect(isListed(h({ verified: true, balance: null }), NONE)).toBe(true);
    expect(isListed(h({ verified: true, balance: 0 }), NONE)).toBe(false);
  });
  it("MON and USDC are always listed", () => {
    expect(isListed(h({ balance: 0, valueUsd: null }), { base: true, bought: false })).toBe(true);
  });
  it("a phishing airdrop is never listed, even with a price", () => {
    expect(isListed(h({ symbol: "Visit claim-monad.xyz", name: "x" }), { base: false, bought: true })).toBe(false);
  });
});

describe("looksLikeSpam", () => {
  it("catches links, domains and bait words", () => {
    for (const name of ["https://x.io", "www.free", "t.me/drop", "claim-mon.com", "Claim reward", "Free AIRDROP", "voucher"]) {
      expect(looksLikeSpam({ symbol: "X", name }), name).toBe(true);
    }
    expect(looksLikeSpam({ symbol: "A".repeat(17), name: "ok" })).toBe(true);
  });
  it("leaves ordinary coin names alone", () => {
    for (const [symbol, name] of [["CHOG", "Chog"], ["MOYAKI", "Moyaki"], ["USDC", "USD Coin"], ["gMON", "Magma Staked MON"]]) {
      expect(looksLikeSpam({ symbol, name }), symbol).toBe(false);
    }
  });
});

describe("formatBalance", () => {
  it("compacts large memecoin balances and keeps small ones readable", () => {
    expect(formatBalance(null)).toBe("—");
    expect(formatBalance(0)).toBe("0");
    expect(formatBalance(12_450_000)).toBe("12.45M");
    expect(formatBalance(1234.5678)).toBe("1,234.57");
    expect(formatBalance(1.23456)).toBe("1.2346");
    expect(formatBalance(0.000123456)).toBe("0.0001235");
    expect(formatBalance(0.0000001)).toBe("1.00e-7");
  });
});
