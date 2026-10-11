import { describe, expect, it } from "vitest";
import { routeRequest } from "@/lib/ask/intent/classify";
import { detectCompoundRequest } from "@/lib/ask/intent/compound";

/**
 * A request naming two recipients must never become a payment to ONE of them.
 * These wordings used to come back from the key-free path as a complete
 * single send to the first recipient — the second was dropped without a word.
 */
const A = "0x5e0d39b4c1a2f3e4d5c6b7a8f9e0d1c2b3a4f5e6";

describe("several recipients are refused, never silently reduced to one", () => {
  it.each([
    "pay alice.nad and bob.nad 5 usdc each",
    "pay alice.nad and bob.nad 5 usdc",
    "send alice.nad and bob.nad 5 usdc each",
    "send 5 usdc to alice.nad & bob.nad",
    "send 5 usdc to alice.nad bob.nad",
    `send 5 usdc to alice.nad and ${A}`,
    "can you pay alice.nad and bob.nad 5 usdc each?",
    "pay alice.nad, bob.nad and carol.nad 5 usdc",
    "send 5 usdc to alice.nad, bob.nad",
  ])("%s", async (t) => {
    const u = detectCompoundRequest(t);
    expect(u).toMatchObject({ outcome: "unsupported", capability: "multiple_recipients" });
    expect((u as { reply: string }).reply).toMatch(/Nothing was prepared/);
    // And the router hands it to that answer, not to a payment preview or the model.
    const r = await routeRequest(t, null);
    expect(r.anthropic).toBe(false);
    expect(r.understanding).toMatchObject({ outcome: "unsupported", capability: "multiple_recipients" });
  });
});

describe("single-recipient requests are unaffected", () => {
  it.each([
    "send 5 usdc to alice.nad",
    "pay alice.nad 5 usdc",
    "send 5 usdc to bob.nad for coffee and snacks",
    "send 5 usdc to bob.nad & thanks",
    `send 5 usdc to ${A}`,
    "send 10 USDC to alice.nad",
  ])("%s", (t) => {
    expect(detectCompoundRequest(t)).toBeNull();
  });
  it("two fully written transfers are still two actions (the plan path's), not 'multiple recipients'", () => {
    expect(detectCompoundRequest("send 1 MON to alice.nad and 2 MON to bob.nad")).toMatchObject({ capability: "compound_request" });
  });
});
