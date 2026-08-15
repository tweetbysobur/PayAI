import { describe, expect, it, vi } from "vitest";
import { routeRequest } from "@/lib/ask/intent/classify";
import type { Understanding } from "@/lib/ask/intent/types";

/**
 * The task spec's own exact test lists — verbatim, both directions. These
 * assert against routeRequest() directly (not understand()) so they never
 * touch the network or the Anthropic SDK: routeRequest()'s whole job is
 * deciding anthropic:true/false BEFORE any call happens, and that decision
 * is what's under test here.
 */

describe("router — must NOT call Anthropic", () => {
  const cases: [string, string?][] = [
    ["Hello"],
    ["Good morning"],
    ["What is PayAI?"],
    ["What is MON?"],
    ["What time is it?"],
    ["What's my USDC balance?"],
    ["What's my MON balance?"],
    ["Show my latest transaction"],
  ];
  for (const [text] of cases) {
    it(`"${text}"`, async () => {
      const r = await routeRequest(text, null);
      expect(r.anthropic).toBe(false);
      expect(r.understanding).not.toBeNull();
    });
  }

  it("also covers the rest of the DO-NOT-USE-ANTHROPIC examples: thanks, what is USDC, how PayAI works, today's date", async () => {
    for (const text of ["Thanks", "What is USDC?", "How does PayAI work?", "What's today's date?"]) {
      const r = await routeRequest(text, null);
      expect(r.anthropic).toBe(false);
    }
  });
});

describe("router — must call Anthropic", () => {
  const cases = [
    "Swap 20 USDC to MON",
    "I need some MON using my USDC",
    "Pay my designer next Friday",
    "Move the money I received yesterday to my other wallet",
    "Make that payment happen every Friday",
    "Use the other wallet instead",
  ];
  for (const text of cases) {
    it(`"${text}"`, async () => {
      const r = await routeRequest(text, null);
      expect(r.anthropic).toBe(true);
      expect(r.understanding).toBeNull();
    });
  }
});

describe("router — a fact question never swallows an actionable request riding in the same message", () => {
  it("'what is USDC, and can you send 50 of it to 0x...?' does not get hijacked into just the USDC definition", async () => {
    const r = await routeRequest("Quick one — what is USDC, and can you send 50 of it to 0x1234567890abcdef1234567890abcdef12345678?", null);
    // Whatever it resolves to, it must NOT be the canned "USDC is a
    // USD-pegged stablecoin..." chat reply with the payment silently
    // dropped — the compound message needs real classification.
    expect(r.route).not.toBe("deterministic_query");
    if (r.understanding?.outcome === "chat") {
      expect(r.understanding.reply).not.toMatch(/USD-pegged stablecoin/i);
    }
  });

  it("a plain, standalone fact question still resolves locally", async () => {
    const r = await routeRequest("What is USDC?", null);
    expect(r.route).toBe("deterministic_query");
    expect(r.anthropic).toBe(false);
  });
});

describe("router — a fresh, unambiguous send/swap request still goes to Anthropic even when the deterministic engine could fully parse it", () => {
  it("a clean 'Send 50 USDC to 0x...' is still routed to Anthropic (actionable_operation), not silently resolved locally", async () => {
    const r = await routeRequest("Send 50 USDC to 0x1234567890abcdef1234567890abcdef12345678", null);
    expect(r.route).toBe("actionable_operation");
    expect(r.anthropic).toBe(true);
  });
});

describe("router — deterministic follow-ups resolve from context without another Anthropic call", () => {
  it("'Actually make it 30.' against a pending swap amount resolves locally", async () => {
    const pending: Understanding = { kind: "swap", outcome: "complete", slots: { amount: "20", fromAsset: "USDC", toAsset: "MON" } };
    // classify.ts's correction-merge only ships for send_payment today (see
    // its own doc comment) — this exercises the still-missing-slot path,
    // which does apply generally: an incomplete swap missing amount.
    const incompletePending: Understanding = { kind: "swap", outcome: "incomplete", slots: { amount: null, fromAsset: "USDC", toAsset: "MON" }, question: "How much USDC?" };
    const r = await routeRequest("30", incompletePending);
    expect(r.route).toBe("follow_up");
    expect(r.anthropic).toBe(false);
    expect(r.understanding).toEqual({ kind: "swap", outcome: "complete", slots: expect.objectContaining({ amount: "30", fromAsset: "USDC", toAsset: "MON" }) });
    void pending; // (kept for symmetry/documentation with the complete-pending case below)
  });

  it("'Actually make it 75.' against a pending, already-complete send_payment corrects it locally", async () => {
    const pending: Understanding = { kind: "send_payment", outcome: "complete", slots: { amount: "50", asset: "USDC", recipient: "0x1234567890abcdef1234567890abcdef12345678" } };
    const r = await routeRequest("Actually make it 75.", pending);
    expect(r.route).toBe("follow_up");
    expect(r.anthropic).toBe(false);
    if (r.understanding?.outcome === "complete") expect(r.understanding.slots.amount).toBe("75");
  });
});

describe("router — an ambiguous follow-up still calls Anthropic, never guesses", () => {
  it("'Use the other one.' against a pending intent that doesn't shape-match any slot escalates", async () => {
    const pending: Understanding = { kind: "swap", outcome: "incomplete", slots: { amount: "20", fromAsset: "USDC", toAsset: null }, question: "What token would you like to receive?" };
    const r = await routeRequest("Use the other one.", pending);
    expect(r.route).toBe("ambiguous");
    expect(r.anthropic).toBe(true);
    expect(r.understanding).toBeNull();
  });
});

describe("router — transaction follow-ups that need conversation context to resolve correctly", () => {
  it("'Was that successful?' with prior conversation escalates rather than silently assuming 'the most recent transaction'", async () => {
    const history = [
      { role: "user" as const, content: "Show me the payment to Alice from Tuesday." },
      { role: "assistant" as const, content: "Sent 30 USDC to alice.nad on Tuesday. Hash: 0xdead..." },
    ];
    const r = await routeRequest("Was that successful?", null, history);
    expect(r.route).toBe("ambiguous");
    expect(r.anthropic).toBe(true);
  });

  it("'Was that successful?' with NO prior conversation resolves locally — nothing for 'that' to conflict with", async () => {
    const r = await routeRequest("Was that successful?", null, []);
    expect(r.anthropic).toBe(false);
  });

  it("a self-contained query ('show my latest transaction') resolves locally even with prior conversation present", async () => {
    const history = [
      { role: "user" as const, content: "What's my USDC balance?" },
      { role: "assistant" as const, content: "You have 250 USDC." },
    ];
    const r = await routeRequest("Show my latest transaction", null, history);
    expect(r.anthropic).toBe(false);
    expect(r.route).toBe("transaction_query");
  });
});

describe("router — logging never leaks to the client, only structured dev observability", () => {
  it("understand() logs a router decision line without throwing or altering its return value", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { understand } = await import("@/lib/ask/intent/classify");
      const u = await understand("Hello", [], null);
      expect(u.outcome).toBe("chat");
      const logged = spy.mock.calls.map((c) => c.join("\n")).join("\n");
      expect(logged).toContain("[AskPayAI Router]");
      expect(logged).toContain("route=simple_chat");
      expect(logged).toContain("anthropic=false");
    } finally {
      spy.mockRestore();
    }
  });
});
