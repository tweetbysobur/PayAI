import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyMessage, executeSwapIntent, handoffToAutomations, respondToUnderstanding,
} from "@/lib/ask/intent/orchestrate";
import type { Understanding } from "@/lib/ask/intent/types";
import type { Operation, PaymentIntent, SwapIntent, WalletOperationIntent } from "@/lib/ask/types";

const ADDR = "0x1234567890abcdef1234567890abcdef12345678";
const WALLET = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";

// getPendingSettlement reads localStorage, which doesn't exist in this
// Node test environment — it already degrades to null there with no
// mocking needed. To actually exercise the "still broadcasting, not in the
// log yet" path in resolveTransaction, mock the module directly.
let pendingSettlementMock: { walletAddress: string; txHash: string } | null = null;
vi.mock("@/lib/hooks/pendingSettlement", () => ({
  getPendingSettlement: (walletAddress?: string | null) =>
    pendingSettlementMock && (!walletAddress || pendingSettlementMock.walletAddress.toLowerCase() === walletAddress.toLowerCase())
      ? pendingSettlementMock
      : null,
  savePendingSettlement: vi.fn(),
  clearPendingSettlement: vi.fn(),
}));

/** Same pattern as test/ask-send-payment.test.ts — mock fetch and record
 *  every call so tests can assert exactly which endpoints were (or weren't)
 *  hit for a given kind of request. */
function mockFetch(responder: (url: string, init?: RequestInit) => unknown) {
  const original = globalThis.fetch;
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: String(url), body });
    const payload = responder(String(url), init);
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

afterEach(() => vi.restoreAllMocks());

describe("respondToUnderstanding — non-actionable outcomes never touch the network", () => {
  it("chat passes the reply straight through", async () => {
    const { calls, restore } = mockFetch(() => ({}));
    try {
      const r = await respondToUnderstanding({ kind: "chat", outcome: "chat", reply: "Hi! I can help you send, swap, or schedule payments." }, WALLET);
      expect(r.message.content).toMatch(/send, swap, or schedule/i);
      expect(r.message.operation).toBeUndefined();
      expect(r.nextPending).toBeNull();
      expect(calls.length).toBe(0);
    } finally { restore(); }
  });

  it("unsupported explains the gap without touching the network or reinterpreting it", async () => {
    const { calls, restore } = mockFetch(() => ({}));
    try {
      const r = await respondToUnderstanding({ kind: "unsupported", outcome: "unsupported", capability: "staking", reply: "Staking isn't available yet." }, WALLET);
      expect(r.message.content).toMatch(/staking/i);
      expect(r.message.operation).toBeUndefined();
      expect(calls.length).toBe(0);
    } finally { restore(); }
  });

  it("incomplete asks the question and carries the same Understanding forward as pending", async () => {
    const { calls, restore } = mockFetch(() => ({}));
    try {
      const pending: Understanding = { kind: "swap", outcome: "incomplete", slots: { fromAsset: "USDC", toAsset: null, amount: "20" }, question: "What token would you like to receive?" };
      const r = await respondToUnderstanding(pending, WALLET);
      expect(r.message.content).toBe("What token would you like to receive?");
      expect(r.nextPending).toEqual(pending);
      expect(calls.length).toBe(0);
    } finally { restore(); }
  });
});

describe("respondToUnderstanding — send_payment dispatches to the real /api/agent pipeline", () => {
  it("builds a ready operation from a complete understanding", async () => {
    const { calls, restore } = mockFetch(() => ({
      decision: "ready_to_sign",
      intent: { action: "send_payment", amount: 50, token: "USDC", recipient: ADDR, purpose: null, network: "monad", summary: "Send 50 USDC", confidence: 1 },
      guardrail: { allowed: true, violations: [] }, compliance: { status: "approved", summary: "ok", checks: [] }, risk: { score: 5, level: "low", factors: [] },
      unsignedTx: { to: ADDR, data: "0x", value: "0x1", from: WALLET },
      confirmRawText: `Send 50 USDC to ${ADDR}`, requestId: "r1",
    }));
    try {
      const u: Understanding = { kind: "send_payment", outcome: "complete", slots: { amount: "50", asset: "USDC", recipient: ADDR } };
      const r = await respondToUnderstanding(u, WALLET);
      expect(calls[0].url).toBe("/api/agent");
      expect(calls[0].body.intent).toBe(`Send 50 USDC to ${ADDR}`); // canonical, not raw user text
      expect(r.message.operation?.status).toBe("ready");
      expect((r.message.operation?.intent as PaymentIntent).kind).toBe("payment");
      // A ready payment card stays "pending" — a follow-up correction
      // ("actually make it 75") or natural confirmation ("yes") needs to
      // know THIS payment is what's being corrected/confirmed.
      expect(r.nextPending).toEqual(u);
    } finally { restore(); }
  });

  it("does not carry the intent forward when the card never became ready (e.g. refused)", async () => {
    const { restore } = mockFetch(() => ({
      decision: "refused",
      guardrail: { allowed: false, violations: ["Amount exceeds the current limit of 100000000 USDC per payment."] },
    }));
    try {
      const u: Understanding = { kind: "send_payment", outcome: "complete", slots: { amount: "999999999", asset: "USDC", recipient: ADDR } };
      const r = await respondToUnderstanding(u, WALLET);
      expect(r.message.operation).toBeUndefined();
      expect(r.nextPending).toBeNull();
    } finally { restore(); }
  });
});

describe("respondToUnderstanding — swap dispatches to the real DEX quote, never executes from preview", () => {
  it("builds a ready swap operation with the real quote", async () => {
    const { calls, restore } = mockFetch(() => ({
      decision: "swap_ready",
      provider: "Uniswap v3",
      swap: {
        quote: { fromToken: "USDC", toToken: "MON", amountIn: 20, amountOut: 42.8, minAmountOut: 42.6, feeTier: 3000, slippage: 0.005, priceImpact: 0.001 },
        steps: [{ kind: "swap", label: "Swap", tx: { to: "0xrouter", data: "0xdead", value: "0x0" } }],
        summary: "Swap 20 USDC for ~42.8 MON",
      },
    }));
    try {
      const u: Understanding = { kind: "swap", outcome: "complete", slots: { amount: "20", fromAsset: "USDC", toAsset: "MON" } };
      const r = await respondToUnderstanding(u, WALLET);
      expect(calls[0].body.intent).toBe("Swap 20 USDC to MON");
      expect(calls.length).toBe(1); // preview never confirms
      const intent = r.message.operation?.intent as SwapIntent;
      expect(r.message.operation?.status).toBe("ready");
      expect(intent.kind).toBe("swap");
      expect(intent.execution?.plan.quote.amountOut).toBe(42.8);
    } finally { restore(); }
  });

  it("refuses to quote a swap without a connected wallet", async () => {
    const { calls, restore } = mockFetch(() => ({}));
    try {
      const u: Understanding = { kind: "swap", outcome: "complete", slots: { amount: "20", fromAsset: "USDC", toAsset: "MON" } };
      const r = await respondToUnderstanding(u, null);
      expect(r.message.content).toMatch(/connect your wallet/i);
      expect(calls.length).toBe(0);
    } finally { restore(); }
  });

  it("surfaces a swap_error honestly instead of a fake quote", async () => {
    const { restore } = mockFetch(() => ({ decision: "swap_error", error: "No pool found for this pair." }));
    try {
      const u: Understanding = { kind: "swap", outcome: "complete", slots: { amount: "20", fromAsset: "USDC", toAsset: "ZZZZ" } };
      const r = await respondToUnderstanding(u, WALLET);
      expect(r.message.content).toMatch(/no pool found/i);
      expect(r.message.operation).toBeUndefined();
    } finally { restore(); }
  });
});

describe("executeSwapIntent — the ONLY function allowed to sign a swap", () => {
  function readySwapOperation(): Operation {
    const intent: SwapIntent = {
      kind: "swap", network: "monad", fromToken: "USDC", toToken: "MON", fromAmount: "20", toAmountEstimate: "42.8", slippage: "0.50%",
      execution: {
        plan: {
          quote: { fromToken: "USDC", toToken: "MON", amountIn: 20, amountOut: 42.8, minAmountOut: 42.6, feeTier: 3000, slippage: 0.005, priceImpact: 0.001 },
          steps: [{ kind: "swap", label: "Swap", tx: { to: "0xrouter", data: "0xdead", value: "0x0" } }],
          summary: "Swap 20 USDC for ~42.8 MON",
        },
        provider: "Uniswap v3",
        quotedAt: Date.now(),
      },
    };
    return { id: "op-swap-1", intent, status: "ready" };
  }

  it("never touches the wallet for a mock/demo swap card with no execution context", async () => {
    const mockOp: Operation = { id: "op-mock", intent: { kind: "swap", network: "monad", fromToken: "MON", toToken: "USDC", fromAmount: "10" }, status: "ready" };
    const wallet = { sendTransaction: vi.fn(), waitForReceipt: vi.fn() };
    const result = await executeSwapIntent(mockOp, wallet, WALLET);
    expect(result).toBe(mockOp);
    expect(wallet.sendTransaction).not.toHaveBeenCalled();
  });

  it("successful swap: signs each step, confirms, attaches the real result", async () => {
    const { restore } = mockFetch(() => ({ success: true, explorerUrl: "https://explorer.monad.xyz/tx/0xswap" }));
    try {
      const wallet = { sendTransaction: vi.fn().mockResolvedValue("0xswap"), waitForReceipt: vi.fn().mockResolvedValue({ status: "success" }) };
      const result = await executeSwapIntent(readySwapOperation(), wallet, WALLET);
      expect(result.status).toBe("success");
      expect(result.result?.txHash).toBe("0xswap");
      expect(wallet.sendTransaction).toHaveBeenCalledTimes(1);
    } finally { restore(); }
  });

  it("reports live progress through signing -> on-chain -> finalizing, never stuck on a stale 'waiting for signature' message", async () => {
    const { restore } = mockFetch(() => ({ success: true, explorerUrl: "https://explorer.monad.xyz/tx/0xswap" }));
    try {
      const wallet = { sendTransaction: vi.fn().mockResolvedValue("0xswap"), waitForReceipt: vi.fn().mockResolvedValue({ status: "success" }) };
      const seen: string[] = [];
      await executeSwapIntent(readySwapOperation(), wallet, WALLET, (label) => seen.push(label));
      expect(seen[0]).toMatch(/waiting for your signature/i);
      expect(seen[1]).toMatch(/confirming on-chain/i);
      expect(seen[2]).toMatch(/finalizing/i);
      // Never regresses back to "waiting for signature" after it's already
      // moved on to a later phase -- the exact bug this was built to fix.
      const firstOnChain = seen.findIndex((l) => /confirming on-chain/i.test(l));
      expect(seen.slice(firstOnChain).some((l) => /waiting for your signature/i.test(l))).toBe(false);
    } finally { restore(); }
  });

  it("reverted swap: a clear final error, no tokens implied moved", async () => {
    const { restore } = mockFetch(() => ({ success: false, reverted: true, error: "This swap failed on-chain. No tokens were swapped." }));
    try {
      const wallet = { sendTransaction: vi.fn().mockResolvedValue("0xdead"), waitForReceipt: vi.fn().mockResolvedValue({ status: "reverted" }) };
      const result = await executeSwapIntent(readySwapOperation(), wallet, WALLET);
      expect(result.status).toBe("error");
      expect(result.error?.code).toBe("REVERTED");
    } finally { restore(); }
  });

  it("user rejects the wallet prompt before anything broadcasts", async () => {
    const wallet = { sendTransaction: vi.fn().mockRejectedValue(new Error("User rejected the request")), waitForReceipt: vi.fn() };
    const result = await executeSwapIntent(readySwapOperation(), wallet, WALLET);
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("NOT_SENT");
    expect(result.error?.message).toMatch(/you canceled it in your wallet/i);
  });

  it("broadcast but unconfirmable: never says 'failed' — tokens may have already moved", async () => {
    const wallet = { sendTransaction: vi.fn().mockResolvedValue("0xswap"), waitForReceipt: vi.fn().mockRejectedValue(new Error("timeout")) };
    const result = await executeSwapIntent(readySwapOperation(), wallet, WALLET);
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("UNCONFIRMED");
    expect(result.error?.message).not.toMatch(/failed/i);
  });
});

describe("respondToUnderstanding — schedule/recurring hand off to the real Automations creator, never execute in-chat", () => {
  it("schedule_payment builds a handoff card, not an executed automation", async () => {
    const { calls, restore } = mockFetch(() => ({
      decision: "automation_prefill",
      prefill: { amount: 10, token: "USDC", recipient: ADDR, domain: null, cadence: "once", nextRun: Date.UTC(2026, 7, 21, 9) },
    }));
    try {
      const u: Understanding = { kind: "schedule_payment", outcome: "complete", slots: { amount: "10", asset: "USDC", recipient: ADDR, when: "Friday" } };
      const r = await respondToUnderstanding(u, WALLET);
      expect(calls[0].body.intent).toContain("Schedule 10 USDC");
      expect(r.message.operation?.status).toBe("ready");
      // The card's primary action now opens the AutomationCreator modal
      // in-chat ("Review & activate") rather than navigating to the
      // Automations page — but it is still a handoff card (status "ready",
      // handoff present), NOT an executed automation.
      expect(r.message.operation?.confirmLabel).toMatch(/review & activate/i);
      expect(r.message.operation?.intent.kind).toBe("scheduled_payment");
      if (r.message.operation?.intent.kind === "scheduled_payment") {
        expect(r.message.operation.intent.handoff?.prefill.recipient).toBe(ADDR);
      }
    } finally { restore(); }
  });

  it("recurring_payment uses the every-<frequency> canonical phrasing", async () => {
    const { calls, restore } = mockFetch(() => ({
      decision: "automation_prefill",
      prefill: { amount: 10, token: "USDC", recipient: ADDR, domain: null, cadence: "weekly", nextRun: Date.UTC(2026, 7, 21, 9) },
    }));
    try {
      const u: Understanding = { kind: "recurring_payment", outcome: "complete", slots: { amount: "10", asset: "USDC", recipient: ADDR, frequency: "weekly" } };
      const r = await respondToUnderstanding(u, WALLET);
      expect(calls[0].body.intent).toBe(`Schedule 10 USDC to ${ADDR} every weekly`);
      expect(r.message.operation?.intent.kind).toBe("recurring_payment");
    } finally { restore(); }
  });

  it("handoffToAutomations stores the prefill and navigates, without any signature", () => {
    // Node test environment (see vitest.config.ts) has no real `window` —
    // stub the whole global fresh rather than mutating a DOM that isn't there.
    const setItem = vi.fn();
    const fakeWindow = { location: { href: "" } };
    vi.stubGlobal("sessionStorage", { setItem });
    vi.stubGlobal("window", fakeWindow);
    handoffToAutomations({ prefill: { amount: 10, token: "USDC", recipient: ADDR, domain: null, cadence: "once", nextRun: null } });
    expect(setItem).toHaveBeenCalledWith("payai_automation_prefill", expect.stringContaining(ADDR));
    expect(fakeWindow.location.href).toBe("/dashboard/automations");
  });
});

describe("respondToUnderstanding — read-only info intents use real data, never fabricated numbers", () => {
  it("wallet_balance requires a connected wallet, explaining they need to connect/create one", async () => {
    const { calls, restore } = mockFetch(() => ({}));
    try {
      const r = await respondToUnderstanding({ kind: "wallet_balance", outcome: "complete", slots: {} }, null);
      expect(r.message.content).toMatch(/connect.*(payai wallet|your wallet)/i);
      expect(calls.length).toBe(0);
    } finally { restore(); }
  });

  it("transaction_history with zero rows says so honestly instead of fabricating activity", async () => {
    const { restore } = mockFetch(() => ({ decision: "info", query: "show_history", count: 0, history: [] }));
    try {
      const r = await respondToUnderstanding({ kind: "transaction_history", outcome: "complete", slots: {} }, WALLET);
      expect(r.message.content).toMatch(/don't have any recorded transactions/i);
      expect(r.message.operation).toBeUndefined();
    } finally { restore(); }
  });

  it("automation_management lists the real count from /api/automations", async () => {
    const { calls, restore } = mockFetch((url) => {
      expect(url).toContain("/api/automations?wallet=");
      return { automations: [{ active: true }, { active: false }], schedules: [{ active: true }, { active: false }] };
    });
    try {
      const r = await respondToUnderstanding({ kind: "automation_management", outcome: "complete", slots: {} }, WALLET);
      expect(r.message.content).toContain("2 automations");
      expect(r.message.content).toContain("1 active");
      expect(calls.length).toBe(1);
    } finally { restore(); }
  });

  // Regression: the active-count used to read a different field (`schedules`)
  // than the one the length count read (`automations`) — a response carrying
  // only one of the two silently reported "0 active" regardless of reality.
  it("counts correctly even when the response carries only `automations`, not `schedules`", async () => {
    const { restore } = mockFetch(() => ({ automations: [{ active: true }, { active: true }, { active: false }] }));
    try {
      const r = await respondToUnderstanding({ kind: "automation_management", outcome: "complete", slots: {} }, WALLET);
      expect(r.message.content).toContain("3 automations");
      expect(r.message.content).toContain("2 active");
    } finally { restore(); }
  });
});

describe("wallet intelligence — balances (real on-chain data, never mocked)", () => {
  afterEach(() => { pendingSettlementMock = null; });

  it("token_balance answers a single MON balance conversationally", async () => {
    const { calls, restore } = mockFetch(() => ({ decision: "info", query: "show_balance", balance: { mon: 12.42, usdc: 250 } }));
    try {
      const r = await respondToUnderstanding({ kind: "token_balance", outcome: "complete", slots: { asset: "MON" } }, WALLET);
      expect(r.message.content).toBe("You have 12.4200 MON.");
      expect(r.message.operation).toBeUndefined(); // plain conversational answer, not a card
      expect(calls[0].body.intent).toBe("show my balance");
    } finally { restore(); }
  });

  it("token_balance answers a single USDC balance conversationally", async () => {
    const { restore } = mockFetch(() => ({ decision: "info", query: "show_balance", balance: { mon: 12.42, usdc: 250 } }));
    try {
      const r = await respondToUnderstanding({ kind: "token_balance", outcome: "complete", slots: { asset: "USDC" } }, WALLET);
      expect(r.message.content).toBe("You have 250.00 USDC.");
    } finally { restore(); }
  });

  it("token_balance for an unsupported token explains honestly without a network call", async () => {
    const { calls, restore } = mockFetch(() => ({}));
    try {
      const r = await respondToUnderstanding({ kind: "token_balance", outcome: "complete", slots: { asset: "ETH" } }, WALLET);
      expect(r.message.content).toMatch(/don't have balance data for ETH/i);
      expect(calls.length).toBe(0);
    } finally { restore(); }
  });

  it("token_balance requires a connected wallet", async () => {
    const r = await respondToUnderstanding({ kind: "token_balance", outcome: "complete", slots: { asset: "MON" } }, null);
    expect(r.message.content).toMatch(/connect.*payai wallet/i);
  });

  it("wallet_balance (the full summary) renders as a real-data card, not text with invented numbers", async () => {
    const { restore } = mockFetch(() => ({ decision: "info", query: "show_balance", balance: { mon: 12.42, usdc: 250 } }));
    try {
      const r = await respondToUnderstanding({ kind: "wallet_balance", outcome: "complete", slots: {} }, WALLET);
      const intent = r.message.operation?.intent as WalletOperationIntent;
      expect(intent.kind).toBe("wallet_operation");
      expect(intent.operation).toBe("balance");
      expect(intent.balances).toEqual([{ token: "MON", amount: "12.4200" }, { token: "USDC", amount: "250.00" }]);
    } finally { restore(); }
  });

  it("adds a real total USD value from the existing wallet-intelligence endpoint when it's configured and priced", async () => {
    const { restore } = mockFetch((url) => {
      if (url.includes("/api/wallet-intelligence")) return { ok: true, configured: true, totalValueUsd: 512.42 };
      return { decision: "info", query: "show_balance", balance: { mon: 12.42, usdc: 250 } };
    });
    try {
      const r = await respondToUnderstanding({ kind: "wallet_balance", outcome: "complete", slots: {} }, WALLET);
      const intent = r.message.operation?.intent as WalletOperationIntent;
      expect(intent.totalValueUsd).toBe("512.42");
    } finally { restore(); }
  });

  it("omits the total value line (never fabricates one) when wallet-intelligence isn't configured", async () => {
    const { restore } = mockFetch((url) => {
      if (url.includes("/api/wallet-intelligence")) return { ok: true, configured: false };
      return { decision: "info", query: "show_balance", balance: { mon: 12.42, usdc: 250 } };
    });
    try {
      const r = await respondToUnderstanding({ kind: "wallet_balance", outcome: "complete", slots: {} }, WALLET);
      const intent = r.message.operation?.intent as WalletOperationIntent;
      expect(intent.totalValueUsd).toBeNull();
    } finally { restore(); }
  });

  it("an RPC failure while checking balance is reported honestly, never as a silent zero", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("RPC timeout"); }) as unknown as typeof fetch;
    try {
      const r = await respondToUnderstanding({ kind: "wallet_balance", outcome: "complete", slots: {} }, WALLET);
      expect(r.message.content).toMatch(/couldn't reach monad/i);
      expect(r.message.operation).toBeUndefined();
    } finally { globalThis.fetch = original; }
  });
});

describe("wallet intelligence — transaction history (premium card, real rows)", () => {
  it("builds a real transaction list card from /api/agent's history", async () => {
    const { restore } = mockFetch(() => ({
      decision: "info", query: "show_history", count: 1,
      history: [{ at: Date.UTC(2026, 7, 14, 10), decision: "executed", action: "send_payment", amount: 50, token: "USDC", recipient: ADDR, txHash: "0xabc", explorerUrl: "https://explorer.monad.xyz/tx/0xabc", summary: "Sent 50 USDC" }],
    }));
    try {
      const r = await respondToUnderstanding({ kind: "transaction_history", outcome: "complete", slots: {} }, WALLET);
      const intent = r.message.operation?.intent as WalletOperationIntent;
      expect(intent.operation).toBe("recent_payments");
      expect(intent.payments).toHaveLength(1);
      expect(intent.payments?.[0]).toMatchObject({ to: ADDR, amount: "50", token: "USDC", status: "success", txHash: "0xabc" });
    } finally { restore(); }
  });

  it("wallet_activity dispatches the same real history card as transaction_history", async () => {
    const { restore } = mockFetch(() => ({
      decision: "info", query: "show_history", count: 1,
      history: [{ at: Date.now(), decision: "executed", action: "send_payment", amount: 5, token: "MON", recipient: ADDR, summary: "Sent 5 MON" }],
    }));
    try {
      const r = await respondToUnderstanding({ kind: "wallet_activity", outcome: "complete", slots: {} }, WALLET);
      expect((r.message.operation?.intent as WalletOperationIntent).operation).toBe("recent_payments");
    } finally { restore(); }
  });

  it("filters by asset when the user asked about one specifically", async () => {
    const { restore } = mockFetch(() => ({
      decision: "info", query: "show_history", count: 2,
      history: [
        { at: 2000, decision: "executed", action: "send_payment", amount: 5, token: "MON", recipient: ADDR, summary: "Sent 5 MON" },
        { at: 1000, decision: "executed", action: "send_payment", amount: 20, token: "USDC", recipient: ADDR, summary: "Sent 20 USDC" },
      ],
    }));
    try {
      const r = await respondToUnderstanding({ kind: "transaction_history", outcome: "complete", slots: { asset: "USDC" } }, WALLET);
      const intent = r.message.operation?.intent as WalletOperationIntent;
      expect(intent.payments).toHaveLength(1);
      expect(intent.payments?.[0].token).toBe("USDC");
    } finally { restore(); }
  });

  it("an RPC failure loading history is reported honestly, not as an empty history", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("RPC timeout"); }) as unknown as typeof fetch;
    try {
      const r = await respondToUnderstanding({ kind: "transaction_history", outcome: "complete", slots: {} }, WALLET);
      expect(r.message.content).toMatch(/couldn't reach payai/i);
      expect(r.message.content).not.toMatch(/don't have any recorded/i);
    } finally { globalThis.fetch = original; }
  });
});

describe("wallet intelligence — transaction status and details (resolved from real activity, never claimed without confirmation)", () => {
  afterEach(() => { pendingSettlementMock = null; });

  function historyResponder(rows: Record<string, unknown>[]) {
    return () => ({ decision: "info", query: "show_history", count: rows.length, history: rows });
  }

  it("latest transaction defaults to the single most recent real entry", async () => {
    const { restore } = mockFetch(historyResponder([
      { at: 2000, decision: "executed", action: "send_payment", amount: 50, token: "USDC", recipient: ADDR, txHash: "0xnewest", explorerUrl: "https://explorer.monad.xyz/tx/0xnewest", summary: "Sent 50 USDC" },
      { at: 1000, decision: "executed", action: "send_payment", amount: 5, token: "MON", recipient: ADDR, txHash: "0xolder", summary: "Sent 5 MON" },
    ]));
    try {
      const r = await respondToUnderstanding({ kind: "transaction_details", outcome: "complete", slots: {} }, WALLET);
      const intent = r.message.operation?.intent as WalletOperationIntent;
      expect(intent.transaction?.txHash).toBe("0xnewest"); // rows[0] — newest-first, per lib/platform/store.ts
      expect(intent.transaction?.sender).toBe(WALLET);
      expect(intent.transaction?.recipient).toBe(ADDR);
      expect(intent.transaction?.amount).toBe("50");
    } finally { restore(); }
  });

  it("reports a real success, never claiming it without the recorded on-chain confirmation", async () => {
    const { restore } = mockFetch(historyResponder([
      { at: 1000, decision: "executed", action: "send_payment", amount: 50, token: "USDC", recipient: ADDR, txHash: "0xok", explorerUrl: "https://explorer.monad.xyz/tx/0xok", summary: "Sent 50 USDC" },
    ]));
    try {
      const r = await respondToUnderstanding({ kind: "transaction_status", outcome: "complete", slots: {} }, WALLET);
      expect(r.message.content).toMatch(/yes.*went through/i);
      expect((r.message.operation?.intent as WalletOperationIntent).transaction?.status).toBe("success");
    } finally { restore(); }
  });

  it("reports a real failure honestly, never dressed up as pending or success", async () => {
    const { restore } = mockFetch(historyResponder([
      { at: 1000, decision: "blocked", action: "send_payment", amount: 50, token: "USDC", recipient: ADDR, summary: "Blocked" },
    ]));
    try {
      const r = await respondToUnderstanding({ kind: "transaction_status", outcome: "complete", slots: {} }, WALLET);
      expect(r.message.content).toMatch(/failed/i);
      expect((r.message.operation?.intent as WalletOperationIntent).transaction?.status).toBe("failed");
    } finally { restore(); }
  });

  it("a payment broadcast but not yet in the log reports Pending, not failed or missing", async () => {
    pendingSettlementMock = { walletAddress: WALLET, txHash: "0xpending" };
    const { restore } = mockFetch(historyResponder([])); // empty log — it hasn't confirmed yet
    try {
      const r = await respondToUnderstanding({ kind: "transaction_status", outcome: "complete", slots: {} }, WALLET);
      expect(r.message.content).toMatch(/still confirming/i);
      expect(r.message.content).toContain("0xpending".slice(0, 8));
    } finally { restore(); }
  });

  it("a txHash resolved from conversation context (not in this message) is matched exactly", async () => {
    const { restore } = mockFetch(historyResponder([
      { at: 2000, decision: "executed", action: "send_payment", amount: 5, token: "MON", recipient: ADDR, txHash: "0xnewest", summary: "Sent 5 MON" },
      { at: 1000, decision: "executed", action: "send_payment", amount: 20, token: "USDC", recipient: ADDR, txHash: "0xtarget", explorerUrl: "https://explorer.monad.xyz/tx/0xtarget", summary: "Sent 20 USDC" },
    ]));
    try {
      const r = await respondToUnderstanding({ kind: "transaction_details", outcome: "complete", slots: { txHash: "0xtarget" } }, WALLET);
      const intent = r.message.operation?.intent as WalletOperationIntent;
      expect(intent.transaction?.txHash).toBe("0xtarget");
      expect(intent.transaction?.amount).toBe("20");
    } finally { restore(); }
  });

  it("ambiguous / unresolvable transaction reference asks for clarification instead of guessing", async () => {
    const { restore } = mockFetch(historyResponder([
      { at: 1000, decision: "executed", action: "send_payment", amount: 5, token: "MON", recipient: ADDR, txHash: "0xreal", summary: "Sent 5 MON" },
    ]));
    try {
      const r = await respondToUnderstanding({ kind: "transaction_details", outcome: "complete", slots: { txHash: "0xnonexistent" } }, WALLET);
      expect(r.message.content).toMatch(/couldn't find that specific transaction/i);
      expect(r.message.content).toMatch(/could you tell me more/i);
      expect(r.message.operation).toBeUndefined();
    } finally { restore(); }
  });

  it("no transactions at all is reported honestly, not as an error", async () => {
    const { restore } = mockFetch(historyResponder([]));
    try {
      const r = await respondToUnderstanding({ kind: "transaction_status", outcome: "complete", slots: {} }, WALLET);
      expect(r.message.content).toMatch(/don't have any recorded transactions/i);
    } finally { restore(); }
  });

  it("an RPC failure resolving a transaction never fabricates a status", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("RPC timeout"); }) as unknown as typeof fetch;
    try {
      const r = await respondToUnderstanding({ kind: "transaction_status", outcome: "complete", slots: {} }, WALLET);
      expect(r.message.content).toMatch(/couldn't reach monad/i);
      expect(r.message.operation).toBeUndefined();
    } finally { globalThis.fetch = original; }
  });

  it("requires a connected wallet before resolving any transaction", async () => {
    const r = await respondToUnderstanding({ kind: "transaction_details", outcome: "complete", slots: {} }, null);
    expect(r.message.content).toMatch(/connect.*payai wallet/i);
  });
});

describe("respondToUnderstanding — distribution is understood but not fabricated as executable", () => {
  it("explains the real limitation instead of pretending to send a bulk payment", async () => {
    const { calls, restore } = mockFetch(() => ({}));
    try {
      const r = await respondToUnderstanding({ kind: "distribution", outcome: "complete", slots: { amount: "10", asset: "USDC", recipientCount: 50 } }, WALLET);
      expect(r.message.content).toContain("50 recipients");
      expect(r.message.content).toMatch(/aren't executable from this chat yet/i);
      expect(r.message.operation).toBeUndefined();
      expect(calls.length).toBe(0);
    } finally { restore(); }
  });
});

describe("classifyMessage — the client wrapper around the semantic layer", () => {
  it("posts text/history/pending to /api/ask/understand and returns its response", async () => {
    const { calls, restore } = mockFetch(() => ({ kind: "chat", outcome: "chat", reply: "Hi there!" }));
    try {
      const u = await classifyMessage("hi", [{ role: "user", content: "hi" }], null);
      expect(calls[0].url).toBe("/api/ask/understand");
      expect(calls[0].body).toEqual({ text: "hi", history: [{ role: "user", content: "hi" }], pending: null });
      expect(u.outcome).toBe("chat");
    } finally { restore(); }
  });

  it("degrades to a plain retry message instead of throwing when the endpoint is unreachable", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    try {
      const u = await classifyMessage("hi", [], null);
      expect(u.outcome).toBe("unclear");
    } finally { globalThis.fetch = original; }
  });
});
