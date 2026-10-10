import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { detectRoomAction } from "@/lib/ask/intent/roomIntent";
import { understand } from "@/lib/ask/intent/classify";
import { respondToUnderstanding } from "@/lib/ask/intent/orchestrate";

/**
 * Rooms through Ask PayAI. Room requests are detected deterministically
 * (never by the model), become a room card in the chat, and every change goes
 * through the Rooms API behind an explicit button — paying a share is the
 * existing plan card. No room id, amount or recipient comes from the text.
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

describe("understand() → a room understanding, before split / compound / timing", () => {
  it("\"create a room for 100 USDC for 5 people\" is one room, not a split or a compound request", async () => {
    const u = await understand("Create a room for 100 USDC for 5 people and send the link", [], null);
    expect(u).toMatchObject({ kind: "room", outcome: "complete", slots: { roomAction: "create", roomId: null } });
    expect((u as { slots: { roomText: string } }).slots.roomText).toBe("Create a room for 100 USDC for 5 people and send the link");
  });

  it("a room with an expiry isn't mistaken for a schedule", async () => {
    expect(await understand("create a room for 100 USDC for 5 people, closes in 3 days", [], null)).toMatchObject({ kind: "room" });
  });

  it("join / pay / status keep only a written id", async () => {
    expect(await understand(`join ${ID}`, [], null)).toMatchObject({ kind: "room", slots: { roomAction: "join", roomId: ID } });
    expect(await understand("pay my share", [], null)).toMatchObject({ kind: "room", slots: { roomAction: "contribute", roomId: null } });
  });
});

describe("respondToUnderstanding → a room card, never an operation", () => {
  it("carries the request only; no operation, no plan, nothing executed", async () => {
    const { message, nextPending } = await respondToUnderstanding(
      { kind: "room", outcome: "complete", slots: { roomAction: "contribute", roomId: ID, roomText: null } }, "0x1111111111111111111111111111111111111111");
    expect(message.room).toEqual({ action: "contribute", roomId: ID, text: null });
    expect(message.operation).toBeUndefined();
    expect(message.plan).toBeUndefined();
    expect(message.content).toMatch(/review it/);
    expect(nextPending).toBeNull();
  });
});

describe("the room card", () => {
  const src = readFileSync(new URL("../components/ask/RoomAskCard.tsx", import.meta.url), "utf8");

  it("never signs or sends; a share is paid only through the existing plan card", () => {
    expect(src).not.toMatch(/sendTransaction|waitForReceipt|createPlanRunner|op:\s*["'](quote|bind|tx|settle)["']/);
    expect(src).toMatch(/<PlanCard planRef=\{\{ planId, kind: "transfer" \}\} \/>/);
    expect(src).toMatch(/payShare\(/);
  });

  it("every change is an explicit button: Create room, Join room, Prepare my payment, Confirm payment", () => {
    for (const b of ["Create room", "Join room", "Prepare my payment", "Confirm payment"]) expect(src).toContain(b);
  });

  it("without an id it asks — the user's own rooms to choose from, or the link to join one", () => {
    expect(src).toMatch(/Paste the room&apos;s link or its id/);
    expect(src).toMatch(/<RoomList onPick=\{setId\}/);
  });

  it("says rooms are open, unescrowed and carry PayAI's fee", () => {
    expect(src).toMatch(/aren&apos;t identity-verified/);
    expect(src).toMatch(/no escrow/);
    expect(src).toMatch(/fee added on top/);
  });

  it("a locked wallet sees only a prompt to unlock (no request is made)", async () => {
    const { RoomAskCard } = await import("@/components/ask/RoomAskCard");
    const html = renderToStaticMarkup(createElement(RoomAskCard, { room: { action: "list", roomId: null, text: null }, messageId: "m1" }));
    expect(html).toMatch(/Unlock your wallet to use Rooms/);
  });
});

describe("the model can never emit a room action", () => {
  it("room is excluded from the classifier's allowed kinds (like protocol_action)", () => {
    const src = readFileSync(new URL("../lib/ask/intent/classify.ts", import.meta.url), "utf8");
    const block = src.slice(src.indexOf("const CLASSIFY_KINDS"), src.indexOf("const CLASSIFY_KINDS") + 300);
    expect(block).toContain('.filter((k) => k !== "room")');
  });
});
