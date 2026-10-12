import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { understandWithScheduling as understand } from "@/lib/ask/intent/classify";
import { analyzeCompound, detectCompoundRequest } from "@/lib/ask/intent/compound";
import { analyzePlanRequest } from "@/lib/ask/planFastPath";

/**
 * Several actions in one request, on Ask's SINGLE-intent path.
 *
 * Several exactly-written actions are the plan path's (test/plan-multi-action
 * and test/plan-long pin that: one plan, one review, one approval, in order,
 * never twice). This file pins what happens when a compound request reaches
 * the single-intent path instead — because the plan path refused it (an
 * unknown payee name, a vague amount, an unsupported action) or no wallet is
 * connected. The audit found that path keeping ONE action and silently
 * dropping the rest:
 *   "Send 10 USDC to Alice, then send 20 USDC to Bob."        → a send to Alice only
 *   "Send 10 USDC to alice.nad, then swap 5 MON for USDC."    → the swap only
 *   "Transfer 10 to Bob and buy the token."                   → the buy only
 *   "Send 10 USDC to alice.nad and schedule 5 USDC to bob.nad every Friday"
 *                                                             → ONE weekly 10 USDC to alice.nad
 * Now a compound request is answered plainly and nothing is prepared.
 */

beforeEach(() => { delete process.env.ANTHROPIC_API_KEY; });

describe("compound requests are never reduced to one action", () => {
  const COMPOUND: [string, string, number][] = [
    ["Send 10 USDC to Alice, then send 20 USDC to Bob.", "compound_request", 2],
    ["Send 10 USDC to alice.nad, then swap 5 MON for USDC.", "compound_request", 2],
    ["Send 10 USDC to alice.nad then swap 5 MON for USDC then send 1 MON to bob.nad", "compound_request", 3],
    ["send 10 usdc to alice.nad and 20 usdc to bob.nad", "compound_request", 2],
    ["Send some USDC to Alice and swap some MON.", "compound_request", 2],
    ["Transfer 10 to Bob and buy the token.", "compound_request", 2],
    ["Send 10 MON and 5 USDC to bob.nad", "compound_request", 2],
    ["Swap 10 MON to USDC; send 5 USDC to bob.nad", "compound_request", 2],
    ["Send 10 USDC to alice.nad and schedule 5 USDC to bob.nad every Friday", "compound_schedule", 2],
  ];
  for (const [text, capability, n] of COMPOUND) {
    it(`"${text}" → ${capability} (${n} actions); nothing prepared`, async () => {
      const u = await understand(text, [], null);
      expect(u).toMatchObject({ kind: "unsupported", outcome: "unsupported", capability });
      const reply = (u as { reply: string }).reply;
      expect(reply).toMatch(new RegExp(`That's ${n} actions`));
      expect(reply).toMatch(/Nothing was prepared/);
    });
  }

  it("the reply shows how to write a request the plan path takes, and that example really is one", async () => {
    const reply = (detectCompoundRequest("Send 10 USDC to Alice, then send 20 USDC to Bob") as { reply: string }).reply;
    const example = reply.match(/"([^"]+)"/)![1];
    expect(analyzePlanRequest(example)).toMatchObject({ kind: "multi", actions: 2 });
  });
});

describe("several recipients for one action are asked about, not guessed", () => {
  for (const text of ["Pay Alice and Bob.", "Send 10 USDC to alice.nad and bob.nad", "pay alice.nad, bob.nad and carol.nad"]) {
    it(`"${text}" → multiple_recipients; nothing prepared`, async () => {
      const u = await understand(text, [], null);
      expect(u).toMatchObject({ kind: "unsupported", capability: "multiple_recipients" });
      expect((u as { reply: string }).reply).toMatch(/more than one recipient/);
    });
  }
});

describe("single requests are untouched", () => {
  const SINGLE = [
    "Send 10 USDC to alice.nad",
    "Swap 10 MON to USDC",
    "Pay bob.nad 20 USDC every Monday",
    "Send 5 USDC to bob.nad for coffee and snacks",
    "Send 10 USDC to alice.nad and let me know when it's done",
    "send 2.5 MON to 0x1111111111111111111111111111111111111111",
    "What did I send and receive this week?",
  ];
  for (const text of SINGLE) {
    it(`"${text}" → not compound`, () => expect(analyzeCompound(text)).toBeNull());
  }

  it("a split stays a split (its own deterministic path runs first)", async () => {
    const u = await understand("Split 30 USDC between alice.nad, bob.nad and carol.nad", [], null);
    expect(u.kind).not.toBe("unsupported");
  });

  it("an ordinary send still completes", async () => {
    expect(await understand("Send 10 USDC to alice.nad", [], null)).toMatchObject({ kind: "send_payment", outcome: "complete" });
  });
});

describe("Ask's plan fast path never falls back to the single-intent path for several actions", () => {
  const src = readFileSync(new URL("../lib/ask/useAskChat.ts", import.meta.url), "utf8");
  const planTurn = readFileSync(new URL("../lib/ask/planTurn.ts", import.meta.url), "utf8");

  it("a multi-action (or swap-then-send) request the Plan API refused ends with the refusal — no understanding call", () => {
    const branch = src.slice(src.indexOf("timing.mark(\"fallback\")"), src.indexOf("setThinkingLabel(guessThinkingLabel"));
    expect(branch).toMatch(/t\.planKind === "multi" \|\| t\.planKind === "swap_send"/);
    expect(branch).toMatch(/Nothing was planned/);
    expect(branch).toMatch(/return;/);
  });

  it("a 400 refusal (e.g. a recipient the server couldn't resolve) carries its reason too, not only a 422", () => {
    expect(planTurn).toMatch(/r\.status === 422 \|\| r\.status === 400 \? replyError\(r\)/);
  });
});
