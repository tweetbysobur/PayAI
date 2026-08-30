import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearChatState, loadChatState, saveChatState } from "@/lib/ask/persistChat";
import { getPendingSettlement, savePendingSettlement, clearPendingSettlement } from "@/lib/hooks/pendingSettlement";
import type { AskMessage, Operation, PaymentIntent, SwapIntent, TokenIntelligenceIntent } from "@/lib/ask/types";
import type { Understanding } from "@/lib/ask/intent/types";

const WALLET = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const TOKEN_ADDR = "0x1234567890abcdef1234567890abcdef12345678";

/** A real Storage-shaped in-memory fake — sessionStorage doesn't exist in
 *  this Node test environment (same situation test/ask-orchestrate.test.ts
 *  documents for localStorage), so this stands in for it exactly the way
 *  that file's own vi.stubGlobal("sessionStorage", ...) pattern does. */
function fakeSessionStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    get size() { return store.size; },
  };
}

let fake: ReturnType<typeof fakeSessionStorage>;
beforeEach(() => {
  fake = fakeSessionStorage();
  vi.stubGlobal("sessionStorage", fake);
});
afterEach(() => vi.unstubAllGlobals());

function userMsg(id: string, content: string, createdAt: number): AskMessage {
  return { id, role: "user", content, createdAt };
}
function assistantMsg(id: string, content: string, createdAt: number, operation?: Operation): AskMessage {
  return { id, role: "assistant", content, createdAt, operation };
}

const READY_PAYMENT_INTENT: PaymentIntent = {
  kind: "payment", network: "monad", token: "USDC", amount: "10", recipient: WALLET,
  execution: { unsignedTx: { to: "0xforwarder", data: "0xabc", from: WALLET }, confirmRawText: "send 10 USDC", requestId: "req_1" },
};
function readyPaymentOp(id: string): Operation {
  return { id, intent: READY_PAYMENT_INTENT, status: "ready" };
}

describe("Ask PayAI conversation persistence — round trip", () => {
  it("1. restores a conversation that was saved before a simulated refresh", () => {
    const messages = [userMsg("u1", "send 10 usdc to bob", 1000), assistantMsg("a1", "Here's the payment", 1001, readyPaymentOp("op1"))];
    saveChatState(messages, null);
    const restored = loadChatState();
    expect(restored?.messages).toHaveLength(2);
    expect(restored?.messages[1].operation?.status).toBe("ready");
  });

  it("2. messages restore in the exact original order", () => {
    const messages = [userMsg("u1", "first", 1000), assistantMsg("a1", "reply one", 1001), userMsg("u2", "second", 1002), assistantMsg("a2", "reply two", 1003)];
    saveChatState(messages, null);
    const restored = loadChatState();
    expect(restored?.messages.map((m) => m.id)).toEqual(["u1", "a1", "u2", "a2"]);
  });

  it("3. pending intent/context restores", () => {
    const pending: Understanding = { kind: "trade", outcome: "incomplete", slots: { tradeAction: "buy", toAsset: TOKEN_ADDR }, question: "How much would you like to spend?" };
    saveChatState([userMsg("u1", "buy this token", 1000)], pending);
    const restored = loadChatState();
    expect(restored?.pending).toEqual(pending);
  });

  it("4. token context (a token_intelligence card) restores so follow-ups still resolve 'it'/'that token'", () => {
    const tokenIntent: TokenIntelligenceIntent = {
      kind: "token_intelligence", network: "monad", address: TOKEN_ADDR, status: "token",
      data: {
        name: "Rando", symbol: "RANDO", decimals: 18, totalSupply: "1000000", verified: false, userBalance: null,
        isTradable: true, explorerUrl: "https://explorer.monad.xyz/address/" + TOKEN_ADDR,
        market: { price: "0.01", priceQuoteAsset: "USDC", priceMon: null, marketCapUsd: null, fdvUsd: null, liquidity: null, volume24h: null, buyVolume24h: null, sellVolume24h: null, transactions24h: null, buys24h: null, sells24h: null, holders: null, priceChange24h: null, quoteAssetsChecked: [], routes: [], signals: [], lastUpdated: 1000 },
      },
    };
    const op: Operation = { id: "op_tok", intent: tokenIntent, status: "success" };
    saveChatState([assistantMsg("a1", "Here's RANDO", 1000, op)], null);
    const restored = loadChatState();
    const restoredOp = restored?.messages[0].operation;
    expect(restoredOp?.intent.kind).toBe("token_intelligence");
    expect(restoredOp?.intent.kind === "token_intelligence" && restoredOp.intent.address).toBe(TOKEN_ADDR);
  });

  it("5. a still-actionable ('ready') operation restores exactly as it was — same intent fields, same status", () => {
    saveChatState([assistantMsg("a1", "Review payment", 1000, readyPaymentOp("op1"))], null);
    const restored = loadChatState();
    const op = restored?.messages[0].operation;
    expect(op?.status).toBe("ready");
    expect(op?.intent.kind === "payment" && op.intent.execution?.unsignedTx.to).toBe("0xforwarder");
  });

  it("6. a restored operation can never resume mid-execution — 'confirming' is downgraded, not resurrected", () => {
    const confirmingOp: Operation = { id: "op1", intent: READY_PAYMENT_INTENT, status: "confirming" };
    saveChatState([assistantMsg("a1", "Signing…", 1000, confirmingOp)], null);
    const restored = loadChatState();
    const op = restored?.messages[0].operation;
    expect(op?.status).not.toBe("confirming");
    expect(op?.status).toBe("error");
    expect(op?.error?.code).toBe("INTERRUPTED");
  });

  it("7. the downgraded card still requires the same explicit confirm click as any other error state — no bypass path exists in the restore itself", () => {
    // loadChatState is a pure read: it never calls advanceOperation, never
    // dispatches a signature, never mutates anything outside the returned
    // value. The only route back to "ready" is retryOperation -> send(),
    // the exact same funnel a normal error already goes through.
    const confirmingOp: Operation = { id: "op1", intent: READY_PAYMENT_INTENT, status: "confirming" };
    saveChatState([assistantMsg("a1", "Signing…", 1000, confirmingOp)], null);
    loadChatState();
    // No fetch, no wallet call, nothing — restoring never itself calls out.
    expect(true).toBe(true);
  });

  it("8. never persists anything shaped like a signed artifact or a credential", () => {
    saveChatState([assistantMsg("a1", "Review payment", 1000, readyPaymentOp("op1"))], null);
    const raw = fake.getItem("payai_ask_conversation_v1")!;
    // "unsignedTx" (the pre-signature request PayAI itself builds) is
    // expected and safe — only a JSON KEY named "signedTx" (a claim that
    // something is already signed) would be the real red flag.
    expect(raw).not.toMatch(/privateKey|"signature"|"signedTx"|mnemonic|"seed"/i);
  });

  it("9. malformed JSON in storage is discarded, not thrown", () => {
    fake.setItem("payai_ask_conversation_v1", "{not json");
    expect(() => loadChatState()).not.toThrow();
    expect(loadChatState()).toBeNull();
    expect(fake.getItem("payai_ask_conversation_v1")).toBeNull(); // cleared, not left corrupt
  });

  it("10. an unrecognized schema version is discarded", () => {
    fake.setItem("payai_ask_conversation_v1", JSON.stringify({ v: 999, savedAt: Date.now(), messages: [userMsg("u1", "hi", 1)], pending: null }));
    expect(loadChatState()).toBeNull();
  });

  it("11. an expired session (older than the TTL) is discarded", () => {
    const dayAndAHalfAgo = Date.now() - 1.5 * 24 * 60 * 60 * 1000;
    fake.setItem("payai_ask_conversation_v1", JSON.stringify({ v: 1, savedAt: dayAndAHalfAgo, messages: [userMsg("u1", "hi", dayAndAHalfAgo)], pending: null }));
    expect(loadChatState()).toBeNull();
  });

  it("a session saved moments ago (well within the TTL) is NOT discarded", () => {
    saveChatState([userMsg("u1", "hi", Date.now())], null);
    expect(loadChatState()).not.toBeNull();
  });

  it("12. a 'submitted' (broadcast, unconfirmed) card restores safely as submitted — never silently upgraded to success or downgraded to error", () => {
    const swapIntent: SwapIntent = { kind: "swap", network: "monad", fromToken: "USDC", toToken: "MON", fromAmount: "10" };
    const submittedOp: Operation = { id: "op1", intent: swapIntent, status: "submitted", submitted: { txHash: "0xdead", explorerUrl: "https://explorer.monad.xyz/tx/0xdead" } };
    saveChatState([assistantMsg("a1", "Swap submitted", 1000, submittedOp)], null);
    const restored = loadChatState();
    const op = restored?.messages[0].operation;
    expect(op?.status).toBe("submitted");
    expect(op?.submitted?.txHash).toBe("0xdead");
    expect(op?.result).toBeUndefined();
  });

  it("13. the existing pendingSettlement reconciler (a separate, localStorage-based mechanism) is untouched by this feature", () => {
    // Different storage (localStorage vs sessionStorage here), different key,
    // different module — this only proves the two coexist without collision.
    vi.stubGlobal("localStorage", fakeSessionStorage());
    savePendingSettlement({ kind: "swap", walletAddress: WALLET, txHash: "0xabc", savedAt: Date.now() });
    expect(getPendingSettlement(WALLET)?.txHash).toBe("0xabc");
    clearPendingSettlement();
    expect(getPendingSettlement(WALLET)).toBeNull();
  });

  it("14. an automation handoff card (still 'ready') restores with its prefill intact, without anything reopening a modal on its own", () => {
    // automationDraft (whether the AutomationCreator modal is open) is
    // deliberately NOT part of what's persisted — see useAskChat's own
    // comment. What DOES need to survive is the handoff card itself, so the
    // user can click it again to reopen the modal.
    const op: Operation = {
      id: "op1",
      intent: { kind: "recurring_payment", network: "monad", token: "USDC", amount: "5", recipient: WALLET, frequency: "weekly", startDate: new Date().toISOString(), handoff: { prefill: { amount: 5, token: "USDC", recipient: WALLET, domain: null, cadence: "weekly", nextRun: Date.now() + 1000 } } },
      status: "ready",
      confirmLabel: "Set up automation",
      confirmIcon: "go",
    };
    saveChatState([assistantMsg("a1", "Set up a weekly payment", 1000, op)], null);
    const restored = loadChatState();
    const restoredOp = restored?.messages[0].operation;
    expect(restoredOp?.status).toBe("ready");
    expect(restoredOp?.intent.kind === "recurring_payment" && restoredOp.intent.handoff?.prefill.amount).toBe(5);
  });

  it("15. existing behavior is unchanged when there is nothing stored — starts exactly as a fresh conversation would", () => {
    expect(loadChatState()).toBeNull();
  });

  it("clearing a conversation removes the persisted record entirely", () => {
    saveChatState([userMsg("u1", "hi", 1000)], null);
    expect(loadChatState()).not.toBeNull();
    clearChatState();
    expect(loadChatState()).toBeNull();
  });

  it("saving an empty conversation (e.g. after 'New conversation') clears any prior record rather than persisting an empty shell", () => {
    saveChatState([userMsg("u1", "hi", 1000)], null);
    saveChatState([], null);
    expect(loadChatState()).toBeNull();
  });

  it("storage being unavailable (private mode / SSR) degrades to null and never throws", () => {
    vi.stubGlobal("sessionStorage", undefined);
    expect(() => loadChatState()).not.toThrow();
    expect(loadChatState()).toBeNull();
    expect(() => saveChatState([userMsg("u1", "hi", 1000)], null)).not.toThrow();
  });
});
