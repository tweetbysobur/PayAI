import { describe, it, expect, beforeEach, vi } from "vitest";
import { detectRoomAction } from "@/lib/ask/intent/roomIntent";
import { understand, ROOMS_REMOVED_REPLY } from "@/lib/ask/intent/classify";
import { respondToUnderstanding } from "@/lib/ask/intent/orchestrate";

/**
 * Rooms were removed from PayAI. Room requests are still recognised
 * deterministically (never by the model), but only so Ask can answer them
 * plainly: nothing is prepared, no card, no plan, no operation.
 */

vi.mock("@/lib/wallet-service/WalletServiceContext", () => ({ useWalletService: () => ({ address: null }) }));
beforeEach(() => { delete process.env.ANTHROPIC_API_KEY; });
const ID = "room_0123456789abcdef01234567";

describe("detectRoomAction", () => {
  const CASES: [string, string, string | null][] = [
    ["Create a room for 100 USDC for 5 people", "create", null],
    ["make a room for 20 USDC each for 4 friends to bob.nad", "create", null],
    ["a room for 50 MON for 2 people", "create", null],
    ["show my rooms", "list", null],
    ["what rooms am I in?", "list", null],
    ["list rooms", "list", null],
    ["how is my room doing?", "status", null],
    [`status of ${ID}`, "status", ID],
    [`https://app.usepayai.xyz/dashboard/rooms/${ID}`, "status", ID],
    [`join ${ID}`, "join", ID],
    ["join the room", "join", null],
    [`pay my share in ${ID}`, "contribute", ID],
    ["pay my share", "contribute", null],
    ["contribute to the dinner room", "contribute", null],
  ];
  for (const [text, action, id] of CASES) {
    it(`"${text}" → ${action}${id ? " (id as written)" : ", no id"}`, () => {
      expect(detectRoomAction(text)).toEqual({ action, roomId: id });
    });
  }

  it("ordinary requests aren't rooms", () => {
    for (const t of ["send 10 USDC to bob.nad", "swap 5 MON to USDC", "split 30 USDC between alice.nad and bob.nad", "show my transactions", "what's my balance"]) {
      expect(detectRoomAction(t), t).toBeNull();
    }
  });

  it("an id is only ever the one written — never derived or guessed", () => {
    expect(detectRoomAction("join the room room_short")).toEqual({ action: "join", roomId: null });
    expect(detectRoomAction("pay my share in the team lunch room")?.roomId).toBeNull();
  });
});

describe("understand() → rooms were removed: one plain answer, nothing prepared", () => {
  for (const text of [
    "Create a room for 100 USDC for 5 people and send the link",
    "create a room for 100 USDC for 5 people, closes in 3 days",
    `join ${ID}`,
    "pay my share",
  ]) {
    it(`"${text}" is declined, not split, scheduled or compounded`, async () => {
      expect(await understand(text, [], null)).toEqual({
        kind: "unsupported", outcome: "unsupported", capability: "rooms_removed", reply: ROOMS_REMOVED_REPLY,
      });
    });
  }

  it("the reply prepares nothing — no room, no operation, no plan", async () => {
    const u = await understand("create a room for 100 USDC for 5 people", [], null);
    const { message } = await respondToUnderstanding(u, "0x1111111111111111111111111111111111111111");
    expect(message.room).toBeUndefined();
    expect(message.operation).toBeUndefined();
    expect(message.plan).toBeUndefined();
    expect(message.content).toBe(ROOMS_REMOVED_REPLY);
  });
});

describe("the model can never emit a room action", () => {
  it("room is excluded from the classifier's allowed kinds (like protocol_action)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../lib/ask/intent/classify.ts", import.meta.url), "utf8");
    const block = src.slice(src.indexOf("const CLASSIFY_KINDS"), src.indexOf("const CLASSIFY_KINDS") + 300);
    expect(block).toContain('.filter((k) => k !== "room")');
  });
});
