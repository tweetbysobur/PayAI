import { afterEach, describe, expect, it, vi } from "vitest";
import { routeRequest } from "@/lib/ask/intent/classify";
import { respondToUnderstanding } from "@/lib/ask/intent/orchestrate";
import type { Understanding } from "@/lib/ask/intent/types";

const TOKEN = "0xaaaabbbbccccddddeeeeffff0000111122223333";
const RECIPIENT = "0x1234567890abcdef1234567890abcdef12345678";

describe("router — token address detection never calls Anthropic", () => {
  const cases = [
    TOKEN,
    `What is this token? ${TOKEN}`,
    `Check this CA: ${TOKEN}`,
    `Is this token tradable? ${TOKEN}`,
    `what's ${TOKEN} about`,
  ];
  for (const text of cases) {
    it(`"${text}"`, async () => {
      const r = await routeRequest(text, null);
      expect(r.anthropic).toBe(false);
      expect(r.understanding).not.toBeNull();
      expect(r.understanding?.kind).toBe("token_lookup");
      if (r.understanding?.kind === "token_lookup" && r.understanding.outcome === "complete") {
        expect(r.understanding.slots.tokenAddress).toBe(TOKEN);
      }
    });
  }

  it("no fixed command is required -- any natural phrasing containing the address works", async () => {
    const r = await routeRequest(`yo can you tell me anything about ${TOKEN} real quick`, null);
    expect(r.anthropic).toBe(false);
    expect(r.understanding?.kind).toBe("token_lookup");
  });
});

describe("router — an address alongside a real money-moving verb is NOT a token lookup", () => {
  const cases = [
    `send 10 USDC to ${TOKEN}`,
    `pay ${TOKEN} 5 MON`,
    `swap into ${TOKEN}`,
    `schedule a payment to ${TOKEN}`,
  ];
  for (const text of cases) {
    it(`"${text}"`, async () => {
      const r = await routeRequest(text, null);
      expect(r.understanding?.kind !== "token_lookup" && r.fallback.kind !== "token_lookup").toBe(true);
    });
  }

  it("'is this token tradable?' still matches even though 'trade' is a money verb elsewhere -- \\btrade\\b doesn't match inside 'tradable'", async () => {
    const r = await routeRequest(`Is this token tradable? ${TOKEN}`, null);
    expect(r.understanding?.kind).toBe("token_lookup");
  });
});

describe("router — an in-flight payment/swap slot fill takes priority over a bare address", () => {
  it("'To 0x...' answering a pending payment's missing recipient is NOT hijacked into a token lookup", async () => {
    const pending: Understanding = { kind: "send_payment", outcome: "incomplete", slots: { amount: "50", asset: "USDC", recipient: null }, question: "Who should receive it?" };
    const r = await routeRequest(`To ${RECIPIENT}`, pending);
    expect(r.route).toBe("follow_up");
    expect(r.understanding?.kind).toBe("send_payment");
    if (r.understanding?.kind === "send_payment" && r.understanding.outcome === "complete") {
      expect(r.understanding.slots.recipient).toBe(RECIPIENT);
    }
  });

  it("a bare address with nothing pending (or pending that doesn't ask for an address-shaped slot) still becomes a token lookup", async () => {
    const pending: Understanding = { kind: "token_balance", outcome: "incomplete", slots: {}, question: "Which token — MON or USDC?" };
    const r = await routeRequest(TOKEN, pending);
    expect(r.understanding?.kind).toBe("token_lookup");
  });
});

describe("router — conversation context: a follow-up about 'the token' resolves against the pending address", () => {
  const pending: Understanding = { kind: "token_lookup", outcome: "complete", slots: { tokenAddress: TOKEN } };

  for (const text of ["What's the price?", "is it tradable", "what's the total supply", "any liquidity?"]) {
    it(`"${text}" merges into the SAME token, no Anthropic call`, async () => {
      const r = await routeRequest(text, pending);
      expect(r.anthropic).toBe(false);
      expect(r.route).toBe("follow_up");
      expect(r.understanding?.kind).toBe("token_lookup");
      if (r.understanding?.kind === "token_lookup" && r.understanding.outcome === "complete") {
        expect(r.understanding.slots.tokenAddress).toBe(TOKEN);
      }
    });
  }

  it("a NEW address in the follow-up always wins over the old pending token", async () => {
    const OTHER = "0x9999888877776666555544443333222211110000";
    const r = await routeRequest(`ok now what about ${OTHER}`, pending);
    expect(r.understanding?.kind).toBe("token_lookup");
    if (r.understanding?.kind === "token_lookup" && r.understanding.outcome === "complete") {
      expect(r.understanding.slots.tokenAddress).toBe(OTHER);
    }
  });

  it("an unrelated follow-up (no token keyword) is NOT swallowed into the token context", async () => {
    const r = await routeRequest("what's my wallet balance", pending);
    expect(r.understanding?.kind).not.toBe("token_lookup");
  });
});

describe("router — natural-language market follow-ups (pair + amount questions)", () => {
  const pending: Understanding = { kind: "token_lookup", outcome: "complete", slots: { tokenAddress: TOKEN } };

  it("'Can I trade it with USDC?' captures the specific asset asked about, no Anthropic call", async () => {
    const r = await routeRequest("Can I trade it with USDC?", pending);
    expect(r.anthropic).toBe(false);
    expect(r.understanding?.kind).toBe("token_lookup");
    if (r.understanding?.kind === "token_lookup" && r.understanding.outcome === "complete") {
      expect(r.understanding.slots.tokenAddress).toBe(TOKEN);
      expect(r.understanding.slots.toAsset).toBe("USDC");
    }
  });

  it("'What about MON?' after a token lookup also captures the asset (WMON normalizes to MON)", async () => {
    const r = await routeRequest("what about WMON", pending);
    if (r.understanding?.kind === "token_lookup" && r.understanding.outcome === "complete") {
      expect(r.understanding.slots.toAsset).toBe("MON");
    }
  });

  it("'How much would I get for 50?' captures the amount, no Anthropic call", async () => {
    const r = await routeRequest("How much would I get for 50?", pending);
    expect(r.anthropic).toBe(false);
    expect(r.understanding?.kind).toBe("token_lookup");
    if (r.understanding?.kind === "token_lookup" && r.understanding.outcome === "complete") {
      expect(r.understanding.slots.amount).toBe("50");
    }
  });

  it("'quote 200' also reads as an amount question", async () => {
    const r = await routeRequest("quote 200", pending);
    if (r.understanding?.kind === "token_lookup" && r.understanding.outcome === "complete") {
      expect(r.understanding.slots.amount).toBe("200");
    }
  });

  it("'how much USDC do I have' (no number) is NOT misread as a token quote request -- stays a real wallet-balance question", async () => {
    const r = await routeRequest("how much USDC do I have", pending);
    expect(r.understanding?.kind).not.toBe("token_lookup");
  });
});

describe("IMPORTANT REGRESSION CHECK — the recipient flow from the task spec, end to end", () => {
  it("'I want to send USDC' -> '50' -> '0xRecipient' ends with the address treated as the recipient, never hijacked into a token lookup", async () => {
    const step1 = await routeRequest("I want to send USDC", null);
    expect(step1.understanding?.kind === "send_payment" || step1.fallback.kind === "send_payment").toBe(true);
    const afterStep1: Understanding = step1.understanding ?? step1.fallback;
    expect(afterStep1.outcome).toBe("incomplete");

    const step2 = await routeRequest("50", afterStep1);
    expect(step2.route).toBe("follow_up");
    const afterStep2 = step2.understanding!;
    if (afterStep2.kind !== "send_payment") throw new Error("expected send_payment");
    expect(afterStep2.slots.amount).toBe("50");

    const step3 = await routeRequest(RECIPIENT, afterStep2);
    expect(step3.route).toBe("follow_up");
    expect(step3.understanding?.kind).toBe("send_payment"); // NOT token_lookup
    if (step3.understanding?.kind === "send_payment" && step3.understanding.outcome === "complete") {
      expect(step3.understanding.slots.recipient).toBe(RECIPIENT);
      expect(step3.understanding.slots.amount).toBe("50");
      expect(step3.understanding.slots.asset).toBe("USDC");
    }
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

afterEach(() => vi.restoreAllMocks());

describe("respondToUnderstanding — token_lookup dispatches to /api/ask/token and carries context forward", () => {
  it("a wallet address gets an honest, non-token message and no confirm funnel", async () => {
    const { calls, restore } = mockFetch(() => ({ status: "wallet" }));
    try {
      const u: Understanding = { kind: "token_lookup", outcome: "complete", slots: { tokenAddress: TOKEN } };
      const r = await respondToUnderstanding(u, null);
      expect(calls[0].url).toBe("/api/ask/token");
      expect(calls[0].body.address).toBe(TOKEN);
      expect(r.message.content).toMatch(/wallet address, not a token contract/i);
      expect(r.message.operation?.intent.kind).toBe("token_intelligence");
      if (r.message.operation?.intent.kind === "token_intelligence") expect(r.message.operation.intent.status).toBe("wallet");
      // Still carries the address forward -- a follow-up like "are you sure?"
      // should be able to re-resolve against the same address.
      expect(r.nextPending).toEqual(u);
    } finally { restore(); }
  });

  it("a non-ERC-20 contract gets an honest message", async () => {
    const { restore } = mockFetch(() => ({ status: "unknown_contract" }));
    try {
      const u: Understanding = { kind: "token_lookup", outcome: "complete", slots: { tokenAddress: TOKEN } };
      const r = await respondToUnderstanding(u, null);
      expect(r.message.content).toMatch(/couldn't identify it as an ERC-20/i);
      if (r.message.operation?.intent.kind === "token_intelligence") expect(r.message.operation.intent.status).toBe("unknown_contract");
    } finally { restore(); }
  });

  const PEPE_DATA = {
    name: "Pepe Coin", symbol: "PEPE", decimals: 18, totalSupply: "1000000",
    verified: false, userBalance: null, isTradable: true, explorerUrl: "https://monadexplorer.com/address/x",
    market: {
      price: "0.0000123", priceQuoteAsset: "USD", liquidity: null, volume24h: null, priceChange24h: null,
      quoteAssetsChecked: ["USDC", "MON"], signals: [],
      routes: [{ provider: "Uniswap v3", inputToken: "PEPE", outputToken: "USDC", estimatedOutput: "0.0000123", priceImpact: "0.10%", available: true as const }],
    },
  };

  it("a real token gets a full card, a summary lead line, and nextPending set for follow-ups", async () => {
    const { restore } = mockFetch(() => ({ status: "token", data: PEPE_DATA }));
    try {
      const u: Understanding = { kind: "token_lookup", outcome: "complete", slots: { tokenAddress: TOKEN } };
      const r = await respondToUnderstanding(u, null);
      expect(r.message.content).toMatch(/PEPE/);
      expect(r.message.content).toMatch(/0\.0000123/);
      expect(r.message.operation?.intent.kind).toBe("token_intelligence");
      if (r.message.operation?.intent.kind === "token_intelligence") {
        expect(r.message.operation.intent.status).toBe("token");
        expect(r.message.operation.intent.data?.symbol).toBe("PEPE");
      }
      expect(r.nextPending).toEqual(u); // context carries forward
    } finally { restore(); }
  });

  it("a non-tradable token is described honestly, not as a price", async () => {
    const data = {
      name: "Dead Token", symbol: "DEAD", decimals: 18, totalSupply: "1",
      verified: false, userBalance: null, isTradable: false, explorerUrl: "https://monadexplorer.com/address/x",
      market: { price: null, priceQuoteAsset: null, liquidity: null, volume24h: null, priceChange24h: null, quoteAssetsChecked: ["USDC", "MON"], signals: ["no_liquidity"], routes: [] },
    };
    const { restore } = mockFetch(() => ({ status: "token", data }));
    try {
      const u: Understanding = { kind: "token_lookup", outcome: "complete", slots: { tokenAddress: TOKEN } };
      const r = await respondToUnderstanding(u, null);
      expect(r.message.content).toMatch(/no usable trading route/i);
    } finally { restore(); }
  });

  it("a route exists but is too shallow to price is described honestly, not as untradable", async () => {
    const data = {
      ...PEPE_DATA,
      market: { ...PEPE_DATA.market, price: null, priceQuoteAsset: null, signals: ["quote_unavailable"] },
    };
    const { restore } = mockFetch(() => ({ status: "token", data }));
    try {
      const u: Understanding = { kind: "token_lookup", outcome: "complete", slots: { tokenAddress: TOKEN } };
      const r = await respondToUnderstanding(u, null);
      expect(r.message.content).toMatch(/route exists/i);
      expect(r.message.content).not.toMatch(/no usable trading route/i);
    } finally { restore(); }
  });

  it("a network failure is reported honestly, not as a false 'not a token'", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    try {
      const u: Understanding = { kind: "token_lookup", outcome: "complete", slots: { tokenAddress: TOKEN } };
      const r = await respondToUnderstanding(u, null);
      expect(r.message.content).toMatch(/couldn't reach monad/i);
    } finally { globalThis.fetch = original; }
  });
});

describe("respondToUnderstanding — 'Can I trade it with USDC?' answers the SPECIFIC pair asked about", () => {
  it("a real USDC route is confirmed by name", async () => {
    const data = {
      name: "Pepe Coin", symbol: "PEPE", decimals: 18, totalSupply: "1000000",
      verified: false, userBalance: null, isTradable: true, explorerUrl: "https://monadexplorer.com/address/x",
      market: {
        price: "0.0000123", priceQuoteAsset: "USD", liquidity: null, volume24h: null, priceChange24h: null,
        quoteAssetsChecked: ["USDC", "MON"], signals: [],
        routes: [{ provider: "Uniswap v3", inputToken: "PEPE", outputToken: "USDC", estimatedOutput: "0.0000123", priceImpact: "0.10%", available: true as const }],
      },
    };
    const { calls, restore } = mockFetch(() => ({ status: "token", data }));
    try {
      const u: Understanding = { kind: "token_lookup", outcome: "complete", slots: { tokenAddress: TOKEN, toAsset: "USDC" } };
      const r = await respondToUnderstanding(u, null);
      expect(r.message.content).toMatch(/yes.*PEPE\/USDC/i);
      expect(r.message.content).toMatch(/Uniswap v3/);
      // toAsset does NOT get sent as a quote request -- only `amount` does;
      // a bare "can I trade with X" is answered from the general probe.
      expect(calls[0].body.amount).toBeUndefined();
    } finally { restore(); }
  });

  it("no route for the asked-about pair is reported honestly, not guessed either way", async () => {
    const data = {
      name: "Pepe Coin", symbol: "PEPE", decimals: 18, totalSupply: "1000000",
      verified: false, userBalance: null, isTradable: true, explorerUrl: "https://monadexplorer.com/address/x",
      market: {
        price: null, priceQuoteAsset: null, liquidity: null, volume24h: null, priceChange24h: null,
        quoteAssetsChecked: ["USDC", "MON"], signals: ["unsupported_trading_pair"],
        routes: [{ provider: "Uniswap v3", inputToken: "PEPE", outputToken: "MON", estimatedOutput: "1.2", priceImpact: null, available: true as const }],
      },
    };
    const { restore } = mockFetch(() => ({ status: "token", data }));
    try {
      const u: Understanding = { kind: "token_lookup", outcome: "complete", slots: { tokenAddress: TOKEN, toAsset: "USDC" } };
      const r = await respondToUnderstanding(u, null);
      expect(r.message.content).toMatch(/no usable usdc route/i);
    } finally { restore(); }
  });
});

describe("respondToUnderstanding — 'How much would I get for 50?' prepares a real quote, never a scaled-up guess", () => {
  it("sends the amount to /api/ask/token and reports the real quoted route", async () => {
    const data = {
      name: "Pepe Coin", symbol: "PEPE", decimals: 18, totalSupply: "1000000",
      verified: false, userBalance: null, isTradable: true, explorerUrl: "https://monadexplorer.com/address/x",
      market: { price: "0.0000123", priceQuoteAsset: "USD", liquidity: null, volume24h: null, priceChange24h: null, quoteAssetsChecked: ["USDC", "MON"], signals: [], routes: [] },
      quote: { amount: "50", quoteAsset: "USDC", route: { provider: "Uniswap v3", inputToken: "PEPE", outputToken: "USDC", estimatedOutput: "0.000615", priceImpact: "0.05%", available: true as const } },
    };
    const { calls, restore } = mockFetch(() => ({ status: "token", data }));
    try {
      const u: Understanding = { kind: "token_lookup", outcome: "complete", slots: { tokenAddress: TOKEN, amount: "50" } };
      const r = await respondToUnderstanding(u, null);
      expect(calls[0].body.amount).toBe("50");
      expect(r.message.content).toMatch(/50 PEPE/);
      expect(r.message.content).toMatch(/0\.000615 USDC/);
      expect(r.message.content).toMatch(/Uniswap v3/);
    } finally { restore(); }
  });

  it("no usable route for the requested amount is reported honestly, never a fabricated figure", async () => {
    const data = {
      name: "Dead Token", symbol: "DEAD", decimals: 18, totalSupply: "1",
      verified: false, userBalance: null, isTradable: false, explorerUrl: "https://monadexplorer.com/address/x",
      market: { price: null, priceQuoteAsset: null, liquidity: null, volume24h: null, priceChange24h: null, quoteAssetsChecked: ["USDC", "MON"], signals: ["no_liquidity"], routes: [] },
      quote: { amount: "50", quoteAsset: "USDC", route: null },
    };
    const { restore } = mockFetch(() => ({ status: "token", data }));
    try {
      const u: Understanding = { kind: "token_lookup", outcome: "complete", slots: { tokenAddress: TOKEN, amount: "50" } };
      const r = await respondToUnderstanding(u, null);
      expect(r.message.content).toMatch(/couldn't find a usable route to quote 50 DEAD/i);
    } finally { restore(); }
  });
});
