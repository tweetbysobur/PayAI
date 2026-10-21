import { describe, expect, it } from "vitest";
import { composeRoomRequest, parseRoomRequest } from "@/lib/rooms/terms";

describe("composeRoomRequest round-trips through parseRoomRequest", () => {
  const cases = [
    { amount: "100", symbol: "USDC", per: "total" as const, participants: 5, recipient: "bob.nad", expiryDays: 7 },
    { amount: "0.5", symbol: "USDC", per: "each" as const, participants: 2, recipient: "", expiryDays: 1 },
    { amount: "3", symbol: "MON", per: "each" as const, participants: 20, recipient: "0x25b84164461FE6EA4dAB470460D0c4eb7c7Fdc3a", expiryDays: 30 },
  ];
  for (const c of cases) {
    it(composeRoomRequest(c), () => {
      const r = parseRoomRequest(composeRoomRequest(c));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.request).toEqual({ symbol: c.symbol, amount: c.amount, per: c.per, participants: c.participants, recipient: c.recipient || null, expiryDays: c.expiryDays });
    });
  }
});
