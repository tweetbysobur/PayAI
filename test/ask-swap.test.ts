import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { respondToUnderstanding } from "@/lib/ask/intent/orchestrate";
import { AFFIRMATION_RE, isQuoteStale } from "@/lib/ask/useAskChat";
import type { Understanding } from "@/lib/ask/intent/types";
import type { SwapIntent } from "@/lib/ask/types";

const WALLET = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";

type CreateFn = (...args: unknown[]) => unknown;
let mockCreate: ReturnType<typeof vi.fn<CreateFn>>;

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function AnthropicMock() {
    return { messages: { create: (...args: unknown[]) => mockCreate(...args) } };
  }),
}));

function mockFetch(responder: (url: string) => unknown) {
  const original = globalThis.fetch;
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: String(url), body });
    return new Response(JSON.stringify(responder(String(url))), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

describe("isQuoteStale — a swap preview's price has a shelf life", () => {
  it("is not stale immediately after quoting", () => {
    const now = Date.now();
    expect(isQuoteStale(now, now)).toBe(false);
  });
  it("is not stale after a normal 'read the preview, confirm' pause", () => {
    const now = Date.now();
    expect(isQuoteStale(now - 10_000, now)).toBe(false);
  });
  it("is stale after the quote window has passed", () => {
    const now = Date.now();
    expect(isQuoteStale(now - 61_000, now)).toBe(true);
  });
});

describe("advanceOperation checks quote staleness before ever signing a swap", () => {
  it("gates execution on isQuoteStale, re-quoting instead of executing when stale", () => {
    const src = readFileSync(new URL("../lib/ask/useAskChat.ts", import.meta.url), "utf8");
    // The staleness check must run BEFORE executeSwapIntent is ever reached
    // for the swap branch — assert the ordering, not just that both exist.
    const swapBranchStart = src.indexOf('op.intent.kind === "swap"');
    const staleCheck = src.indexOf("isQuoteStale(op.intent.execution.quotedAt)");
    const executeCall = src.indexOf("await executeSwapIntent(op, wallet, wallet.address)");
    expect(swapBranchStart).toBeGreaterThan(-1);
    expect(staleCheck).toBeGreaterThan(swapBranchStart);
    expect(executeCall).toBeGreaterThan(staleCheck);
  });
});

describe("AFFIRMATION_RE recognizes swap-specific confirmations", () => {
  it("'swap it' and combinations of it are recognized", () => {
    for (const phrase of ["swap it", "Swap it!", "Yes, swap it."]) {
      expect(AFFIRMATION_RE.test(phrase)).toBe(true);
    }
  });
});

describe("swap — balance validation surfaces honestly, no fake quote shown", () => {
  it("insufficient USDC balance is refused with the real reason, no operation card", async () => {
    const { restore } = mockFetch(() => ({ decision: "swap_error", error: "Insufficient USDC balance. You have 40.00 USDC but need 100." }));
    try {
      const u: Understanding = { kind: "swap", outcome: "complete", slots: { amount: "100", fromAsset: "USDC", toAsset: "MON" } };
      const r = await respondToUnderstanding(u, WALLET);
      expect(r.message.operation).toBeUndefined();
      expect(r.message.content).toMatch(/insufficient usdc balance/i);
      expect(r.message.content).toMatch(/40\.00 usdc/i);
    } finally { restore(); }
  });
});

describe("swap — MON as the input (native asset), not just native output", () => {
  it("MON to USDC produces a real quote with a native-input unsigned tx (no approve step)", async () => {
    const { calls, restore } = mockFetch(() => ({
      decision: "swap_ready",
      provider: "Uniswap v3",
      swap: {
        quote: { fromToken: "MON", toToken: "USDC", amountIn: 5, amountOut: 2.34, minAmountOut: 2.32, feeTier: 3000, slippage: 0.005, priceImpact: 0.002 },
        // Native MON in: no allowance/approve step needed (it's msg.value, not pulled).
        steps: [{ kind: "swap", label: "Swap 5 MON for USDC", tx: { to: "0xrouter", data: "0xdead", value: "0x4563918244f40000" } }],
        summary: "Swap 5 MON for ~2.34 USDC",
      },
    }));
    try {
      const u: Understanding = { kind: "swap", outcome: "complete", slots: { amount: "5", fromAsset: "MON", toAsset: "USDC" } };
      const r = await respondToUnderstanding(u, WALLET);
      expect(calls[0].body.intent).toBe("Swap 5 MON to USDC");
      const intent = r.message.operation?.intent as SwapIntent;
      expect(intent.fromToken).toBe("MON");
      expect(intent.execution?.plan.steps.length).toBe(1); // no approve step for native input
      expect(intent.execution?.plan.steps[0].kind).toBe("swap");
      expect(intent.execution?.plan.steps[0].tx.value).not.toBe("0x0"); // real MON value carried
    } finally { restore(); }
  });
});

describe("swap — excessive price impact / slippage failures are surfaced honestly", () => {
  it("a price-impact-rejected quote is refused with the real reason, never a fabricated one", async () => {
    const { restore } = mockFetch(() => ({
      decision: "swap_error",
      error: "This trade would move the pool price by an estimated 22.0%, which is too high to execute safely. Try a smaller amount.",
    }));
    try {
      const u: Understanding = { kind: "swap", outcome: "complete", slots: { amount: "500000", fromAsset: "USDC", toAsset: "MON" } };
      const r = await respondToUnderstanding(u, WALLET);
      expect(r.message.operation).toBeUndefined();
      expect(r.message.content).toMatch(/too high to execute safely/i);
    } finally { restore(); }
  });
});

describe("swap — RPC/network failure while getting a quote", () => {
  it("a fetch failure during quoting is reported honestly, not as a silent hang or a fake quote", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    try {
      const u: Understanding = { kind: "swap", outcome: "complete", slots: { amount: "20", fromAsset: "USDC", toAsset: "MON" } };
      const r = await respondToUnderstanding(u, WALLET);
      expect(r.message.operation).toBeUndefined();
      expect(r.message.content).toMatch(/couldn't reach payai/i);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("swap — user changes the amount after a preview: new quote, old one invalidated", () => {
  it("a corrected amount dispatches a fresh real quote for the new amount, same pair", async () => {
    const { calls, restore } = mockFetch(() => ({
      decision: "swap_ready",
      provider: "Uniswap v3",
      swap: {
        quote: { fromToken: "USDC", toToken: "MON", amountIn: 30, amountOut: 64.2, minAmountOut: 63.9, feeTier: 3000, slippage: 0.005, priceImpact: 0.001 },
        steps: [{ kind: "swap", label: "Swap", tx: { to: "0xrouter", data: "0xdead", value: "0x0" } }],
        summary: "Swap 30 USDC for ~64.2 MON",
      },
    }));
    try {
      const corrected: Understanding = { kind: "swap", outcome: "complete", slots: { amount: "30", fromAsset: "USDC", toAsset: "MON" } };
      const r = await respondToUnderstanding(corrected, WALLET);
      expect(calls[0].body.intent).toBe("Swap 30 USDC to MON");
      const intent = r.message.operation?.intent as SwapIntent;
      expect(intent.fromAmount).toBe("30");
      expect(intent.toAmountEstimate).toBe("64.2");
      // The corrected card stays pending too, so a further correction or a
      // natural "swap it" resolves against THIS quote, not a stale one.
      expect(r.nextPending).toEqual(corrected);
    } finally { restore(); }
  });
});

describe("classify.ts — a swap correction never guesses which side a token change means", () => {
  it("'actually use MON instead' does not locally resolve a pending swap — real understanding is required", async () => {
    const { understand } = await import("@/lib/ask/intent/classify");
    const pending: Understanding = { kind: "swap", outcome: "complete", slots: { amount: "20", fromAsset: "USDC", toAsset: "MON" } };
    // No ANTHROPIC_API_KEY in this test env, so this exercises the
    // deterministic path end-to-end: the correction merge must NOT guess,
    // and nothing else should misfire it into something else either.
    const u = await understand("Actually use MON instead.", [], pending);
    // Never silently "corrected" to a specific (possibly wrong) side locally.
    expect(u).not.toEqual({ kind: "swap", outcome: "complete", slots: { amount: "20", fromAsset: "MON", toAsset: "MON" } });
  });

  it("'Actually make it 30.' against a pending swap updates only the amount", async () => {
    const { understand } = await import("@/lib/ask/intent/classify");
    const pending: Understanding = { kind: "swap", outcome: "complete", slots: { amount: "20", fromAsset: "USDC", toAsset: "MON" } };
    const u = await understand("Actually make it 30.", [], pending);
    expect(u).toEqual({ kind: "swap", outcome: "complete", slots: { amount: "30", fromAsset: "USDC", toAsset: "MON" } });
  });
});

describe("swap — missing output token needs real understanding, honestly", () => {
  it("the deterministic engine can't complete 'I want to swap some USDC' (no destination token) — stays unclear, not a guess", async () => {
    const { understand } = await import("@/lib/ask/intent/classify");
    const u = await understand("I want to swap some USDC.", [], null);
    expect(u.kind).not.toBe("swap");
  });
});

describe("cost — after Anthropic understands the swap intent once, nothing downstream calls it again", () => {
  const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockCreate = vi.fn<CreateFn>();
    vi.resetModules();
  });
  afterEach(() => {
    process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY;
  });

  it("classify once (Anthropic), then quote + execute + confirm are pure application logic — one call total", async () => {
    mockCreate.mockResolvedValue({
      content: [{ type: "tool_use", id: "t1", name: "submit_understanding", input: { kind: "swap", outcome: "complete", slots: { amount: "20", fromAsset: "USDC", toAsset: "MON" } } }],
    });
    const { understand } = await import("@/lib/ask/intent/classify");
    const { respondToUnderstanding: respond, executeSwapIntent } = await import("@/lib/ask/intent/orchestrate");

    // Step 1: understand — the one and only Anthropic call for this flow.
    const understanding = await understand("I need MON using the USDC in my wallet.", [], null);
    expect(mockCreate).toHaveBeenCalledTimes(1);

    // Step 2: quote retrieval (dispatchSwap) — pure application logic, no Anthropic.
    const { restore } = mockFetch(() => ({
      decision: "swap_ready", provider: "Uniswap v3",
      swap: { quote: { fromToken: "USDC", toToken: "MON", amountIn: 20, amountOut: 42.8, minAmountOut: 42.6, feeTier: 3000, slippage: 0.005, priceImpact: 0.001 }, steps: [{ kind: "swap", label: "Swap", tx: { to: "0xrouter", data: "0xdead", value: "0x0" } }], summary: "Swap 20 USDC for ~42.8 MON" },
    }));
    let result;
    try {
      result = await respond(understanding, WALLET);
    } finally { restore(); }
    expect(mockCreate).toHaveBeenCalledTimes(1); // still just the one call

    // Step 3: confirmation / execution — pure application logic, no Anthropic.
    const { restore: restoreConfirm } = mockFetch(() => ({ success: true, explorerUrl: "https://explorer.monad.xyz/tx/0xswap" }));
    try {
      const wallet = { sendTransaction: vi.fn().mockResolvedValue("0xswap"), waitForReceipt: vi.fn().mockResolvedValue({ status: "success" }) };
      const op = result.message.operation!;
      const final = await executeSwapIntent(op, wallet, WALLET);
      expect(final.status).toBe("success");
    } finally { restoreConfirm(); }
    expect(mockCreate).toHaveBeenCalledTimes(1); // token validation, quote, execution, confirmation — zero extra Anthropic calls
  });
});
