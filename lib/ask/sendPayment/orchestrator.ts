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
import { MONAD_EXPLORER } from "@/lib/monad/public";
import type { AskMessage, Operation, OperationError, PaymentIntent, PlatformFeeView, TransactionResult } from "@/lib/ask/types";
import { extractSendPaymentCandidate, looksLikeSendPayment } from "./parse";
import { validateSendPaymentCandidate } from "./validate";

/** Mirrors lib/ask/intent/orchestrate.ts's own configExplorerTx — client-side
 *  code can't use lib/monad/config's explorerTx() (non-public MONAD_* env is
 *  undefined in the browser). Used only for the "submitted" state below, and
 *  for a reverted approval's own real explorer link. */
function configExplorerTx(txHash: string): string {
  return `${MONAD_EXPLORER}/tx/${txHash}`;
}

/** P1.4 — mirrors orchestrate.ts's own prefixApprovalContext: says the
 *  approval already confirmed separately (and only ever changed an
 *  allowance, never moved funds) before whatever this message is about. */
function prefixApprovalContext(message: string, approvalTx: { txHash: string; explorerUrl: string } | null): string {
  if (!approvalTx) return message;
  return `Your token approval already confirmed separately on Monad — that only set an allowance, no funds moved. ${message}`;
}

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
function isFeeView(v: unknown): v is PlatformFeeView {
  const f = v as PlatformFeeView | null;
  return !!f && [f.amount, f.total, f.token, f.percent].every((x) => typeof x === "string" && x.length > 0 && x.length < 64);
}

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
    // approvalTx/approvalLabel are only present for a forwarder-routed ERC-20
    // payment needing an allowance top-up — read them off the loose response.
    const extra = json as { approvalTx?: { to: string; data: string; value?: string; from: string } | null; approvalLabel?: string | null; platformFee?: PlatformFeeView | null };
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
      platformFee: isFeeView(extra.platformFee) ? extra.platformFee : null,
      execution: {
        unsignedTx: json.unsignedTx,
        // Optional exact-amount approval pre-step for an ERC-20 payment routed
        // through PayAIForwarder — present only when the current allowance is
        // short (see /api/agent). Absent otherwise, keeping the common case a
        // single signature.
        approvalTx: extra.approvalTx ?? null,
        approvalLabel: extra.approvalLabel ?? null,
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
export async function executeSendPayment(
  operation: Operation, wallet: SendPaymentWallet,
  onProgress?: (label: string) => void,
): Promise<Operation> {
  if (operation.intent.kind !== "payment" || !operation.intent.execution) return operation;
  const { unsignedTx, approvalTx, approvalLabel, confirmRawText, requestId } = operation.intent.execution;

  let broadcastHash: string | null = null;
  // P1.4 — the approval's OWN real txHash/explorerUrl, once it confirms.
  // Named distinctly from `approvalTx` above (the UNSIGNED approval request)
  // to keep "the thing we're about to sign" and "the thing that already
  // confirmed" from ever being confused with each other.
  let approvalTxInfo: { txHash: string; explorerUrl: string } | null = null;
  try {
    // Step 1 (ERC-20-through-forwarder, only when allowance is short): the
    // exact-amount approval. This moves NO funds — it only authorizes the
    // forwarder to pull exactly this payment's amount — so a failure/rejection
    // here is a clean pre-payment abort (no pendingSettlement saved, no confirm
    // attempted). Only after it's mined do we sign the actual payment. This is
    // the SAME operation and the SAME states (ready -> confirming -> success/
    // error), just with one extra pre-signature — not a second state machine.
    if (approvalTx) {
      onProgress?.(`Step 1 of 2: ${approvalLabel ?? "approve PayAI to spend the token"} — nothing has moved yet.`);
      let approvalHash: string;
      try {
        approvalHash = await wallet.sendTransaction(approvalTx);
      } catch (e) {
        // User rejected the approval, or it failed to broadcast — nothing has
        // moved, nothing to confirm; surface it as a clean not-sent error.
        const error: OperationError = { message: friendlyError(e instanceof Error ? e.message : "Approval was not completed."), code: "APPROVAL_NOT_SENT" };
        return { ...operation, status: "error", error };
      }
      onProgress?.("Approval sent — confirming it on-chain before the payment…");
      let approvalReceipt: { status?: string | number } | undefined;
      try {
        approvalReceipt = (await wallet.waitForReceipt(approvalHash)) as { status?: string | number } | undefined;
      } catch {
        // P1.4: the approval genuinely broadcast (a real hash exists) but its
        // OWN confirmation couldn't be observed — a receipt-wait timeout or
        // RPC hiccup. This used to fall through to a generic "payment
        // failed" with no hash at all, losing a real, possibly-still-settling
        // transaction. It's the same broadcast-but-unconfirmed situation P0
        // already has a real answer for: never a failure, never rebroadcast,
        // and the payment itself must never be signed on top of an approval
        // whose outcome isn't known yet.
        return { ...operation, status: "submitted", submitted: { txHash: approvalHash, explorerUrl: configExplorerTx(approvalHash), step: "approval" } };
      }
      // A reverted approval must not fall through into a forward that will then
      // revert for a missing allowance — stop here with a clear message. Its
      // own real hash is worth keeping (a confirmed, if failed, transaction),
      // never dropped just because the OUTCOME was bad.
      if (approvalReceipt && (approvalReceipt.status === "reverted" || approvalReceipt.status === 0 || approvalReceipt.status === "0x0")) {
        const error: OperationError = {
          message: "The token approval failed on-chain — no payment was attempted. You can safely try again.",
          code: "APPROVAL_REVERTED", txHash: approvalHash, explorerUrl: configExplorerTx(approvalHash),
        };
        return { ...operation, status: "error", error };
      }
      approvalTxInfo = { txHash: approvalHash, explorerUrl: configExplorerTx(approvalHash) };
      onProgress?.("Approved. Step 2 of 2: sign the payment — still nothing moved until you do.");
    }

    onProgress?.(approvalTx ? "Waiting for your payment signature — nothing has moved yet." : "Waiting for your signature — nothing has moved yet.");
    const hash = await wallet.sendTransaction(unsignedTx);
    broadcastHash = hash;
    // The wallet has now broadcast a REAL transaction — persist immediately,
    // before anything else can fail, so a closed tab or a confirm-step
    // hiccup never reads back as "the payment failed" (see pendingSettlement.ts).
    savePendingSettlement({ kind: "payment", walletAddress: unsignedTx.from, txHash: hash, rawText: confirmRawText, requestId, savedAt: Date.now() });

    onProgress?.("Signed — confirming on-chain…");
    await wallet.waitForReceipt(hash);
    onProgress?.("Finalizing payment…");
    const r = await fetch("/api/agent/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rawText: confirmRawText, walletAddress: unsignedTx.from, txHash: hash, requestId }),
    });
    // A malformed body throws here and lands in the catch below, which treats
    // it as broadcast-but-unconfirmed — never as "not sent".
    const json = (await r.json()) as AgentResult & { error?: string; reverted?: boolean; success?: boolean };
    // The pending settlement is cleared ONLY on a definitive outcome: the
    // confirm route saw the transaction mined and reverted, or it verified
    // and recorded the payment. Anything else — approval missing, 503,
    // not mined yet, already processing/confirmed, a mismatch, a policy
    // refusal, a rate limit — leaves the payment possibly settled, so the
    // evidence is kept and the user is told not to resend.
    if (json.reverted === true) {
      clearPendingSettlement(hash);
      const message = prefixApprovalContext(json.error || "This payment failed on-chain. No funds were transferred.", approvalTxInfo);
      const error: OperationError = { message, code: "REVERTED", txHash: hash, explorerUrl: configExplorerTx(hash), approvalTx: approvalTxInfo ?? undefined };
      return { ...operation, status: "error", error };
    }
    if (!r.ok || json.success !== true || !json.intent) {
      const error: OperationError = {
        message: `Your payment was sent (${hash.slice(0, 10)}…) but we couldn't confirm it yet. Don't resend it — check the transaction on the explorer or in Transactions for the latest status.`,
        code: "CONFIRM_FAILED", txHash: hash, explorerUrl: configExplorerTx(hash), approvalTx: approvalTxInfo ?? undefined,
      };
      return { ...operation, status: "error", error };
    }
    clearPendingSettlement(hash);
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
        code: "UNCONFIRMED", txHash: broadcastHash, explorerUrl: configExplorerTx(broadcastHash),
      };
      return { ...operation, status: "error", error };
    }
    // The payment's own signature was never even broadcast (rejected, or
    // threw before reaching the wallet). If an approval already confirmed
    // earlier in this same attempt, say so explicitly rather than a bare,
    // unqualified failure.
    const error: OperationError = {
      message: prefixApprovalContext(friendlyError(e instanceof Error ? e.message : "Wallet payment failed."), approvalTxInfo),
      code: "NOT_SENT", approvalTx: approvalTxInfo ?? undefined,
    };
    return { ...operation, status: "error", error };
  }
}
