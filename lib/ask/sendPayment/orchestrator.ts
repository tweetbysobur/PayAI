/**
 * Ask PayAI Phase 2 — orchestration layer for send_payment.
 *
 * This is the ONLY module allowed to (a) call the real payment pipeline and
 * (b) request a wallet signature, for a natural-language send_payment
 * request. It creates no new execution system: `/api/agent` and
 * `/api/agent/confirm` are the exact same endpoints the rest of PayAI's
 * dashboard uses (see lib/hooks/useAgentConsole.ts), and the wallet call is
 * the same `wallet.sendTransaction` / `wallet.waitForReceipt` pair every
 * other signed transaction in the app goes through.
 *
 * Two functions, two very different powers:
 *   - respondToSendPayment  — parses, validates, previews. Never touches a
 *     wallet. Cannot execute anything by construction: it doesn't even
 *     receive a wallet object.
 *   - executeSendPayment    — the only function that can request a
 *     signature, and only ever called from the "Confirm with passkey" click
 *     on a card this module already built and the server already approved.
 */
"use client";

import { friendlyError, type AgentResult } from "@/lib/hooks/useAgentConsole";
import { clearPendingSettlement, savePendingSettlement } from "@/lib/hooks/pendingSettlement";
import type { AskMessage, Operation, OperationError, PaymentIntent, TransactionResult } from "@/lib/ask/types";
import { extractSendPaymentCandidate, looksLikeSendPayment } from "./parse";
import { validateSendPaymentCandidate } from "./validate";

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now()}_${counter}`;
}

function assistantText(content: string): AskMessage {
  return { id: nextId("msg"), role: "assistant", content, createdAt: Date.now() };
}

/** The minimal wallet surface executeSendPayment needs — matches
 *  WalletServiceState's shape so the real hook satisfies it structurally. */
export interface SendPaymentWallet {
  sendTransaction(tx: { to: string; data?: string; value?: string }): Promise<string>;
  waitForReceipt(hash: string): Promise<unknown>;
}

/**
 * Entry point for a message that might be a real send_payment request.
 * Returns `null` when the text isn't send-payment-shaped at all — the
 * caller should fall through to the mock/demo layer for every other intent
 * this phase doesn't implement (swap, schedule, distribute, balance, ...).
 *
 * Never requests a wallet signature. The furthest this function can reach is
 * a `ready_to_sign` Operation card — advancing past that is executeSendPayment's
 * job alone, triggered only by an explicit user click in the UI.
 */
export async function respondToSendPayment(rawText: string, walletAddress: string | null): Promise<AskMessage | null> {
  if (!looksLikeSendPayment(rawText)) return null;

  const candidate = extractSendPaymentCandidate(rawText);
  const validation = validateSendPaymentCandidate(candidate);
  if (!validation.ok) return assistantText(validation.question);

  // "Wallet is connected" is itself a required validation check, and it's
  // the one that keeps Ask PayAI non-custodial: without a walletAddress,
  // /api/agent's send_payment path falls through to the platform's own
  // agent wallet (the custodial path other, non-interactive flows use) —
  // Ask PayAI must never reach that branch.
  if (!walletAddress) {
    return assistantText("Connect your wallet to send a payment — I can't sign this for you.");
  }

  const idempotencyKey = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let json: (AgentResult & { error?: string; requestId?: string }) | null = null;
  try {
    const r = await fetch("/api/agent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // The text reaching this point is always Ask PayAI's own canonical
      // reconstruction from an already-classified intent (see
      // lib/ask/intent/orchestrate.ts's dispatchSendPayment) — never raw,
      // ambiguous user wording. Nothing left for a second Anthropic call to
      // refine, so skip it (see brain.ts's parseIntent skipLLM option).
      body: JSON.stringify({ intent: rawText, walletAddress, idempotencyKey, skipLLMRefinement: true }),
    });
    json = await r.json();
  } catch {
    return assistantText("Couldn't reach PayAI to prepare that payment. Check your connection and try again.");
  }
  if (!json) return assistantText("Something went wrong preparing that payment. Try again.");

  const decision = json.decision as string;

  if (
    decision === "ready_to_sign" &&
    json.unsignedTx &&
    json.confirmRawText &&
    json.intent?.recipient &&
    json.intent.amount != null
  ) {
    const intent: PaymentIntent = {
      kind: "payment",
      network: "monad",
      token: json.intent.token,
      amount: String(json.intent.amount),
      recipient: json.intent.recipient,
      recipientDomain: json.intent.domain ?? null,
      // Never fabricated — PayAI has no pre-signature fee estimate for a
      // plain wallet-signed transfer; the wallet itself shows gas at signing.
      estimatedFee: null,
      execution: {
        unsignedTx: json.unsignedTx,
        confirmRawText: json.confirmRawText,
        requestId: json.requestId,
      },
    };
    const operation: Operation = { id: nextId("op"), intent, status: "ready" };
    return { id: nextId("msg"), role: "assistant", content: "Here's the payment, ready for your confirmation.", createdAt: Date.now(), operation };
  }

  if (decision === "refused") {
    const reason = json.guardrail?.violations?.join(" ") || json.error || "I can't send that — the details didn't check out.";
    return assistantText(reason);
  }
  if (decision === "blocked") {
    const failed = json.compliance?.checks?.find((c) => !c.passed);
    return assistantText(`Payment blocked. Reason: ${failed?.detail || json.compliance?.summary || "This didn't pass compliance screening."}`);
  }
  if (decision === "needs_review") {
    return assistantText("This payment needs manual review before it can be sent — it wasn't cleared for instant execution.");
  }
  if (decision === "error") {
    return assistantText(json.error || "Something went wrong preparing that payment.");
  }
  // Any other/unexpected shape (including a malformed or unrecognized
  // decision) is treated as "couldn't prepare it" — never as a green light.
  return assistantText("I couldn't prepare that payment. Try rephrasing it, e.g. \"Send 50 USDC to 0x742d...91F.\"");
}

/**
 * The only function in this module allowed to request a wallet signature.
 * Called exclusively from the "Confirm with passkey" click on an
 * already-displayed, already-server-approved operation.
 */
export async function executeSendPayment(operation: Operation, wallet: SendPaymentWallet): Promise<Operation> {
  if (operation.intent.kind !== "payment" || !operation.intent.execution) return operation;
  const { unsignedTx, confirmRawText, requestId } = operation.intent.execution;

  let broadcastHash: string | null = null;
  try {
    const hash = await wallet.sendTransaction(unsignedTx);
    broadcastHash = hash;
    // The wallet has now broadcast a REAL transaction — persist immediately,
    // before anything else can fail, so a closed tab or a confirm-step
    // hiccup never reads back as "the payment failed" (see pendingSettlement.ts).
    savePendingSettlement({ kind: "payment", walletAddress: unsignedTx.from, txHash: hash, rawText: confirmRawText, requestId, savedAt: Date.now() });

    await wallet.waitForReceipt(hash);
    const r = await fetch("/api/agent/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rawText: confirmRawText, walletAddress: unsignedTx.from, txHash: hash, requestId }),
    });
    const json = (await r.json()) as AgentResult & { error?: string; reverted?: boolean };
    if (!json.intent) {
      clearPendingSettlement();
      const message = json.reverted
        ? (json.error || "This payment failed on-chain. No funds were transferred.")
        : friendlyError(json.error || "Could not confirm the payment.");
      const error: OperationError = { message, code: json.reverted ? "REVERTED" : "CONFIRM_FAILED" };
      return { ...operation, status: "error", error };
    }
    clearPendingSettlement();
    const result: TransactionResult = {
      txHash: json.transaction?.txHash ?? hash,
      explorerUrl: json.transaction?.explorerUrl ?? "",
      blockNumber: json.transaction?.blockNumber,
      gasFee: json.transaction?.gasFee,
    };
    return { ...operation, status: "success", result };
  } catch (e) {
    if (broadcastHash) {
      // Broadcast but unconfirmed — never say "failed": funds may already
      // have moved, and re-offering Confirm here is how someone pays twice.
      const error: OperationError = {
        message: `Your payment was sent (${broadcastHash.slice(0, 10)}…) but we couldn't confirm it yet. Don't resend it — check Transactions for the latest status.`,
        code: "UNCONFIRMED",
      };
      return { ...operation, status: "error", error };
    }
    const error: OperationError = { message: friendlyError(e instanceof Error ? e.message : "Wallet payment failed."), code: "NOT_SENT" };
    return { ...operation, status: "error", error };
  }
}
