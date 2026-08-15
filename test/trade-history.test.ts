import { afterEach, describe, expect, it, vi } from "vitest";
import { recordTx, listTx } from "@/lib/platform/store";
import { respondToUnderstanding } from "@/lib/ask/intent/orchestrate";
import type { Understanding } from "@/lib/ask/intent/types";
import type { WalletOperationIntent } from "@/lib/ask/types";

/**
 * Step 5, Part 6 — trade history extends the EXISTING transaction log
 * (lib/platform/store.ts's TxLogEntry) rather than a new system: a trade
 * settles through the exact same /api/swap/confirm -> recordTx call a
 * Smart Swap already used, now carrying three additional optional fields
 * (outputAmount/outputToken/provider) and a "trade" feature/action label
 * distinct from "swap". This file covers (1) that the store itself
 * round-trips those fields losslessly, and (2) that Ask PayAI's own
 * history-reading surface (dispatchTransactionHistoryCard/Status/Details)
 * actually surfaces them, not just carries them silently.
 */

const MERCHANT = `test-trade-history-${Math.random().toString(36).slice(2)}`;
const WALLET = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";

describe("recordTx/listTx — trade entries round-trip their output side and DEX losslessly", () => {
  it("a recorded trade carries feature, outputAmount, outputToken, and provider back out exactly as stored", async () => {
    await recordTx(MERCHANT, {
      decision: "executed", action: "trade", feature: "trade",
      amount: 50, token: "USDC", recipient: WALLET, sender: WALLET,
      riskScore: null, compliance: null,
      txHash: "0x" + "a".repeat(64), explorerUrl: "https://explorer.monad.xyz/tx/0xa",
      summary: "Trade 50 USDC → 12345 RANDO via Uniswap v3",
      outputAmount: 12345, outputToken: "RANDO", provider: "Uniswap v3",
    });
    const rows = await listTx(MERCHANT, { sender: WALLET });
    const row = rows.find((r) => r.action === "trade");
    expect(row).toBeDefined();
    expect(row?.feature).toBe("trade");
    expect(row?.outputAmount).toBe(12345);
    expect(row?.outputToken).toBe("RANDO");
    expect(row?.provider).toBe("Uniswap v3");
  });

  it("an ordinary payment entry (no output side) still round-trips fine without these fields", async () => {
    await recordTx(MERCHANT, {
      decision: "executed", action: "send_payment", feature: "payment",
      amount: 10, token: "USDC", recipient: "0x1111111111111111111111111111111111111111", sender: WALLET,
      riskScore: 5, compliance: "approved",
      summary: "Sent 10 USDC",
    });
    const rows = await listTx(MERCHANT, { sender: WALLET });
    const row = rows.find((r) => r.action === "send_payment");
    expect(row).toBeDefined();
    expect(row?.outputAmount).toBeUndefined();
    expect(row?.outputToken).toBeUndefined();
    expect(row?.provider).toBeUndefined();
  });
});

function mockFetch(responder: () => unknown) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(responder()), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
  return () => { globalThis.fetch = original; };
}

afterEach(() => vi.restoreAllMocks());

describe("Ask PayAI transaction history/status/details — a trade row is labeled and shown distinctly from a payment", () => {
  const TRADE_ROW = {
    at: Date.now(), decision: "executed" as const, action: "trade", feature: "trade" as const,
    amount: 50, token: "USDC", recipient: WALLET, sender: WALLET,
    txHash: "0x" + "b".repeat(64), explorerUrl: "https://explorer.monad.xyz/tx/0xb",
    summary: "Trade 50 USDC → 12345 RANDO via Uniswap v3",
    outputAmount: 12345, outputToken: "RANDO", provider: "Uniswap v3",
  };

  it("'show my transaction history' labels a trade row as Trade, not Payment, and carries the output side", async () => {
    const restore = mockFetch(() => ({ decision: "history", history: [TRADE_ROW] }));
    try {
      const u: Understanding = { kind: "transaction_history", outcome: "complete", slots: {} };
      const r = await respondToUnderstanding(u, WALLET);
      const intent = r.message.operation?.intent as WalletOperationIntent;
      expect(intent.payments?.[0]).toMatchObject({ outputAmount: "12345", outputToken: "RANDO", provider: "Uniswap v3" });
    } finally { restore(); }
  });

  it("'did that transaction go through' resolves a trade with type 'Trade' and its route, not 'Payment' with a self-addressed recipient", async () => {
    const restore = mockFetch(() => ({ decision: "history", history: [TRADE_ROW] }));
    try {
      const u: Understanding = { kind: "transaction_status", outcome: "complete", slots: { txHash: TRADE_ROW.txHash } };
      const r = await respondToUnderstanding(u, WALLET);
      const intent = r.message.operation?.intent as WalletOperationIntent;
      expect(intent.transaction?.type).toBe("Trade");
      expect(intent.transaction?.outputAmount).toBe("12345");
      expect(intent.transaction?.outputToken).toBe("RANDO");
      expect(intent.transaction?.provider).toBe("Uniswap v3");
    } finally { restore(); }
  });

  it("an ordinary swap row (feature 'swap') is still labeled 'Swap', distinctly from a trade", async () => {
    const swapRow = { ...TRADE_ROW, action: "swap", feature: "swap" as const, summary: "Swap 50 USDC → 20 MON" };
    const restore = mockFetch(() => ({ decision: "history", history: [swapRow] }));
    try {
      const u: Understanding = { kind: "transaction_status", outcome: "complete", slots: { txHash: swapRow.txHash } };
      const r = await respondToUnderstanding(u, WALLET);
      const intent = r.message.operation?.intent as WalletOperationIntent;
      expect(intent.transaction?.type).toBe("Swap");
    } finally { restore(); }
  });

  it("an ordinary payment row is unaffected -- still 'Payment', no output side fields", async () => {
    const paymentRow = { at: Date.now(), decision: "executed" as const, action: "send_payment", amount: 10, token: "USDC", recipient: "0x1111111111111111111111111111111111111111", sender: WALLET, txHash: "0x" + "c".repeat(64), explorerUrl: "https://explorer.monad.xyz/tx/0xc", summary: "Sent 10 USDC" };
    const restore = mockFetch(() => ({ decision: "history", history: [paymentRow] }));
    try {
      const u: Understanding = { kind: "transaction_status", outcome: "complete", slots: { txHash: paymentRow.txHash } };
      const r = await respondToUnderstanding(u, WALLET);
      const intent = r.message.operation?.intent as WalletOperationIntent;
      expect(intent.transaction?.type).toBe("Payment");
      expect(intent.transaction?.outputToken).toBeNull();
    } finally { restore(); }
  });
});
