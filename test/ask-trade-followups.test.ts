import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findCurrentTokenAddress, findLastConfirmedTrade, PRICE_NOW_RE, SELL_JUST_BOUGHT_RE, TRADE_RESULT_RE } from "@/lib/ask/useAskChat";
import { respondToUnderstanding } from "@/lib/ask/intent/orchestrate";
import type { Understanding } from "@/lib/ask/intent/types";
import type { AskMessage, Operation, TradePreviewIntent } from "@/lib/ask/types";

/**
 * Step 5, Part 7 — conversation experience after a trade. The regexes and
 * finder functions are exported from useAskChat.ts specifically so this
 * pure decision logic ("does this message match a follow-up, and what
 * context does it resolve against") is testable without rendering the
 * hook itself — see that module's own doc.
 */

const TOKEN = "0xaaaabbbbccccddddeeeeffff0000111122223333";
const WALLET = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";

function confirmedTradeMessage(overrides: Partial<{ outputToken: string; receiveToken: string }> = {}): AskMessage {
  const intent: TradePreviewIntent = {
    kind: "trade_preview", network: "monad",
    data: {
      action: "buy", spend: { amount: "50", token: "USDC" }, receive: { amount: "12345", token: overrides.receiveToken ?? "RANDO" },
      rate: "x", minimumReceived: "x", priceImpact: "0.30%", highPriceImpact: false,
      route: { provider: "Uniswap v3", path: ["USDC", "RANDO"] }, slippage: "0.50%", network: "Monad", quotedAt: Date.now(), fee: null,
    },
    execution: { request: { action: "buy", inputToken: "USDC", outputToken: overrides.outputToken ?? TOKEN, amount: "50", amountType: "exact_input", slippage: null } },
  };
  const operation: Operation = {
    id: "op_1", intent, status: "success",
    result: { txHash: "0x" + "d".repeat(64), explorerUrl: "https://explorer.monad.xyz/tx/0xd" },
  };
  return { id: "m1", role: "assistant", content: "Trade completed.", createdAt: Date.now(), operation };
}

describe("TRADE_RESULT_RE / SELL_JUST_BOUGHT_RE / PRICE_NOW_RE — match the intended phrasings only", () => {
  it("recognizes 'how much did I get' style questions", () => {
    for (const phrase of ["How much did I get?", "what did I receive", "How much did that get me"]) {
      expect(TRADE_RESULT_RE.test(phrase)).toBe(true);
    }
  });
  it("does not fire on an unrelated question", () => {
    expect(TRADE_RESULT_RE.test("How much is a coffee")).toBe(false);
  });

  it("recognizes 'sell what I just bought' style phrasings", () => {
    for (const phrase of ["Can I sell what I just bought?", "sell what I bought", "Can I sell that now?", "sell it back"]) {
      expect(SELL_JUST_BOUGHT_RE.test(phrase)).toBe(true);
    }
  });

  it("recognizes 'what's the price now' style phrasings", () => {
    for (const phrase of ["What's the price now?", "current price", "price now", "what's it worth now"]) {
      expect(PRICE_NOW_RE.test(phrase)).toBe(true);
    }
  });
});

describe("findLastConfirmedTrade — only a real, settled trade counts", () => {
  it("finds a successful trade with a real result", () => {
    const found = findLastConfirmedTrade([confirmedTradeMessage()]);
    expect(found?.result.txHash).toBe("0x" + "d".repeat(64));
  });

  it("ignores a trade preview that was only shown, never confirmed", () => {
    const intent: TradePreviewIntent = {
      kind: "trade_preview", network: "monad",
      data: { action: "buy", spend: { amount: "50", token: "USDC" }, receive: { amount: "12345", token: "RANDO" }, rate: "x", minimumReceived: "x", priceImpact: null, highPriceImpact: false, route: { provider: "Uniswap v3", path: ["USDC", "RANDO"] }, slippage: "0.50%", network: "Monad", quotedAt: Date.now(), fee: null },
      execution: { request: { action: "buy", inputToken: "USDC", outputToken: TOKEN, amount: "50", amountType: "exact_input", slippage: null } },
    };
    const op: Operation = { id: "op_1", intent, status: "ready" }; // never confirmed
    const found = findLastConfirmedTrade([{ id: "m1", role: "assistant", content: "x", createdAt: Date.now(), operation: op }]);
    expect(found).toBeNull();
  });

  it("ignores a trade that errored (reverted) -- not a real settled result", () => {
    const intent: TradePreviewIntent = {
      kind: "trade_preview", network: "monad",
      data: { action: "buy", spend: { amount: "50", token: "USDC" }, receive: { amount: "12345", token: "RANDO" }, rate: "x", minimumReceived: "x", priceImpact: null, highPriceImpact: false, route: { provider: "Uniswap v3", path: ["USDC", "RANDO"] }, slippage: "0.50%", network: "Monad", quotedAt: Date.now(), fee: null },
    };
    const op: Operation = { id: "op_1", intent, status: "error", error: { message: "reverted", code: "REVERTED" } };
    const found = findLastConfirmedTrade([{ id: "m1", role: "assistant", content: "x", createdAt: Date.now(), operation: op }]);
    expect(found).toBeNull();
  });

  it("returns the MOST RECENT confirmed trade when several exist", () => {
    const older = confirmedTradeMessage({ receiveToken: "OLD" });
    const newer = confirmedTradeMessage({ receiveToken: "NEW" });
    const found = findLastConfirmedTrade([older, newer]);
    expect(found?.intent.data.receive.token).toBe("NEW");
  });
});

describe("findCurrentTokenAddress — contract-address identity, never guessed from a symbol", () => {
  it("resolves to an active token_intelligence card's own address", () => {
    const op: Operation = { id: "op_1", intent: { kind: "token_intelligence", network: "monad", address: TOKEN, status: "token" }, status: "success" };
    const found = findCurrentTokenAddress([{ id: "m1", role: "assistant", content: "x", createdAt: Date.now(), operation: op }]);
    expect(found).toBe(TOKEN);
  });

  it("resolves to a confirmed arbitrary-token trade's RECEIVED side when it was originally an address", () => {
    const found = findCurrentTokenAddress([confirmedTradeMessage({ outputToken: TOKEN })]);
    expect(found).toBe(TOKEN);
  });

  it("returns null for a confirmed CURATED-SYMBOL trade -- never guesses an address for a bare symbol like MON", () => {
    const found = findCurrentTokenAddress([confirmedTradeMessage({ outputToken: "MON" })]);
    expect(found).toBeNull();
  });

  it("returns null when there is no relevant context at all", () => {
    expect(findCurrentTokenAddress([])).toBeNull();
  });
});

function mockFetch(responder: (url: string, body: Record<string, unknown> | undefined) => unknown) {
  const original = globalThis.fetch;
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: String(url), body });
    return new Response(JSON.stringify(responder(String(url), body)), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

type CreateFn = (...args: unknown[]) => unknown;
let mockCreate: ReturnType<typeof vi.fn<CreateFn>>;
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function AnthropicMock() {
    return { messages: { create: (...args: unknown[]) => mockCreate(...args) } };
  }),
}));

describe("cost — the deterministic follow-up path never spends an Anthropic call", () => {
  const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockCreate = vi.fn<CreateFn>();
  });
  afterEach(() => {
    process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY;
    vi.restoreAllMocks();
  });

  it("'what's the price now' resolved to a known address dispatches token_lookup directly -- zero Anthropic calls", async () => {
    const { restore } = mockFetch(() => ({ status: "token", data: {
      name: "Random Token", symbol: "RANDO", decimals: 18, totalSupply: null, verified: false, userBalance: null, isTradable: true,
      explorerUrl: "https://x", market: { price: "1.23", priceQuoteAsset: "USD", liquidity: null, volume24h: null, priceChange24h: null, quoteAssetsChecked: ["USDC"], routes: [], signals: [], lastUpdated: Date.now() },
    } }));
    try {
      // This is exactly what answerPriceNow constructs once
      // findCurrentTokenAddress resolves a real address -- respondToUnderstanding
      // dispatches it directly, never through classifyMessage/Anthropic.
      const understanding: Understanding = { kind: "token_lookup", outcome: "complete", slots: { tokenAddress: TOKEN } };
      const r = await respondToUnderstanding(understanding, WALLET);
      expect(r.message.operation?.intent.kind).toBe("token_intelligence");
      expect(mockCreate).not.toHaveBeenCalled();
    } finally { restore(); }
  });

  it("'can I sell what I just bought' reversed into a trade Understanding dispatches directly -- zero Anthropic calls", async () => {
    const { restore } = mockFetch(() => ({ ok: true, action: "sell", spend: { amount: "12345", token: "RANDO" }, receive: { amount: "49.8", token: "USDC" }, rate: "x", minimumReceived: "x", priceImpact: null, highPriceImpact: false, route: { provider: "Uniswap v3", path: ["RANDO", "USDC"] }, slippage: "0.50%", network: "Monad", quotedAt: Date.now(), fee: null }));
    try {
      // Exactly what sellLastPurchase constructs from a confirmed trade's own
      // execution.request (received side becomes input, spent side becomes output).
      const understanding: Understanding = { kind: "trade", outcome: "complete", slots: { tradeAction: "sell", fromAsset: TOKEN, toAsset: "USDC", amount: "12345", amountType: "exact_input", slippage: null } };
      const r = await respondToUnderstanding(understanding, WALLET);
      expect(r.message.operation?.intent.kind).toBe("trade_preview");
      expect(mockCreate).not.toHaveBeenCalled();
    } finally { restore(); }
  });
});
