import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { executeSendPayment, type SendPaymentWallet } from "@/lib/ask/sendPayment/orchestrator";
import type { Operation } from "@/lib/ask/types";

// The ERC-20-through-forwarder interactive flow signs an exact-amount approval
// FIRST (only when one is present), then the forward — inside the SAME payment
// operation, not a second state machine. These tests drive executeSendPayment
// directly with a mock wallet + mock /api/agent/confirm.

const FWD = "0x7777777777777777777777777777777777777777" as `0x${string}`;
const TOKEN = "0x3333333333333333333333333333333333333333";
const WALLET = "0x1111111111111111111111111111111111111111";

function mockFetch(responder: () => unknown) {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    calls.push(String(url));
    // A real 200 Response (executeSendPayment checks r.ok, as fetch always sets it).
    return { ok: true, status: 200, json: async () => responder() } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

/** Records the order of txs signed; returns a canned hash + success receipt. */
function makeWallet(overrides?: Partial<SendPaymentWallet>): { wallet: SendPaymentWallet; sent: { to: string; data: string }[] } {
  const sent: { to: string; data: string }[] = [];
  const wallet: SendPaymentWallet = {
    async sendTransaction(tx) {
      sent.push({ to: tx.to, data: tx.data ?? "0x" });
      return `0x${(sent.length).toString(16).padStart(64, "0")}`;
    },
    async waitForReceipt() {
      return { status: "success" };
    },
    ...overrides,
  };
  return { wallet, sent };
}

function opWith(execution: NonNullable<Extract<Operation["intent"], { kind: "payment" }>["execution"]>): Operation {
  return {
    id: "op1",
    status: "ready",
    intent: { kind: "payment", network: "monad", token: "USDC", amount: "50", recipient: "0x2222222222222222222222222222222222222222", execution },
  };
}

const forwardTx = { to: FWD, data: "0xforward", value: "0x0", from: WALLET };
const approvalTx = { to: TOKEN, data: "0xapprove", value: "0x0", from: WALLET };

describe("executeSendPayment — ERC-20 forwarder two-step", () => {
  let fetchMock: { calls: string[]; restore: () => void };
  beforeEach(() => {
    fetchMock = mockFetch(() => ({ success: true, intent: { recipient: "0x2222222222222222222222222222222222222222", amount: 50 }, transaction: { txHash: "0xabc", explorerUrl: "e" } }));
  });
  afterEach(() => fetchMock.restore());

  it("with an approvalTx present: signs the approval FIRST, then the forward", async () => {
    const { wallet, sent } = makeWallet();
    const op = opWith({ unsignedTx: forwardTx, approvalTx, approvalLabel: "Approve 50 USDC for PayAI", confirmRawText: "Send 50 USDC to 0x2222", requestId: "r1" });
    const result = await executeSendPayment(op, wallet);
    expect(result.status).toBe("success");
    expect(sent.map((s) => s.data)).toEqual(["0xapprove", "0xforward"]); // order: approval THEN forward
    expect(sent[0].to.toLowerCase()).toBe(TOKEN.toLowerCase());
    expect(sent[1].to.toLowerCase()).toBe(FWD.toLowerCase());
  });

  it("with NO approvalTx (allowance already sufficient): a SINGLE signature, just the forward", async () => {
    const { wallet, sent } = makeWallet();
    const op = opWith({ unsignedTx: forwardTx, approvalTx: null, confirmRawText: "Send 50 USDC", requestId: "r2" });
    const result = await executeSendPayment(op, wallet);
    expect(result.status).toBe("success");
    expect(sent).toHaveLength(1);
    expect(sent[0].data).toBe("0xforward");
  });

  it("if the user rejects the approval: clean abort — the forward is NEVER signed", async () => {
    let calls = 0;
    const wallet: SendPaymentWallet = {
      async sendTransaction() { calls += 1; throw new Error("User rejected the request"); },
      async waitForReceipt() { return { status: "success" }; },
    };
    const op = opWith({ unsignedTx: forwardTx, approvalTx, approvalLabel: "Approve", confirmRawText: "x", requestId: "r3" });
    const result = await executeSendPayment(op, wallet);
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error?.code).toBe("APPROVAL_NOT_SENT");
    expect(calls).toBe(1); // only the approval was attempted; the forward never was
  });

  it("if the approval reverts on-chain: stops before the forward with a clear message", async () => {
    const sent: string[] = [];
    const wallet: SendPaymentWallet = {
      async sendTransaction(tx) { sent.push(tx.data ?? "0x"); return "0xhash"; },
      async waitForReceipt() { return { status: "reverted" }; },
    };
    const op = opWith({ unsignedTx: forwardTx, approvalTx, confirmRawText: "x", requestId: "r4" });
    const result = await executeSendPayment(op, wallet);
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.error?.code).toBe("APPROVAL_REVERTED");
    expect(sent).toEqual(["0xapprove"]); // forward never signed
  });

  it("if the forward is rejected AFTER a successful approval: reports an error, not success", async () => {
    let n = 0;
    const wallet: SendPaymentWallet = {
      async sendTransaction() { n += 1; if (n === 2) throw new Error("User rejected the request"); return "0xhash"; },
      async waitForReceipt() { return { status: "success" }; },
    };
    const op = opWith({ unsignedTx: forwardTx, approvalTx, confirmRawText: "x", requestId: "r5" });
    const result = await executeSendPayment(op, wallet);
    expect(result.status).toBe("error");
    expect(n).toBe(2); // approval + forward both attempted; forward failed
  });

  it("native MON regression: an operation with no approvalTx still executes as a single signature", async () => {
    const { wallet, sent } = makeWallet();
    const nativeTx = { to: "0x2222222222222222222222222222222222222222", data: "0x", value: "0xde0b6b3a7640000", from: WALLET };
    const op = opWith({ unsignedTx: nativeTx, confirmRawText: "Send 1 MON", requestId: "r6" });
    const result = await executeSendPayment(op, wallet);
    expect(result.status).toBe("success");
    expect(sent).toHaveLength(1);
  });
});
