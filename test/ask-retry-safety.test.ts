import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import type { Operation, PaymentIntent } from "@/lib/ask/types";

/**
 * Ask PayAI must never invite a second payment while the first may already
 * have settled.
 *
 *   - "Try again" (which starts a NEW payment: new approval, new signature)
 *     is offered only for failures that provably moved nothing.
 *   - After a broadcast, the pending-settlement record is kept for every
 *     outcome except a verified success or a definitive on-chain revert.
 *   - No message tells the user to pay again when the original may have
 *     settled.
 *
 * MOCKED: the wallet (sendTransaction/waitForReceipt), fetch to
 * /api/agent/confirm, and browser localStorage. Nothing is signed or sent.
 */

const ADDR = "0x2222222222222222222222222222222222222222";
const WALLET = "0x1234567890abcdef1234567890abcdef12345678";
const HASH = `0x${"ab".repeat(32)}`;
const PENDING_KEY = "payai_pending_settlement";

// The chain, for the confirm-route section: a successful transaction from
// WALLET. MOCKED — no RPC is touched.
vi.mock("viem", async (orig) => {
  const actual = await orig<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: () => ({
      getTransactionReceipt: async () => ({ status: "success", from: WALLET, to: ADDR, logs: [], blockNumber: 7n }),
    }),
  };
});

// Browser localStorage, in memory (pendingSettlement.ts reads the global).
const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function paymentOp(status: Operation["status"] = "ready", error?: Operation["error"]): Operation {
  const intent: PaymentIntent = {
    kind: "payment", network: "monad", token: "USDC", amount: "50", recipient: ADDR, recipientDomain: null, estimatedFee: null,
    execution: { unsignedTx: { to: ADDR, data: "0x", value: "0x0", from: WALLET }, confirmRawText: `Send 50 USDC to ${ADDR}`, requestId: "req-1" },
  };
  return { id: "op-1", intent, status, ...(error ? { error } : {}) };
}

/* ── 1. Retry eligibility ──────────────────────────────────────────────── */

describe("retry eligibility: only failures that provably moved nothing", () => {
  async function renderCard(op: Operation) {
    const { OperationCard } = await import("@/components/ask/OperationCard");
    return renderToStaticMarkup(createElement(OperationCard, { operation: op, onAdvance: () => {}, onRetry: () => {} }));
  }

  const UNSAFE: [string, string | undefined][] = [
    ["unconfirmed (broadcast, receipt wait failed)", "UNCONFIRMED"],
    ["confirmation failed after broadcast", "CONFIRM_FAILED"],
    ["interrupted mid-signature (page closed)", "INTERRUPTED"],
    ["one hop of a multi-hop trade done", "PARTIAL_MULTI_HOP"],
    ["superseded by an updated card", "SUPERSEDED"],
    ["mismatch / unknown status (unlisted code)", "SETTLEMENT_MISMATCH"],
    ["no code at all", undefined],
  ];
  for (const [label, code] of UNSAFE) {
    it(`no "Try again" for ${label}`, async () => {
      const op = paymentOp("error", { message: "x", code });
      expect(await renderCard(op)).not.toContain("Try again");
      const { retryTextFor } = await import("@/lib/ask/useAskChat");
      expect(retryTextFor(op)).toBeNull(); // so neither page wires onRetry, and retryOperation is a no-op
    });
  }

  for (const code of ["NOT_SENT", "REVERTED"]) {
    it(`"Try again" stays for ${code} (nothing moved / definitive revert)`, async () => {
      const op = paymentOp("error", { message: "x", code });
      expect(await renderCard(op)).toContain("Try again");
      const { retryTextFor } = await import("@/lib/ask/useAskChat");
      expect(retryTextFor(op)).toBe(`Send 50 USDC to ${ADDR}`);
    });
  }

  it("the allow-list is exactly the codes set only where nothing could have moved", async () => {
    const { RETRYABLE_ERROR_CODES } = await import("@/lib/ask/retryPolicy");
    expect([...RETRYABLE_ERROR_CODES].sort()).toEqual([
      "APPROVAL_FAILED", "APPROVAL_NOT_SENT", "APPROVAL_REVERTED", "BUILD_FAILED", "NOT_SENT",
      "NO_WALLET", "QUOTE_EXPIRED", "REVERTED", "USER_CANCELLED", "WRONG_NETWORK",
    ]);
    for (const c of ["UNCONFIRMED", "CONFIRM_FAILED", "INTERRUPTED", "PARTIAL_MULTI_HOP", "SUPERSEDED"]) {
      expect(RETRYABLE_ERROR_CODES.has(c), c).toBe(false);
    }
  });

  it("a non-error card never offers retry, even with an allow-listed code", async () => {
    const { isSafeToRetry } = await import("@/lib/ask/retryPolicy");
    expect(isSafeToRetry({ status: "submitted", error: { message: "x", code: "NOT_SENT" } })).toBe(false);
  });

  it("no alternate path: both entry points and retryOperation go through the same gate", () => {
    const src = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
    expect(src("app/dashboard/ask/page.tsx")).toMatch(/onRetryOperation=\{m\.operation && retryTextFor\(m\.operation\) \? retryOperation : undefined\}/);
    expect(src("components/dashboard/CommandBar.tsx")).toMatch(/onRetryOperation=\{m\.operation && retryTextFor\(m\.operation\) \? chat\.retryOperation : undefined\}/);
    const chat = src("lib/ask/useAskChat.ts");
    expect(chat).toMatch(/function retryOperation[\s\S]{0,300}retryTextFor\(op\)/);
    expect(chat).toMatch(/export function retryTextFor[\s\S]{0,120}if \(!isSafeToRetry\(op\)\) return null;/);
    expect(src("components/ask/OperationCard.tsx")).toMatch(/status === "error" && onRetry && isSafeToRetry\(operation\)/);
  });
});

/* ── 2. Pending-settlement evidence ────────────────────────────────────── */

describe("pending settlement: kept unless verified success or definitive revert", () => {
  function mockConfirm(status: number, body: unknown, raw?: string) {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(raw ?? JSON.stringify(body), { status, headers: { "content-type": "application/json" } })));
  }
  const wallet = () => ({
    sendTransaction: vi.fn().mockResolvedValue(HASH),
    waitForReceipt: vi.fn().mockResolvedValue({ status: "success" }),
  });
  const pending = () => {
    const raw = store.get(PENDING_KEY);
    return raw ? (JSON.parse(raw) as { txHash: string; requestId?: string }) : null;
  };
  async function run() {
    const { executeSendPayment } = await import("@/lib/ask/sendPayment/orchestrator");
    return executeSendPayment(paymentOp(), wallet());
  }
  /** Nothing a user reads may invite another payment. */
  const NEW_PAYMENT_INVITATION = /start (the|a new) payment|start again|pay again|send it again|try again|retry the payment/i;

  const UNCERTAIN: [string, number, unknown, string?][] = [
    ["approval_not_found", 409, { error: "We couldn't find the approval…", reason: "approval_not_found" }],
    ["approval_required", 409, { error: "We couldn't match…", reason: "approval_required" }],
    ["503 RPC unavailable", 503, { error: "Could not reach the Monad network to verify this transaction. Please retry." }],
    ["not mined yet", 409, { error: "Transaction not found or not successful yet." }],
    ["already being processed", 409, { error: "This confirmation is already being processed." }],
    ["already_confirmed (another owner)", 409, { error: "This transaction has already been confirmed.", reason: "already_confirmed" }],
    ["verifier mismatch", 409, { error: "Transaction does not match this payment (wrong token, recipient, or amount).", reason: "calldata_recipient_mismatch" }],
    ["guardrail/compliance refusal", 409, { error: "This request no longer clears compliance for wallet settlement." }],
    ["rate limited", 429, { error: "Too many requests" }],
    ["200 but not a success body", 200, { intent: { action: "send_payment" } }],
    ["500 with a non-JSON body", 500, null, "<html>Internal Server Error</html>"],
    ["200 with a malformed body", 200, null, "{not json"],
  ];
  for (const [label, status, body, raw] of UNCERTAIN) {
    it(`keeps the evidence and says "don't resend": ${label}`, async () => {
      mockConfirm(status, body, raw);
      const result = await run();
      expect(result.status).toBe("error");
      expect(["CONFIRM_FAILED", "UNCONFIRMED"]).toContain(result.error?.code);
      expect(pending()?.txHash).toBe(HASH); // evidence survives
      expect(pending()?.requestId).toBe("req-1");
      expect(result.error?.txHash).toBe(HASH);
      expect(result.error?.message).toMatch(/don't resend/i);
      expect(result.error?.message).not.toMatch(NEW_PAYMENT_INVITATION);
      const { isSafeToRetry } = await import("@/lib/ask/retryPolicy");
      expect(isSafeToRetry(result)).toBe(false); // and no "Try again"
    });
  }

  it("clears the evidence after a verified, recorded success", async () => {
    mockConfirm(200, { success: true, intent: { action: "send_payment" }, transaction: { txHash: HASH, explorerUrl: "https://x/tx" } });
    const result = await run();
    expect(result.status).toBe("success");
    expect(pending()).toBeNull();
  });

  it("clears the evidence after a definitive on-chain revert — and retry is allowed", async () => {
    mockConfirm(409, { error: "This transaction failed on-chain (reverted). No funds were transferred. You can safely try again.", reverted: true, txHash: HASH });
    const result = await run();
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("REVERTED");
    expect(pending()).toBeNull();
    const { isSafeToRetry } = await import("@/lib/ask/retryPolicy");
    expect(isSafeToRetry(result)).toBe(true);
  });

  it("a payment that was never broadcast leaves no evidence and stays retryable", async () => {
    const { executeSendPayment } = await import("@/lib/ask/sendPayment/orchestrator");
    const result = await executeSendPayment(paymentOp(), {
      sendTransaction: vi.fn().mockRejectedValue(new Error("User rejected the request")),
      waitForReceipt: vi.fn(),
    });
    expect(result.error?.code).toBe("NOT_SENT");
    expect(pending()).toBeNull();
    const { isSafeToRetry } = await import("@/lib/ask/retryPolicy");
    expect(isSafeToRetry(result)).toBe(true);
  });

  it("a receipt-wait failure after broadcast keeps the evidence (UNCONFIRMED)", async () => {
    const { executeSendPayment } = await import("@/lib/ask/sendPayment/orchestrator");
    const result = await executeSendPayment(paymentOp(), {
      sendTransaction: vi.fn().mockResolvedValue(HASH),
      waitForReceipt: vi.fn().mockRejectedValue(new Error("network timeout")),
    });
    expect(result.error?.code).toBe("UNCONFIRMED");
    expect(pending()?.txHash).toBe(HASH);
    expect(result.error?.message).toMatch(/don't resend/i);
  });
});

/* ── 3. Server wording ─────────────────────────────────────────────────── */

describe("/api/agent/confirm never tells a possibly-settled payer to pay again", () => {
  async function confirm(body: Record<string, unknown>) {
    const { POST } = await import("@/app/api/agent/confirm/route");
    const res = await POST(new NextRequest("http://localhost/api/agent/confirm", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` },
      body: JSON.stringify({ rawText: "Send 1 USDC", walletAddress: WALLET, txHash: HASH, ...body }),
    }));
    return { status: res.status, body: (await res.json()) as { error?: string; reason?: string } };
  }

  it("approval_required and approval_not_found use neutral recovery wording", async () => {
    // The transaction settled on-chain; only its approval is missing.
    for (const [body, reason] of [[{}, "approval_required"], [{ requestId: "gone" }, "approval_not_found"]] as const) {
      const r = await confirm(body);
      expect(r.status).toBe(409);
      expect(r.body.reason).toBe(reason);
      expect((r.body as Record<string, unknown>).state).toBe("settled_unmatched");
      expect(r.body.error).toMatch(/don't send it again/i);
      expect(r.body.error).not.toMatch(/start the payment again|start a new payment|pay again|try again/i);
    }
  });

  it("the route has no 'start the payment again' wording anywhere", () => {
    const route = readFileSync(new URL("../app/api/agent/confirm/route.ts", import.meta.url), "utf8");
    expect(route).not.toMatch(/start the payment again/i);
    // The one "try again" left is the definitive mined-revert message.
    expect(route.match(/try again\./gi) ?? []).toHaveLength(1);
    expect(route).toMatch(/failed on-chain \(reverted\)\. No funds were transferred\. You can safely try again\./);
  });
});
