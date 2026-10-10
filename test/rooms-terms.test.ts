import { describe, it, expect } from "vitest";
import { deriveStatus, fixedSplit, parseRoomRequest, cleanMemo, expiryFrom, MAX_PARTICIPANTS } from "@/lib/rooms/terms";

/** PayAI Rooms — pure terms (lib/rooms/terms.ts). Spec §5, §6, §16. */

const USDC = { symbol: "USDC", decimals: 6 };
const MON = { symbol: "MON", decimals: 18 };

describe("parseRoomRequest — deterministic, one amount, one group size", () => {
  it("total, people, and the defaults", () => {
    expect(parseRoomRequest("Create a room for 100 USDC for 5 people")).toEqual({
      ok: true, request: { symbol: "USDC", amount: "100", per: "total", participants: 5, recipient: null, expiryDays: 7 },
    });
  });

  it("each share, a named recipient and an expiry", () => {
    const r = parseRoomRequest("collect 20 USDC each from 4 friends, paid to bob.nad, closes in 3 days");
    expect(r).toEqual({ ok: true, request: { symbol: "USDC", amount: "20", per: "each", participants: 4, recipient: "bob.nad", expiryDays: 3 } });
  });

  it("MON and a 0x recipient", () => {
    const r = parseRoomRequest("room for 2.5 MON for 2 people to 0x1111111111111111111111111111111111111111");
    expect(r).toMatchObject({ ok: true, request: { symbol: "MON", amount: "2.5", participants: 2, recipient: "0x1111111111111111111111111111111111111111" } });
  });

  it("any named recipient is kept for the resolver to accept or refuse — never dropped (\"to nobody\" used to pay the creator)", () => {
    expect(parseRoomRequest("100 USDC for 5 people to nobody")).toMatchObject({ ok: true, request: { recipient: "nobody" } });
    expect(parseRoomRequest("100 USDC for 5 people, goes to alice")).toMatchObject({ ok: true, request: { recipient: "alice" } });
    expect(parseRoomRequest("up to 5 people pay 100 USDC")).toMatchObject({ ok: true, request: { recipient: null } });
  });

  it("A-USDC is read as AUSDC (the service refuses it — verified rooms aren't available)", () => {
    expect(parseRoomRequest("room for 100 A-USDC for 5 people")).toMatchObject({ ok: true, request: { symbol: "AUSDC" } });
  });

  const REFUSED: [string, RegExp][] = [
    ["", /Describe the room/],
    ["a room for 5 people", /How much/],
    ["a room for 100 USDC", /How many people/],
    ["100 USDC and 50 MON for 5 people", /more than one amount/],
    ["100 USDC for 5 people or 6 people", /more than one group size/],
    ["100 USDC for 1 person", /How many people|2 to 20/],
    ["100 USDC for 1 people", /2 to 20/],
    [`100 USDC for ${MAX_PARTICIPANTS + 1} people`, /2 to 20/],
    ["100 USDC for 5 people in 45 days", /1 to 30 days/],
    ["weighted room for 100 USDC for 5 people", /weighted/],
    ["stream 100 USDC for 5 people", /Streaming/],
    ["escrow 100 USDC for 5 people and refund if it fails", /no escrow/],
  ];
  for (const [text, msg] of REFUSED) {
    it(`refuses ${JSON.stringify(text)}`, () => {
      const r = parseRoomRequest(text);
      expect(r.ok).toBe(false);
      expect((r as { message: string }).message).toMatch(msg);
    });
  }
});

describe("fixedSplit — exact at the token's decimals, never rounded silently", () => {
  it("100 USDC between 5 → 20 each, exact base units", () => {
    expect(fixedSplit("100", "total", 5, USDC)).toEqual({ ok: true, totalUnits: 100_000_000n, shareUnits: 20_000_000n, total: "100", share: "20" });
  });

  it("each-share mode multiplies exactly", () => {
    expect(fixedSplit("2.5", "each", 4, MON)).toMatchObject({ ok: true, share: "2.5", total: "10", shareUnits: 2_500_000_000_000_000_000n });
  });

  it("100 USDC between 3 doesn't divide at 6 decimals — refused with exact alternatives", () => {
    const r = fixedSplit("100", "total", 3, USDC);
    expect(r.ok).toBe(false);
    const m = (r as { message: string }).message;
    expect(m).toMatch(/doesn't split exactly between 3 people/);
    expect(m).toMatch(/33\.33 each \(99\.99 total\)/);
    expect(m).toMatch(/33\.34 each \(100\.02 total\)/);
    // The suggested totals really do split exactly.
    expect(fixedSplit("99.99", "total", 3, USDC).ok).toBe(true);
    expect(fixedSplit("100.02", "total", 3, USDC).ok).toBe(true);
  });

  it("refuses zero, negative-looking, malformed and over-precise amounts", () => {
    for (const a of ["0", "-1", "1e3", "1,000", "abc", ""]) expect(fixedSplit(a, "total", 2, USDC).ok, a).toBe(false);
    expect(fixedSplit("1.0000001", "total", 2, USDC)).toMatchObject({ ok: false, message: expect.stringMatching(/6 decimal places/) });
  });

  it("the smallest unit can't be split", () => {
    expect(fixedSplit("0.000001", "total", 2, USDC).ok).toBe(false);
    expect(fixedSplit("0.000002", "total", 2, USDC)).toMatchObject({ ok: true, shareUnits: 1n });
  });

  it("a participant count out of range is refused even when called directly", () => {
    expect(fixedSplit("10", "total", 1, USDC).ok).toBe(false);
    expect(fixedSplit("10", "total", 21, USDC).ok).toBe(false);
    expect(fixedSplit("10", "total", 2.5, USDC).ok).toBe(false);
  });
});

describe("deriveStatus — forward-only, derived from facts", () => {
  const room = { cancelledAt: null, expiresAt: 1_000, target: 3 };

  it("open → completed when the target-th share lands before expiry", () => {
    expect(deriveStatus(room, [10, 20], 30)).toEqual({ status: "open", completedAt: null });
    expect(deriveStatus(room, [10, 20, 30], 40)).toEqual({ status: "completed", completedAt: 30 });
  });

  it("expired without the target; a late share doesn't complete it", () => {
    expect(deriveStatus(room, [10, 20], 1_000)).toMatchObject({ status: "expired" });
    expect(deriveStatus(room, [10, 20, 1_500], 2_000)).toMatchObject({ status: "expired" });
  });

  it("completed stays completed after the expiry passes", () => {
    expect(deriveStatus(room, [10, 20, 30], 5_000)).toEqual({ status: "completed", completedAt: 30 });
  });

  it("cancelled wins", () => {
    expect(deriveStatus({ ...room, cancelledAt: 50 }, [], 60)).toEqual({ status: "cancelled", completedAt: null });
  });

  it("order of confirmations doesn't matter", () => {
    expect(deriveStatus(room, [30, 10, 20], 40)).toEqual({ status: "completed", completedAt: 30 });
  });
});

describe("memo and expiry", () => {
  it("memo: trimmed, control characters removed, capped", () => {
    expect(cleanMemo("  Team\u0007 dinner  ")).toBe("Team dinner");
    expect(cleanMemo("x".repeat(200))).toHaveLength(80);
    expect(cleanMemo(42)).toBeNull();
    expect(cleanMemo("   ")).toBeNull();
  });
  it("expiry is whole days from creation", () => expect(expiryFrom(0, 7)).toBe(7 * 86_400_000));
});
