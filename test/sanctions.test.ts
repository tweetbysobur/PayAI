import { describe, it, expect, beforeAll } from "vitest";

// Exercises the synchronous address screen against the env denylist. The remote
// OFAC-list fetch (ensureSanctionsLoaded) is deliberately NOT called here — it's
// network-dependent; the sync check is what the money path relies on.

const SANCTIONED = "0x8589427373d6d84e98730d7795d8f6f8731fda16";
const CLEAN = "0x1111111111111111111111111111111111111111";

beforeAll(() => {
  process.env.PAYAI_ADDRESS_DENYLIST = SANCTIONED;
});

describe("isSanctionedAddress", () => {
  it("flags an address on the denylist (case-insensitive)", async () => {
    const { isSanctionedAddress } = await import("@/lib/payment/sanctions");
    expect(isSanctionedAddress(SANCTIONED)).toBe(true);
    expect(isSanctionedAddress(` ${SANCTIONED.toUpperCase().replace("0X", "0x")} `)).toBe(true);
  });

  it("clears a normal address", async () => {
    const { isSanctionedAddress } = await import("@/lib/payment/sanctions");
    expect(isSanctionedAddress(CLEAN)).toBe(false);
  });

  it("ignores non-addresses (names, empty)", async () => {
    const { isSanctionedAddress } = await import("@/lib/payment/sanctions");
    expect(isSanctionedAddress("test.nads")).toBe(false);
    expect(isSanctionedAddress("")).toBe(false);
  });
});
