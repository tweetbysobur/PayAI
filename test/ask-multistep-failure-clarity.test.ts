import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Operation, PaymentIntent, SwapIntent, TradePreviewIntent } from "@/lib/ask/types";

/**
 * P1.4 — multi-step failure clarity.
 *
 * The audited bug: executeSwapIntent/executeTradeIntent tracked ONE
 * `broadcastHash` variable across the whole approve-then-trade loop,
 * without resetting it between steps. If the approval confirmed and then
 * the TRADE's own signature was rejected (or threw before ever reaching
 * the wallet), the catch block still saw the APPROVAL's hash sitting in
 * `broadcastHash` from the prior iteration — and reported "Trade submitted"
 * using it, misattributing an already-CONFIRMED approval as a still-PENDING
 * trade. These tests pin the fix: every result must attribute the right
 * hash to the right transaction, never imply an approval moved funds, and
 * always say plainly when an approval already succeeded but the trade
 * itself failed or was never sent.
 */

const WALLET = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";

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

function readyBuildWithApproval(provider = "Uniswap v3") {
  const steps = [
    { kind: "approve" as const, label: "Approve 50 USDC for the trade", tx: { to: "0xUSDCToken000000000000000000000000000000", data: "0xapprove", value: "0x0" } },
    { kind: "swap" as const, label: "Trade 50 USDC for RANDO", tx: { to: "0xRouterAddress00000000000000000000000000", data: "0xswap", value: "0x0" } },
  ];
  return {
    ok: true, status: "ready",
    preview: { action: "buy", spend: { amount: "50", token: "USDC" }, receive: { amount: "12345", token: "RANDO" }, rate: "x", minimumReceived: "x", priceImpact: null, highPriceImpact: false, route: { provider, path: ["USDC", "RANDO"] }, slippage: "0.50%", network: "Monad", quotedAt: Date.now(), fee: null },
    steps,
  };
}

function swapOperationWithApproval(): Operation {
  const steps = [
    { kind: "approve" as const, label: "Approve 50 USDC", tx: { to: "0xUSDCToken000000000000000000000000000000", data: "0xapprove", value: "0x0" } },
    { kind: "swap" as const, label: "Swap 50 USDC for RANDO", tx: { to: "0xRouterAddress00000000000000000000000000", data: "0xswap", value: "0x0" } },
  ];
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

function paymentOperationWithApproval(): Operation {
  const intent: PaymentIntent = {
    kind: "payment", network: "monad", token: "USDC", amount: "10", recipient: "0x1111111111111111111111111111111111111111",
    execution: {
      unsignedTx: { to: "0xforwarder0000000000000000000000000000000", data: "0xforward", from: WALLET },
      approvalTx: { to: "0xUSDCToken000000000000000000000000000000", data: "0xapprove", from: WALLET },
      approvalLabel: "Approve 10 USDC for PayAI",
      confirmRawText: "send 10 USDC to 0x1111111111111111111111111111111111111111",
      requestId: "req_1",
    },
  };
  return { id: "op_pay_1", intent, status: "ready" };
}

beforeEach(() => { saveSpy.mockClear(); clearSpy.mockClear(); });
afterEach(() => { vi.restoreAllMocks(); });

describe("1. approval succeeds + trade succeeds — full success, both hashes distinct", () => {
  it("(trade)", async () => {
    const { executeTradeIntent } = await import("@/lib/ask/intent/orchestrate");
    const { restore } = mockFetch((url) => url === "/api/ask/trade/build" ? readyBuildWithApproval() : { success: true, explorerUrl: "https://explorer.monad.xyz/tx/0xtradehash" });
    try {
      const wallet = {
        sendTransaction: vi.fn().mockResolvedValueOnce("0xapprovehash").mockResolvedValueOnce("0xtradehash"),
        waitForReceipt: vi.fn().mockResolvedValue({ status: "success" }),
      };
      const result = await executeTradeIntent(tradeOperation(), wallet, WALLET);
      expect(result.status).toBe("success");
      expect(result.result?.txHash).toBe("0xtradehash");
      expect(result.error).toBeUndefined();
      expect(result.submitted).toBeUndefined();
    } finally { restore(); }
  });
});

describe("2. approval rejected by wallet — clean pre-broadcast failure, no txHash at all", () => {
  it("(trade)", async () => {
    const { executeTradeIntent } = await import("@/lib/ask/intent/orchestrate");
    const { restore } = mockFetch((url) => url === "/api/ask/trade/build" ? readyBuildWithApproval() : { success: true });
    try {
      const wallet = { sendTransaction: vi.fn().mockRejectedValue(new Error("User rejected the request")), waitForReceipt: vi.fn() };
      const result = await executeTradeIntent(tradeOperation(), wallet, WALLET);
      expect(result.status).toBe("error");
      expect(result.error?.code).toBe("NOT_SENT");
      expect(result.error?.txHash).toBeUndefined();
      expect(result.error?.approvalTx).toBeUndefined();
    } finally { restore(); }
  });

  it("(payment)", async () => {
    const { executeSendPayment } = await import("@/lib/ask/sendPayment/orchestrator");
    const wallet = { sendTransaction: vi.fn().mockRejectedValue(new Error("User rejected the request")), waitForReceipt: vi.fn() };
    const result = await executeSendPayment(paymentOperationWithApproval(), wallet);
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("APPROVAL_NOT_SENT");
    expect(result.error?.approvalTx).toBeUndefined();
  });
});

describe("3. approval fails on-chain (reverted) — a real error with its OWN hash, never lost", () => {
  it("(payment) APPROVAL_REVERTED now preserves the approval's own txHash/explorerUrl", async () => {
    const { executeSendPayment } = await import("@/lib/ask/sendPayment/orchestrator");
    const wallet = {
      sendTransaction: vi.fn().mockResolvedValueOnce("0xapprovereverted"),
      waitForReceipt: vi.fn().mockResolvedValueOnce({ status: "reverted" }),
    };
    const result = await executeSendPayment(paymentOperationWithApproval(), wallet);
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("APPROVAL_REVERTED");
    expect(result.error?.txHash).toBe("0xapprovereverted");
    expect(result.error?.explorerUrl).toContain("0xapprovereverted");
    // Only ONE signature was ever requested — the payment itself was never attempted.
    expect(wallet.sendTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("4. approval submitted/unconfirmed — never shown as failed", () => {
  it("(payment) approval broadcasts but its OWN receipt wait throws → submitted, not a generic failure", async () => {
    const { executeSendPayment } = await import("@/lib/ask/sendPayment/orchestrator");
    const wallet = {
      sendTransaction: vi.fn().mockResolvedValueOnce("0xapprovepending"),
      waitForReceipt: vi.fn().mockRejectedValueOnce(new Error("RPC timeout")),
    };
    const result = await executeSendPayment(paymentOperationWithApproval(), wallet);
    expect(result.status).toBe("submitted");
    expect(result.error).toBeUndefined();
    expect(result.submitted?.txHash).toBe("0xapprovepending");
    expect(result.submitted?.step).toBe("approval");
    // The payment itself must never be signed on top of an unconfirmed approval.
    expect(wallet.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it("(trade) the approval step itself times out mid-loop → submitted with step 'approval', not 'main'", async () => {
    const { executeTradeIntent } = await import("@/lib/ask/intent/orchestrate");
    const { restore } = mockFetch((url) => url === "/api/ask/trade/build" ? readyBuildWithApproval() : { success: true });
    try {
      const wallet = {
        sendTransaction: vi.fn().mockResolvedValueOnce("0xapprovepending"),
        waitForReceipt: vi.fn().mockRejectedValueOnce(new Error("timeout")),
      };
      const result = await executeTradeIntent(tradeOperation(), wallet, WALLET);
      expect(result.status).toBe("submitted");
      expect(result.submitted?.txHash).toBe("0xapprovepending");
      expect(result.submitted?.step).toBe("approval");
      expect(wallet.sendTransaction).toHaveBeenCalledTimes(1); // the trade was never even attempted
    } finally { restore(); }
  });
});

describe("5. THE BUG — approval succeeds, then the trade is rejected by the wallet", () => {
  it("(trade) reports a real NOT_SENT error, NEVER 'submitted' with the approval's stale hash", async () => {
    const { executeTradeIntent } = await import("@/lib/ask/intent/orchestrate");
    const { restore } = mockFetch((url) => url === "/api/ask/trade/build" ? readyBuildWithApproval() : { success: true });
    try {
      const wallet = {
        sendTransaction: vi.fn().mockResolvedValueOnce("0xapprovehash").mockRejectedValueOnce(new Error("User rejected the request")),
        waitForReceipt: vi.fn().mockResolvedValue({ status: "success" }), // the approval's own receipt confirms
      };
      const result = await executeTradeIntent(tradeOperation(), wallet, WALLET);
      // The core fix: this must be a real error, not "submitted" — nothing
      // new is pending, since the trade's own signature never broadcast.
      expect(result.status).toBe("error");
      expect(result.submitted).toBeUndefined();
      expect(result.error?.code).toBe("NOT_SENT");
      // The approval's hash must NEVER be reported as the trade's own txHash.
      expect(result.error?.txHash).toBeUndefined();
      // But it IS available, correctly labeled as the approval's own.
      expect(result.error?.approvalTx?.txHash).toBe("0xapprovehash");
    } finally { restore(); }
  });

  it("(swap) same fix applies to executeSwapIntent", async () => {
    const { executeSwapIntent } = await import("@/lib/ask/intent/orchestrate");
    const wallet = {
      sendTransaction: vi.fn().mockResolvedValueOnce("0xapprovehash").mockRejectedValueOnce(new Error("User rejected the request")),
      waitForReceipt: vi.fn().mockResolvedValue({ status: "success" }),
    };
    const result = await executeSwapIntent(swapOperationWithApproval(), wallet, WALLET);
    expect(result.status).toBe("error");
    expect(result.submitted).toBeUndefined();
    expect(result.error?.code).toBe("NOT_SENT");
    expect(result.error?.txHash).toBeUndefined();
    expect(result.error?.approvalTx?.txHash).toBe("0xapprovehash");
  });
});

describe("6. approval succeeds + trade submitted/unconfirmed — the TRADE's hash, not the approval's", () => {
  it("(trade)", async () => {
    const { executeTradeIntent } = await import("@/lib/ask/intent/orchestrate");
    const { restore } = mockFetch((url) => url === "/api/ask/trade/build" ? readyBuildWithApproval() : { success: true });
    try {
      const waitForReceipt = vi.fn().mockResolvedValueOnce({ status: "success" }).mockRejectedValueOnce(new Error("timeout"));
      const wallet = { sendTransaction: vi.fn().mockResolvedValueOnce("0xapprovehash").mockResolvedValueOnce("0xtradehash"), waitForReceipt };
      const result = await executeTradeIntent(tradeOperation(), wallet, WALLET);
      expect(result.status).toBe("submitted");
      expect(result.submitted?.txHash).toBe("0xtradehash"); // never the approval's
      expect(result.submitted?.step).toBe("main");
      expect(result.submitted?.approvalTx?.txHash).toBe("0xapprovehash");
      expect(result.submitted?.approvalConfirmed).toBe(true);
    } finally { restore(); }
  });
});

describe("7. approval succeeds + trade reverts — a real, specific error, approval named separately", () => {
  it("(trade) message states the trade failed, never implies the approval moved funds, and carries approvalTx", async () => {
    const { executeTradeIntent } = await import("@/lib/ask/intent/orchestrate");
    const { restore } = mockFetch((url) => url === "/api/ask/trade/build"
      ? readyBuildWithApproval()
      : { success: false, reverted: true, error: "This trade failed on-chain. No tokens were traded.", explorerUrl: "https://explorer.monad.xyz/tx/0xtradereverted" });
    try {
      const wallet = { sendTransaction: vi.fn().mockResolvedValueOnce("0xapprovehash").mockResolvedValueOnce("0xtradereverted"), waitForReceipt: vi.fn().mockResolvedValue({ status: "success" }) };
      const result = await executeTradeIntent(tradeOperation(), wallet, WALLET);
      expect(result.status).toBe("error");
      expect(result.error?.code).toBe("REVERTED");
      expect(result.error?.txHash).toBe("0xtradereverted"); // the TRADE's hash, correctly attributed
      expect(result.error?.approvalTx?.txHash).toBe("0xapprovehash"); // the approval's, separately
      expect(result.error?.message).toMatch(/approval/i);
      expect(result.error?.message).toMatch(/no funds moved/i);
    } finally { restore(); }
  });
});

describe("8. trade succeeds after approval (already covered by scenario 1, exercised again for swap)", () => {
  it("(swap)", async () => {
    const { executeSwapIntent } = await import("@/lib/ask/intent/orchestrate");
    const wallet = {
      sendTransaction: vi.fn().mockResolvedValueOnce("0xapprovehash").mockResolvedValueOnce("0xswaphash"),
      waitForReceipt: vi.fn().mockResolvedValue({ status: "success" }),
    };
    const { restore } = mockFetch(() => ({ success: true, explorerUrl: "https://explorer.monad.xyz/tx/0xswaphash" }));
    try {
      const result = await executeSwapIntent(swapOperationWithApproval(), wallet, WALLET);
      expect(result.status).toBe("success");
      expect(result.result?.txHash).toBe("0xswaphash");
    } finally { restore(); }
  });
});

describe("9 & 10 & 11. approval hash, trade hash, and their explorer URLs are all preserved and distinct", () => {
  it("submitted state carries both hashes with their own distinct explorer URLs", async () => {
    const { executeTradeIntent } = await import("@/lib/ask/intent/orchestrate");
    const { restore } = mockFetch((url) => url === "/api/ask/trade/build" ? readyBuildWithApproval() : { success: true });
    try {
      const waitForReceipt = vi.fn().mockResolvedValueOnce({ status: "success" }).mockRejectedValueOnce(new Error("timeout"));
      const wallet = { sendTransaction: vi.fn().mockResolvedValueOnce("0xAAAAapprove").mockResolvedValueOnce("0xBBBBtrade"), waitForReceipt };
      const result = await executeTradeIntent(tradeOperation(), wallet, WALLET);
      expect(result.submitted?.approvalTx?.txHash).toBe("0xAAAAapprove");
      expect(result.submitted?.txHash).toBe("0xBBBBtrade");
      expect(result.submitted?.approvalTx?.explorerUrl).toContain("0xAAAAapprove");
      expect(result.submitted?.explorerUrl).toContain("0xBBBBtrade");
      expect(result.submitted?.approvalTx?.explorerUrl).not.toBe(result.submitted?.explorerUrl);
    } finally { restore(); }
  });
});

describe("12. a submitted APPROVAL is never shown as failed", () => {
  it("(trade)", async () => {
    const { executeTradeIntent } = await import("@/lib/ask/intent/orchestrate");
    const { restore } = mockFetch((url) => url === "/api/ask/trade/build" ? readyBuildWithApproval() : { success: true });
    try {
      const wallet = { sendTransaction: vi.fn().mockResolvedValueOnce("0xapprovepending"), waitForReceipt: vi.fn().mockRejectedValueOnce(new Error("timeout")) };
      const result = await executeTradeIntent(tradeOperation(), wallet, WALLET);
      expect(result.status).not.toBe("error");
      expect(result.status).toBe("submitted");
    } finally { restore(); }
  });
});

describe("13. a submitted TRADE is never shown as failed", () => {
  it("(trade)", async () => {
    const { executeTradeIntent } = await import("@/lib/ask/intent/orchestrate");
    const { restore } = mockFetch((url) => url === "/api/ask/trade/build" ? readyBuildWithApproval() : { success: true });
    try {
      const waitForReceipt = vi.fn().mockResolvedValueOnce({ status: "success" }).mockRejectedValueOnce(new Error("timeout"));
      const wallet = { sendTransaction: vi.fn().mockResolvedValueOnce("0xapprovehash").mockResolvedValueOnce("0xtradehash"), waitForReceipt };
      const result = await executeTradeIntent(tradeOperation(), wallet, WALLET);
      expect(result.status).not.toBe("error");
      expect(result.status).toBe("submitted");
    } finally { restore(); }
  });
});

describe("14. a failed trade clearly identifies the approval as already completed", () => {
  it("(trade, NOT_SENT after approval)", async () => {
    const { executeTradeIntent } = await import("@/lib/ask/intent/orchestrate");
    const { restore } = mockFetch((url) => url === "/api/ask/trade/build" ? readyBuildWithApproval() : { success: true });
    try {
      const wallet = { sendTransaction: vi.fn().mockResolvedValueOnce("0xapprovehash").mockRejectedValueOnce(new Error("User rejected")), waitForReceipt: vi.fn().mockResolvedValue({ status: "success" }) };
      const result = await executeTradeIntent(tradeOperation(), wallet, WALLET);
      expect(result.error?.message).toMatch(/approval/i);
      expect(result.error?.message).toMatch(/confirm/i);
      expect(result.error?.approvalTx).toBeDefined();
    } finally { restore(); }
  });
});

describe("15. a failed trade never claims funds moved for the approval", () => {
  it("(trade, REVERTED after approval)", async () => {
    const { executeTradeIntent } = await import("@/lib/ask/intent/orchestrate");
    const { restore } = mockFetch((url) => url === "/api/ask/trade/build"
      ? readyBuildWithApproval()
      : { success: false, reverted: true, error: "This trade failed on-chain. No tokens were traded." });
    try {
      const wallet = { sendTransaction: vi.fn().mockResolvedValueOnce("0xapprovehash").mockResolvedValueOnce("0xtradereverted"), waitForReceipt: vi.fn().mockResolvedValue({ status: "success" }) };
      const result = await executeTradeIntent(tradeOperation(), wallet, WALLET);
      expect(result.error?.message).toMatch(/no funds moved/i);
      expect(result.error?.message).not.toMatch(/approval.*(sent|transferred|moved funds)/i);
    } finally { restore(); }
  });

  it("(payment, NOT_SENT after approval)", async () => {
    const { executeSendPayment } = await import("@/lib/ask/sendPayment/orchestrator");
    const wallet = {
      sendTransaction: vi.fn().mockResolvedValueOnce("0xapprovehash").mockRejectedValueOnce(new Error("User rejected")),
      waitForReceipt: vi.fn().mockResolvedValueOnce({ status: "success" }),
    };
    const result = await executeSendPayment(paymentOperationWithApproval(), wallet);
    expect(result.error?.message).toMatch(/no funds moved/i);
    expect(result.error?.approvalTx?.txHash).toBe("0xapprovehash");
  });
});

describe("16. no automatic retry — the failed step is never resigned or rebroadcast", () => {
  it("(trade) rejecting the trade after approval calls sendTransaction exactly twice total (approval + one rejected attempt)", async () => {
    const { executeTradeIntent } = await import("@/lib/ask/intent/orchestrate");
    const { restore } = mockFetch((url) => url === "/api/ask/trade/build" ? readyBuildWithApproval() : { success: true });
    try {
      const sendTransaction = vi.fn().mockResolvedValueOnce("0xapprovehash").mockRejectedValueOnce(new Error("User rejected"));
      const wallet = { sendTransaction, waitForReceipt: vi.fn().mockResolvedValue({ status: "success" }) };
      await executeTradeIntent(tradeOperation(), wallet, WALLET);
      expect(sendTransaction).toHaveBeenCalledTimes(2);
    } finally { restore(); }
  });
});

describe("17. existing P0 submitted-state behavior is intact (single-step, no approval)", () => {
  it("(trade) a broadcast-then-timeout single-step trade is still submitted, not failed", async () => {
    const { executeTradeIntent } = await import("@/lib/ask/intent/orchestrate");
    const singleStepBuild = { ok: true, status: "ready", preview: { action: "buy", spend: { amount: "50", token: "USDC" }, receive: { amount: "12345", token: "RANDO" }, rate: "x", minimumReceived: "x", priceImpact: null, highPriceImpact: false, route: { provider: "Uniswap v3", path: ["USDC", "RANDO"] }, slippage: "0.50%", network: "Monad", quotedAt: Date.now(), fee: null }, steps: [{ kind: "swap", label: "Trade", tx: { to: "0xRouter", data: "0xswap", value: "0x0" } }] };
    const { restore } = mockFetch((url) => url === "/api/ask/trade/build" ? singleStepBuild : { success: true });
    try {
      const wallet = { sendTransaction: vi.fn().mockResolvedValue("0xonly"), waitForReceipt: vi.fn().mockRejectedValue(new Error("timeout")) };
      const result = await executeTradeIntent(tradeOperation(), wallet, WALLET);
      expect(result.status).toBe("submitted");
      expect(result.submitted?.txHash).toBe("0xonly");
      expect(result.submitted?.step).toBe("main");
      expect(result.submitted?.approvalTx).toBeUndefined(); // no approval step existed
    } finally { restore(); }
  });
});

describe("18. existing single-signature payment behavior is intact (no approval step at all)", () => {
  it("success path unaffected", async () => {
    const { executeSendPayment } = await import("@/lib/ask/sendPayment/orchestrator");
    const intent: PaymentIntent = {
      kind: "payment", network: "monad", token: "MON", amount: "1", recipient: "0x1111111111111111111111111111111111111111",
      execution: { unsignedTx: { to: "0x1111111111111111111111111111111111111111", data: "0x", value: "0xde0b6b3a7640000", from: WALLET }, confirmRawText: "send 1 MON to 0x1111111111111111111111111111111111111111" },
    };
    const op: Operation = { id: "op", intent, status: "ready" };
    const wallet = { sendTransaction: vi.fn().mockResolvedValue("0xpay"), waitForReceipt: vi.fn().mockResolvedValue({ status: "success" }) };
    const { restore } = mockFetch(() => ({ intent: { action: "send_payment" }, transaction: { txHash: "0xpay", explorerUrl: "https://explorer.monad.xyz/tx/0xpay" } }));
    try {
      const result = await executeSendPayment(op, wallet);
      expect(result.status).toBe("success");
      expect(result.result?.txHash).toBe("0xpay");
      expect(wallet.sendTransaction).toHaveBeenCalledTimes(1); // single signature, unchanged
    } finally { restore(); }
  });
});

describe("19, 20, 21 — provider-agnostic: Uniswap, Kuru, Nad.Fun all classify the bug fix identically", () => {
  for (const provider of ["Uniswap v3", "Kuru", "Nad.Fun"]) {
    it(`(${provider}) approval confirms, trade rejected → real error, never misattributed`, async () => {
      const { executeTradeIntent } = await import("@/lib/ask/intent/orchestrate");
      const { restore } = mockFetch((url) => url === "/api/ask/trade/build" ? readyBuildWithApproval(provider) : { success: true });
      try {
        const wallet = {
          sendTransaction: vi.fn().mockResolvedValueOnce("0xapprovehash").mockRejectedValueOnce(new Error("User rejected")),
          waitForReceipt: vi.fn().mockResolvedValue({ status: "success" }),
        };
        const result = await executeTradeIntent(tradeOperation(provider), wallet, WALLET);
        expect(result.status).toBe("error");
        expect(result.error?.code).toBe("NOT_SENT");
        expect(result.error?.txHash).toBeUndefined();
        expect(result.error?.approvalTx?.txHash).toBe("0xapprovehash");
      } finally { restore(); }
    });

    it(`(${provider}) approval confirms, trade genuinely reverts → REVERTED with the trade's own hash, approval named separately`, async () => {
      const { executeTradeIntent } = await import("@/lib/ask/intent/orchestrate");
      const { restore } = mockFetch((url) => url === "/api/ask/trade/build"
        ? readyBuildWithApproval(provider)
        : { success: false, reverted: true, error: "Reverted on-chain." });
      try {
        const wallet = { sendTransaction: vi.fn().mockResolvedValueOnce("0xapprovehash").mockResolvedValueOnce("0xrev"), waitForReceipt: vi.fn().mockResolvedValue({ status: "success" }) };
        const result = await executeTradeIntent(tradeOperation(provider), wallet, WALLET);
        expect(result.status).toBe("error");
        expect(result.error?.code).toBe("REVERTED");
        expect(result.error?.txHash).toBe("0xrev");
        expect(result.error?.approvalTx?.txHash).toBe("0xapprovehash");
      } finally { restore(); }
    });
  }
});
