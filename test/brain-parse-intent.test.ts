import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * parseIntent()'s skipLLM option — the second half of the double-Anthropic-
 * call fix. Ask PayAI's own dispatch functions (see
 * lib/ask/sendPayment/orchestrator.ts) send text they've already run through
 * a real Anthropic classification once (classify.ts); without skipLLM,
 * /api/agent's own parseIntent() would spend a SECOND Anthropic call
 * refining that already-precise, machine-generated text for no benefit.
 */

type CreateFn = (...args: unknown[]) => unknown;
let mockCreate: ReturnType<typeof vi.fn<CreateFn>>;

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function AnthropicMock() {
    return { messages: { create: (...args: unknown[]) => mockCreate(...args) } };
  }),
}));

const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY;

describe("parseIntent — skipLLM option", () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockCreate = vi.fn<CreateFn>();
    vi.resetModules();
  });
  afterEach(() => {
    process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY;
  });

  it("skipLLM:true never calls Anthropic even though a key is configured", async () => {
    const { parseIntent } = await import("@/lib/agent/brain");
    const { intent, source } = await parseIntent("Send 50 USDC to 0x1234567890abcdef1234567890abcdef12345678", { skipLLM: true });
    expect(mockCreate).not.toHaveBeenCalled();
    expect(source).toBe("deterministic");
    expect(intent.amount).toBe(50);
    expect(intent.token).toBe("USDC");
  });

  it("without skipLLM (the general command-bar / raw-text path), a configured key still triggers the real refinement call", async () => {
    mockCreate.mockResolvedValue({
      content: [{
        type: "tool_use", id: "t1", name: "submit_intent",
        input: { action: "send_payment", amount: 50, token: "USDC", recipient: "0x1234567890abcdef1234567890abcdef12345678", purpose: null, network: "monad", confidence: 0.99 },
      }],
    });
    const { parseIntent } = await import("@/lib/agent/brain");
    const { source } = await parseIntent("send 50 usdc to 0x1234567890abcdef1234567890abcdef12345678");
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(source).toBe("llm");
  });
});
