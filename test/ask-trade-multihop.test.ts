import { afterEach, describe, expect, it, vi } from "vitest";
import type { Operation, TradePreviewIntent } from "@/lib/ask/types";

/**
 * The execution side of a Nad.Fun-through-MON multi-hop trade (see
 * lib/monad/tradeQuote.ts's buildNadFunMultiHopSteps and this file's own
 * executeTradeIntent): two REAL, independently-signed on-chain legs, each
 * settled as its own receipt confirms via `settleLeg` — never one blended
 * settlement call that would misrepresent the second leg's actual tokens,
 * and never a scenario where leg A's real, fund-moving transaction goes
 * unrecorded because leg B failed afterward.
 */

const WALLET = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";

function mockFetch(responder: (url: string, body: Record<string, unknown> | undefined, callIndex: number) => unknown) {
  const original = globalThis.fetch;
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const callIndex = calls.length;
    calls.push({ url: String(url), body });
    return new Response(JSON.stringify(responder(String(url), body, callIndex)), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function tradeOperation(): Operation {
  const intent: TradePreviewIntent = {
    kind: "trade_preview", network: "monad",
    data: {
      action: "buy", spend: { amount: "50", token: "USDC" }, receive: { amount: "5000", token: "GRAD" },
      rate: "1 USDC ≈ 100 GRAD", minimumReceived: "4975 GRAD", priceImpact: null, highPriceImpact: false,
      route: { provider: "Uniswap v3 + Nad.Fun", path: ["USDC", "MON", "GRAD"] }, slippage: "0.50%", network: "Monad", quotedAt: Date.now(), fee: null,
    },
    execution: { request: { action: "buy", inputToken: "USDC", outputToken: "0xaaaabbbbccccddddeeeeffff0000111122223333", amount: "50", amountType: "exact_input", slippage: null } },
  };
  return { id: "op_1", intent, status: "ready", confirmLabel: "Confirm trade" };
}

/** A real multi-hop build response: approve(USDC) + swap(USDC->MON, tagged)
 *  + buy(MON->GRAD, tagged) — exactly what prepareTradeExecution's
 *  buildNadFunMultiHopSteps produces for a BUY. */
function multiHopBuild() {
  return {
    ok: true, status: "ready",
    preview: {
      action: "buy", spend: { amount: "50", token: "USDC" }, receive: { amount: "5000", token: "GRAD" },
      rate: "x", minimumReceived: "x", priceImpact: null, highPriceImpact: false,
      route: { provider: "Uniswap v3 + Nad.Fun", path: ["USDC", "MON", "GRAD"] }, slippage: "0.50%", network: "Monad", quotedAt: Date.now(), fee: null,
    },
    steps: [
      { kind: "approve", label: "Approve USDC", tx: { to: "0xUSDC", data: "0xapprove", value: "0x0" } },
      {
        kind: "swap", label: "Swap USDC for MON", tx: { to: "0xRouter", data: "0xswap", value: "0x0" },
        settleLeg: { fromToken: "USDC", toToken: "MON", amountIn: 50, amountOut: 100, provider: "Uniswap v3" },
      },
      {
        kind: "swap", label: "Buy GRAD on Nad.Fun", tx: { to: "0xNadFunRouter", data: "0xbuy", value: "0x0" },
        settleLeg: { fromToken: "MON", toToken: "GRAD", amountIn: 100, amountOut: 5000, provider: "Nad.Fun" },
      },
    ],
  };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("executeTradeIntent — Nad.Fun-through-MON multi-hop happy path", () => {
  it("signs all 3 steps in order, settles leg A mid-flow and leg B at the end, reports success with leg B's real hash", async () => {
    const { executeTradeIntent } = await import("@/lib/ask/intent/orchestrate");
    const { calls, restore } = mockFetch((url, body) => {
      if (url === "/api/ask/trade/build") return multiHopBuild();
      // Two confirm calls: first for leg A (USDC->MON), then leg B (MON->GRAD).
      if (body?.fromToken === "USDC") return { success: true, explorerUrl: "https://explorer.monad.xyz/tx/0xlegA" };
      return { success: true, explorerUrl: "https://explorer.monad.xyz/tx/0xlegB" };
    });
    const progressLabels: string[] = [];
    try {
      const sendTransaction = vi.fn().mockResolvedValueOnce("0xapprove").mockResolvedValueOnce("0xlegA").mockResolvedValueOnce("0xlegB");
      const wallet = { sendTransaction, waitForReceipt: vi.fn().mockResolvedValue({ status: "success" }) };
      const result = await executeTradeIntent(tradeOperation(), wallet, WALLET, (l) => progressLabels.push(l));
      expect(sendTransaction).toHaveBeenCalledTimes(3);
      expect(result.status).toBe("success");
      expect(result.result?.txHash).toBe("0xlegB");
      expect(result.result?.explorerUrl).toBe("https://explorer.monad.xyz/tx/0xlegB");

      const confirmCalls = calls.filter((c) => c.url === "/api/swap/confirm");
      expect(confirmCalls).toHaveLength(2);
      expect(confirmCalls[0].body).toMatchObject({ txHash: "0xlegA", fromToken: "USDC", toToken: "MON", amountIn: 50, amountOut: 100, provider: "Uniswap v3" });
      expect(confirmCalls[1].body).toMatchObject({ txHash: "0xlegB", fromToken: "MON", toToken: "GRAD", amountIn: 100, amountOut: 5000, provider: "Nad.Fun" });
      expect(progressLabels.some((l) => /confirming.*uniswap/i.test(l))).toBe(true);
      expect(progressLabels.some((l) => /finalizing trade/i.test(l))).toBe(true);
    } finally { restore(); }
  });
});

describe("executeTradeIntent — multi-hop partial completion (leg A done, leg B never happened)", () => {
  it("leg A confirms and settles, then leg B's SIGNATURE IS REJECTED — an honest, specific error with leg A's real hash, never a vague 'submitted'", async () => {
    const { executeTradeIntent } = await import("@/lib/ask/intent/orchestrate");
    const { restore } = mockFetch((url) => {
      if (url === "/api/ask/trade/build") return multiHopBuild();
      return { success: true, explorerUrl: "https://explorer.monad.xyz/tx/0xlegA" };
    });
    try {
      const sendTransaction = vi.fn()
        .mockResolvedValueOnce("0xapprove")
        .mockResolvedValueOnce("0xlegA")
        .mockRejectedValueOnce(new Error("User rejected the request")); // leg B's signature refused
      const wallet = { sendTransaction, waitForReceipt: vi.fn().mockResolvedValue({ status: "success" }) };
      const result = await executeTradeIntent(tradeOperation(), wallet, WALLET);
      // NOT "submitted" -- leg B never broadcast, there is nothing pending
      // to wait for. Leg A's real, confirmed transaction is disclosed instead.
      expect(result.status).toBe("error");
      expect(result.submitted).toBeUndefined();
      expect(result.error?.code).toBe("PARTIAL_MULTI_HOP");
      expect(result.error?.txHash).toBe("0xlegA");
      expect(result.error?.explorerUrl).toBe("https://explorer.monad.xyz/tx/0xlegA");
      expect(result.error?.message).toMatch(/0xlegA/);
    } finally { restore(); }
  });

  it("leg A confirms and settles, then leg B BROADCASTS but times out — this is genuinely still 'submitted' (leg B's own outcome is truly unknown yet), using leg B's hash", async () => {
    const { executeTradeIntent } = await import("@/lib/ask/intent/orchestrate");
    const original = globalThis.fetch;
    let confirmCallCount = 0;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (String(url) === "/api/ask/trade/build") return new Response(JSON.stringify(multiHopBuild()), { status: 200 });
      confirmCallCount += 1;
      if (body?.fromToken === "USDC") return new Response(JSON.stringify({ success: true, explorerUrl: "https://explorer.monad.xyz/tx/0xlegA" }), { status: 200 });
      throw new Error("should not reach a second confirm call — leg B never confirms in this test");
    }) as unknown as typeof fetch;
    try {
      const sendTransaction = vi.fn().mockResolvedValueOnce("0xapprove").mockResolvedValueOnce("0xlegA").mockResolvedValueOnce("0xlegB");
      // Leg A's receipt resolves; leg B's receipt wait times out.
      const waitForReceipt = vi.fn()
        .mockResolvedValueOnce({ status: "success" }) // approve
        .mockResolvedValueOnce({ status: "success" }) // leg A swap
        .mockRejectedValueOnce(new Error("Timed out waiting for receipt")); // leg B buy
      const wallet = { sendTransaction, waitForReceipt };
      const result = await executeTradeIntent(tradeOperation(), wallet, WALLET);
      expect(result.status).toBe("submitted");
      expect(result.submitted?.txHash).toBe("0xlegB");
      expect(confirmCallCount).toBe(1); // only leg A's settle call ever happened
    } finally { globalThis.fetch = original; }
  });

  it("leg A REVERTS on-chain — the whole trade fails honestly with leg A's hash, and leg B is NEVER signed", async () => {
    const { executeTradeIntent } = await import("@/lib/ask/intent/orchestrate");
    const { restore } = mockFetch((url) => {
      if (url === "/api/ask/trade/build") return multiHopBuild();
      return { success: false, reverted: true, error: "This trade failed on-chain. No tokens were traded.", explorerUrl: "https://explorer.monad.xyz/tx/0xlegAreverted" };
    });
    try {
      const sendTransaction = vi.fn().mockResolvedValueOnce("0xapprove").mockResolvedValueOnce("0xlegAreverted");
      const wallet = { sendTransaction, waitForReceipt: vi.fn().mockResolvedValue({ status: "reverted" }) };
      const result = await executeTradeIntent(tradeOperation(), wallet, WALLET);
      expect(sendTransaction).toHaveBeenCalledTimes(2); // approve + leg A only — leg B never attempted
      expect(result.status).toBe("error");
      expect(result.error?.code).toBe("REVERTED");
      expect(result.error?.txHash).toBe("0xlegAreverted");
    } finally { restore(); }
  });

  it("leg A succeeds, leg B REVERTS on-chain — reported against leg B's hash, distinct from a leg-A revert", async () => {
    const { executeTradeIntent } = await import("@/lib/ask/intent/orchestrate");
    const { restore } = mockFetch((url, body) => {
      if (url === "/api/ask/trade/build") return multiHopBuild();
      if (body?.fromToken === "USDC") return { success: true, explorerUrl: "https://explorer.monad.xyz/tx/0xlegA" };
      return { success: false, reverted: true, error: "This trade failed on-chain. No tokens were traded.", explorerUrl: "https://explorer.monad.xyz/tx/0xlegBreverted" };
    });
    try {
      const sendTransaction = vi.fn().mockResolvedValueOnce("0xapprove").mockResolvedValueOnce("0xlegA").mockResolvedValueOnce("0xlegBreverted");
      const wallet = { sendTransaction, waitForReceipt: vi.fn().mockResolvedValue({ status: "success" }) };
      const result = await executeTradeIntent(tradeOperation(), wallet, WALLET);
      expect(sendTransaction).toHaveBeenCalledTimes(3); // every step DID get signed — leg B just reverted
      expect(result.status).toBe("error");
      expect(result.error?.code).toBe("REVERTED");
      expect(result.error?.txHash).toBe("0xlegBreverted");
    } finally { restore(); }
  });
});
