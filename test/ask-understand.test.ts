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
    await understand("20", [{ role: "user", content: "I want to swap some USDC." }, { role: "assistant", content: "How much USDC would you like to swap, and what token would you like to receive?" }], pending);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const call = mockCreate.mock.calls[0][0] as { system: string; messages: { content: string }[]; tool_choice: unknown };
    expect(call.system).toMatch(/never invent or assume/i);
    expect(call.system).toMatch(/never execute anything/i);
    const userContent = call.messages[0].content as string;
    expect(userContent).toContain("Pending intent");
    expect(userContent).toContain("swap");
    expect(userContent).toContain("How much USDC would you like to swap");
    expect(userContent).toContain('New message: "20"');
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

  it("recognizes a balance check", async () => {
    const { understand } = await import("@/lib/ask/intent/classify");
    const u = await understand("what's my balance", [], null);
    expect(u).toEqual({ kind: "check_balance", outcome: "complete", slots: expect.any(Object) });
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
});
