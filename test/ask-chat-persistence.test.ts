import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearChatState, loadChatState, normalizeWalletAddress, saveChatState } from "@/lib/ask/persistChat";
import { getPendingSettlement, savePendingSettlement, clearPendingSettlement } from "@/lib/hooks/pendingSettlement";
import type { AskMessage, Operation, PaymentIntent, SwapIntent, TokenIntelligenceIntent } from "@/lib/ask/types";
import type { Understanding } from "@/lib/ask/intent/types";

const WALLET_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WALLET_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
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
    keys: () => [...store.keys()],
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
  kind: "payment", network: "monad", token: "USDC", amount: "10", recipient: WALLET_A,
  execution: { unsignedTx: { to: "0xforwarder", data: "0xabc", from: WALLET_A }, confirmRawText: "send 10 USDC", requestId: "req_1" },
};
function readyPaymentOp(id: string): Operation {
  return { id, intent: READY_PAYMENT_INTENT, status: "ready" };
}

describe("P1.2 — wallet-scoped Ask PayAI conversation persistence", () => {
  it("1. the same wallet restores its own conversation correctly", () => {
    saveChatState([userMsg("u1", "hi from wallet A", 1000)], null, WALLET_A);
    const restored = loadChatState(WALLET_A);
    expect(restored?.messages).toHaveLength(1);
    expect(restored?.messages[0].content).toBe("hi from wallet A");
  });

  it("2. a different wallet never sees the previous wallet's conversation", () => {
    saveChatState([userMsg("u1", "wallet A's private context", 1000)], null, WALLET_A);
    const asB = loadChatState(WALLET_B);
    expect(asB).toBeNull();
  });

  it("3. switching from Wallet A to Wallet B isolates each — nothing from A is visible under B's identity", () => {
    saveChatState([userMsg("u1", "A's conversation", 1000)], null, WALLET_A);
    // Simulates useAskChat's reconcile effect on a wallet-change event: it
    // loads under the NEW identity only, never carrying A's in-memory state
    // along with it.
    const bView = loadChatState(WALLET_B) ?? { messages: [], pending: null };
    expect(bView.messages).toHaveLength(0);
    // A's own record is untouched by B becoming active — still there under
    // A's own key.
    expect(loadChatState(WALLET_A)?.messages).toHaveLength(1);
  });

  it("4. Wallet B's own pre-existing conversation restores when B connects", () => {
    saveChatState([userMsg("u1", "A's conversation", 1000)], null, WALLET_A);
    saveChatState([userMsg("u1", "B's own conversation", 2000)], null, WALLET_B);
    const bView = loadChatState(WALLET_B);
    expect(bView?.messages[0].content).toBe("B's own conversation");
  });

  it("5. switching back to Wallet A restores A's conversation, untouched by B's activity in between", () => {
    saveChatState([userMsg("u1", "A's conversation", 1000)], null, WALLET_A);
    // B connects, has its own separate activity — writes to its OWN key.
    saveChatState([userMsg("u1", "B chats a bunch", 2000), userMsg("u2", "more from B", 2001)], null, WALLET_B);
    // Switch back to A.
    const aView = loadChatState(WALLET_A);
    expect(aView?.messages).toHaveLength(1);
    expect(aView?.messages[0].content).toBe("A's conversation");
  });

  it("6. a pending intent is wallet-scoped — never answers a follow-up with another wallet's in-flight context", () => {
    const pendingA: Understanding = { kind: "trade", outcome: "incomplete", slots: { tradeAction: "buy", toAsset: TOKEN_ADDR }, question: "How much would you like to spend?" };
    saveChatState([userMsg("u1", "buy this token", 1000)], pendingA, WALLET_A);
    expect(loadChatState(WALLET_B)?.pending ?? null).toBeNull();
    expect(loadChatState(WALLET_A)?.pending).toEqual(pendingA);
  });

  it("7. token context (a token_intelligence card) is wallet-scoped", () => {
    const tokenIntent: TokenIntelligenceIntent = {
      kind: "token_intelligence", network: "monad", address: TOKEN_ADDR, status: "token",
      data: {
        name: "Rando", symbol: "RANDO", decimals: 18, totalSupply: "1000000", verified: false, userBalance: null,
        isTradable: true, explorerUrl: "https://explorer.monad.xyz/address/" + TOKEN_ADDR,
        market: { price: "0.01", priceQuoteAsset: "USDC", priceMon: null, marketCapUsd: null, fdvUsd: null, liquidity: null, volume24h: null, buyVolume24h: null, sellVolume24h: null, transactions24h: null, buys24h: null, sells24h: null, holders: null, priceChange24h: null, quoteAssetsChecked: [], routes: [], signals: [], lastUpdated: 1000 },
      },
    };
    const op: Operation = { id: "op_tok", intent: tokenIntent, status: "success" };
    saveChatState([assistantMsg("a1", "Here's RANDO", 1000, op)], null, WALLET_A);
    expect(loadChatState(WALLET_B)).toBeNull(); // B has no token context of A's to inherit
    const restoredOp = loadChatState(WALLET_A)?.messages[0].operation;
    expect(restoredOp?.intent.kind === "token_intelligence" && restoredOp.intent.address).toBe(TOKEN_ADDR);
  });

  it("8. an actionable ('ready') operation restores safely and cannot auto-execute", () => {
    saveChatState([assistantMsg("a1", "Review payment", 1000, readyPaymentOp("op1"))], null, WALLET_A);
    const op = loadChatState(WALLET_A)?.messages[0].operation;
    expect(op?.status).toBe("ready"); // still requires the existing explicit confirm click

    const confirmingOp: Operation = { id: "op1", intent: READY_PAYMENT_INTENT, status: "confirming" };
    saveChatState([assistantMsg("a1", "Signing…", 1000, confirmingOp)], null, WALLET_B);
    const restored = loadChatState(WALLET_B)?.messages[0].operation;
    expect(restored?.status).not.toBe("confirming");
    expect(restored?.status).toBe("error");
    expect(restored?.error?.code).toBe("INTERRUPTED");
  });

  it("9. a 'submitted' (broadcast, unconfirmed) operation restores safely, still wallet-scoped", () => {
    const swapIntent: SwapIntent = { kind: "swap", network: "monad", fromToken: "USDC", toToken: "MON", fromAmount: "10" };
    const submittedOp: Operation = { id: "op1", intent: swapIntent, status: "submitted", submitted: { txHash: "0xdead", explorerUrl: "https://explorer.monad.xyz/tx/0xdead" } };
    saveChatState([assistantMsg("a1", "Swap submitted", 1000, submittedOp)], null, WALLET_A);
    expect(loadChatState(WALLET_B)).toBeNull(); // not B's transaction to see
    const op = loadChatState(WALLET_A)?.messages[0].operation;
    expect(op?.status).toBe("submitted");
    expect(op?.submitted?.txHash).toBe("0xdead");
    expect(op?.result).toBeUndefined(); // never silently upgraded to success
  });

  it("10. old v1 (wallet-unaware) storage is rejected safely and cleaned up", () => {
    fake.setItem("payai_ask_conversation_v1", JSON.stringify({ v: 1, savedAt: Date.now(), messages: [userMsg("u1", "old", 1)], pending: null }));
    expect(loadChatState(WALLET_A)).toBeNull();
    expect(fake.getItem("payai_ask_conversation_v1")).toBeNull(); // actively discarded, not just ignored
  });

  it("11. a malformed or mismatched walletAddress inside a stored record is rejected", () => {
    // Hand-edited / corrupted: the record's OWN walletAddress field doesn't
    // match the key it's stored under (or isn't address-shaped at all).
    fake.setItem(`payai_ask_conversation_v2:${WALLET_A}`, JSON.stringify({ v: 2, savedAt: Date.now(), walletAddress: "not-an-address", messages: [userMsg("u1", "hi", 1)], pending: null }));
    expect(loadChatState(WALLET_A)).toBeNull();

    fake.setItem(`payai_ask_conversation_v2:${WALLET_A}`, JSON.stringify({ v: 2, savedAt: Date.now(), walletAddress: WALLET_B, messages: [userMsg("u1", "hi", 1)], pending: null }));
    expect(loadChatState(WALLET_A)).toBeNull();
  });

  it("normalizeWalletAddress rejects anything that isn't a real address shape", () => {
    expect(normalizeWalletAddress(null)).toBeNull();
    expect(normalizeWalletAddress(undefined)).toBeNull();
    expect(normalizeWalletAddress("")).toBeNull();
    expect(normalizeWalletAddress("not-an-address")).toBeNull();
    expect(normalizeWalletAddress("0x123")).toBeNull();
    // Real checksum casing only ever affects the hex digits, never the "0x"
    // prefix — mirrors what an actual EIP-55 checksummed address looks like.
    const checksummedShape = "0x" + WALLET_A.slice(2).toUpperCase();
    expect(normalizeWalletAddress(checksummedShape)).toBe(WALLET_A.toLowerCase());
  });

  it("12. no connected wallet never restores or persists wallet-specific state", () => {
    saveChatState([userMsg("u1", "should never be written anywhere", 1000)], null, null);
    expect(fake.size).toBe(0); // nothing was written at all — no identity to write under
    expect(loadChatState(null)).toBeNull();
  });

  it("13. TTL behavior is unchanged — 24h sliding, per wallet", () => {
    const dayAndAHalfAgo = Date.now() - 1.5 * 24 * 60 * 60 * 1000;
    fake.setItem(`payai_ask_conversation_v2:${WALLET_A}`, JSON.stringify({ v: 2, savedAt: dayAndAHalfAgo, walletAddress: WALLET_A, messages: [userMsg("u1", "old", dayAndAHalfAgo)], pending: null }));
    expect(loadChatState(WALLET_A)).toBeNull();

    saveChatState([userMsg("u1", "fresh", Date.now())], null, WALLET_A);
    expect(loadChatState(WALLET_A)).not.toBeNull();
  });

  it("14. a clean state (nothing stored for this wallet) behaves exactly like before — empty conversation", () => {
    expect(loadChatState(WALLET_A)).toBeNull();
  });

  it("15. an automation handoff card restores safely, still wallet-scoped, without reopening any modal on its own", () => {
    const op: Operation = {
      id: "op1",
      intent: { kind: "recurring_payment", network: "monad", token: "USDC", amount: "5", recipient: WALLET_A, frequency: "weekly", startDate: new Date().toISOString(), handoff: { prefill: { amount: 5, token: "USDC", recipient: WALLET_A, domain: null, cadence: "weekly", nextRun: Date.now() + 1000 } } },
      status: "ready",
      confirmLabel: "Set up automation",
      confirmIcon: "go",
    };
    saveChatState([assistantMsg("a1", "Set up a weekly payment", 1000, op)], null, WALLET_A);
    expect(loadChatState(WALLET_B)).toBeNull(); // B never inherits A's automation draft
    const restoredOp = loadChatState(WALLET_A)?.messages[0].operation;
    expect(restoredOp?.status).toBe("ready");
    expect(restoredOp?.intent.kind === "recurring_payment" && restoredOp.intent.handoff?.prefill.amount).toBe(5);
  });

  it("never persists anything shaped like a signed artifact or a credential", () => {
    saveChatState([assistantMsg("a1", "Review payment", 1000, readyPaymentOp("op1"))], null, WALLET_A);
    const raw = fake.getItem(`payai_ask_conversation_v2:${WALLET_A}`)!;
    // "unsignedTx" (the pre-signature request PayAI itself builds) is
    // expected and safe — only a JSON KEY named "signedTx" (a claim that
    // something is already signed) would be the real red flag.
    expect(raw).not.toMatch(/privateKey|"signature"|"signedTx"|mnemonic|"seed"/i);
  });

  it("malformed JSON in a wallet's own record is discarded, not thrown", () => {
    fake.setItem(`payai_ask_conversation_v2:${WALLET_A}`, "{not json");
    expect(() => loadChatState(WALLET_A)).not.toThrow();
    expect(loadChatState(WALLET_A)).toBeNull();
  });

  it("clearing a wallet's conversation only removes THAT wallet's record", () => {
    saveChatState([userMsg("u1", "A", 1000)], null, WALLET_A);
    saveChatState([userMsg("u1", "B", 1000)], null, WALLET_B);
    clearChatState(WALLET_A);
    expect(loadChatState(WALLET_A)).toBeNull();
    expect(loadChatState(WALLET_B)).not.toBeNull();
  });

  it("saving an empty conversation clears that wallet's record rather than persisting an empty shell", () => {
    saveChatState([userMsg("u1", "hi", 1000)], null, WALLET_A);
    saveChatState([], null, WALLET_A);
    expect(loadChatState(WALLET_A)).toBeNull();
  });

  it("the existing pendingSettlement reconciler (a separate, localStorage-based mechanism) is untouched by this feature", () => {
    vi.stubGlobal("localStorage", fakeSessionStorage());
    savePendingSettlement({ kind: "swap", walletAddress: WALLET_A, txHash: "0xabc", savedAt: Date.now() });
    expect(getPendingSettlement(WALLET_A)?.txHash).toBe("0xabc");
    clearPendingSettlement();
    expect(getPendingSettlement(WALLET_A)).toBeNull();
  });

  it("storage being unavailable (private mode / SSR) degrades to null and never throws", () => {
    vi.stubGlobal("sessionStorage", undefined);
    expect(() => loadChatState(WALLET_A)).not.toThrow();
    expect(loadChatState(WALLET_A)).toBeNull();
    expect(() => saveChatState([userMsg("u1", "hi", 1000)], null, WALLET_A)).not.toThrow();
  });
});
