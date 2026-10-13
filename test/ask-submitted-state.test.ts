import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Operation, SwapIntent, TradePreviewIntent } from "@/lib/ask/types";

/**
 * P0 — the broadcast-but-unconfirmed state.
 *
 * A swap/trade that the wallet successfully BROADCASTS (a real txHash exists)
 * but whose confirmation we can't yet observe — a receipt-wait timeout, or an
 * inconclusive server confirm check — must NEVER be shown as a red "Failed".
 * The funds may already have moved. These tests pin the four distinct outcomes
 * executeSwapIntent / executeTradeIntent must produce:
 *
 *   1. Failed BEFORE broadcast          → status "error",     code NOT_SENT   (red)
 *   2. Broadcast, confirmation unknown  → status "submitted"                  (amber)
 *   3. Confirmed success                → status "success",   result attached (green)
 *   4. Confirmed on-chain revert        → status "error",     code REVERTED   (red)
 *
 * plus the invariants that make the amber state honest: the real broadcast
 * hash is preserved, a clickable explorer link is always present, the pending
 * settlement is kept (never cleared) so the background reconciler resolves the
 * true outcome, and the transaction is never rebroadcast just because
 * confirmation timed out.
 */

const WALLET = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";

// Spy on the pending-settlement store so we can assert the reconciliation
// contract directly (kept on submitted, cleared only on a definitive outcome).
const saveSpy = vi.fn();
const clearSpy = vi.fn();
vi.mock("@/lib/hooks/pendingSettlement", () => ({
  savePendingSettlement: (p: unknown) => saveSpy(p),
  clearPendingSettlement: () => clearSpy(),
  getPendingSettlement: () => null,
}));

function mockFetch(responder: (url: string, body: Record<string, unknown> | undefined) => unknown) {
  const original = globalThis.fetch;
  const calls: { url: string; body: Record<string, unknown> | undefined }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: String(url), body });
    return new Response(JSON.stringify(responder(String(url), body)), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

/** A ready trade card whose route provider is overridable, so the same
 *  classification can be asserted across Uniswap / Kuru / Nad.Fun. */
function tradeOperation(provider = "Uniswap v3"): Operation {
  const intent: TradePreviewIntent = {
    kind: "trade_preview", network: "monad",
    data: {
      action: "buy", spend: { amount: "50", token: "USDC" }, receive: { amount: "12345", token: "RANDO" },
      rate: "1 USDC ≈ 246.9 RANDO", minimumReceived: "12283.28 RANDO", priceImpact: "0.30%", highPriceImpact: false,
      route: { provider, path: ["USDC", "RANDO"] }, slippage: "0.50%", network: "Monad", quotedAt: Date.now(), fee: null,
    },
    execution: { request: { action: "buy", inputToken: "USDC", outputToken: "0xaaaabbbbccccddddeeeeffff0000111122223333", amount: "50", amountType: "exact_input", slippage: null } },
  };
  return { id: "op_1", intent, status: "ready", confirmLabel: "Confirm trade" };
}

/** The build response for a single-step (no approval) trade. */
function readyBuild(provider = "Uniswap v3", steps?: unknown) {
  return {
    ok: true, status: "ready",
    preview: { action: "buy", spend: { amount: "50", token: "USDC" }, receive: { amount: "12345", token: "RANDO" }, rate: "x", minimumReceived: "x", priceImpact: null, highPriceImpact: false, route: { provider, path: ["USDC", "RANDO"] }, slippage: "0.50%", network: "Monad", quotedAt: Date.now(), fee: null },
    steps: steps ?? [{ kind: "swap", label: "Trade 50 USDC for RANDO", tx: { to: "0xRouterAddress00000000000000000000000000", data: "0xswap", value: "0x0" } }],
  };
}

/** A ready swap card with a real execution plan (executeSwapIntent needs no
 *  build round-trip — it signs the plan directly). */
function swapOperation(steps: { kind: "approve" | "swap"; label: string; tx: { to: string; data: string; value: string } }[]): Operation {
  const intent: SwapIntent = {
    kind: "swap", network: "monad", fromToken: "USDC", toToken: "RANDO", fromAmount: "50",
    execution: {
      plan: {
        quote: { fromToken: "USDC", toToken: "RANDO", amountIn: 50, amountOut: 12345, minAmountOut: 12283, feeTier: 3000, slippage: 0.5, priceImpact: 0.3 },
        steps, summary: "Swap 50 USDC for RANDO",
      },
      quotedAt: Date.now(),
    },
  } as SwapIntent;
  return { id: "op_swap_1", intent, status: "ready" };
}

const SWAP_STEP = [{ kind: "swap" as const, label: "Swap 50 USDC for RANDO", tx: { to: "0xRouterAddress00000000000000000000000000", data: "0xswap", value: "0x0" } }];

beforeEach(() => { saveSpy.mockClear(); clearSpy.mockClear(); });
afterEach(() => { vi.restoreAllMocks(); });

describe("Scenario 1 — broadcast succeeds AND confirmation succeeds → green success", () => {
  it("(trade) returns success with the real txHash + explorerUrl, and clears the pending settlement", async () => {
    const { executeTradeIntent } = await import("@/lib/ask/intent/orchestrate");
    const { restore } = mockFetch((url) => url === "/api/ask/trade/build" ? readyBuild() : { success: true, explorerUrl: "https://explorer.monad.xyz/tx/0xtrade" });
    try {
      const wallet = { sendTransaction: vi.fn().mockResolvedValue("0xtrade"), waitForReceipt: vi.fn().mockResolvedValue({ status: "success" }) };
      const result = await executeTradeIntent(tradeOperation(), wallet, WALLET);
      expect(result.status).toBe("success");
      expect(result.submitted).toBeUndefined();
      expect(result.result?.txHash).toBe("0xtrade");
      expect(result.result?.explorerUrl).toMatch(/0xtrade/);
      expect(clearSpy).toHaveBeenCalled();
    } finally { restore(); }
  });

  it("(swap) returns success and clears the pending settlement", async () => {
    const { executeSwapIntent } = await import("@/lib/ask/intent/orchestrate");
    const { restore } = mockFetch(() => ({ success: true, explorerUrl: "https://explorer.monad.xyz/tx/0xswap" }));
    try {
      const wallet = { sendTransaction: vi.fn().mockResolvedValue("0xswap"), waitForReceipt: vi.fn().mockResolvedValue({ status: "success" }) };
      const result = await executeSwapIntent(swapOperation(SWAP_STEP), wallet, WALLET);
      expect(result.status).toBe("success");
      expect(result.result?.txHash).toBe("0xswap");
      expect(clearSpy).toHaveBeenCalled();
    } finally { restore(); }
  });
});

describe("Scenario 2 — broadcast succeeds but confirmation TIMES OUT → amber submitted, never failed", () => {
  it("(trade) receipt-wait timeout is reported as submitted with the broadcast hash, not an error", async () => {
    const { executeTradeIntent } = await import("@/lib/ask/intent/orchestrate");
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      if (String(url) === "/api/ask/trade/build") {
        return new Response(JSON.stringify(readyBuild()), { status: 200 });
      }
      throw new Error("RPC timeout confirming");
    }) as unknown as typeof fetch;
    try {
      const wallet = { sendTransaction: vi.fn().mockResolvedValue("0xbroadcasted"), waitForReceipt: vi.fn().mockRejectedValue(new Error("Timed out waiting for receipt")) };
      const result = await executeTradeIntent(tradeOperation(), wallet, WALLET);
      expect(result.status).toBe("submitted");
      expect(result.error).toBeUndefined();
      expect(result.submitted?.txHash).toBe("0xbroadcasted");
    } finally { globalThis.fetch = original; }
  });

  it("(swap) receipt-wait timeout is reported as submitted, not an error", async () => {
    const { executeSwapIntent } = await import("@/lib/ask/intent/orchestrate");
    const wallet = { sendTransaction: vi.fn().mockResolvedValue("0xswapbroadcast"), waitForReceipt: vi.fn().mockRejectedValue(new Error("Timed out waiting for receipt")) };
    const result = await executeSwapIntent(swapOperation(SWAP_STEP), wallet, WALLET);
    expect(result.status).toBe("submitted");
    expect(result.error).toBeUndefined();
    expect(result.submitted?.txHash).toBe("0xswapbroadcast");
  });

  it("(trade) an inconclusive server confirm (no success, no reverted) is ALSO submitted, keeping the server's explorerUrl", async () => {
    const { executeTradeIntent } = await import("@/lib/ask/intent/orchestrate");
    const { restore } = mockFetch((url) => url === "/api/ask/trade/build"
      ? readyBuild()
      : { error: "Couldn't confirm your trade yet — it may still settle.", explorerUrl: "https://explorer.monad.xyz/tx/0xpending" });
    try {
      const wallet = { sendTransaction: vi.fn().mockResolvedValue("0xpending"), waitForReceipt: vi.fn().mockResolvedValue({ status: "success" }) };
      const result = await executeTradeIntent(tradeOperation(), wallet, WALLET);
      expect(result.status).toBe("submitted");
      expect(result.error).toBeUndefined();
      expect(result.submitted?.txHash).toBe("0xpending");
      // When the server DID hand back an explorer URL, we use it verbatim.
      expect(result.submitted?.explorerUrl).toBe("https://explorer.monad.xyz/tx/0xpending");
    } finally { restore(); }
  });
});

describe("Scenario 3 & 4 — the true outcome is resolved later, honestly", () => {
  it("(3) a submitted trade KEEPS its pending settlement so the reconciler can resolve it — never cleared", async () => {
    const { executeTradeIntent } = await import("@/lib/ask/intent/orchestrate");
    const { restore } = mockFetch((url) => url === "/api/ask/trade/build"
      ? readyBuild()
      : { error: "Couldn't confirm yet.", explorerUrl: "https://explorer.monad.xyz/tx/0xpending" });
    try {
      const wallet = { sendTransaction: vi.fn().mockResolvedValue("0xpending"), waitForReceipt: vi.fn().mockResolvedValue({ status: "success" }) };
      const result = await executeTradeIntent(tradeOperation(), wallet, WALLET);
      expect(result.status).toBe("submitted");
      expect(saveSpy).toHaveBeenCalledTimes(1);   // saved when the tx broadcast
      expect(clearSpy).not.toHaveBeenCalled();     // and NEVER cleared while unconfirmed
    } finally { restore(); }
  });

  it("(4) a CONFIRMED on-chain revert is a real, final error (REVERTED) — and the pending settlement IS cleared", async () => {
    const { executeTradeIntent } = await import("@/lib/ask/intent/orchestrate");
    const { restore } = mockFetch((url) => url === "/api/ask/trade/build"
      ? readyBuild()
      : { success: false, reverted: true, error: "This trade failed on-chain. No tokens were traded.", explorerUrl: "https://explorer.monad.xyz/tx/0xreverted" });
    try {
      const wallet = { sendTransaction: vi.fn().mockResolvedValue("0xreverted"), waitForReceipt: vi.fn().mockResolvedValue({ status: "reverted" }) };
      const result = await executeTradeIntent(tradeOperation(), wallet, WALLET);
      expect(result.status).toBe("error");
      expect(result.submitted).toBeUndefined();
      expect(result.error?.code).toBe("REVERTED");
      // A confirmed revert points at the real reverted tx.
      expect(result.error?.txHash).toBe("0xreverted");
      expect(clearSpy).toHaveBeenCalled();
    } finally { restore(); }
  });
});

describe("Scenario 5 — a failure BEFORE broadcast stays a red error, with no txHash", () => {
  it("(trade) a rejected signature is NOT_SENT — no submitted, no tx to point at", async () => {
    const { executeTradeIntent } = await import("@/lib/ask/intent/orchestrate");
    const { restore } = mockFetch((url) => url === "/api/ask/trade/build" ? readyBuild() : { success: true });
    try {
      const wallet = { sendTransaction: vi.fn().mockRejectedValue(new Error("User rejected the request")), waitForReceipt: vi.fn() };
      const result = await executeTradeIntent(tradeOperation(), wallet, WALLET);
      expect(result.status).toBe("error");
      expect(result.error?.code).toBe("NOT_SENT");
      expect(result.submitted).toBeUndefined();
      expect(result.error?.txHash).toBeUndefined();
    } finally { restore(); }
  });

  it("(swap) a rejected signature is NOT_SENT with no submitted state", async () => {
    const { executeSwapIntent } = await import("@/lib/ask/intent/orchestrate");
    const wallet = { sendTransaction: vi.fn().mockRejectedValue(new Error("User rejected the request")), waitForReceipt: vi.fn() };
    const result = await executeSwapIntent(swapOperation(SWAP_STEP), wallet, WALLET);
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("NOT_SENT");
    expect(result.submitted).toBeUndefined();
    // Nothing was ever saved because nothing was ever broadcast.
    expect(saveSpy).not.toHaveBeenCalled();
  });
});

describe("Scenario 6 & 7 — the amber state is genuinely useful: real hash, real clickable link", () => {
  it("(6) the exact wallet-returned broadcast hash is preserved into submitted.txHash", async () => {
    const { executeTradeIntent } = await import("@/lib/ask/intent/orchestrate");
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      if (String(url) === "/api/ask/trade/build") return new Response(JSON.stringify(readyBuild()), { status: 200 });
      throw new Error("timeout");
    }) as unknown as typeof fetch;
    try {
      const wallet = { sendTransaction: vi.fn().mockResolvedValue("0xDEADBEEFcafe1234"), waitForReceipt: vi.fn().mockRejectedValue(new Error("timeout")) };
      const result = await executeTradeIntent(tradeOperation(), wallet, WALLET);
      expect(result.submitted?.txHash).toBe("0xDEADBEEFcafe1234");
    } finally { globalThis.fetch = original; }
  });

  it("(7a) when the server returned NO explorerUrl (timeout path), one is DERIVED from client-safe config and contains the hash", async () => {
    const { executeTradeIntent } = await import("@/lib/ask/intent/orchestrate");
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      if (String(url) === "/api/ask/trade/build") return new Response(JSON.stringify(readyBuild()), { status: 200 });
      throw new Error("timeout");
    }) as unknown as typeof fetch;
    try {
      const wallet = { sendTransaction: vi.fn().mockResolvedValue("0xnoserverurl"), waitForReceipt: vi.fn().mockRejectedValue(new Error("timeout")) };
      const result = await executeTradeIntent(tradeOperation(), wallet, WALLET);
      expect(result.submitted?.explorerUrl).toBeTruthy();
      expect(result.submitted?.explorerUrl).toMatch(/\/tx\/0xnoserverurl$/);
      // Never the wrong-network/testnet fallback smuggled from a non-public env.
      expect(result.submitted?.explorerUrl).toMatch(/^https?:\/\//);
    } finally { globalThis.fetch = original; }
  });

  it("(7b) when the server DID return an explorerUrl (inconclusive confirm), it is used verbatim", async () => {
    const { executeSwapIntent } = await import("@/lib/ask/intent/orchestrate");
    const { restore } = mockFetch(() => ({ error: "Couldn't confirm yet.", explorerUrl: "https://explorer.monad.xyz/tx/0xserversaid" }));
    try {
      const wallet = { sendTransaction: vi.fn().mockResolvedValue("0xserversaid"), waitForReceipt: vi.fn().mockResolvedValue({ status: "success" }) };
      const result = await executeSwapIntent(swapOperation(SWAP_STEP), wallet, WALLET);
      expect(result.status).toBe("submitted");
      expect(result.submitted?.explorerUrl).toBe("https://explorer.monad.xyz/tx/0xserversaid");
    } finally { restore(); }
  });
});

describe("Scenario 8 — the UI renders the submitted state as a clickable, honest in-progress card", () => {
  const src = readFileSync(new URL("../components/ask/OperationCard.tsx", import.meta.url), "utf8");

  it("declares a 'submitted' status chip in neutral, in-progress tones — never the red problem/failure treatment", () => {
    // Warning and danger are both red now (app/globals.css): either would make
    // a payment that is merely confirming look failed, inviting a retry.
    const chip = src.slice(src.indexOf("submitted:"), src.indexOf("submitted:") + 120);
    expect(chip).toMatch(/tone: "neutral"/);
    expect(chip).not.toMatch(/warning|danger|destructive|text-error\b/);
  });

  it("renders a dedicated SubmittedBody with a clickable explorer link built from submitted.explorerUrl", () => {
    expect(src).toMatch(/SubmittedBody/);
    // The link href must come from the real submitted.explorerUrl, and the tx
    // hash must be surfaced for the user to click through.
    expect(src).toMatch(/submitted\.explorerUrl/);
    expect(src).toMatch(/submitted\.txHash/);
    // The hash itself is the explorer link (TxLink opens it in a new tab).
    expect(src).toMatch(/<TxLink hash=\{submitted\.txHash\} href=\{submitted\.explorerUrl\}/);
  });

  it("never labels the submitted state as failed, and never shows the retry/confirm footer for it", () => {
    // The footer (which offers confirm/retry) is suppressed for submitted.
    expect(src).toMatch(/status !== "submitted"/);
  });
});

describe("Scenario 9 — a confirmation timeout NEVER triggers a rebroadcast", () => {
  it("(trade) sendTransaction is called exactly once even though confirmation failed", async () => {
    const { executeTradeIntent } = await import("@/lib/ask/intent/orchestrate");
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      if (String(url) === "/api/ask/trade/build") return new Response(JSON.stringify(readyBuild()), { status: 200 });
      throw new Error("timeout");
    }) as unknown as typeof fetch;
    const sendTransaction = vi.fn().mockResolvedValue("0xonce");
    try {
      const wallet = { sendTransaction, waitForReceipt: vi.fn().mockRejectedValue(new Error("timeout")) };
      await executeTradeIntent(tradeOperation(), wallet, WALLET);
      expect(sendTransaction).toHaveBeenCalledTimes(1);
    } finally { globalThis.fetch = original; }
  });

  it("(swap) sendTransaction is called exactly once on a confirm timeout", async () => {
    const { executeSwapIntent } = await import("@/lib/ask/intent/orchestrate");
    const sendTransaction = vi.fn().mockResolvedValue("0xonce");
    const wallet = { sendTransaction, waitForReceipt: vi.fn().mockRejectedValue(new Error("timeout")) };
    await executeSwapIntent(swapOperation(SWAP_STEP), wallet, WALLET);
    expect(sendTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("Scenario 10 — the background reconciliation contract is intact", () => {
  it("(trade) the pending settlement is saved the moment the tx broadcasts, and NOT cleared while submitted", async () => {
    const { executeTradeIntent } = await import("@/lib/ask/intent/orchestrate");
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      if (String(url) === "/api/ask/trade/build") return new Response(JSON.stringify(readyBuild()), { status: 200 });
      throw new Error("timeout");
    }) as unknown as typeof fetch;
    try {
      const wallet = { sendTransaction: vi.fn().mockResolvedValue("0xkept"), waitForReceipt: vi.fn().mockRejectedValue(new Error("timeout")) };
      await executeTradeIntent(tradeOperation(), wallet, WALLET);
      expect(saveSpy).toHaveBeenCalledTimes(1);
      expect(saveSpy.mock.calls[0][0]).toMatchObject({ kind: "swap", walletAddress: WALLET, txHash: "0xkept" });
      expect(clearSpy).not.toHaveBeenCalled();
    } finally { globalThis.fetch = original; }
  });
});

describe("Scenario 11 & 12 — multi-step (approve → trade) never disguises which step is which", () => {
  const approveThenTrade = [
    { kind: "approve" as const, label: "Approve 50 USDC for the trade", tx: { to: "0xUSDCToken000000000000000000000000000000", data: "0xapprove", value: "0x0" } },
    { kind: "swap" as const, label: "Trade 50 USDC for RANDO", tx: { to: "0xRouterAddress00000000000000000000000000", data: "0xswap", value: "0x0" } },
  ];

  it("(11) approval CONFIRMS then the trade broadcasts but times out → submitted with approvalConfirmed = true", async () => {
    const { executeTradeIntent } = await import("@/lib/ask/intent/orchestrate");
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      if (String(url) === "/api/ask/trade/build") return new Response(JSON.stringify(readyBuild("Uniswap v3", approveThenTrade)), { status: 200 });
      throw new Error("timeout");
    }) as unknown as typeof fetch;
    try {
      // Approval receipt resolves; the trade receipt times out.
      const waitForReceipt = vi.fn().mockResolvedValueOnce({ status: "success" }).mockRejectedValueOnce(new Error("timeout"));
      const wallet = { sendTransaction: vi.fn().mockResolvedValueOnce("0xapprovehash").mockResolvedValueOnce("0xtradehash"), waitForReceipt };
      const result = await executeTradeIntent(tradeOperation(), wallet, WALLET);
      expect(result.status).toBe("submitted");
      expect(result.submitted?.approvalConfirmed).toBe(true);
      // It's the TRADE hash that's submitted, never the approval's.
      expect(result.submitted?.txHash).toBe("0xtradehash");
    } finally { globalThis.fetch = original; }
  });

  it("(12) approval confirms then the trade genuinely REVERTS → a real error, approval not passed off as the trade", async () => {
    const { executeTradeIntent } = await import("@/lib/ask/intent/orchestrate");
    const { restore } = mockFetch((url) => url === "/api/ask/trade/build"
      ? readyBuild("Uniswap v3", approveThenTrade)
      : { success: false, reverted: true, error: "This trade failed on-chain. No tokens were traded." });
    try {
      const wallet = { sendTransaction: vi.fn().mockResolvedValueOnce("0xapprovehash").mockResolvedValueOnce("0xtradehash"), waitForReceipt: vi.fn().mockResolvedValue({ status: "success" }) };
      const result = await executeTradeIntent(tradeOperation(), wallet, WALLET);
      expect(result.status).toBe("error");
      expect(result.error?.code).toBe("REVERTED");
      // The revert is pinned to the trade hash, not the earlier successful approval.
      expect(result.error?.txHash).toBe("0xtradehash");
    } finally { restore(); }
  });
});

describe("Scenario 13 — payment execution is untouched by this change", () => {
  const orchestrateSrc = readFileSync(new URL("../lib/ask/intent/orchestrate.ts", import.meta.url), "utf8");

  it("only swap/trade/protocol-action execution produces a 'submitted' status — payment paths never do", () => {
    // Guard against a future edit leaking the submitted state into a code path
    // (payments) that doesn't have a broadcast-but-unconfirmed reconciler
    // wired the same way. Every submitted producer lives in an execute*Intent
    // function and is backed by a real on-chain verification (a receipt wait
    // plus a server confirm route).
    const submittedCount = (orchestrateSrc.match(/status: "submitted"/g) ?? []).length;
    // Exactly seven submitted returns:
    //   - swap: confirm + catch (2)
    //   - trade: confirm + catch (2)
    //   - protocol_action (Phase 2): confirm-unreachable + confirm-not-success
    //     + catch (3) — the same broadcast-then-unconfirmed semantics, verified
    //     via wallet.waitForReceipt + /api/ask/action/confirm.
    // No more — an eighth would mean it leaked into a path without that
    // verification (e.g. the payment send path).
    expect(submittedCount).toBe(7);
  });

  it("does not reference the payment send path inside the submitted classification", () => {
    // The submitted branches sit only inside executeSwapIntent/executeTradeIntent.
    const firstSubmitted = orchestrateSrc.indexOf('status: "submitted"');
    const swapFnStart = orchestrateSrc.indexOf("export async function executeSwapIntent");
    expect(firstSubmitted).toBeGreaterThan(swapFnStart);
  });
});

describe("Scenario 14 — provider-agnostic: Uniswap, Kuru and Nad.Fun classify identically", () => {
  for (const provider of ["Uniswap v3", "Kuru", "Nad.Fun"]) {
    it(`(${provider}) a broadcast-then-timeout is submitted, not failed`, async () => {
      const { executeTradeIntent } = await import("@/lib/ask/intent/orchestrate");
      const original = globalThis.fetch;
      globalThis.fetch = (async (url: string) => {
        if (String(url) === "/api/ask/trade/build") return new Response(JSON.stringify(readyBuild(provider)), { status: 200 });
        throw new Error("timeout");
      }) as unknown as typeof fetch;
      try {
        const wallet = { sendTransaction: vi.fn().mockResolvedValue("0xprov"), waitForReceipt: vi.fn().mockRejectedValue(new Error("timeout")) };
        const result = await executeTradeIntent(tradeOperation(provider), wallet, WALLET);
        expect(result.status).toBe("submitted");
        expect(result.submitted?.txHash).toBe("0xprov");
      } finally { globalThis.fetch = original; }
    });

    it(`(${provider}) a confirmed revert is still a real REVERTED failure`, async () => {
      const { executeTradeIntent } = await import("@/lib/ask/intent/orchestrate");
      const { restore } = mockFetch((url) => url === "/api/ask/trade/build"
        ? readyBuild(provider)
        : { success: false, reverted: true, error: "Reverted on-chain." });
      try {
        const wallet = { sendTransaction: vi.fn().mockResolvedValue("0xrev"), waitForReceipt: vi.fn().mockResolvedValue({ status: "reverted" }) };
        const result = await executeTradeIntent(tradeOperation(provider), wallet, WALLET);
        expect(result.status).toBe("error");
        expect(result.error?.code).toBe("REVERTED");
      } finally { restore(); }
    });
  }
});
