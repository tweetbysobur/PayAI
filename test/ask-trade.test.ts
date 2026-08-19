import { afterEach, describe, expect, it, vi } from "vitest";
import { routeRequest } from "@/lib/ask/intent/classify";
import { respondToUnderstanding } from "@/lib/ask/intent/orchestrate";
import type { Understanding } from "@/lib/ask/intent/types";

const TOKEN = "0xaaaabbbbccccddddeeeeffff0000111122223333";
const RECIPIENT = "0x1234567890abcdef1234567890abcdef12345678";
const CONTEXT: Understanding = { kind: "token_lookup", outcome: "complete", slots: { tokenAddress: TOKEN } };

describe("router — a fresh trade request always gets a real Anthropic pass", () => {
  const cases = [
    "Buy this token with 50 USDC.",
    "Swap 100 USDC into this token.",
    "Sell 20 MON for USDC.",
    "Use half of my USDC to buy this.",
    "Get me $50 worth of this token.",
    "How much of this token can I get for 100 USDC?",
    "Sell half of my balance.",
  ];
  for (const text of cases) {
    it(`"${text}" (with token context) resolves to a trade understanding via Anthropic`, async () => {
      const r = await routeRequest(text, CONTEXT);
      expect(r.anthropic).toBe(true);
      // The deterministic fallback (used if Anthropic is unavailable) must
      // still land on "trade", not get misrouted into the old swap/payment
      // detectors -- see the collision this guards against below.
      expect(r.fallback.kind).toBe("trade");
    });
  }
});

describe("router — REGRESSION: 'swap X into this' never falls through to detectSwapIntent and captures 'this' as a bogus token symbol", () => {
  it("'Swap 100 USDC into this token.' does not produce a swap understanding naming THIS as a token", async () => {
    const r = await routeRequest("Swap 100 USDC into this token.", CONTEXT);
    expect(r.fallback.kind).not.toBe("swap");
    if (r.fallback.kind === "trade" && (r.fallback.outcome === "complete" || r.fallback.outcome === "incomplete")) {
      expect(r.fallback.slots.toAsset).not.toMatch(/^this$/i);
      expect(r.fallback.slots.fromAsset).not.toMatch(/^this$/i);
    }
  });
});

describe("router — existing Smart Swap flow is completely unaffected", () => {
  it("'Swap 20 USDC to MON' (no pronoun, no context) still resolves as the existing swap kind", async () => {
    const r = await routeRequest("Swap 20 USDC to MON", null);
    expect(r.anthropic).toBe(true); // fresh money-moving intent, same as before
    expect(r.fallback.kind).toBe("swap");
    if (r.fallback.outcome === "complete" || r.fallback.outcome === "incomplete") {
      expect(r.fallback.slots.fromAsset).toBe("USDC");
      expect(r.fallback.slots.toAsset).toBe("MON");
    }
  });

  it("'I need some MON using my USDC' still resolves as swap, not trade", async () => {
    const r = await routeRequest("I need some MON using my USDC", null);
    expect(r.fallback.kind).not.toBe("trade");
  });
});

describe("router — token context from a previous message resolves 'this'/'it'", () => {
  it("'Buy 50 USDC worth.' after a token_lookup fills toAsset from the identified address", async () => {
    const r = await routeRequest("Buy 50 USDC worth.", CONTEXT);
    expect(r.fallback.kind).toBe("trade");
    if (r.fallback.kind === "trade" && r.fallback.outcome === "complete") {
      expect(r.fallback.slots.toAsset).toBe(TOKEN);
      expect(r.fallback.slots.fromAsset).toBe("USDC");
      expect(r.fallback.slots.tradeAction).toBe("buy");
    } else {
      throw new Error(`expected complete trade, got ${JSON.stringify(r.fallback)}`);
    }
  });

  it("with NO token context, 'Buy 50 USDC worth.' asks for the missing token rather than guessing", async () => {
    const r = await routeRequest("Buy 50 USDC worth.", null);
    if (r.fallback.kind === "trade" && r.fallback.outcome === "incomplete") {
      expect(r.fallback.slots.toAsset).toBeNull();
      expect(r.fallback.question).toMatch(/which token/i);
    } else {
      throw new Error(`expected incomplete trade asking for the token, got ${JSON.stringify(r.fallback)}`);
    }
  });

  it("'Sell 20 MON for USDC.' needs no context at all -- both sides are explicit", async () => {
    const r = await routeRequest("Sell 20 MON for USDC.", null);
    if (r.fallback.kind === "trade" && r.fallback.outcome === "complete") {
      expect(r.fallback.slots.fromAsset).toBe("MON");
      expect(r.fallback.slots.toAsset).toBe("USDC");
      expect(r.fallback.slots.amount).toBe("20");
    } else {
      throw new Error(`expected complete trade, got ${JSON.stringify(r.fallback)}`);
    }
  });
});

describe("router — missing-field questions ask only for what's actually missing, deterministically", () => {
  it("'Buy this token.' (no amount) asks how much, no Anthropic call needed to recognize incompleteness", async () => {
    const r = await routeRequest("Buy this token.", CONTEXT);
    if (r.fallback.kind === "trade" && r.fallback.outcome === "incomplete") {
      expect(r.fallback.question).toMatch(/how much/i);
    } else {
      throw new Error(`expected incomplete trade, got ${JSON.stringify(r.fallback)}`);
    }
  });

  it("an incomplete trade pending, answered with '50 USDC', completes deterministically (no Anthropic)", async () => {
    const pending: Understanding = { kind: "trade", outcome: "incomplete", slots: { tradeAction: "buy", amount: null, amountType: null, fromAsset: null, toAsset: TOKEN }, question: "How much would you like to spend?" };
    const r = await routeRequest("50 USDC", pending);
    expect(r.anthropic).toBe(false);
    expect(r.understanding?.kind).toBe("trade");
    if (r.understanding?.kind === "trade" && r.understanding.outcome === "complete") {
      expect(r.understanding.slots.amount).toBe("50");
      expect(r.understanding.slots.fromAsset).toBe("USDC");
    } else {
      throw new Error(`expected complete trade, got ${JSON.stringify(r.understanding)}`);
    }
  });

  it("a bare 'buy' or 'sell' answers a pending action question deterministically", async () => {
    const pending: Understanding = { kind: "trade", outcome: "incomplete", slots: { tradeAction: null, amount: "50", amountType: "exact_input", fromAsset: "USDC", toAsset: TOKEN }, question: "Would you like to buy or sell?" };
    const r = await routeRequest("buy", pending);
    expect(r.anthropic).toBe(false);
    expect(r.understanding?.kind).toBe("trade");
    if (r.understanding?.kind === "trade" && r.understanding.outcome === "complete") {
      expect(r.understanding.slots.tradeAction).toBe("buy");
    }
  });
});

describe("router — corrections on an already-previewed trade are resolved deterministically (no Anthropic)", () => {
  const previewed: Understanding = { kind: "trade", outcome: "complete", slots: { tradeAction: "buy", amount: "50", amountType: "exact_input", fromAsset: "USDC", toAsset: TOKEN } };

  it("'Actually make it 100.' updates only the amount", async () => {
    const r = await routeRequest("Actually make it 100.", previewed);
    expect(r.anthropic).toBe(false);
    if (r.understanding?.kind === "trade" && r.understanding.outcome === "complete") {
      expect(r.understanding.slots.amount).toBe("100");
      expect(r.understanding.slots.fromAsset).toBe("USDC");
      expect(r.understanding.slots.toAsset).toBe(TOKEN);
    } else {
      throw new Error(`expected complete trade, got ${JSON.stringify(r.understanding)}`);
    }
  });

  it("'Actually use MON instead.' on a BUY corrects the INPUT (fromAsset) -- the output is anchored by context", async () => {
    const r = await routeRequest("Actually use MON instead.", previewed);
    expect(r.anthropic).toBe(false);
    if (r.understanding?.kind === "trade" && r.understanding.outcome === "complete") {
      expect(r.understanding.slots.fromAsset).toBe("MON");
      expect(r.understanding.slots.toAsset).toBe(TOKEN); // unchanged
    } else {
      throw new Error(`expected complete trade, got ${JSON.stringify(r.understanding)}`);
    }
  });

  it("'Actually use MON instead.' on a SELL corrects the OUTPUT (toAsset) instead", async () => {
    const sellPreviewed: Understanding = { kind: "trade", outcome: "complete", slots: { tradeAction: "sell", amount: "20", amountType: "exact_input", fromAsset: TOKEN, toAsset: "USDC" } };
    const r = await routeRequest("Actually use MON instead.", sellPreviewed);
    if (r.understanding?.kind === "trade" && r.understanding.outcome === "complete") {
      expect(r.understanding.slots.toAsset).toBe("MON");
      expect(r.understanding.slots.fromAsset).toBe(TOKEN); // unchanged
    } else {
      throw new Error(`expected complete trade, got ${JSON.stringify(r.understanding)}`);
    }
  });

  it("'Sell instead.' flips the action and swaps the two sides, dropping the now-ambiguous amount", async () => {
    const r = await routeRequest("Sell instead.", previewed);
    expect(r.anthropic).toBe(false);
    expect(r.understanding?.kind).toBe("trade");
    if (r.understanding?.kind === "trade" && r.understanding.outcome === "incomplete") {
      expect(r.understanding.slots.tradeAction).toBe("sell");
      expect(r.understanding.slots.fromAsset).toBe(TOKEN); // was toAsset
      expect(r.understanding.slots.toAsset).toBe("USDC"); // was fromAsset
      expect(r.understanding.slots.amount).toBeNull();
      expect(r.understanding.question).toMatch(/how much/i);
    } else {
      throw new Error(`expected incomplete trade after flip, got ${JSON.stringify(r.understanding)}`);
    }
  });

  it("a bare number with NO correction cue is genuinely ambiguous and does NOT auto-correct", async () => {
    const r = await routeRequest("100", previewed);
    // Not a deterministic follow-up on this pending -- falls through to
    // fresh classification (which may or may not itself produce something,
    // but must NOT silently reinterpret the bare number as a correction).
    if (r.understanding?.kind === "trade" && r.understanding.outcome === "complete") {
      expect(r.understanding.slots.amount).not.toBe("100");
    }
  });
});

describe("IMPORTANT REGRESSION CHECK — trade/token detection never hijacks an active payment operation", () => {
  it("'I want to send USDC' -> '50' -> '0xRecipient' still ends with the address as the recipient", async () => {
    const step1 = await routeRequest("I want to send USDC", null);
    const afterStep1: Understanding = step1.understanding ?? step1.fallback;
    expect(afterStep1.kind).toBe("send_payment");

    const step2 = await routeRequest("50", afterStep1);
    const afterStep2 = step2.understanding!;
    if (afterStep2.kind !== "send_payment") throw new Error("expected send_payment");

    const step3 = await routeRequest(RECIPIENT, afterStep2);
    expect(step3.understanding?.kind).toBe("send_payment"); // NOT trade, NOT token_lookup
    if (step3.understanding?.kind === "send_payment" && step3.understanding.outcome === "complete") {
      expect(step3.understanding.slots.recipient).toBe(RECIPIENT);
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

describe("respondToUnderstanding — trade dispatches to /api/ask/trade and never signs anything", () => {
  const TRADE_DATA = {
    action: "buy" as const, spend: { amount: "50", token: "USDC" }, receive: { amount: "12345", token: "RANDO" },
    rate: "1 USDC ≈ 246.9 RANDO", minimumReceived: "12283.28 RANDO", priceImpact: "0.30%", highPriceImpact: false,
    route: { provider: "Uniswap v3", path: ["USDC", "RANDO"] }, slippage: "0.50%", network: "Monad" as const, quotedAt: Date.now(),
  };

  it("a successful quote with no wallet builds a trade_preview card with status 'success' (informational-only, no execution to sign) and carries context forward", async () => {
    const { calls, restore } = mockFetch(() => ({ ok: true, ...TRADE_DATA }));
    try {
      const u: Understanding = { kind: "trade", outcome: "complete", slots: { tradeAction: "buy", amount: "50", amountType: "exact_input", fromAsset: "USDC", toAsset: TOKEN } };
      const r = await respondToUnderstanding(u, null);
      expect(calls[0].url).toBe("/api/ask/trade");
      expect(calls[0].body).toMatchObject({ action: "buy", inputToken: "USDC", outputToken: TOKEN, amount: "50", amountType: "exact_input" });
      expect(r.message.operation?.intent.kind).toBe("trade_preview");
      expect(r.message.operation?.status).toBe("success"); // no wallet -- no execution field, informational only
      if (r.message.operation?.intent.kind === "trade_preview") expect(r.message.operation.intent.execution).toBeUndefined();
      expect(r.message.content).toMatch(/50 USDC/);
      expect(r.message.content).toMatch(/12345 RANDO/);
      expect(r.nextPending).toEqual(u);
    } finally { restore(); }
  });

  it("a successful quote WITH a connected wallet builds a 'ready' card carrying the execution request", async () => {
    const { restore } = mockFetch(() => ({ ok: true, ...TRADE_DATA }));
    try {
      const u: Understanding = { kind: "trade", outcome: "complete", slots: { tradeAction: "buy", amount: "50", amountType: "exact_input", fromAsset: "USDC", toAsset: TOKEN } };
      const r = await respondToUnderstanding(u, "0xWallet");
      expect(r.message.operation?.status).toBe("ready");
      expect(r.message.operation?.confirmLabel).toBe("Confirm trade");
      if (r.message.operation?.intent.kind === "trade_preview") {
        expect(r.message.operation.intent.execution?.request).toMatchObject({ action: "buy", inputToken: "USDC", outputToken: TOKEN, amount: "50", amountType: "exact_input" });
      }
    } finally { restore(); }
  });

  it("a high-impact trade includes a visible warning in the lead text", async () => {
    const { restore } = mockFetch(() => ({ ok: true, ...TRADE_DATA, highPriceImpact: true }));
    try {
      const u: Understanding = { kind: "trade", outcome: "complete", slots: { tradeAction: "buy", amount: "50", amountType: "exact_input", fromAsset: "USDC", toAsset: TOKEN } };
      const r = await respondToUnderstanding(u, null);
      expect(r.message.content).toMatch(/high price impact/i);
    } finally { restore(); }
  });

  it("insufficient balance is reported as plain text, never a fake preview card", async () => {
    const { restore } = mockFetch(() => ({ ok: false, message: "You only have 100 USDC available — that's less than the 500 USDC you asked to trade." }));
    try {
      const u: Understanding = { kind: "trade", outcome: "complete", slots: { tradeAction: "buy", amount: "500", amountType: "exact_input", fromAsset: "USDC", toAsset: TOKEN } };
      const r = await respondToUnderstanding(u, null);
      expect(r.message.content).toMatch(/only have 100 USDC/i);
      expect(r.message.operation).toBeUndefined();
      expect(r.nextPending).toBeNull();
    } finally { restore(); }
  });

  it("no route is reported as plain text, never a fake preview card", async () => {
    const { restore } = mockFetch(() => ({ ok: false, message: "No usable trading route found for USDC → DEAD right now." }));
    try {
      const u: Understanding = { kind: "trade", outcome: "complete", slots: { tradeAction: "buy", amount: "50", amountType: "exact_input", fromAsset: "USDC", toAsset: TOKEN } };
      const r = await respondToUnderstanding(u, null);
      expect(r.message.content).toMatch(/no usable trading route/i);
      expect(r.message.operation).toBeUndefined();
    } finally { restore(); }
  });

  it("a network failure is reported honestly", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    try {
      const u: Understanding = { kind: "trade", outcome: "complete", slots: { tradeAction: "buy", amount: "50", amountType: "exact_input", fromAsset: "USDC", toAsset: TOKEN } };
      const r = await respondToUnderstanding(u, null);
      expect(r.message.content).toMatch(/couldn't reach monad/i);
    } finally { globalThis.fetch = original; }
  });
});

/** Understanding is a union; only the slot-carrying variants have `slots`.
 *  Narrow explicitly so a test that accidentally gets `unclear` fails loudly
 *  on the kind assertion rather than on a type error. */
function slotsOf(u: Understanding): Record<string, unknown> {
  if (!("slots" in u)) throw new Error(`expected a slot-carrying understanding, got ${u.kind}`);
  return u.slots as unknown as Record<string, unknown>;
}

describe("a trade never puts the same asset on both sides", () => {
  /**
   * applyTradeContext fills whichever side the user didn't name. It defaulted
   * that side to USDC unconditionally, which is right until USDC is already
   * the OTHER side: "sell half my USDC" named USDC as what's being sold and
   * then defaulted the receiving side to USDC too. The result looked complete
   * and was unroutable — an ordinary sell came back "no route found".
   *
   * This runs on Anthropic's output as well as the key-free fallback, so it
   * was reachable in production, not just offline.
   */
  const SELLS = ["sell half my USDC", "sell all my USDC", "sell 100 USDC"];
  for (const text of SELLS) {
    it(`"${text}" sells USDC into MON, not into USDC`, async () => {
      const { understand } = await import("@/lib/ask/intent/classify");
      const u = await understand(text, [], null);
      expect(u.kind).toBe("trade");
      const s = slotsOf(u);
      expect(s.fromAsset).toBe("USDC");
      expect(s.toAsset).toBe("MON");
    });
  }

  it("keeps USDC as the counter-asset when the traded asset is not USDC", async () => {
    const { understand } = await import("@/lib/ask/intent/classify");
    const s = slotsOf(await understand("sell half my MON", [], null));
    expect(s.fromAsset).toBe("MON");
    expect(s.toAsset).toBe("USDC");
  });

  it("buy/sell resolves across MON, WMON and USDC, with WMON normalized to MON", async () => {
    const { understand } = await import("@/lib/ask/intent/classify");
    const cases: [string, string, string, string][] = [
      ["buy 10 MON with USDC", "buy", "MON", "USDC"],
      ["buy 10 WMON with USDC", "buy", "MON", "USDC"],
      ["sell 5 WMON for USDC", "sell", "MON", "USDC"],
      ["buy 100 USDC with MON", "buy", "USDC", "MON"],
      ["sell 100 USDC for MON", "sell", "USDC", "MON"],
    ];
    for (const [text, action, from, to] of cases) {
      const u = await understand(text, [], null);
      expect(u.kind, text).toBe("trade");
      const s = slotsOf(u);
      expect(s.tradeAction, text).toBe(action);
      expect(s.fromAsset, text).toBe(from);
      expect(s.toAsset, text).toBe(to);
      expect(s.fromAsset, text).not.toBe(s.toAsset);
    }
  });
});

describe("the Ask PayAI tile phrase did not capture real swaps", () => {
  /**
   * TRADE_SIGNAL_RE gained a clause so the "Trade a token" tile resolves in
   * the key-free fallback instead of dead-ending at `unclear`. detectTradeFresh
   * runs BEFORE detectSwapIntent, so an over-broad clause there would quietly
   * divert genuine swaps. It is anchored at both ends for exactly that reason.
   */
  it("routes the tile phrase to trade", async () => {
    const { understand } = await import("@/lib/ask/intent/classify");
    for (const t of ["trade a token", "Trade a token", "trade token", "trade tokens"]) {
      expect((await understand(t, [], null)).kind, t).toBe("trade");
    }
  });

  it("leaves a real swap that merely opens with the word alone", async () => {
    const { understand } = await import("@/lib/ask/intent/classify");
    for (const t of ["trade tokens for USDC", "trade 50 USDC for MON"]) {
      expect((await understand(t, [], null)).kind, t).toBe("swap");
    }
  });

  it("leaves ordinary swap phrasings untouched", async () => {
    const { understand } = await import("@/lib/ask/intent/classify");
    for (const t of ["swap 100 USDC for MON", "exchange 20 USDC for MON", "convert 10 MON into USDC"]) {
      expect((await understand(t, [], null)).kind, t).toBe("swap");
    }
  });
});
