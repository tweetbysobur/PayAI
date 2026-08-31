import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAllHistory, createConversationId, deleteConversation, deriveConversationTitle,
  loadConversation, loadHistoryIndex, MAX_CONVERSATIONS, MAX_MESSAGES_PER_CONVERSATION,
  normalizeWalletAddress, renameConversation, searchConversations, setActiveConversationPointer,
  upsertConversation,
} from "@/lib/ask/persistChat";
import { getPendingSettlement, savePendingSettlement, clearPendingSettlement } from "@/lib/hooks/pendingSettlement";
import type { AskMessage, Operation, PaymentIntent, SwapIntent, TokenIntelligenceIntent } from "@/lib/ask/types";
import type { Understanding } from "@/lib/ask/intent/types";

const WALLET_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WALLET_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

/** A real Storage-shaped in-memory fake — localStorage doesn't exist in
 *  this Node test environment
 *  so this stands in for it. */
function fakeLocalStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    get size() { return store.size; },
    keys: () => [...store.keys()],
  };
}

let fake: ReturnType<typeof fakeLocalStorage>;
beforeEach(() => {
  fake = fakeLocalStorage();
  vi.stubGlobal("localStorage", fake);
});
afterEach(() => vi.unstubAllGlobals());

function userMsg(id: string, content: string, createdAt: number): AskMessage {
  return { id, role: "user", content, createdAt };
}
function assistantMsg(id: string, content: string, createdAt: number, operation?: Operation): AskMessage {
  return { id, role: "assistant", content, createdAt, operation };
}

const READY_PAYMENT_INTENT: PaymentIntent = {
  kind: "payment", network: "monad", token: "USDC", amount: "10", recipient: "0x1111111111111111111111111111111111111111",
  execution: { unsignedTx: { to: "0xforwarder", data: "0xabc", from: WALLET_A }, confirmRawText: "send 10 USDC", requestId: "req_1" },
};
function readyPaymentOp(id: string): Operation {
  return { id, intent: READY_PAYMENT_INTENT, status: "ready" };
}

/** Convenience: build+save a conversation in one call, mirroring what
 *  useAskChat's save effect actually does (title auto-derived unless a
 *  custom one is passed). */
function saveConvo(
  wallet: string, id: string, messages: AskMessage[],
  opts: { title?: string; titleIsCustom?: boolean; createdAt?: number; updatedAt?: number; pending?: Understanding | null } = {},
) {
  const now = Date.now();
  return upsertConversation(wallet, {
    conversationId: id, title: opts.title ?? deriveConversationTitle(messages), titleIsCustom: opts.titleIsCustom ?? false,
    createdAt: opts.createdAt ?? now, updatedAt: opts.updatedAt ?? now, messages, pending: opts.pending ?? null,
  });
}

describe("P1.3 — Ask PayAI conversation history", () => {
  it("1. creates a conversation and it's findable afterward", () => {
    const id = createConversationId();
    saveConvo(WALLET_A, id, [userMsg("u1", "send 10 usdc to alex", 1000)]);
    const record = loadConversation(WALLET_A, id);
    expect(record?.messages).toHaveLength(1);
  });

  it("2. multiple conversations coexist independently for the same wallet", () => {
    const id1 = createConversationId();
    const id2 = createConversationId();
    saveConvo(WALLET_A, id1, [userMsg("u1", "first conversation", 1000)]);
    saveConvo(WALLET_A, id2, [userMsg("u1", "second conversation", 2000)]);
    const index = loadHistoryIndex(WALLET_A);
    expect(index.summaries).toHaveLength(2);
    expect(loadConversation(WALLET_A, id1)?.messages[0].content).toBe("first conversation");
    expect(loadConversation(WALLET_A, id2)?.messages[0].content).toBe("second conversation");
  });

  it("3. conversation IDs are unique", () => {
    const ids = new Set(Array.from({ length: 50 }, () => createConversationId()));
    expect(ids.size).toBe(50);
  });

  it("4. titles are generated deterministically and vary naturally by intent kind (not one fixed template)", () => {
    const swapIntent: SwapIntent = { kind: "swap", network: "monad", fromToken: "MON", toToken: "USDC", fromAmount: "5" };
    const paymentTitle = deriveConversationTitle([assistantMsg("a1", "ok", 1, { id: "op1", intent: READY_PAYMENT_INTENT, status: "ready" })]);
    const swapTitle = deriveConversationTitle([assistantMsg("a1", "ok", 1, { id: "op2", intent: swapIntent, status: "ready" })]);
    const chatTitle = deriveConversationTitle([userMsg("u1", "what can you do?", 1)]);
    expect(paymentTitle).toMatch(/^Send 10 USDC to/);
    expect(swapTitle).toBe("Swap MON for USDC");
    expect(chatTitle).toBe("What can you do?");
    expect(paymentTitle).not.toBe(swapTitle);
    // Deterministic: same input, same output, every time — no Anthropic call involved.
    expect(deriveConversationTitle([assistantMsg("a1", "ok", 1, { id: "op1", intent: READY_PAYMENT_INTENT, status: "ready" })])).toBe(paymentTitle);
  });

  it("title generation never calls out to anything — purely a function of the messages passed in", () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => { throw new Error("must never be called for title generation"); }) as unknown as typeof fetch;
    try {
      expect(() => deriveConversationTitle([userMsg("u1", "hello there", 1)])).not.toThrow();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("5. switching the active conversation loads the other one's own messages", () => {
    const id1 = createConversationId();
    const id2 = createConversationId();
    saveConvo(WALLET_A, id1, [userMsg("u1", "conversation one", 1000)]);
    saveConvo(WALLET_A, id2, [userMsg("u1", "conversation two", 2000)]);
    setActiveConversationPointer(WALLET_A, id1);
    expect(loadHistoryIndex(WALLET_A).activeConversationId).toBe(id1);
    setActiveConversationPointer(WALLET_A, id2);
    expect(loadHistoryIndex(WALLET_A).activeConversationId).toBe(id2);
    expect(loadConversation(WALLET_A, id2)?.messages[0].content).toBe("conversation two");
  });

  it("6. 'new conversation' clears the active pointer without deleting any existing conversation", () => {
    const id1 = createConversationId();
    saveConvo(WALLET_A, id1, [userMsg("u1", "keep me", 1000)]);
    setActiveConversationPointer(WALLET_A, null);
    expect(loadHistoryIndex(WALLET_A).activeConversationId).toBeNull();
    expect(loadHistoryIndex(WALLET_A).summaries).toHaveLength(1);
    expect(loadConversation(WALLET_A, id1)?.messages[0].content).toBe("keep me");
  });

  it("7. reopening an old conversation restores its exact messages", () => {
    const id = createConversationId();
    saveConvo(WALLET_A, id, [userMsg("u1", "a", 1000), assistantMsg("a1", "b", 1001)]);
    const reopened = loadConversation(WALLET_A, id);
    expect(reopened?.messages.map((m) => m.id)).toEqual(["u1", "a1"]);
  });

  it("8. renaming sets a custom title that survives further auto-title attempts", () => {
    const id = createConversationId();
    saveConvo(WALLET_A, id, [userMsg("u1", "send 10 usdc to alex", 1000)]);
    const summaries = renameConversation(WALLET_A, id, "My custom name");
    expect(summaries.find((s) => s.conversationId === id)?.title).toBe("My custom name");
    // A later save with titleIsCustom carried forward must not overwrite it.
    const record = loadConversation(WALLET_A, id)!;
    expect(record.titleIsCustom).toBe(true);
    saveConvo(WALLET_A, id, [...record.messages, userMsg("u2", "more", 2000)], { title: record.title, titleIsCustom: true, createdAt: record.createdAt });
    expect(loadConversation(WALLET_A, id)?.title).toBe("My custom name");
  });

  it("9. deleting a conversation removes it and leaves others untouched", () => {
    const id1 = createConversationId();
    const id2 = createConversationId();
    saveConvo(WALLET_A, id1, [userMsg("u1", "delete me", 1000)]);
    saveConvo(WALLET_A, id2, [userMsg("u1", "keep me", 2000)]);
    const { summaries } = deleteConversation(WALLET_A, id1);
    expect(summaries).toHaveLength(1);
    expect(loadConversation(WALLET_A, id1)).toBeNull();
    expect(loadConversation(WALLET_A, id2)?.messages[0].content).toBe("keep me");
  });

  it("10. clearing all history removes every conversation for that wallet", () => {
    saveConvo(WALLET_A, createConversationId(), [userMsg("u1", "one", 1000)]);
    saveConvo(WALLET_A, createConversationId(), [userMsg("u1", "two", 2000)]);
    clearAllHistory(WALLET_A);
    expect(loadHistoryIndex(WALLET_A).summaries).toHaveLength(0);
  });

  it("11. search matches by title", () => {
    const id = createConversationId();
    saveConvo(WALLET_A, id, [userMsg("u1", "swap mon for usdc", 1000)], { title: "Swap MON for USDC" });
    saveConvo(WALLET_A, createConversationId(), [userMsg("u1", "unrelated", 2000)], { title: "Something else entirely" });
    const results = searchConversations(WALLET_A, "swap");
    expect(results).toHaveLength(1);
    expect(results[0].conversationId).toBe(id);
  });

  it("12. search matches by message content even when the title doesn't", () => {
    const id = createConversationId();
    saveConvo(WALLET_A, id, [userMsg("u1", "please check token 0xDEADBEEF for me", 1000)], { title: "A generic title" });
    const results = searchConversations(WALLET_A, "deadbeef");
    expect(results.map((s) => s.conversationId)).toContain(id);
  });

  it("13. a wallet is capped at MAX_CONVERSATIONS conversations", () => {
    for (let i = 0; i < MAX_CONVERSATIONS + 5; i++) {
      saveConvo(WALLET_A, createConversationId(), [userMsg("u1", `conversation ${i}`, 1000 + i)], { updatedAt: 1000 + i });
    }
    expect(loadHistoryIndex(WALLET_A).summaries).toHaveLength(MAX_CONVERSATIONS);
  });

  it("14. adding a 21st conversation prunes the oldest-updated one, never the currently active one", () => {
    const ids: string[] = [];
    for (let i = 0; i < MAX_CONVERSATIONS; i++) {
      const id = createConversationId();
      ids.push(id);
      saveConvo(WALLET_A, id, [userMsg("u1", `c${i}`, 1000 + i)], { updatedAt: 1000 + i });
    }
    // Reopen and continue chatting in the OLDEST one (ids[0]) — it becomes
    // both ACTIVE and freshly-updated, so ids[1] is now the true oldest.
    saveConvo(WALLET_A, ids[0], [userMsg("u1", "c0", 1000), userMsg("u2", "still chatting here", 5000)], { updatedAt: 5000, createdAt: 1000 });
    const newId = createConversationId();
    saveConvo(WALLET_A, newId, [userMsg("u1", "the 21st", 9999)], { updatedAt: 9999 });
    const summaries = loadHistoryIndex(WALLET_A).summaries;
    expect(summaries).toHaveLength(MAX_CONVERSATIONS);
    expect(summaries.some((s) => s.conversationId === ids[0])).toBe(true); // recently active, survives
    expect(summaries.some((s) => s.conversationId === newId)).toBe(true); // the newest, survives
    expect(summaries.some((s) => s.conversationId === ids[1])).toBe(false); // true oldest now, pruned instead
    expect(loadConversation(WALLET_A, ids[1])).toBeNull(); // its full record is gone too, not just the summary
  });

  it("pruning never removes the conversation being saved in the SAME call, even if its timestamp would otherwise make it 'oldest'", () => {
    // A defensive edge case: if a caller ever saves a conversation with an
    // updatedAt that ties or trails the rest (a clock skew, a backdated
    // migration), the one actively being written must still never be the
    // one pruned — see upsertConversation's own eligibility filter.
    const ids: string[] = [];
    for (let i = 0; i < MAX_CONVERSATIONS; i++) {
      const id = createConversationId();
      ids.push(id);
      saveConvo(WALLET_A, id, [userMsg("u1", `c${i}`, 2000 + i)], { updatedAt: 2000 + i });
    }
    const newId = createConversationId();
    // Deliberately backdated relative to everything else already stored.
    saveConvo(WALLET_A, newId, [userMsg("u1", "backdated", 1)], { updatedAt: 1 });
    const summaries = loadHistoryIndex(WALLET_A).summaries;
    expect(summaries).toHaveLength(MAX_CONVERSATIONS);
    expect(summaries.some((s) => s.conversationId === newId)).toBe(true); // the one just saved always survives
    expect(summaries.some((s) => s.conversationId === ids[0])).toBe(false); // the real oldest among the rest is pruned instead
  });

  it("15. a conversation is capped at MAX_MESSAGES_PER_CONVERSATION, keeping the newest", () => {
    const id = createConversationId();
    const many = Array.from({ length: MAX_MESSAGES_PER_CONVERSATION + 20 }, (_, i) => userMsg(`u${i}`, `message ${i}`, 1000 + i));
    saveConvo(WALLET_A, id, many);
    const record = loadConversation(WALLET_A, id)!;
    expect(record.messages).toHaveLength(MAX_MESSAGES_PER_CONVERSATION);
    expect(record.messages[record.messages.length - 1].content).toBe(`message ${many.length - 1}`); // newest kept
    expect(record.messages[0].content).not.toBe("message 0"); // oldest trimmed
  });

  it("16. wallet A cannot see wallet B's conversations", () => {
    saveConvo(WALLET_A, createConversationId(), [userMsg("u1", "A's private conversation", 1000)]);
    expect(loadHistoryIndex(WALLET_B).summaries).toHaveLength(0);
  });

  it("17. wallet B cannot see wallet A's conversations, and has its own independently", () => {
    saveConvo(WALLET_A, createConversationId(), [userMsg("u1", "A's stuff", 1000)]);
    const idB = createConversationId();
    saveConvo(WALLET_B, idB, [userMsg("u1", "B's stuff", 2000)]);
    const bIndex = loadHistoryIndex(WALLET_B);
    expect(bIndex.summaries).toHaveLength(1);
    expect(loadConversation(WALLET_B, idB)?.messages[0].content).toBe("B's stuff");
  });

  it("18. A -> B -> A restores the correct list and conversation for each, never mixed", () => {
    const idA = createConversationId();
    saveConvo(WALLET_A, idA, [userMsg("u1", "A's conversation", 1000)]);
    setActiveConversationPointer(WALLET_A, idA);

    const idB = createConversationId();
    saveConvo(WALLET_B, idB, [userMsg("u1", "B's conversation", 2000)]);
    setActiveConversationPointer(WALLET_B, idB);

    const bView = loadHistoryIndex(WALLET_B);
    expect(bView.summaries).toHaveLength(1);
    expect(loadConversation(WALLET_B, bView.activeConversationId!)?.messages[0].content).toBe("B's conversation");

    const aViewAgain = loadHistoryIndex(WALLET_A);
    expect(aViewAgain.summaries).toHaveLength(1);
    expect(loadConversation(WALLET_A, aViewAgain.activeConversationId!)?.messages[0].content).toBe("A's conversation");
  });

  it("19. refresh persistence — the active conversation and pending context survive a simulated reload", () => {
    const id = createConversationId();
    const pending: Understanding = { kind: "trade", outcome: "incomplete", slots: { tradeAction: "buy" }, question: "How much?" };
    saveConvo(WALLET_A, id, [userMsg("u1", "buy this token", 1000)], { pending });
    setActiveConversationPointer(WALLET_A, id);
    // Simulate a fresh page load re-reading storage from scratch.
    const index = loadHistoryIndex(WALLET_A);
    const restored = loadConversation(WALLET_A, index.activeConversationId!);
    expect(restored?.pending).toEqual(pending);
  });

  it("20. pending intent is never carried across conversations or wallets", () => {
    const pendingA: Understanding = { kind: "trade", outcome: "incomplete", slots: { tradeAction: "sell" }, question: "How much would you like to sell?" };
    const id1 = createConversationId();
    saveConvo(WALLET_A, id1, [userMsg("u1", "sell some token", 1000)], { pending: pendingA });
    const id2 = createConversationId();
    saveConvo(WALLET_A, id2, [userMsg("u1", "unrelated conversation", 2000)]);
    expect(loadConversation(WALLET_A, id2)?.pending).toBeNull();
    expect(loadConversation(WALLET_B, id1)).toBeNull();
  });

  it("21. a restored 'ready' operation still shows as ready — requires the same explicit confirm click", () => {
    const id = createConversationId();
    saveConvo(WALLET_A, id, [assistantMsg("a1", "Review payment", 1000, readyPaymentOp("op1"))]);
    const op = loadConversation(WALLET_A, id)?.messages[0].operation;
    expect(op?.status).toBe("ready");
  });

  it("22. a restored 'confirming' operation is downgraded and can never auto-execute", () => {
    const confirmingOp: Operation = { id: "op1", intent: READY_PAYMENT_INTENT, status: "confirming" };
    const id = createConversationId();
    saveConvo(WALLET_A, id, [assistantMsg("a1", "Signing…", 1000, confirmingOp)]);
    const op = loadConversation(WALLET_A, id)?.messages[0].operation;
    expect(op?.status).not.toBe("confirming");
    expect(op?.status).toBe("error");
    expect(op?.error?.code).toBe("INTERRUPTED");
  });

  it("23. a submitted (broadcast, unconfirmed) operation restores safely, never upgraded or downgraded", () => {
    const swapIntent: SwapIntent = { kind: "swap", network: "monad", fromToken: "USDC", toToken: "MON", fromAmount: "10" };
    const submittedOp: Operation = { id: "op1", intent: swapIntent, status: "submitted", submitted: { txHash: "0xdead", explorerUrl: "https://explorer.monad.xyz/tx/0xdead" } };
    const id = createConversationId();
    saveConvo(WALLET_A, id, [assistantMsg("a1", "Swap submitted", 1000, submittedOp)]);
    const op = loadConversation(WALLET_A, id)?.messages[0].operation;
    expect(op?.status).toBe("submitted");
    expect(op?.submitted?.txHash).toBe("0xdead");
    expect(op?.result).toBeUndefined();
  });

  it("24. malformed storage is discarded, not thrown", () => {
    fake.setItem("payai_ask_history_index_v1:" + WALLET_A, "{not json");
    expect(() => loadHistoryIndex(WALLET_A)).not.toThrow();
    expect(loadHistoryIndex(WALLET_A).summaries).toHaveLength(0);

    const id = createConversationId();
    fake.setItem(`payai_ask_history_conv_v1:${WALLET_A}:${id}`, "{also not json");
    expect(() => loadConversation(WALLET_A, id)).not.toThrow();
    expect(loadConversation(WALLET_A, id)).toBeNull();
  });

  it("25. an unrecognized schema version is rejected safely", () => {
    fake.setItem("payai_ask_history_index_v1:" + WALLET_A, JSON.stringify({ v: 999, walletAddress: WALLET_A, activeConversationId: null, summaries: [] }));
    expect(loadHistoryIndex(WALLET_A).summaries).toHaveLength(0);

    const id = createConversationId();
    fake.setItem(`payai_ask_history_conv_v1:${WALLET_A}:${id}`, JSON.stringify({ v: 999, conversationId: id, walletAddress: WALLET_A, title: "x", createdAt: 1, updatedAt: 1, messages: [] }));
    expect(loadConversation(WALLET_A, id)).toBeNull();
  });

  it("26. a storage quota failure never throws a user-facing error and never corrupts the active conversation", () => {
    let failNextWrite = true;
    const originalSetItem = fake.setItem;
    vi.stubGlobal("localStorage", {
      ...fake,
      setItem: (k: string, v: string) => {
        if (failNextWrite) { failNextWrite = false; throw new DOMException("Quota exceeded", "QuotaExceededError"); }
        originalSetItem(k, v);
      },
    });
    const id = createConversationId();
    expect(() => saveConvo(WALLET_A, id, [userMsg("u1", "hello", 1000)])).not.toThrow();
  });

  it("27. existing P1.1 behavior is preserved — an empty query returns everything, storage unavailable degrades to empty/null", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(() => loadHistoryIndex(WALLET_A)).not.toThrow();
    expect(loadHistoryIndex(WALLET_A)).toEqual({ activeConversationId: null, summaries: [] });
    expect(() => saveConvo(WALLET_A, createConversationId(), [userMsg("u1", "hi", 1)])).not.toThrow();
  });

  it("28. existing P1.2 wallet-scoping behavior is preserved — normalization, disconnected state", () => {
    expect(normalizeWalletAddress(null)).toBeNull();
    expect(normalizeWalletAddress("not-an-address")).toBeNull();
    const checksummed = "0x" + WALLET_A.slice(2).toUpperCase();
    expect(normalizeWalletAddress(checksummed)).toBe(WALLET_A.toLowerCase());
    // Disconnected (null wallet) never reads or writes anything.
    expect(loadHistoryIndex(null)).toEqual({ activeConversationId: null, summaries: [] });
    expect(saveConvo(null as unknown as string, createConversationId(), [userMsg("u1", "hi", 1)])).toEqual([]);
    expect(fake.size).toBe(0);
  });

  it("29. a historical operation card never duplicates the transaction ledger — only the existing sanitized display fields, plus the link back", () => {
    const swapIntent: SwapIntent = { kind: "swap", network: "monad", fromToken: "USDC", toToken: "MON", fromAmount: "10" };
    const successOp: Operation = {
      id: "op1", intent: swapIntent, status: "success",
      result: { txHash: "0xabc123", explorerUrl: "https://explorer.monad.xyz/tx/0xabc123", blockNumber: 42, gasFee: "0.001 MON" },
    };
    const id = createConversationId();
    saveConvo(WALLET_A, id, [assistantMsg("a1", "Swap complete", 1000, successOp)]);
    const restored = loadConversation(WALLET_A, id)!.messages[0].operation!;
    // Exactly the existing, already-sanitized TransactionResult shape — no
    // extra fields that would imply a second, separately-maintained ledger.
    expect(Object.keys(restored.result!).sort()).toEqual(["blockNumber", "explorerUrl", "gasFee", "txHash"].sort());
    expect(restored.result?.txHash).toBe("0xabc123");
    expect(restored.result?.explorerUrl).toContain("0xabc123");
  });

  it("30. no secrets are ever persisted anywhere in a conversation record", () => {
    const id = createConversationId();
    saveConvo(WALLET_A, id, [assistantMsg("a1", "Review payment", 1000, readyPaymentOp("op1"))]);
    const raw = fake.getItem(`payai_ask_history_conv_v1:${WALLET_A}:${id}`)!;
    // "unsignedTx" (the pre-signature request PayAI itself builds) is
    // expected and safe — only a JSON KEY claiming something is already
    // signed would be the real red flag.
    expect(raw).not.toMatch(/privateKey|"signature"|"signedTx"|mnemonic|"seed"/i);
  });

  it("a title-worthy token_intelligence card produces a natural, non-templated title", () => {
    const tokenIntent: TokenIntelligenceIntent = {
      kind: "token_intelligence", network: "monad", address: "0x1234567890abcdef1234567890abcdef12345678", status: "token",
      data: {
        name: "Rando", symbol: "RANDO", decimals: 18, totalSupply: null, verified: false, userBalance: null, isTradable: true,
        explorerUrl: "https://explorer.monad.xyz/address/0x1234567890abcdef1234567890abcdef12345678",
        market: { price: null, priceQuoteAsset: null, priceMon: null, marketCapUsd: null, fdvUsd: null, liquidity: null, volume24h: null, buyVolume24h: null, sellVolume24h: null, transactions24h: null, buys24h: null, sells24h: null, holders: null, priceChange24h: null, quoteAssetsChecked: [], routes: [], signals: [], lastUpdated: 1 },
      },
    };
    const title = deriveConversationTitle([assistantMsg("a1", "here", 1, { id: "op1", intent: tokenIntent, status: "success" })]);
    expect(title).toBe("Check RANDO");
  });

  it("renaming does not bump updatedAt (a metadata edit, not new activity)", () => {
    const id = createConversationId();
    saveConvo(WALLET_A, id, [userMsg("u1", "hi", 1000)], { updatedAt: 5000 });
    renameConversation(WALLET_A, id, "Renamed");
    const summary = loadHistoryIndex(WALLET_A).summaries.find((s) => s.conversationId === id);
    expect(summary?.updatedAt).toBe(5000);
  });

  it("the existing pendingSettlement reconciler (separate, localStorage-based) is untouched by this feature", () => {
    vi.stubGlobal("localStorage", fakeLocalStorage());
    savePendingSettlement({ kind: "swap", walletAddress: WALLET_A, txHash: "0xabc", savedAt: Date.now() });
    expect(getPendingSettlement(WALLET_A)?.txHash).toBe("0xabc");
    clearPendingSettlement();
    expect(getPendingSettlement(WALLET_A)).toBeNull();
  });

  it("an old P1.1/P1.2 single-conversation v2 record migrates once, unambiguously, into the new history model", () => {
    const legacyKey = `payai_ask_conversation_v2:${WALLET_A}`;
    fake.setItem(legacyKey, JSON.stringify({
      v: 2, savedAt: Date.now(), walletAddress: WALLET_A,
      messages: [userMsg("u1", "send 10 usdc to alex", 1000)], pending: null,
    }));
    const index = loadHistoryIndex(WALLET_A);
    expect(index.summaries).toHaveLength(1);
    expect(index.activeConversationId).toBe(index.summaries[0].conversationId);
    expect(loadConversation(WALLET_A, index.activeConversationId!)?.messages[0].content).toBe("send 10 usdc to alex");
    // The legacy key is retired — never re-read, never migrated twice.
    expect(fake.getItem(legacyKey)).toBeNull();
  });

  it("an expired or invalid legacy v2 record is discarded, not migrated", () => {
    const legacyKey = `payai_ask_conversation_v2:${WALLET_A}`;
    const wayTooOld = Date.now() - 3 * 24 * 60 * 60 * 1000;
    fake.setItem(legacyKey, JSON.stringify({ v: 2, savedAt: wayTooOld, walletAddress: WALLET_A, messages: [userMsg("u1", "old", wayTooOld)], pending: null }));
    expect(loadHistoryIndex(WALLET_A).summaries).toHaveLength(0);
  });
});
