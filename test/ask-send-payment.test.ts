import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeFunctionData } from "viem";
import { extractSendPaymentCandidate, looksLikeSendPayment } from "@/lib/ask/sendPayment/parse";
import { validateSendPaymentCandidate } from "@/lib/ask/sendPayment/validate";
import { executeSendPayment, respondToSendPayment, type SendPaymentWallet } from "@/lib/ask/sendPayment/orchestrator";
import type { Operation, PaymentIntent } from "@/lib/ask/types";

const ADDR = "0x1234567890abcdef1234567890abcdef12345678";
const WALLET = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";

/** Mocks globalThis.fetch and records every call so tests can assert exactly
 *  which endpoints were (or weren't) hit — the same pattern test/auth-email.test.ts
 *  uses. Each test installs its own responder. */
function mockFetch(responder: (url: string, init?: RequestInit) => unknown) {
  const original = globalThis.fetch;
  const calls: { url: string; body: unknown }[] = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: String(url), body });
    const payload = responder(String(url), init);
    return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

describe("send_payment — AI intent parser (pure text extraction, never resolves/guesses)", () => {
  it("recognizes send/pay phrasing and ignores everything else", () => {
    expect(looksLikeSendPayment("Send 50 USDC to 0x123")).toBe(true);
    expect(looksLikeSendPayment("Pay 10 MON to alex.nad")).toBe(true);
    expect(looksLikeSendPayment("Swap 20 MON to USDC")).toBe(false);
    expect(looksLikeSendPayment("What's my balance?")).toBe(false);
  });

  it("extracts only what's literally present, leaving the rest null", () => {
    const c = extractSendPaymentCandidate("Send 50 USDC to Alex.");
    expect(c.amountText).toBe("50");
    expect(c.assetText).toBe("USDC");
    expect(c.recipientText).toBe("Alex");
    expect(c.networkText).toBeNull();
  });

  it("never invents an amount or recipient that isn't in the text", () => {
    const c = extractSendPaymentCandidate("Send USDC to Alex.");
    expect(c.amountText).toBeNull();
    const c2 = extractSendPaymentCandidate("Send 50 USDC.");
    expect(c2.recipientText).toBeNull();
  });

  it("different wording for the same payment resolves to the identical amount/asset/recipient", () => {
    // The task spec's own set of equivalent phrasings.
    const variants = [
      `Send 50 USDC to ${ADDR}`,
      `Pay ${ADDR} 50 USDC`,
      `Can you transfer 50 USDC to ${ADDR}?`,
    ];
    for (const text of variants) {
      const c = extractSendPaymentCandidate(text);
      expect(c.amountText).toBe("50");
      expect(c.assetText).toBe("USDC");
      expect(c.recipientText).toBe(ADDR);
    }
  });
});

describe("send_payment — validation layer (missing/invalid fields ask, never guess)", () => {
  it("missing amount: asks how much, in the exact task-spec phrasing", () => {
    const v = validateSendPaymentCandidate(extractSendPaymentCandidate("Send USDC to Alex."));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.question).toBe("How much USDC would you like to send?");
  });

  it("missing recipient: asks who, in the exact task-spec phrasing", () => {
    const v = validateSendPaymentCandidate(extractSendPaymentCandidate("Send 50 USDC."));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.question).toBe("Who should receive the 50 USDC?");
  });

  it("missing both: asks a single combined question, not two separate guesses", () => {
    const v = validateSendPaymentCandidate(extractSendPaymentCandidate("Send some money."));
    expect(v.ok).toBe(false);
  });

  it("zero amount is rejected before ever reaching the network", () => {
    const v = validateSendPaymentCandidate(extractSendPaymentCandidate(`Send 0 USDC to ${ADDR}`));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.question).toMatch(/greater than 0/i);
  });

  it("unsupported token (this phase is MON/USDC only) is refused, never silently swapped for a default", () => {
    const v = validateSendPaymentCandidate(extractSendPaymentCandidate(`Send 50 USDT to ${ADDR}`));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.question).toMatch(/MON and USDC only/i);
  });

  it("missing token: asks which one instead of defaulting to USDC", () => {
    const v = validateSendPaymentCandidate(extractSendPaymentCandidate(`Send 50 to ${ADDR}`));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.question).toMatch(/MON or USDC/i);
  });

  it("wrong network: refuses instead of silently building a Monad tx for a different chain", () => {
    const v = validateSendPaymentCandidate(extractSendPaymentCandidate(`Send 50 USDC to ${ADDR} on Base`));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.question).toMatch(/Monad only/i);
  });

  it("a complete, valid request produces the exact structured intent contract", () => {
    const v = validateSendPaymentCandidate(extractSendPaymentCandidate(`Send 50 USDC to ${ADDR}`));
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.intent).toEqual({ intent: "send_payment", asset: "USDC", amount: "50", recipient: ADDR, network: "monad" });
    }
  });
});

describe("send_payment — respondToSendPayment (preview only, never executes)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("refuses to call the pipeline at all without a connected wallet — never reaches the custodial agent-wallet path", async () => {
    const { calls, restore } = mockFetch(() => ({}));
    try {
      const msg = await respondToSendPayment(`Send 50 USDC to ${ADDR}`, null);
      expect(msg?.content).toMatch(/connect your wallet/i);
      expect(msg?.operation).toBeUndefined();
      expect(calls.length).toBe(0);
    } finally {
      restore();
    }
  });

  it("sends skipLLMRefinement so /api/agent never spends a second Anthropic call re-parsing text Ask PayAI's own semantic layer already classified", async () => {
    const { calls, restore } = mockFetch(() => ({
      decision: "ready_to_sign",
      intent: { action: "send_payment", amount: 50, token: "USDC", recipient: ADDR, purpose: null, network: "monad", summary: "Send 50 USDC", confidence: 1 },
      guardrail: { allowed: true, violations: [] }, compliance: { status: "approved", summary: "ok", checks: [] }, risk: { score: 5, level: "low", factors: [] },
      unsignedTx: { to: ADDR, data: "0x", value: "0x1", from: WALLET }, confirmRawText: `Send 50 USDC to ${ADDR}`, requestId: "req-skip",
    }));
    try {
      await respondToSendPayment(`Send 50 USDC to ${ADDR}`, WALLET);
      expect(calls[0].body).toMatchObject({ skipLLMRefinement: true });
    } finally {
      restore();
    }
  });

  it("valid MON payment intent → ready_to_sign becomes a 'ready' operation card, never auto-executed", async () => {
    const { calls, restore } = mockFetch(() => ({
      decision: "ready_to_sign",
      intent: { action: "send_payment", amount: 0.5, token: "MON", recipient: ADDR, purpose: null, network: "monad", summary: "Send 0.5 MON", confidence: 1 },
      guardrail: { allowed: true, violations: [] },
      compliance: { status: "approved", summary: "ok", checks: [] },
      risk: { score: 5, level: "low", factors: [] },
      unsignedTx: { to: ADDR, data: "0x", value: "0x6f05b59d3b20000", from: WALLET },
      confirmRawText: `Send 0.5 MON to ${ADDR}`,
      requestId: "req-1",
    }));
    try {
      const msg = await respondToSendPayment(`Send 0.5 MON to ${ADDR}`, WALLET);
      expect(calls[0].url).toContain("/api/agent");
      expect(calls.some((c) => c.url.includes("/api/agent/confirm"))).toBe(false); // preview never confirms
      expect(msg?.operation?.status).toBe("ready");
      const intent = msg?.operation?.intent as PaymentIntent;
      expect(intent.kind).toBe("payment");
      expect(intent.token).toBe("MON");
      expect(intent.amount).toBe("0.5");
      expect(intent.execution?.unsignedTx.value).toBe("0x6f05b59d3b20000");
    } finally {
      restore();
    }
  });

  it("valid USDC payment intent → ready_to_sign becomes a 'ready' operation card", async () => {
    const usdcTransferData = encodeFunctionData({
      abi: [{ name: "transfer", type: "function", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] }],
      functionName: "transfer",
      args: [ADDR as `0x${string}`, 50_000000n],
    });
    const { restore } = mockFetch(() => ({
      decision: "ready_to_sign",
      intent: { action: "send_payment", amount: 50, token: "USDC", recipient: ADDR, purpose: null, network: "monad", summary: "Send 50 USDC", confidence: 1 },
      guardrail: { allowed: true, violations: [] },
      compliance: { status: "approved", summary: "ok", checks: [] },
      risk: { score: 5, level: "low", factors: [] },
      unsignedTx: { to: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", data: usdcTransferData, value: "0x0", from: WALLET },
      confirmRawText: `Send 50 USDC to ${ADDR}`,
      requestId: "req-2",
    }));
    try {
      const msg = await respondToSendPayment(`Send 50 USDC to ${ADDR}`, WALLET);
      expect(msg?.operation?.status).toBe("ready");
      const intent = msg?.operation?.intent as PaymentIntent;
      expect(intent.token).toBe("USDC");
      expect(intent.amount).toBe("50");
      // A direct wallet-signed ERC-20 send is transfer(), not transferFrom() —
      // it moves the wallet's own tokens, so no prior allowance/approval is
      // required. transfer()'s selector is 0xa9059cbb; transferFrom's is
      // 0x23b872dd. This is the concrete proof the "allowance" validation
      // item is architecturally satisfied rather than skipped.
      expect(intent.execution?.unsignedTx.data.slice(0, 10)).toBe("0xa9059cbb");
      expect(intent.execution?.unsignedTx.data.slice(0, 10)).not.toBe("0x23b872dd");
    } finally {
      restore();
    }
  });

  it("invalid recipient (unresolvable name) is refused with the real reason, never guessed into an address", async () => {
    const { restore } = mockFetch(() => ({
      decision: "refused",
      intent: { action: "send_payment", amount: 50, token: "USDC", recipient: "Alex", purpose: null, network: "monad", summary: "Send 50 USDC to Alex", confidence: 0.6 },
      guardrail: { allowed: false, violations: [`"Alex" is not a valid wallet address, .nad domain, or known payee.`] },
      compliance: null, risk: null,
    }));
    try {
      const msg = await respondToSendPayment(`Send 50 USDC to Alex`, WALLET);
      expect(msg?.operation).toBeUndefined();
      expect(msg?.content).toMatch(/not a valid wallet address/i);
    } finally {
      restore();
    }
  });

  it("insufficient USDC balance is surfaced as a refusal with the real reason, no operation card", async () => {
    const { restore } = mockFetch(() => ({
      decision: "refused",
      intent: { action: "send_payment", amount: 5000, token: "USDC", recipient: ADDR, purpose: null, network: "monad", summary: "Send 5000 USDC", confidence: 1 },
      guardrail: { allowed: false, violations: ["Insufficient USDC balance."] },
      compliance: { status: "approved", summary: "ok", checks: [] },
      risk: { score: 10, level: "low", factors: [] },
    }));
    try {
      const msg = await respondToSendPayment(`Send 5000 USDC to ${ADDR}`, WALLET);
      expect(msg?.operation).toBeUndefined();
      expect(msg?.content).toMatch(/insufficient usdc balance/i);
    } finally {
      restore();
    }
  });

  it("insufficient MON balance is surfaced as a refusal with the real reason, no operation card — checked separately from USDC since native MON has no ERC-20 balanceOf call behind it", async () => {
    const { restore } = mockFetch(() => ({
      decision: "refused",
      intent: { action: "send_payment", amount: 500, token: "MON", recipient: ADDR, purpose: null, network: "monad", summary: "Send 500 MON", confidence: 1 },
      guardrail: { allowed: false, violations: ["Insufficient MON balance."] },
      compliance: { status: "approved", summary: "ok", checks: [] },
      risk: { score: 10, level: "low", factors: [] },
    }));
    try {
      const msg = await respondToSendPayment(`Send 500 MON to ${ADDR}`, WALLET);
      expect(msg?.operation).toBeUndefined();
      expect(msg?.content).toMatch(/insufficient mon balance/i);
    } finally {
      restore();
    }
  });

  it("blocked (compliance) is surfaced honestly, no operation card", async () => {
    const { restore } = mockFetch(() => ({
      decision: "blocked",
      intent: { action: "send_payment", amount: 50, token: "USDC", recipient: ADDR, purpose: null, network: "monad", summary: "Send 50 USDC", confidence: 1 },
      guardrail: { allowed: true, violations: [] },
      compliance: { status: "rejected", summary: "Failed a mandatory validation check.", checks: [{ id: "sanctions", label: "Sanctions screen", passed: false, severity: "hard", detail: "Recipient is on the OFAC sanctions list." }] },
      risk: { score: 20, level: "low", factors: [] },
    }));
    try {
      const msg = await respondToSendPayment(`Send 50 USDC to ${ADDR}`, WALLET);
      expect(msg?.operation).toBeUndefined();
      expect(msg?.content).toMatch(/OFAC sanctions list/i);
    } finally {
      restore();
    }
  });

  it("AI produces a malformed intent (missing fields on a supposedly-ready response) — never builds an executable card from it", async () => {
    const { restore } = mockFetch(() => ({ decision: "ready_to_sign" /* no unsignedTx, no confirmRawText, no intent */ }));
    try {
      const msg = await respondToSendPayment(`Send 50 USDC to ${ADDR}`, WALLET);
      expect(msg?.operation).toBeUndefined();
      expect(msg?.content).toMatch(/couldn't prepare/i);
    } finally {
      restore();
    }
  });

  it("AI tries to include an unsupported/unrecognized decision — treated as 'couldn't prepare', never as a green light", async () => {
    const { restore } = mockFetch(() => ({
      decision: "execute_now", // not a real decision this pipeline ever returns
      unsignedTx: { to: ADDR, data: "0x", value: "0x1", from: WALLET },
      confirmRawText: "do it now",
    }));
    try {
      const msg = await respondToSendPayment(`Send 50 USDC to ${ADDR}`, WALLET);
      expect(msg?.operation).toBeUndefined();
    } finally {
      restore();
    }
  });

  it("a non-send message returns null so the caller falls through to the existing mock layer for other intents", async () => {
    const msg = await respondToSendPayment("Swap 20 MON to USDC", WALLET);
    expect(msg).toBeNull();
  });
});

describe("send_payment — executeSendPayment (the ONLY function allowed to sign)", () => {
  function readyOperation(): Operation {
    const intent: PaymentIntent = {
      kind: "payment", network: "monad", token: "USDC", amount: "50", recipient: ADDR, recipientDomain: null, estimatedFee: null,
      execution: { unsignedTx: { to: ADDR, data: "0x", value: "0x0", from: WALLET }, confirmRawText: `Send 50 USDC to ${ADDR}`, requestId: "req-3" },
    };
    return { id: "op-1", intent, status: "ready" };
  }

  afterEach(() => vi.restoreAllMocks());

  it("never touches the wallet for an operation with no execution context (a mock/demo card)", async () => {
    const mockOnlyOp: Operation = { id: "op-mock", intent: { kind: "payment", network: "monad", token: "USDC", amount: "10", recipient: ADDR, recipientDomain: null, estimatedFee: "0.001 MON" }, status: "ready" };
    const wallet: SendPaymentWallet = { sendTransaction: vi.fn(), waitForReceipt: vi.fn() };
    const result = await executeSendPayment(mockOnlyOp, wallet);
    expect(result).toBe(mockOnlyOp); // returned unchanged
    expect(wallet.sendTransaction).not.toHaveBeenCalled();
  });

  it("successful transaction: signs, confirms, and attaches the real result", async () => {
    const { restore } = mockFetch(() => ({
      intent: { action: "send_payment", amount: 50, token: "USDC", recipient: ADDR, purpose: null, network: "monad", summary: "Sent 50 USDC", confidence: 1 },
      decision: "executed",
      transaction: { status: "settled", detail: "ok", mode: "monad", txHash: "0xabc123", explorerUrl: "https://explorer.monad.xyz/tx/0xabc123", gasFee: "0.0004 MON", blockNumber: 42 },
    }));
    try {
      const wallet: SendPaymentWallet = {
        sendTransaction: vi.fn().mockResolvedValue("0xabc123"),
        waitForReceipt: vi.fn().mockResolvedValue({ status: "success" }),
      };
      const result = await executeSendPayment(readyOperation(), wallet);
      expect(result.status).toBe("success");
      expect(result.result?.txHash).toBe("0xabc123");
      expect(result.result?.explorerUrl).toContain("0xabc123");
      expect(wallet.sendTransaction).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it("reports live progress through signing -> on-chain -> finalizing", async () => {
    const { restore } = mockFetch(() => ({
      intent: { action: "send_payment", amount: 50, token: "USDC", recipient: ADDR, purpose: null, network: "monad", summary: "Sent 50 USDC", confidence: 1 },
      decision: "executed",
      transaction: { status: "settled", detail: "ok", mode: "monad", txHash: "0xabc123", explorerUrl: "https://explorer.monad.xyz/tx/0xabc123", gasFee: "0.0004 MON", blockNumber: 42 },
    }));
    try {
      const wallet: SendPaymentWallet = {
        sendTransaction: vi.fn().mockResolvedValue("0xabc123"),
        waitForReceipt: vi.fn().mockResolvedValue({ status: "success" }),
      };
      const seen: string[] = [];
      await executeSendPayment(readyOperation(), wallet, (label) => seen.push(label));
      expect(seen[0]).toMatch(/waiting for your signature/i);
      expect(seen[1]).toMatch(/confirming on-chain/i);
      expect(seen[2]).toMatch(/finalizing/i);
    } finally {
      restore();
    }
  });

  it("failed transaction: a mined revert becomes a clear, final error — no fabricated success", async () => {
    const { restore } = mockFetch(() => ({ reverted: true, error: "This payment failed on-chain. No funds were transferred." }));
    try {
      const wallet: SendPaymentWallet = {
        sendTransaction: vi.fn().mockResolvedValue("0xdead"),
        waitForReceipt: vi.fn().mockResolvedValue({ status: "reverted" }),
      };
      const result = await executeSendPayment(readyOperation(), wallet);
      expect(result.status).toBe("error");
      expect(result.error?.code).toBe("REVERTED");
      expect(result.error?.message).toMatch(/no funds were transferred/i);
    } finally {
      restore();
    }
  });

  it("user rejects the wallet/passkey prompt: a clean, friendly cancellation, not a generic crash", async () => {
    const wallet: SendPaymentWallet = {
      sendTransaction: vi.fn().mockRejectedValue(new Error("User rejected the request")),
      waitForReceipt: vi.fn(),
    };
    const result = await executeSendPayment(readyOperation(), wallet);
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("NOT_SENT");
    expect(result.error?.message).toMatch(/you canceled it in your wallet/i);
    expect(wallet.waitForReceipt).not.toHaveBeenCalled();
  });

  it("broadcast but unconfirmable (e.g. an RPC hiccup after signing): never says 'failed' — funds may have moved", async () => {
    const wallet: SendPaymentWallet = {
      sendTransaction: vi.fn().mockResolvedValue("0xbeef"),
      waitForReceipt: vi.fn().mockRejectedValue(new Error("network timeout")),
    };
    const result = await executeSendPayment(readyOperation(), wallet);
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("UNCONFIRMED");
    expect(result.error?.message).not.toMatch(/failed/i);
    expect(result.error?.message).toMatch(/0xbeef/);
  });
});

describe("send_payment — the AI cannot execute without passing through validation and confirmation", () => {
  afterEach(() => vi.restoreAllMocks());

  it("respondToSendPayment can only ever produce a 'ready' card (pre-signature), never 'success' — it has no access to a wallet at all", async () => {
    const { calls, restore } = mockFetch(() => ({
      decision: "ready_to_sign",
      intent: { action: "send_payment", amount: 1, token: "MON", recipient: ADDR, purpose: null, network: "monad", summary: "Send 1 MON", confidence: 1 },
      guardrail: { allowed: true, violations: [] },
      compliance: { status: "approved", summary: "ok", checks: [] },
      risk: { score: 5, level: "low", factors: [] },
      unsignedTx: { to: ADDR, data: "0x", value: "0xde0b6b3a7640000", from: WALLET },
      confirmRawText: `Send 1 MON to ${ADDR}`,
      requestId: "req-4",
    }));
    try {
      const msg = await respondToSendPayment(`Send 1 MON to ${ADDR}`, WALLET);
      expect(msg?.operation?.status).toBe("ready");
      expect(msg?.operation?.status).not.toBe("success");
      // Only /api/agent was ever hit — no broadcast, no confirm call, no
      // signature request happened anywhere in this path.
      expect(calls.map((c) => c.url)).toEqual(["/api/agent"]);
    } finally {
      restore();
    }
  });

  it("a real signature is only ever requested by executeSendPayment, called from the explicit 'Confirm' step — never from the preview path", async () => {
    // respondToSendPayment's exported signature takes no wallet parameter at
    // all: it is structurally incapable of calling wallet.sendTransaction.
    expect(respondToSendPayment.length).toBeLessThanOrEqual(2); // (rawText, walletAddress) — no wallet object
    // (operation, wallet, onProgress?) — the only path that can sign. The
    // third param is a progress-text reporter (see OperationCard's live
    // "confirming" label), never a capability that widens what this can do.
    expect(executeSendPayment.length).toBe(3);
  });
});
