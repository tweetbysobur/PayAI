import { afterEach, describe, expect, it } from "vitest";
import { roomsAllowed, roomsOpenToAll } from "@/lib/rooms/access";

const TESTER = "0x25b84164461FE6EA4dAB470460D0c4eb7c7Fdc3a";
const OTHER = "0x1111111111111111111111111111111111111111";

describe("Rooms tester list", () => {
  afterEach(() => { delete process.env.PAYAI_ROOM_ESCROW_CREATORS; });
  it("unset: Rooms is open to everyone, signed in or not", () => {
    expect(roomsOpenToAll()).toBe(true);
    expect(roomsAllowed(OTHER)).toBe(true);
    expect(roomsAllowed(null)).toBe(true);
  });
  it("set: only listed wallets; signed-out viewers are refused", () => {
    process.env.PAYAI_ROOM_ESCROW_CREATORS = `${TESTER}, 0x2222222222222222222222222222222222222222`;
    expect(roomsOpenToAll()).toBe(false);
    expect(roomsAllowed(TESTER.toLowerCase())).toBe(true);
    expect(roomsAllowed("0x2222222222222222222222222222222222222222")).toBe(true);
    expect(roomsAllowed(OTHER)).toBe(false);
    expect(roomsAllowed(null)).toBe(false);
  });
});
