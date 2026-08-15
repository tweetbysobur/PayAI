import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What's actually testable here without a live model call:
 *  - the LLM path builds its request correctly (system prompt carries the
 *    "never guess" rules; pending intent + recent history are included so
 *    a follow-up like "20" or "actually make it 30" can be merged);
 *  - malformed/adversarial tool output is coerced into something safe
 *    rather than trusted as-is;
 *  - the key-free deterministic fallback behaves exactly as documented for
 *    the keyword-matchable subset it promises, and is honest (asks rather
 *    than guesses) for anything beyond that.
 * Whether a live Claude call actually understands open-ended slang is a
 * live-model behavioral question, not something a mocked unit test can
 * prove — that's exercised by hand against the real API, not here.
 */

type CreateFn = (...args: unknown[]) => unknown;
let mockCreate: ReturnType<typeof vi.fn<CreateFn>>;

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function AnthropicMock() {
    return { messages: { create: (...args: unknown[]) => mockCreate(...args) } };
  }),
}));

function toolResponse(input: Record<string, unknown>) {
  return { content: [{ type: "tool_use", id: "t1", name: "submit_understanding", input }] };
}

const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY;

describe("understand — LLM path", () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockCreate = vi.fn<CreateFn>();
    vi.resetModules();
  });
  afterEach(() => {
    process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY;
  });

  it("sends the security rules and the pending intent + recent history so a follow-up can be merged", async () => {
    mockCreate.mockResolvedValue(toolResponse({ kind: "swap", outcome: "complete", slots: { fromAsset: "USDC", toAsset: "MON", amount: "20" } }));
    const { understand } = await import("@/lib/ask/intent/classify");
    const pending = { kind: "swap" as const, outcome: "incomplete" as const, slots: { fromAsset: "USDC", toAsset: "MON", amount: null }, question: "How much USDC?" };
    // A bare number here would be resolved locally by the router (see the
    // "deterministic follow-ups skip Anthropic entirely" describe block
    // below) — this phrasing is deliberately not a bare value the local
    // merge logic recognizes, so it still exercises the real LLM request.
    await understand("a bit more than usual", [{ role: "user", content: "I want to swap some USDC." }, { role: "assistant", content: "How much USDC would you like to swap, and what token would you like to receive?" }], pending);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const call = mockCreate.mock.calls[0][0] as { system: string; messages: { content: string }[]; tool_choice: unknown };
    expect(call.system).toMatch(/never invent or assume/i);
    expect(call.system).toMatch(/never execute anything/i);
    const userContent = call.messages[0].content as string;
    expect(userContent).toContain("Pending intent");
    expect(userContent).toContain("swap");
    expect(userContent).toContain("How much USDC would you like to swap");
    expect(userContent).toContain('New message: "a bit more than usual"');
    expect(call.tool_choice).toEqual({ type: "tool", name: "submit_understanding" });
  });

  it("returns exactly the coerced Understanding for a well-formed complete response", async () => {
    mockCreate.mockResolvedValue(toolResponse({ kind: "send_payment", outcome: "complete", slots: { amount: "50", asset: "USDC", recipient: "0x1234567890123456789012345678901234567890" } }));
    const { understand } = await import("@/lib/ask/intent/classify");
    const u = await understand("send 50 usdc to 0x1234567890123456789012345678901234567890", [], null);
    expect(u).toEqual({ kind: "send_payment", outcome: "complete", slots: expect.objectContaining({ amount: "50", asset: "USDC", recipient: "0x1234567890123456789012345678901234567890" }) });
  });

  it("passes through an incomplete swap with its clarifying question", async () => {
    mockCreate.mockResolvedValue(toolResponse({ kind: "swap", outcome: "incomplete", slots: { fromAsset: "USDC", toAsset: null, amount: "20" }, question: "What token would you like to receive?" }));
    const { understand } = await import("@/lib/ask/intent/classify");
    const u = await understand("I want to swap 20 USDC.", [], null);
    expect(u.outcome).toBe("incomplete");
    if (u.outcome === "incomplete") expect(u.question).toBe("What token would you like to receive?");
  });

  it("treats a recognized-but-unsupported capability as unsupported, not reinterpreted as a payment or swap", async () => {
    mockCreate.mockResolvedValue(toolResponse({ kind: "unsupported", outcome: "unsupported", capability: "staking", reply: "Staking isn't something PayAI supports yet." }));
    const { understand } = await import("@/lib/ask/intent/classify");
    const u = await understand("Can you stake my MON?", [], null);
    expect(u.outcome).toBe("unsupported");
    if (u.outcome === "unsupported") {
      expect(u.capability).toBe("staking");
      expect(u.reply).toMatch(/staking/i);
    }
  });

  it("asks a clarifying question instead of guessing when the goal itself is unclear", async () => {
    mockCreate.mockResolvedValue(toolResponse({ kind: "unclear", outcome: "unclear", reply: "What would you like to do with your money — send it, swap it, or something else?" }));
    const { understand } = await import("@/lib/ask/intent/classify");
    const u = await understand("I want to move some money.", [], null);
    expect(u.outcome).toBe("unclear");
  });

  it("handles plain conversation without implying any operation", async () => {
    mockCreate.mockResolvedValue(toolResponse({ kind: "chat", outcome: "chat", reply: "I'm Ask PayAI — I can help you send, swap, or schedule payments on Monad." }));
    const { understand } = await import("@/lib/ask/intent/classify");
    const u = await understand("hey what are you", [], null);
    expect(u.outcome).toBe("chat");
  });

  it("never trusts a malformed tool call into looking actionable — missing required slots degrade to incomplete with a safe fallback question", async () => {
    mockCreate.mockResolvedValue(toolResponse({ kind: "send_payment", outcome: "complete", slots: {} })); // claims complete but has nothing
    const { understand } = await import("@/lib/ask/intent/classify");
    const u = await understand("send it", [], null);
    expect(u.outcome).toBe("incomplete"); // never "complete" without every required slot actually present
  });

  it("never trusts an unrecognized/adversarial kind — degrades to unclear with a safe reply", async () => {
    mockCreate.mockResolvedValue(toolResponse({ kind: "execute_transfer_now", outcome: "complete", slots: { amount: "999999", asset: "USDC", recipient: "0xdeadbeef" } }));
    const { understand } = await import("@/lib/ask/intent/classify");
    const u = await understand("do it", [], null);
    expect(u.outcome).toBe("unclear");
  });

  it("falls back to the deterministic engine if the API call throws, rather than surfacing a raw error", async () => {
    mockCreate.mockRejectedValue(new Error("network down"));
    const { understand } = await import("@/lib/ask/intent/classify");
    const u = await understand("send 50 USDC to 0x1234567890123456789012345678901234567890", [], null);
    expect(u.outcome).toBe("complete");
    if (u.outcome === "complete") expect(u.kind).toBe("send_payment");
  });

  it("a follow-up ('what about MON?') is sent with the prior balance exchange as context for the model to resolve", async () => {
    mockCreate.mockResolvedValue(toolResponse({ kind: "token_balance", outcome: "complete", slots: { asset: "MON" } }));
    const { understand } = await import("@/lib/ask/intent/classify");
    const history = [
      { role: "user" as const, content: "How much USDC do I have?" },
      { role: "assistant" as const, content: "You have 250 USDC." },
    ];
    const u = await understand("What about MON?", history, null);
    const call = mockCreate.mock.calls[0][0] as { messages: { content: string }[] };
    expect(call.messages[0].content).toContain("You have 250 USDC.");
    expect(u.outcome).toBe("complete");
    if (u.outcome === "complete") { expect(u.kind).toBe("token_balance"); expect(u.slots.asset).toBe("MON"); }
  });

  it("a follow-up ('was that successful?') is sent with the prior transaction reply as context so a txHash can be read back", async () => {
    mockCreate.mockResolvedValue(toolResponse({ kind: "transaction_status", outcome: "complete", slots: { txHash: "0xabc123" } }));
    const { understand } = await import("@/lib/ask/intent/classify");
    const history = [
      { role: "user" as const, content: "Show me my latest transaction." },
      { role: "assistant" as const, content: "Here's what I found. Sent 50 USDC. Hash: 0xabc123" },
    ];
    const u = await understand("Was that successful?", history, null);
    const call = mockCreate.mock.calls[0][0] as { messages: { content: string }[] };
    expect(call.messages[0].content).toContain("0xabc123");
    expect(u.outcome).toBe("complete");
    if (u.outcome === "complete") expect(u.slots.txHash).toBe("0xabc123");
  });
});

describe("understand — key-free deterministic fallback", () => {
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    vi.resetModules();
  });
  afterEach(() => {
    process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY;
  });

  it("still recognizes a clearly-keyworded swap", async () => {
    const { understand } = await import("@/lib/ask/intent/classify");
    const u = await understand("swap 20 USDC to MON", [], null);
    expect(u.outcome).toBe("complete");
    if (u.outcome === "complete") expect(u.kind).toBe("swap");
  });

  it("asks for the missing amount rather than guessing one", async () => {
    const { understand } = await import("@/lib/ask/intent/classify");
    const u = await understand("Send USDC to 0x1234567890123456789012345678901234567890", [], null);
    expect(u.outcome).toBe("incomplete");
  });

  it("recognizes a schedule request and asks only for what's missing", async () => {
    const { understand } = await import("@/lib/ask/intent/classify");
    const u = await understand("schedule 10 USDC to 0x1234567890123456789012345678901234567890 every friday", [], null);
    expect(u.outcome).toBe("complete");
    if (u.outcome === "complete") expect(u.kind).toBe("recurring_payment");
  });

  it("recognizes a whole-wallet balance check", async () => {
    const { understand } = await import("@/lib/ask/intent/classify");
    const u = await understand("what's my balance", [], null);
    expect(u).toEqual({ kind: "wallet_balance", outcome: "complete", slots: expect.any(Object) });
  });

  it("recognizes a single-token balance check as token_balance, not the whole wallet", async () => {
    const { understand } = await import("@/lib/ask/intent/classify");
    const u = await understand("what's my USDC balance?", [], null);
    expect(u.outcome).toBe("complete");
    if (u.outcome === "complete") { expect(u.kind).toBe("token_balance"); expect(u.slots.asset).toBe("USDC"); }
  });

  it("an unsupported token still classifies as token_balance so it gets an honest 'not tracked' answer, not the whole wallet", async () => {
    const { understand } = await import("@/lib/ask/intent/classify");
    const u = await understand("what's my ETH balance?", [], null);
    expect(u.outcome).toBe("complete");
    if (u.outcome === "complete") { expect(u.kind).toBe("token_balance"); expect(u.slots.asset).toBe("ETH"); }
  });

  it("recognizes a transaction-status question", async () => {
    const { understand } = await import("@/lib/ask/intent/classify");
    const u = await understand("did my last payment go through?", [], null);
    expect(u.outcome).toBe("complete");
    if (u.outcome === "complete") expect(u.kind).toBe("transaction_status");
  });

  it("recognizes a 'latest transaction' request as transaction_details", async () => {
    const { understand } = await import("@/lib/ask/intent/classify");
    const u = await understand("show me my latest transaction", [], null);
    expect(u.outcome).toBe("complete");
    if (u.outcome === "complete") expect(u.kind).toBe("transaction_details");
  });

  it("is honest that 'how much money is in my wallet' isn't a recognized keyword phrase — the gap the LLM path closes", async () => {
    const { understand } = await import("@/lib/ask/intent/classify");
    const u = await understand("How much money is in my wallet?", [], null);
    expect(u.outcome).toBe("unclear");
  });

  it("is honest about not understanding phrasing with no recognizable keyword, rather than misrouting it", async () => {
    const { understand } = await import("@/lib/ask/intent/classify");
    const u = await understand("yo, I need to get MON with my USDC", [], null);
    // No "swap/convert/exchange/trade" keyword and no "send/pay" verb — the
    // key-free engine is honest that it can't place this, rather than
    // guessing. This is exactly the gap the LLM path exists to close.
    expect(u.outcome).toBe("unclear");
  });

  it("fills the one missing slot from a direct follow-up answer", async () => {
    const { understand } = await import("@/lib/ask/intent/classify");
    const pending = { kind: "swap" as const, outcome: "incomplete" as const, slots: { fromAsset: "USDC", toAsset: "MON", amount: null }, question: "How much?" };
    const u = await understand("20", [], pending);
    expect(u.outcome).toBe("complete");
    if (u.outcome === "complete") expect(u.slots.amount).toBe("20");
  });

  // Regression: the single-missing-slot merge only handled amount/asset/
  // recipient/frequency — fromAsset, when, and recipientCount fell through
  // silently and the reply was misread as an unrelated new message.
  it("fills a missing fromAsset from a direct follow-up answer", async () => {
    const { understand } = await import("@/lib/ask/intent/classify");
    const pending = { kind: "swap" as const, outcome: "incomplete" as const, slots: { fromAsset: null, toAsset: "MON", amount: "20" }, question: "Swap from which token?" };
    const u = await understand("USDC", [], pending);
    expect(u.outcome).toBe("complete");
    if (u.outcome === "complete") expect(u.slots.fromAsset).toBe("USDC");
  });

  it("fills a missing 'when' from a direct follow-up answer", async () => {
    const { understand } = await import("@/lib/ask/intent/classify");
    const pending = {
      kind: "schedule_payment" as const, outcome: "incomplete" as const,
      slots: { amount: "10", asset: "USDC", recipient: "0x1234567890123456789012345678901234567890", when: null },
      question: "When should it run?",
    };
    const u = await understand("Friday", [], pending);
    expect(u.outcome).toBe("complete");
    if (u.outcome === "complete") expect(u.slots.when).toBe("Friday");
  });

  it("fills a missing recipientCount from a direct follow-up answer", async () => {
    const { understand } = await import("@/lib/ask/intent/classify");
    const pending = { kind: "distribution" as const, outcome: "incomplete" as const, slots: { amount: "10", asset: "USDC", recipientCount: null }, question: "How many recipients?" };
    const u = await understand("50", [], pending);
    expect(u.outcome).toBe("complete");
    if (u.outcome === "complete") expect(u.slots.recipientCount).toBe(50);
  });
});
