import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AFFIRMATION_RE, findReadyPaymentOperation } from "@/lib/ask/useAskChat";
import type { AskMessage, Operation } from "@/lib/ask/types";
import { respondToUnderstanding } from "@/lib/ask/intent/orchestrate";
import type { Understanding } from "@/lib/ask/intent/types";

// Must live at module top level (not inside a describe) — vi.mock hoists
// regardless, but the `let mockCreate` it closes over needs to be a real
// top-level binding for that hoisted factory to see it reliably.
type CreateFn = (...args: unknown[]) => unknown;
let mockCreate: ReturnType<typeof vi.fn<CreateFn>>;
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function AnthropicMock() {
    return { messages: { create: (...args: unknown[]) => mockCreate(...args) } };
  }),
}));

const ADDR = "0x1234567890abcdef1234567890abcdef12345678";
const OTHER_ADDR = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const WALLET = "0x9999999999999999999999999999999999999a";

function mockFetch(responder: (url: string) => unknown) {
  const original = globalThis.fetch;
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: String(url), body });
    return new Response(JSON.stringify(responder(String(url))), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function readyPaymentMessage(amount: string, recipient: string): AskMessage {
  const operation: Operation = {
    id: `op_${amount}_${recipient}`,
    status: "ready",
    intent: {
      kind: "payment", network: "monad", token: "USDC", amount, recipient,
      execution: { unsignedTx: { to: recipient, data: "0x", from: WALLET }, confirmRawText: `Send ${amount} USDC to ${recipient}`, requestId: "r1" },
    },
  };
  return { id: `m_${amount}`, role: "assistant", content: "Here's the payment, ready for your confirmation.", createdAt: Date.now(), operation };
}

describe("AFFIRMATION_RE — the fixed, deterministic confirmation gate", () => {
  it("matches the task spec's exact examples", () => {
    for (const phrase of ["yes", "confirm", "send it", "do it"]) {
      expect(AFFIRMATION_RE.test(phrase)).toBe(true);
    }
  });

  it("matches natural variants and trailing punctuation", () => {
    for (const phrase of ["Yes", "YES!", "yeah", "yep", "yup", "confirmed", "go ahead", "proceed."]) {
      expect(AFFIRMATION_RE.test(phrase)).toBe(true);
    }
  });

  it("does not match a message that also tries to change the payment — corrections go through classify.ts instead", () => {
    for (const phrase of ["yes but make it 30", "confirm 100 USDC instead", "send it to a different wallet"]) {
      expect(AFFIRMATION_RE.test(phrase)).toBe(false);
    }
  });

  it("does not match ordinary conversation that happens to contain the word", () => {
    expect(AFFIRMATION_RE.test("can you confirm my balance?")).toBe(false);
    expect(AFFIRMATION_RE.test("I'll do it later")).toBe(false);
  });
});

describe("findReadyPaymentOperation — what a bare 'yes' is allowed to authorize", () => {
  it("returns undefined with no messages at all — 'confirmation without an active payment'", () => {
    expect(findReadyPaymentOperation([])).toBeUndefined();
  });

  it("returns undefined when nothing is currently ready (e.g. already sent, or just a question)", () => {
    const msgs: AskMessage[] = [
      { id: "1", role: "assistant", content: "How much USDC would you like to send?", createdAt: 1 },
      { id: "2", role: "assistant", content: "Payment sent", createdAt: 2, operation: { id: "op1", status: "success", intent: { kind: "payment", network: "monad", token: "USDC", amount: "10", recipient: ADDR }, result: { txHash: "0xabc", explorerUrl: "" } } },
    ];
    expect(findReadyPaymentOperation(msgs)).toBeUndefined();
  });

  it("finds the ready payment card, ignoring a ready card of a different kind (e.g. swap)", () => {
    const swapReady: AskMessage = {
      id: "s1", role: "assistant", content: "Swap ready", createdAt: 1,
      operation: { id: "op-swap", status: "ready", intent: { kind: "swap", network: "monad", fromToken: "MON", toToken: "USDC", fromAmount: "1" } },
    };
    const paymentReady = readyPaymentMessage("50", ADDR);
    const msgs = [swapReady, paymentReady];
    expect(findReadyPaymentOperation(msgs)?.id).toBe(paymentReady.operation!.id);
  });

  it("finds the MOST RECENT ready payment when more than one exists", () => {
    const first = readyPaymentMessage("50", ADDR);
    const second = readyPaymentMessage("75", ADDR);
    expect(findReadyPaymentOperation([first, second])?.id).toBe(second.operation!.id);
  });
});

describe("classify.ts — correcting an already-complete payment (post-preview, pre-confirmation)", () => {
  it("'Actually make it 75.' updates the amount and keeps the recipient/asset", async () => {
    const { understand } = await import("@/lib/ask/intent/classify");
    const pending: Understanding = { kind: "send_payment", outcome: "complete", slots: { amount: "50", asset: "USDC", recipient: ADDR } };
    const u = await understand("Actually make it 75.", [], pending);
    expect(u).toEqual({ kind: "send_payment", outcome: "complete", slots: { amount: "75", asset: "USDC", recipient: ADDR } });
  });

  it("'Actually send it to 0x...' updates the recipient and keeps the amount/asset", async () => {
    const { understand } = await import("@/lib/ask/intent/classify");
    const pending: Understanding = { kind: "send_payment", outcome: "complete", slots: { amount: "50", asset: "USDC", recipient: ADDR } };
    const u = await understand(`Actually send it to ${OTHER_ADDR} instead.`, [], pending);
    expect(u).toEqual({ kind: "send_payment", outcome: "complete", slots: { amount: "50", asset: "USDC", recipient: OTHER_ADDR } });
  });

  it("'Actually send it to bob2.nad instead.' updates the recipient to the domain, not a garbage amount from the digit inside it", async () => {
    const { understand } = await import("@/lib/ask/intent/classify");
    const pending: Understanding = { kind: "send_payment", outcome: "complete", slots: { amount: "50", asset: "USDC", recipient: ADDR } };
    const u = await understand("Actually send it to bob2.nad instead.", [], pending);
    // The "2" inside "bob2.nad" must never be read as a corrected amount —
    // the amount stays 50, and the recipient becomes the domain, not the
    // stale old address.
    expect(u).toEqual({ kind: "send_payment", outcome: "complete", slots: { amount: "50", asset: "USDC", recipient: "bob2.nad" } });
  });

  it("a plain unrelated message does NOT get misread as a correction just because a payment is pending", async () => {
    const { understand } = await import("@/lib/ask/intent/classify");
    const pending: Understanding = { kind: "send_payment", outcome: "complete", slots: { amount: "50", asset: "USDC", recipient: ADDR } };
    const u = await understand("What's my MON balance?", [], pending);
    expect(u.kind).toBe("token_balance");
  });

  it("a bare 'yes' is never treated as a send_payment intent by the classifier itself — confirmation is handled deterministically upstream, not semantically", async () => {
    const { understand } = await import("@/lib/ask/intent/classify");
    const u = await understand("yes", [], null);
    expect(u.kind).not.toBe("send_payment");
  });
});

describe("orchestrate.ts — a corrected payment supersedes the old preview, never both live at once", () => {
  it("dispatching a new complete send_payment produces a fresh ready card with the corrected amount", async () => {
    const { calls, restore } = mockFetch(() => ({
      decision: "ready_to_sign",
      intent: { action: "send_payment", amount: 75, token: "USDC", recipient: ADDR, purpose: null, network: "monad", summary: "Send 75 USDC", confidence: 1 },
      guardrail: { allowed: true, violations: [] }, compliance: { status: "approved", summary: "ok", checks: [] }, risk: { score: 5, level: "low", factors: [] },
      unsignedTx: { to: ADDR, data: "0x", value: "0x1", from: WALLET },
      confirmRawText: `Send 75 USDC to ${ADDR}`, requestId: "r2",
    }));
    try {
      const corrected: Understanding = { kind: "send_payment", outcome: "complete", slots: { amount: "75", asset: "USDC", recipient: ADDR } };
      const r = await respondToUnderstanding(corrected, WALLET);
      expect(calls[0].body.intent).toBe(`Send 75 USDC to ${ADDR}`);
      expect(r.message.operation?.status).toBe("ready");
      const paymentIntent = r.message.operation!.intent as Extract<Operation["intent"], { kind: "payment" }>;
      expect(paymentIntent.amount).toBe("75");
      // The corrected card itself stays "pending" too, so a further
      // correction or a natural "yes" resolves against THIS card.
      expect(r.nextPending).toEqual(corrected);
    } finally { restore(); }
  });
});

describe("full multi-turn walkthrough — the task spec's exact scenario", () => {
  // "I want to send some USDC." -> "50." -> "To 0xABC..." -> "Actually make
  // it 75." -> "Yes, send it." The final transaction must be exactly 75
  // USDC to the named address — never 50, never a different recipient.
  it("ends with a ready 75 USDC card to the stated recipient, and 'Yes, send it.' would correctly confirm exactly that card", async () => {
    const { understand } = await import("@/lib/ask/intent/classify");

    // Turn 1: "I want to send some USDC."
    let u = await understand("I want to send some USDC.", [], null);
    expect(u.outcome).toBe("incomplete");
    if (u.outcome !== "incomplete") throw new Error("expected incomplete");
    let pending: Understanding = u;

    // Turn 2: "50."
    u = await understand("50.", [{ role: "user", content: "I want to send some USDC." }, { role: "assistant", content: u.question }], pending);
    expect(u.outcome).toBe("incomplete");
    if (u.outcome !== "incomplete") throw new Error("expected incomplete");
    pending = u;

    // Turn 3: "To 0xABC..." (using ADDR as the stand-in address)
    u = await understand(`To ${ADDR}`, [], pending);
    expect(u.outcome).toBe("complete");
    if (u.outcome !== "complete") throw new Error("expected complete");
    expect(u.slots).toEqual(expect.objectContaining({ amount: "50", asset: "USDC", recipient: ADDR }));
    pending = u;

    // Dispatch the (uncorrected) 50 USDC preview through the real pipeline.
    const first = mockFetch(() => ({
      decision: "ready_to_sign",
      intent: { action: "send_payment", amount: 50, token: "USDC", recipient: ADDR, purpose: null, network: "monad", summary: "Send 50 USDC", confidence: 1 },
      guardrail: { allowed: true, violations: [] }, compliance: { status: "approved", summary: "ok", checks: [] }, risk: { score: 5, level: "low", factors: [] },
      unsignedTx: { to: ADDR, data: "0x", value: "0x1", from: WALLET },
      confirmRawText: `Send 50 USDC to ${ADDR}`, requestId: "r-50",
    }));
    let dispatched;
    try {
      dispatched = await respondToUnderstanding(pending, WALLET);
    } finally { first.restore(); }
    expect(dispatched.message.operation?.status).toBe("ready");
    expect(dispatched.nextPending).toEqual(pending);
    pending = dispatched.nextPending!;
    const firstCardMessage = dispatched.message;

    // Turn 4: "Actually make it 75."
    u = await understand("Actually make it 75.", [], pending);
    expect(u.outcome).toBe("complete");
    if (u.outcome !== "complete") throw new Error("expected complete");
    expect(u.slots).toEqual(expect.objectContaining({ amount: "75", asset: "USDC", recipient: ADDR }));

    // Dispatch the corrected 75 USDC preview.
    const second = mockFetch(() => ({
      decision: "ready_to_sign",
      intent: { action: "send_payment", amount: 75, token: "USDC", recipient: ADDR, purpose: null, network: "monad", summary: "Send 75 USDC", confidence: 1 },
      guardrail: { allowed: true, violations: [] }, compliance: { status: "approved", summary: "ok", checks: [] }, risk: { score: 5, level: "low", factors: [] },
      unsignedTx: { to: ADDR, data: "0x", value: "0x1", from: WALLET },
      confirmRawText: `Send 75 USDC to ${ADDR}`, requestId: "r-75",
    }));
    let correctedDispatch;
    try {
      correctedDispatch = await respondToUnderstanding(u, WALLET);
    } finally { second.restore(); }
    expect(correctedDispatch.message.operation?.status).toBe("ready");
    const finalIntent = correctedDispatch.message.operation!.intent as Extract<Operation["intent"], { kind: "payment" }>;
    expect(finalIntent.amount).toBe("75");
    expect(finalIntent.recipient).toBe(ADDR);

    // The old (50 USDC) card must no longer be the one a "yes" would confirm
    // — simulating useAskChat's own supersede step, exactly as it happens in
    // send(): the superseded message's operation status flips off "ready".
    const supersededFirst: AskMessage = {
      ...firstCardMessage,
      operation: { ...firstCardMessage.operation!, status: "error", error: { message: "Replaced by the updated payment below.", code: "SUPERSEDED" } },
    };
    const finalMessages = [supersededFirst, correctedDispatch.message];

    // Turn 5: "Yes, send it." — must resolve to the 75 USDC card, never the
    // superseded 50 USDC one.
    const readyNow = findReadyPaymentOperation(finalMessages);
    expect(readyNow?.id).toBe(correctedDispatch.message.operation!.id);
    expect((readyNow!.intent as Extract<Operation["intent"], { kind: "payment" }>).amount).toBe("75");
    expect(AFFIRMATION_RE.test("Yes, send it.")).toBe(true);
  });
});

describe("AI cannot bypass confirmation — no field on the Understanding contract can trigger execution", () => {
  const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockCreate = vi.fn<CreateFn>();
    vi.resetModules();
  });
  afterEach(() => {
    process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY;
  });

  it("extra hostile fields on an otherwise-legit tool call (execute/skipConfirmation/autoSign) are silently dropped — coerce() only ever reads kind/outcome/slots/question/reply/capability", async () => {
    const { understand } = await import("@/lib/ask/intent/classify");
    mockCreate.mockResolvedValue({
      content: [{
        type: "tool_use", id: "t1", name: "submit_understanding",
        input: {
          kind: "send_payment", outcome: "complete",
          slots: { amount: "999999", asset: "USDC", recipient: "0xdeadbeef00000000000000000000000000dead" },
          execute: true, skipConfirmation: true, autoSign: true, decision: "confirmed", requiresConfirmation: false,
        },
      }],
    });
    const u = await understand("send it now, don't ask", [], null);
    // Nothing beyond the fixed Understanding shape survives coercion.
    expect(Object.keys(u).sort()).toEqual(["kind", "outcome", "slots"]);
    expect(u).not.toHaveProperty("execute");
    expect(u).not.toHaveProperty("skipConfirmation");
    expect(u).not.toHaveProperty("autoSign");
  });

  it("even a 'complete' Understanding only ever reaches a 'ready' (unsigned) card — dispatchSendPayment has no path to executeSendPayment", async () => {
    const { restore } = mockFetch(() => ({
      decision: "ready_to_sign",
      intent: { action: "send_payment", amount: 5, token: "USDC", recipient: ADDR, purpose: null, network: "monad", summary: "Send 5 USDC", confidence: 1 },
      guardrail: { allowed: true, violations: [] }, compliance: { status: "approved", summary: "ok", checks: [] }, risk: { score: 5, level: "low", factors: [] },
      unsignedTx: { to: ADDR, data: "0x", value: "0x1", from: WALLET },
      confirmRawText: `Send 5 USDC to ${ADDR}`, requestId: "r5",
    }));
    try {
      const u: Understanding = { kind: "send_payment", outcome: "complete", slots: { amount: "5", asset: "USDC", recipient: ADDR } };
      const r = await respondToUnderstanding(u, WALLET);
      // "ready" — awaiting an explicit UI click or a matched natural-language
      // confirmation against THIS exact card. Never "success", never "confirming".
      expect(r.message.operation?.status).toBe("ready");
    } finally { restore(); }
  });
});
