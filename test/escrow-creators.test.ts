import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { escrowCreatorAllowed } from "@/lib/rooms/escrowService";

describe("PAYAI_ROOM_ESCROW_CREATORS private test", () => {
  afterEach(() => { delete process.env.PAYAI_ROOM_ESCROW_CREATORS; });
  it("unset lets every wallet create", () => {
    expect(escrowCreatorAllowed("0x1111111111111111111111111111111111111111")).toBe(true);
  });
  it("set lets only listed wallets create, case-insensitively", () => {
    process.env.PAYAI_ROOM_ESCROW_CREATORS = " 0x25b84164461FE6EA4dAB470460D0c4eb7c7Fdc3a , ";
    expect(escrowCreatorAllowed("0x25b84164461fe6ea4dab470460d0c4eb7c7fdc3a")).toBe(true);
    expect(escrowCreatorAllowed("0x1111111111111111111111111111111111111111")).toBe(false);
  });
});
