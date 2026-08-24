import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Operation, TradePreviewIntent } from "@/lib/ask/types";

/**
 * Step 4 — Secure Trade Execution.
 *
 * These tests cover the pieces previewTrade()/prepareTradeExecution() (see
 * test/trade-quote.test.ts) don't: the API route boundary
 * (/api/ask/trade/build never trusts a client-supplied transaction target or
 * calldata — it only ever forwards the token/amount fields prepareTradeExecution
 * itself validates), and executeTradeIntent (the ONLY function allowed to
 * request a wallet signature for a trade) — wrong-network refusal, a
 * materially-changed quote never being signed, the real approve-then-trade
 * signing loop, settlement via the existing /api/swap/confirm endpoint, and
 * honest error translation for every failure mode the spec calls out.
 */

const WALLET = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";

let prepareTradeExecutionImpl: (req: unknown, previous: unknown) => Promise<unknown> = async () => ({ ok: false, message: "not stubbed" });
vi.mock("@/lib/monad/tradeQuote", () => ({
  prepareTradeExecution: (req: unknown, previous: unknown) => prepareTradeExecutionImpl(req, previous),
}));

describe("/api/ask/trade/build — never accepts a client-supplied transaction target, always re-derives one server-side", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    prepareTradeExecutionImpl = async () => ({ ok: false, message: "not stubbed" });
  });

  function req(body: unknown): NextRequest {
    return new NextRequest("https://usepayai.xyz/api/ask/trade/build", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
  }

  it("rejects a request with no walletAddress — building real steps always needs a real signer", async () => {
    const { POST } = await import("@/app/api/ask/trade/build/route");
    const r = await POST(req({ action: "buy", inputToken: "USDC", outputToken: "0xaaaabbbbccccddddeeeeffff0000111122223333", amount: "50", amountType: "exact_input" }));
    expect(r.status).toBe(400);
    const json = await r.json();
    expect(json.ok).toBe(false);
    expect(json.message).toMatch(/connect your wallet/i);
  });

  it("rejects an invalid action/amountType the same way /api/ask/trade does", async () => {
    const { POST } = await import("@/app/api/ask/trade/build/route");
    const r = await POST(req({ action: "hodl", inputToken: "USDC", outputToken: "TOKEN", amount: "50", amountType: "exact_input", walletAddress: WALLET }));
    expect(r.status).toBe(400);
  });

  it("forwards ONLY the token/amount/slippage fields to prepareTradeExecution — a client that adds `to`/`data`/`calldata` fields has them silently dropped, never reaching a signed transaction", async () => {
    let seenReq: Record<string, unknown> | null = null;
    prepareTradeExecutionImpl = async (r) => { seenReq = r as Record<string, unknown>; return { ok: true, status: "ready", preview: {}, steps: [] }; };
    const { POST } = await import("@/app/api/ask/trade/build/route");
    const malicious = {
      action: "buy", inputToken: "USDC", outputToken: "0xaaaabbbbccccddddeeeeffff0000111122223333",
      amount: "50", amountType: "exact_input", walletAddress: WALLET,
      // An attacker-controlled client could try to smuggle these in — the
      // route must never read them.
      to: "0xattackercontract000000000000000000000000",
      data: "0xdeadbeef",
      calldata: "0xdeadbeef",
      target: "0xattackercontract000000000000000000000000",
    };
    await POST(req(malicious));
    expect(seenReq).not.toBeNull();
    const keys = Object.keys(seenReq!);
    expect(keys).not.toContain("to");
    expect(keys).not.toContain("data");
    expect(keys).not.toContain("calldata");
    expect(keys).not.toContain("target");
    expect(keys.sort()).toEqual(["action", "amount", "amountType", "inputToken", "outputToken", "slippage", "walletAddress"].sort());
  });

  it("passes previousQuote through only when both fields are present, for the material-change comparison", async () => {
    let seenPrevious: unknown = "unset";
    prepareTradeExecutionImpl = async (_r, previous) => { seenPrevious = previous; return { ok: true, status: "ready", preview: {}, steps: [] }; };
    const { POST } = await import("@/app/api/ask/trade/build/route");
    await POST(req({ action: "buy", inputToken: "USDC", outputToken: "TOKEN", amount: "50", amountType: "exact_input", walletAddress: WALLET, previousQuote: { receiveAmount: "100", provider: "Uniswap v3" } }));
    expect(seenPrevious).toEqual({ receiveAmount: "100", provider: "Uniswap v3" });
  });

  it("a 'changed' result is passed straight through — the client, not the server, decides steps are unsafe to sign", async () => {
    prepareTradeExecutionImpl = async () => ({ ok: true, status: "changed", preview: { receive: { amount: "999", token: "TOKEN" } } });
    const { POST } = await import("@/app/api/ask/trade/build/route");
    const r = await POST(req({ action: "buy", inputToken: "USDC", outputToken: "TOKEN", amount: "50", amountType: "exact_input", walletAddress: WALLET }));
    const json = await r.json();
    expect(json.status).toBe("changed");
    expect(json.steps).toBeUndefined();
  });
});

describe("executeTradeIntent — the only function allowed to request a wallet signature for a trade", () => {
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

  function tradeOperation(overrides: Partial<TradePreviewIntent["data"]> = {}): Operation {
    const intent: TradePreviewIntent = {
      kind: "trade_preview", network: "monad",
      data: {
        action: "buy", spend: { amount: "50", token: "USDC" }, receive: { amount: "12345", token: "RANDO" },
        rate: "1 USDC ≈ 246.9 RANDO", minimumReceived: "12283.28 RANDO", priceImpact: "0.30%", highPriceImpact: false,
        route: { provider: "Uniswap v3", path: ["USDC", "RANDO"] }, slippage: "0.50%", network: "Monad", quotedAt: Date.now(), fee: null,
        ...overrides,
      },
      execution: { request: { action: "buy", inputToken: "USDC", outputToken: "0xaaaabbbbccccddddeeeeffff0000111122223333", amount: "50", amountType: "exact_input", slippage: null } },
    };
    return { id: "op_1", intent, status: "ready", confirmLabel: "Confirm trade" };
  }

  afterEach(() => { vi.restoreAllMocks(); });

  it("never asks for a signature when the wallet is on the wrong network — no build request is even made", async () => {
    const { executeTradeIntent } = await import("@/lib/ask/intent/orchestrate");
    const { calls, restore } = mockFetch(() => ({ ok: true, status: "ready", preview: {}, steps: [] }));
    const sendTransaction = vi.fn();
    try {
      const wallet = { sendTransaction, waitForReceipt: vi.fn(), isWrongNetwork: true };
      const result = await executeTradeIntent(tradeOperation(), wallet, WALLET);
      expect(result.status).toBe("error");
      expect(result.error?.code).toBe("WRONG_NETWORK");
      expect(sendTransaction).not.toHaveBeenCalled();
      expect(calls).toHaveLength(0);
    } finally { restore(); }
  });

  it("a materially changed quote is NEVER signed — returns an updated 'ready' card requiring a fresh confirm click", async () => {
    const { executeTradeIntent } = await import("@/lib/ask/intent/orchestrate");
    const { restore } = mockFetch(() => ({
      ok: true, status: "changed",
      preview: {
        action: "buy", spend: { amount: "50", token: "USDC" }, receive: { amount: "9000", token: "RANDO" },
        rate: "1 USDC ≈ 180 RANDO", minimumReceived: "8950 RANDO", priceImpact: "5.00%", highPriceImpact: false,
        route: { provider: "Kuru", path: ["USDC", "RANDO"] }, slippage: "0.50%", network: "Monad", quotedAt: Date.now(), fee: null,
      },
    }));
    const sendTransaction = vi.fn();
    try {
      const wallet = { sendTransaction, waitForReceipt: vi.fn() };
      const result = await executeTradeIntent(tradeOperation(), wallet, WALLET);
      expect(sendTransaction).not.toHaveBeenCalled();
      expect(result.status).toBe("ready");
      expect(result.confirmLabel).toMatch(/quote updated/i);
      const intent = result.intent as TradePreviewIntent;
      expect(intent.data.receive.amount).toBe("9000");
      expect(intent.data.route.provider).toBe("Kuru");
    } finally { restore(); }
  });

  it("a build failure (no route, revert, etc.) is reported honestly and never signs anything", async () => {
    const { executeTradeIntent } = await import("@/lib/ask/intent/orchestrate");
    const { restore } = mockFetch(() => ({ ok: false, message: "No usable trading route found for USDC → RANDO right now." }));
    const sendTransaction = vi.fn();
    try {
      const wallet = { sendTransaction, waitForReceipt: vi.fn() };
      const result = await executeTradeIntent(tradeOperation(), wallet, WALLET);
      expect(sendTransaction).not.toHaveBeenCalled();
      expect(result.status).toBe("error");
      expect(result.error?.message).toMatch(/no usable trading route/i);
    } finally { restore(); }
  });

  it("a network failure while building is reported honestly, never a silent hang", async () => {
    const { executeTradeIntent } = await import("@/lib/ask/intent/orchestrate");
    const original = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    try {
      const wallet = { sendTransaction: vi.fn(), waitForReceipt: vi.fn() };
      const result = await executeTradeIntent(tradeOperation(), wallet, WALLET);
      expect(result.status).toBe("error");
      expect(result.error?.code).toBe("BUILD_FAILED");
    } finally { globalThis.fetch = original; }
  });

  it("a single-step trade (no approval needed) signs once and settles via the existing /api/swap/confirm endpoint", async () => {
    const { executeTradeIntent } = await import("@/lib/ask/intent/orchestrate");
    const steps = [{ kind: "swap", label: "Trade 50 USDC for RANDO", tx: { to: "0xRouterAddress00000000000000000000000000", data: "0xdead", value: "0x0" } }];
    const { calls, restore } = mockFetch((url) => {
      if (url === "/api/ask/trade/build") {
        return { ok: true, status: "ready", preview: { action: "buy", spend: { amount: "50", token: "USDC" }, receive: { amount: "12345", token: "RANDO" }, rate: "x", minimumReceived: "x", priceImpact: null, highPriceImpact: false, route: { provider: "Uniswap v3", path: ["USDC", "RANDO"] }, slippage: "0.50%", network: "Monad", quotedAt: Date.now(), fee: null }, steps };
      }
      return { success: true, explorerUrl: "https://explorer.monad.xyz/tx/0xtrade" };
    });
    const progressLabels: string[] = [];
    try {
      const wallet = { sendTransaction: vi.fn().mockResolvedValue("0xtrade"), waitForReceipt: vi.fn().mockResolvedValue({ status: "success" }) };
      const result = await executeTradeIntent(tradeOperation(), wallet, WALLET, (label) => progressLabels.push(label));
      expect(wallet.sendTransaction).toHaveBeenCalledTimes(1);
      expect(wallet.sendTransaction).toHaveBeenCalledWith(steps[0].tx);
      expect(result.status).toBe("success");
      expect(result.result?.txHash).toBe("0xtrade");
      expect(result.result?.explorerUrl).toMatch(/0xtrade/);
      // The settlement call reuses the existing swap confirm endpoint verbatim.
      expect(calls[1].url).toBe("/api/swap/confirm");
      expect(calls[1].body).toMatchObject({ walletAddress: WALLET, txHash: "0xtrade", fromToken: "USDC", toToken: "RANDO" });
      expect(progressLabels.some((l) => /waiting for your signature/i.test(l))).toBe(true);
    } finally { restore(); }
  });

  it("an approve-then-trade (two-step) sequence signs BOTH steps in order, with progress labels that never disguise the approval as the trade itself", async () => {
    const { executeTradeIntent } = await import("@/lib/ask/intent/orchestrate");
    const steps = [
      { kind: "approve", label: "Approve 50 USDC for the trade", tx: { to: "0xUSDCTokenAddress00000000000000000000000", data: "0xapprove", value: "0x0" } },
      { kind: "swap", label: "Trade 50 USDC for RANDO", tx: { to: "0xRouterAddress00000000000000000000000000", data: "0xswap", value: "0x0" } },
    ];
    const { calls, restore } = mockFetch((url) => {
      if (url === "/api/ask/trade/build") {
        return { ok: true, status: "ready", preview: { action: "buy", spend: { amount: "50", token: "USDC" }, receive: { amount: "12345", token: "RANDO" }, rate: "x", minimumReceived: "x", priceImpact: null, highPriceImpact: false, route: { provider: "Uniswap v3", path: ["USDC", "RANDO"] }, slippage: "0.50%", network: "Monad", quotedAt: Date.now(), fee: null }, steps };
      }
      return { success: true, explorerUrl: "https://explorer.monad.xyz/tx/0xtrade2" };
    });
    const progressLabels: string[] = [];
    try {
      const sendTransaction = vi.fn().mockResolvedValueOnce("0xapprovehash").mockResolvedValueOnce("0xtrade2");
      const wallet = { sendTransaction, waitForReceipt: vi.fn().mockResolvedValue({ status: "success" }) };
      const result = await executeTradeIntent(tradeOperation(), wallet, WALLET, (label) => progressLabels.push(label));
      expect(sendTransaction).toHaveBeenCalledTimes(2);
      expect(sendTransaction.mock.calls[0][0]).toEqual(steps[0].tx);
      expect(sendTransaction.mock.calls[1][0]).toEqual(steps[1].tx);
      expect(result.status).toBe("success");
      // Step labels are explicit about which step is the approval vs. the trade.
      expect(progressLabels.some((l) => /step 1 of 2.*approve 50 usdc/i.test(l))).toBe(true);
      expect(progressLabels.some((l) => /step 2 of 2.*trade 50 usdc for rando/i.test(l))).toBe(true);
      expect(calls[calls.length - 1].url).toBe("/api/swap/confirm");
      expect(calls[calls.length - 1].body.txHash).toBe("0xtrade2"); // settles with the LAST (trade) hash, not the approval's
    } finally { restore(); }
  });

  it("the user rejecting the wallet signature is reported honestly, never as a silent hang or a fabricated success", async () => {
    const { executeTradeIntent } = await import("@/lib/ask/intent/orchestrate");
    const steps = [{ kind: "swap", label: "Trade", tx: { to: "0xRouterAddress00000000000000000000000000", data: "0xdead", value: "0x0" } }];
    const { restore } = mockFetch(() => ({ ok: true, status: "ready", preview: { action: "buy", spend: { amount: "50", token: "USDC" }, receive: { amount: "12345", token: "RANDO" }, rate: "x", minimumReceived: "x", priceImpact: null, highPriceImpact: false, route: { provider: "Uniswap v3", path: ["USDC", "RANDO"] }, slippage: "0.50%", network: "Monad", quotedAt: Date.now(), fee: null }, steps }));
    try {
      const wallet = { sendTransaction: vi.fn().mockRejectedValue(new Error("User rejected the request")), waitForReceipt: vi.fn() };
      const result = await executeTradeIntent(tradeOperation(), wallet, WALLET);
      expect(result.status).toBe("error");
      expect(result.error?.code).toBe("NOT_SENT");
    } finally { restore(); }
  });

  it("a broadcast tx that can't be confirmed yet is reported as unconfirmed, NEVER as failed (funds may have already moved)", async () => {
    const { executeTradeIntent } = await import("@/lib/ask/intent/orchestrate");
    const steps = [{ kind: "swap", label: "Trade", tx: { to: "0xRouterAddress00000000000000000000000000", data: "0xdead", value: "0x0" } }];
    let call = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      call += 1;
      if (String(url) === "/api/ask/trade/build") {
        return new Response(JSON.stringify({ ok: true, status: "ready", preview: { action: "buy", spend: { amount: "50", token: "USDC" }, receive: { amount: "12345", token: "RANDO" }, rate: "x", minimumReceived: "x", priceImpact: null, highPriceImpact: false, route: { provider: "Uniswap v3", path: ["USDC", "RANDO"] }, slippage: "0.50%", network: "Monad", quotedAt: Date.now(), fee: null }, steps }), { status: 200 });
      }
      throw new Error("RPC timeout confirming");
    }) as unknown as typeof fetch;
    try {
      const wallet = { sendTransaction: vi.fn().mockResolvedValue("0xbroadcasted"), waitForReceipt: vi.fn().mockResolvedValue({ status: "success" }) };
      const result = await executeTradeIntent(tradeOperation(), wallet, WALLET);
      expect(result.status).toBe("error");
      expect(result.error?.code).toBe("UNCONFIRMED");
      expect(result.error?.message).toMatch(/0xbroadcas/i);
      expect(result.error?.message).not.toMatch(/failed/i);
    } finally { globalThis.fetch = original; }
    expect(call).toBeGreaterThan(0);
  });

  it("an on-chain revert is reported as a real, final failure — no tokens moved", async () => {
    const { executeTradeIntent } = await import("@/lib/ask/intent/orchestrate");
    const steps = [{ kind: "swap", label: "Trade", tx: { to: "0xRouterAddress00000000000000000000000000", data: "0xdead", value: "0x0" } }];
    const { restore } = mockFetch((url) => {
      if (url === "/api/ask/trade/build") {
        return { ok: true, status: "ready", preview: { action: "buy", spend: { amount: "50", token: "USDC" }, receive: { amount: "12345", token: "RANDO" }, rate: "x", minimumReceived: "x", priceImpact: null, highPriceImpact: false, route: { provider: "Uniswap v3", path: ["USDC", "RANDO"] }, slippage: "0.50%", network: "Monad", quotedAt: Date.now(), fee: null }, steps };
      }
      return { success: false, reverted: true, error: "This trade failed on-chain. No tokens were traded." };
    });
    try {
      const wallet = { sendTransaction: vi.fn().mockResolvedValue("0xreverted"), waitForReceipt: vi.fn().mockResolvedValue({ status: "reverted" }) };
      const result = await executeTradeIntent(tradeOperation(), wallet, WALLET);
      expect(result.status).toBe("error");
      expect(result.error?.code).toBe("REVERTED");
      expect(result.error?.message).toMatch(/no tokens were traded/i);
    } finally { restore(); }
  });
});

describe("advanceOperation checks quote staleness before ever signing a trade — mirrors the existing swap gate exactly", () => {
  it("gates execution on isQuoteStale, re-quoting instead of executing when stale", () => {
    const src = readFileSync(new URL("../lib/ask/useAskChat.ts", import.meta.url), "utf8");
    const tradeBranchStart = src.indexOf('op.intent.kind === "trade_preview"');
    const staleCheck = src.indexOf("isQuoteStale(op.intent.data.quotedAt)");
    const executeCall = src.indexOf("await executeTradeIntent(op, wallet, wallet.address, setProgressFor)");
    expect(tradeBranchStart).toBeGreaterThan(-1);
    expect(staleCheck).toBeGreaterThan(tradeBranchStart);
    expect(executeCall).toBeGreaterThan(staleCheck);
  });
});

describe("CONFIRMABLE_KINDS / findReadyConfirmableOperation — a bare 'yes' can authorize a ready trade card", () => {
  it("includes trade_preview alongside payment and swap", async () => {
    const { findReadyConfirmableOperation } = await import("@/lib/ask/useAskChat");
    const intent: TradePreviewIntent = {
      kind: "trade_preview", network: "monad",
      data: { action: "buy", spend: { amount: "50", token: "USDC" }, receive: { amount: "12345", token: "RANDO" }, rate: "x", minimumReceived: "x", priceImpact: null, highPriceImpact: false, route: { provider: "Uniswap v3", path: ["USDC", "RANDO"] }, slippage: "0.50%", network: "Monad", quotedAt: Date.now(), fee: null },
      execution: { request: { action: "buy", inputToken: "USDC", outputToken: "RANDO", amount: "50", amountType: "exact_input", slippage: null } },
    };
    const op: Operation = { id: "op_1", intent, status: "ready" };
    const found = findReadyConfirmableOperation([{ id: "m1", role: "assistant", content: "x", createdAt: Date.now(), operation: op }]);
    expect(found?.id).toBe("op_1");
  });

  it("does NOT authorize an informational-only preview (no execution field, e.g. no wallet connected)", async () => {
    const { findReadyConfirmableOperation } = await import("@/lib/ask/useAskChat");
    const intent: TradePreviewIntent = {
      kind: "trade_preview", network: "monad",
      data: { action: "buy", spend: { amount: "50", token: "USDC" }, receive: { amount: "12345", token: "RANDO" }, rate: "x", minimumReceived: "x", priceImpact: null, highPriceImpact: false, route: { provider: "Uniswap v3", path: ["USDC", "RANDO"] }, slippage: "0.50%", network: "Monad", quotedAt: Date.now(), fee: null },
    };
    // status can only be "success" for an execution-less preview (see
    // tradePreviewCard) — "ready" is unreachable without execution, but this
    // asserts the invariant explicitly in case that ever regresses.
    const op: Operation = { id: "op_1", intent, status: "success" };
    const found = findReadyConfirmableOperation([{ id: "m1", role: "assistant", content: "x", createdAt: Date.now(), operation: op }]);
    expect(found).toBeUndefined();
  });
});
