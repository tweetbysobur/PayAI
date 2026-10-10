/**
 * Ask PayAI — orchestration layer.
 *
 * Takes a settled Understanding (see classify.ts) and turns it into a chat
 * reply, dispatching anything actionable+complete to the SAME real backends
 * the rest of the dashboard already uses: /api/agent for send_payment, swap
 * quoting, and read-only balance/history queries; /api/swap/confirm for
 * swap settlement; /api/automations for a real automation listing. No new
 * execution system — the raw text this module sends downstream is always a
 * precise, canonical reconstruction of the already-validated slots (never
 * the user's original ambiguous wording), so the existing, already-hardened
 * parsers on the other end re-derive and re-validate everything themselves.
 *
 * Nothing here signs a transaction except executeSwapIntent, and nothing
 * calls it except an explicit "Confirm" click already gated behind a
 * server-approved, fully-previewed operation card.
 */
"use client";

import { scheduleRequestText } from "./scheduleText";
import { roomLead } from "./roomIntent";
import { friendlyError, type AgentResult } from "@/lib/hooks/useAgentConsole";
import { clearPendingSettlement, getPendingSettlement, savePendingSettlement } from "@/lib/hooks/pendingSettlement";
import { MONAD_EXPLORER } from "@/lib/monad/public";
import type { AskMessage, AutomationHandoff, Operation, OperationError, ProtocolActionData, ProtocolActionIntent, RecurringPaymentIntent, ScheduledPaymentIntent, SwapIntent, TokenData, TokenIntelligenceIntent, TradePreviewData, TradePreviewIntent, TransactionResult, WalletOperationIntent, WalletTransactionView } from "@/lib/ask/types";
import { respondToSendPayment, type SendPaymentWallet } from "@/lib/ask/sendPayment/orchestrator";
import type { ConversationTurn } from "./classify";
import type { Understanding } from "./types";
import type { ActionInputs, ActionInputValue } from "@/lib/sdk/types";

// Re-exported so client code (e.g. app/dashboard/ask/page.tsx) never imports
// from classify.ts directly — that module is "server-only" and this is the
// one type from it a client component legitimately needs.
export type { ConversationTurn };

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now()}_${counter}`;
}
function assistantText(content: string): AskMessage {
  return { id: nextId("msg"), role: "assistant", content, createdAt: Date.now() };
}
function idemKey(tag: string): string {
  return `ask-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** A real EVM contract address, as opposed to a curated display symbol —
 *  used only to decide whether a trade's received token has an address
 *  worth recording for portfolio discovery (see TxLogEntry's
 *  outputTokenAddress and executeTradeIntent's settle call below). */
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

type SwapPlan = NonNullable<SwapIntent["execution"]>["plan"];
/** One row of real transaction history, as /api/agent's show_history query
 *  returns it — this is lib/platform/types.ts's TxLogEntry verbatim (minus
 *  fields this module doesn't use), never a client-side reconstruction. */
interface TxHistoryRow {
  at: number;
  decision: "executed" | "needs_review" | "blocked" | "refused" | "error";
  action: string;
  feature?: "payment" | "swap" | "trade" | "automation" | "bulk";
  amount: number | null;
  token: string;
  recipient: string | null;
  sender?: string | null;
  txHash?: string;
  explorerUrl?: string;
  summary: string;
  /** Swap/trade only (see lib/platform/types.ts's TxLogEntry). */
  outputAmount?: number | null;
  outputToken?: string | null;
  provider?: string | null;
}
/** /api/agent's response covers far more decisions than AgentResult's own
 *  type declares (swap_ready, automation_prefill, info, ...) — widen
 *  `decision` to a plain string rather than fighting that union here. */
type AgentApiResponse = Omit<AgentResult, "decision"> & {
  decision: string;
  error?: string;
  swap?: SwapPlan;
  provider?: string;
  prefill?: { amount: number; token: string; recipient: string; domain?: string | null; cadence: string; nextRun: number | null };
  balance?: { mon: number; usdc: number };
  history?: TxHistoryRow[];
  count?: number;
  query?: string;
};

/** Step 1 of every turn — ask the semantic layer what the message means. */
export async function classifyMessage(text: string, history: ConversationTurn[], pending: Understanding | null, signal?: AbortSignal): Promise<Understanding> {
  try {
    const r = await fetch("/api/ask/understand", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, history, pending }),
      ...(signal ? { signal } : {}),
    });
    return (await r.json()) as Understanding;
  } catch {
    return { kind: "unclear", outcome: "unclear", reply: "Couldn't reach PayAI just now — try that again in a moment." };
  }
}

export interface UnderstandResult {
  message: AskMessage;
  /** Carried into the next turn so a follow-up can complete or correct it.
   *  Null once the turn reached a terminal outcome (dispatched, chat,
   *  unsupported, unclear). */
  nextPending: Understanding | null;
}

/** Step 2 — turn a settled Understanding into a reply, dispatching anything
 *  actionable+complete to its real backend. */
export async function respondToUnderstanding(u: Understanding, walletAddress: string | null): Promise<UnderstandResult> {
  if (u.outcome === "chat" || u.outcome === "unsupported" || u.outcome === "unclear") {
    return { message: assistantText(u.reply), nextPending: null };
  }
  if (u.outcome === "incomplete") {
    return { message: assistantText(u.question), nextPending: u };
  }

  switch (u.kind) {
    case "send_payment": {
      const message = await dispatchSendPayment(u.slots, walletAddress);
      // A ready-to-confirm payment card stays "pending" (in the same sense
      // as an incomplete intent) so a follow-up like "actually make it 75"
      // or "yes, send it" is understood as continuing/correcting THIS
      // payment rather than starting an unrelated new one — see
      // classify.ts rule 3 and useAskChat's natural-confirmation handling.
      // A question, refusal, or error carries nothing forward to correct.
      const nextPending = message.operation?.status === "ready" && message.operation.intent.kind === "payment"
        ? { kind: "send_payment" as const, outcome: "complete" as const, slots: u.slots }
        : null;
      return { message, nextPending };
    }
    case "swap": {
      const message = await dispatchSwap(u.slots, walletAddress);
      // Same reasoning as send_payment above: a ready swap quote stays
      // "pending" so "actually make it 30" or "swap it" resolves against
      // THIS quote rather than starting over or falling through to unclear.
      const nextPending = message.operation?.status === "ready" && message.operation.intent.kind === "swap"
        ? { kind: "swap" as const, outcome: "complete" as const, slots: u.slots }
        : null;
      return { message, nextPending };
    }
    case "schedule_payment": return { message: await dispatchSchedule("schedule_payment", u.slots, walletAddress), nextPending: null };
    case "recurring_payment": return { message: await dispatchSchedule("recurring_payment", u.slots, walletAddress), nextPending: null };
    case "wallet_balance": return { message: await dispatchWalletBalance(walletAddress), nextPending: null };
    case "token_balance": return { message: await dispatchTokenBalance(u.slots, walletAddress), nextPending: null };
    case "transaction_history": case "wallet_activity": return { message: await dispatchTransactionHistoryCard(u.slots, walletAddress), nextPending: null };
    case "transaction_status": return { message: await dispatchTransactionStatus(u.slots, walletAddress), nextPending: null };
    case "transaction_details": return { message: await dispatchTransactionDetails(u.slots, walletAddress), nextPending: null };
    case "automation_management": return { message: await dispatchAutomations(walletAddress), nextPending: null };
    case "distribution": return { message: dispatchDistribution(u.slots), nextPending: null };
    case "room": {
      // A card, not an action: everything it does goes through the Rooms API
      // behind an explicit button (components/ask/RoomAskCard.tsx).
      const action = u.slots.roomAction ?? "list";
      return {
        message: { id: nextId("msg"), role: "assistant", content: roomLead(action), createdAt: Date.now(), room: { action, roomId: u.slots.roomId ?? null, text: u.slots.roomText ?? null } },
        nextPending: null,
      };
    }
    case "token_lookup": {
      const message = await dispatchTokenLookup(u.slots, walletAddress);
      // Unlike the other read-only kinds above, this one DOES carry forward
      // — "What's the price?" right after this card means the SAME token
      // (see classify.ts's TOKEN_FOLLOWUP_RE), so the address needs to stay
      // in `pending` for that merge to have something to resolve against.
      return { message, nextPending: { kind: "token_lookup" as const, outcome: "complete" as const, slots: u.slots } };
    }
    case "trade": {
      const message = await dispatchTrade(u.slots, walletAddress);
      // A successful preview stays pending too — "Actually make it 100." /
      // "Actually use MON instead." / "Sell instead." (see classify.ts's own
      // trade-correction handling) all need something to correct. A failed
      // preview (no route, insufficient balance, ...) carries nothing
      // forward, same as every other dispatch failure in this file.
      const nextPending = message.operation?.intent.kind === "trade_preview"
        ? { kind: "trade" as const, outcome: "complete" as const, slots: u.slots }
        : null;
      return { message, nextPending };
    }
    case "protocol_action":
      // No pending carry-forward in Phase 2: WMON wrap/unwrap is a
      // single-shot, fully-specified action, not a multi-turn correction
      // flow like trade/payment. Nothing needs to stay pending to amend.
      return { message: await dispatchProtocolAction(u.slots, walletAddress), nextPending: null };
  }
}

async function dispatchSendPayment(slots: { amount?: string | null; asset?: string | null; recipient?: string | null }, walletAddress: string | null): Promise<AskMessage> {
  const canonical = `Send ${slots.amount} ${slots.asset} to ${slots.recipient}`;
  const msg = await respondToSendPayment(canonical, walletAddress);
  return msg ?? assistantText("I couldn't prepare that payment. Try again in a moment.");
}

async function dispatchSwap(slots: { amount?: string | null; fromAsset?: string | null; toAsset?: string | null }, walletAddress: string | null): Promise<AskMessage> {
  if (!walletAddress) return assistantText("Connect your wallet to swap — I can't sign this for you.");
  const canonical = `Swap ${slots.amount} ${slots.fromAsset} to ${slots.toAsset}`;
  let json: AgentApiResponse | null = null;
  try {
    const r = await fetch("/api/agent", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: canonical, walletAddress, idempotencyKey: idemKey("swap") }),
    });
    json = await r.json();
  } catch {
    return assistantText("Couldn't reach PayAI to quote that swap. Check your connection and try again.");
  }
  if (!json) return assistantText("Couldn't prepare that swap. Try again.");

  if (json.decision === "swap_ready" && json.swap) {
    const plan = json.swap;
    const intent: SwapIntent = {
      kind: "swap", network: "monad",
      fromToken: plan.quote.fromToken, toToken: plan.quote.toToken,
      fromAmount: String(plan.quote.amountIn),
      toAmountEstimate: plan.quote.amountOut != null ? String(plan.quote.amountOut) : null,
      slippage: `${(plan.quote.slippage * 100).toFixed(2)}%`,
      execution: { plan, provider: json.provider, quotedAt: Date.now() },
    };
    const operation: Operation = { id: nextId("op"), intent, status: "ready" };
    return { id: nextId("msg"), role: "assistant", content: `Here's a live quote for that swap, via ${json.provider ?? "the DEX"}.`, createdAt: Date.now(), operation };
  }
  return assistantText(json.error || "I couldn't quote that swap. Try again in a moment.");
}

/** A block-explorer transaction URL derived from the client-safe network
 *  configuration (NEXT_PUBLIC_MONAD_EXPLORER, set per environment). Used for
 *  the "submitted" state, where the transaction broadcast but confirmation
 *  timed out before the server returned an explorerUrl — so we still hand the
 *  user a real, clickable link to inspect it. Client-side code cannot use
 *  lib/monad/config's explorerTx(): that reads non-public MONAD_* env which is
 *  undefined in the browser and would resolve to the testnet explorer. */
function configExplorerTx(txHash: string): string {
  return `${MONAD_EXPLORER}/tx/${txHash}`;
}

/** P1.4 — the audited gap: "approval succeeded, but the trade/swap failed"
 *  used to read as a plain, unqualified failure, with nothing telling the
 *  user their approval was a real, separate, already-confirmed transaction.
 *  Prefixes an error message with that context whenever a genuine approval
 *  preceded it — a no-op passthrough when there wasn't one. Explicitly says
 *  an approval only ever changes an allowance, never that funds moved (see
 *  this file's own executeSwapIntent/executeTradeIntent doc for why the
 *  approval's hash is carried as its own separate field, never folded into
 *  the failing step's own txHash). */
function prefixApprovalContext(message: string, approvalTx: { txHash: string; explorerUrl: string } | null): string {
  if (!approvalTx) return message;
  return `Your token approval already confirmed separately on Monad — that only set an allowance, no funds moved. ${message}`;
}

/** The only function allowed to request a wallet signature for a swap —
 *  called exclusively from an explicit "Confirm" click on a card this
 *  module already built and the server already quoted. */
export async function executeSwapIntent(
  operation: Operation, wallet: SendPaymentWallet, walletAddress: string,
  onProgress?: (label: string) => void,
): Promise<Operation> {
  if (operation.intent.kind !== "swap" || !operation.intent.execution) return operation;
  const { plan } = operation.intent.execution;
  // P1.4: reset every iteration — the actual bug this fixes. Previously this
  // was declared once, outside the loop, so a step's OWN broadcast could
  // still be sitting here from a PRIOR iteration if the current step's
  // signature was rejected before ever reaching the wallet. That let an
  // already-confirmed approval's hash get reported as if the SWAP itself
  // were "submitted" — a real transaction, just the wrong one. Resetting to
  // null at the top of every iteration means the catch block below can only
  // ever see a hash that THIS iteration's own send actually produced.
  let broadcastHash: string | null = null;
  // Whether the hash currently in `broadcastHash` belongs to the LAST step
  // (the real swap) or an earlier approval — read in the catch block to
  // label a submitted state accurately ("Approval submitted" vs "Swap
  // submitted") rather than always naming the outer operation.
  let broadcastIsFinalStep = false;
  // Tracks whether an earlier approval step already CONFIRMED before we
  // broadcast the swap step, so a "submitted" outcome can say "Approval
  // complete." rather than implying the whole thing is still pending.
  let approvalConfirmed = false;
  // The approval's OWN real txHash/explorerUrl, once it confirms — carried
  // separately from the swap's own txHash so the two are never conflated
  // (see this function's error/submitted returns below, and OperationCard's
  // dedicated "Approval transaction" block).
  let approvalTx: { txHash: string; explorerUrl: string } | null = null;
  try {
    let lastHash = "";
    for (let i = 0; i < plan.steps.length; i++) {
      broadcastHash = null;
      broadcastIsFinalStep = false;
      const step = plan.steps[i].label;
      const isLast = i === plan.steps.length - 1;
      onProgress?.(
        plan.steps.length > 1
          ? `Step ${i + 1} of ${plan.steps.length}: waiting for your signature (${step}) — nothing has moved yet.`
          : "Waiting for your signature — nothing has moved yet.",
      );
      lastHash = await wallet.sendTransaction(plan.steps[i].tx);
      broadcastHash = lastHash;
      broadcastIsFinalStep = isLast;
      if (isLast) {
        savePendingSettlement({
          kind: "swap", walletAddress, txHash: lastHash,
          fromToken: plan.quote.fromToken, toToken: plan.quote.toToken,
          amountIn: plan.quote.amountIn, amountOut: plan.quote.amountOut, savedAt: Date.now(),
        });
      }
      onProgress?.(
        plan.steps.length > 1
          ? `Step ${i + 1} of ${plan.steps.length}: confirming on-chain…`
          : "Signed — confirming on-chain…",
      );
      await wallet.waitForReceipt(lastHash);
      // This step's receipt confirmed. If it was an approval (never the last
      // step), remember that — including its own real hash — so a later
      // "submitted" or error outcome is accurate and can link to it directly.
      if (!isLast && plan.steps[i].kind === "approve") {
        approvalConfirmed = true;
        approvalTx = { txHash: lastHash, explorerUrl: configExplorerTx(lastHash) };
      }
    }
    onProgress?.("Finalizing swap…");
    const r = await fetch("/api/swap/confirm", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ walletAddress, txHash: lastHash, fromToken: plan.quote.fromToken, toToken: plan.quote.toToken, amountIn: plan.quote.amountIn, amountOut: plan.quote.amountOut }),
    });
    const cj = (await r.json()) as { explorerUrl?: string; error?: string; success?: boolean; reverted?: boolean };
    if (!cj.success) {
      // Only a CONFIRMED on-chain revert is a real failure. Anything else here
      // ("couldn't confirm yet — may still settle") is submitted-but-pending:
      // keep the pending settlement so the reconciler resolves it on next load,
      // and never call it "failed".
      if (cj.reverted) {
        clearPendingSettlement();
        const error: OperationError = {
          message: prefixApprovalContext(cj.error || "This swap failed on-chain. No tokens were swapped.", approvalTx),
          code: "REVERTED", txHash: lastHash, explorerUrl: cj.explorerUrl, approvalTx: approvalTx ?? undefined,
        };
        return { ...operation, status: "error", error };
      }
      return { ...operation, status: "submitted", submitted: { txHash: lastHash, explorerUrl: cj.explorerUrl || configExplorerTx(lastHash), approvalConfirmed, approvalTx: approvalTx ?? undefined, step: "main" } };
    }
    clearPendingSettlement();
    const result: TransactionResult = { txHash: lastHash, explorerUrl: cj.explorerUrl ?? "" };
    return { ...operation, status: "success", result };
  } catch (e) {
    if (broadcastHash) {
      // THIS iteration's own step really did broadcast (a real, fresh hash —
      // never a stale one left over from an earlier step); the receipt wait
      // or something right after it failed. Genuinely submitted/pending for
      // THIS specific transaction — never rebroadcast just because
      // confirmation timed out.
      return {
        ...operation, status: "submitted",
        submitted: { txHash: broadcastHash, explorerUrl: configExplorerTx(broadcastHash), approvalConfirmed, approvalTx: approvalTx ?? undefined, step: broadcastIsFinalStep ? "main" : "approval" },
      };
    }
    // This step's OWN broadcast never happened (the signature was rejected,
    // or it threw before ever reaching the wallet) — nothing new is
    // pending. If an approval already confirmed earlier in this same
    // attempt, say so explicitly rather than a bare, unqualified failure.
    const error: OperationError = {
      message: prefixApprovalContext(friendlyError(e instanceof Error ? e.message : "Swap failed.", "Swap"), approvalTx),
      code: "NOT_SENT", approvalTx: approvalTx ?? undefined,
    };
    return { ...operation, status: "error", error };
  }
}

/** /api/ask/trade/build's response shape — mirrors lib/monad/tradeQuote.ts's
 *  TradeExecutionResult exactly: flat, same convention as
 *  TradePreviewApiResponse above. */
type TradeBuildApiResponse =
  | {
      ok: true; status: "ready"; preview: TradePreviewData & { ok?: true };
      steps: {
        kind: "approve" | "swap"; label: string; tx: { to: string; data: string; value: string };
        /** Present only on the LAST step of a real, independently-settleable
         *  on-chain leg — see lib/monad/tradeQuote.ts's TradeExecutionStep
         *  (server-side origin of this field) and this file's
         *  executeTradeIntent (which reads it) for the full contract. */
        settleLeg?: { fromToken: string; toToken: string; amountIn: number; amountOut: number; provider: string };
      }[];
    }
  | { ok: true; status: "changed"; preview: TradePreviewData & { ok?: true } }
  | { ok: false; message: string };

function stripOk(preview: TradePreviewData & { ok?: true }): TradePreviewData {
  const { ok: _ok, ...data } = preview;
  return data;
}

/**
 * The only function allowed to request a wallet signature for a trade —
 * called exclusively from an explicit "Confirm trade" click on a card this
 * module already built. Mirrors executeSwapIntent above almost exactly
 * (multi-step approve-then-trade signing, pendingSettlement, /api/swap/confirm
 * settlement, translated errors) — see that function's own doc for why each
 * piece exists; this reuses the identical /api/swap/confirm settlement path
 * and pendingSettlement "swap" kind rather than inventing a second one, since
 * a trade settles exactly the same way a swap does.
 *
 * Two things this adds beyond executeSwapIntent:
 *  1. An explicit wrong-network check before ever asking for a signature — a
 *     trade may touch an arbitrary, never-before-approved token contract, so
 *     "wrong chain" must never silently sign into it.
 *  2. It never signs the preview card's own numbers. It always re-quotes and
 *     rebuilds fresh via /api/ask/trade/build first (never constructs a
 *     transaction from stale preview data); if that fresh quote moved
 *     materially since the card was shown, it returns an updated "ready"
 *     card instead of ever signing — the user must click Confirm again on
 *     the new numbers (see the "changed" branch below).
 */
export async function executeTradeIntent(
  operation: Operation,
  wallet: SendPaymentWallet & { isWrongNetwork?: boolean },
  walletAddress: string,
  onProgress?: (label: string) => void,
): Promise<Operation> {
  if (operation.intent.kind !== "trade_preview" || !operation.intent.execution) return operation;
  const { request } = operation.intent.execution;
  const priorData = operation.intent.data;

  if (wallet.isWrongNetwork) {
    const error: OperationError = { message: "You're connected to the wrong network — switch your wallet to Monad and try again.", code: "WRONG_NETWORK" };
    return { ...operation, status: "error", error };
  }

  onProgress?.("Preparing trade…");
  let build: TradeBuildApiResponse | null = null;
  try {
    const r = await fetch("/api/ask/trade/build", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...request, walletAddress,
        previousQuote: { receiveAmount: priorData.receive.amount, provider: priorData.route.provider },
      }),
    });
    build = await r.json();
  } catch {
    const error: OperationError = { message: "Couldn't reach Monad to prepare that trade. Try again in a moment.", code: "BUILD_FAILED" };
    return { ...operation, status: "error", error };
  }
  if (!build) {
    const error: OperationError = { message: "Couldn't prepare that trade. Try again.", code: "BUILD_FAILED" };
    return { ...operation, status: "error", error };
  }
  if (!build.ok) {
    const error: OperationError = { message: build.message || "Couldn't prepare that trade.", code: "BUILD_FAILED" };
    return { ...operation, status: "error", error };
  }

  const freshData = stripOk(build.preview);
  if (build.status === "changed") {
    // The fresh, just-fetched quote moved enough (or the route changed) that
    // executing against what the user approved would be executing a
    // materially different trade. Never sign it — show the updated numbers
    // and require an explicit new confirm click instead.
    return {
      ...operation,
      status: "ready",
      intent: { ...operation.intent, data: freshData },
      confirmLabel: "Quote updated — confirm again",
    };
  }

  const steps = build.steps;
  // P1.4: reset every iteration — see executeSwapIntent's own doc for the
  // exact bug this fixes (a rejected/never-broadcast step could otherwise
  // still see an EARLIER step's own hash sitting here, misattributing an
  // already-confirmed approval as if it were the still-pending trade).
  let broadcastHash: string | null = null;
  // Whether the hash currently in `broadcastHash` belongs to the LAST step
  // (the real trade) or an earlier approval — read in the catch block to
  // label a submitted state accurately.
  let broadcastIsFinalStep = false;
  // See executeSwapIntent: remembers a confirmed approval so a "submitted"
  // trade can say "Approval complete. Trade submitted." accurately.
  let approvalConfirmed = false;
  // The approval's OWN real txHash/explorerUrl, once it confirms — carried
  // separately from the trade's own txHash so the two are never conflated
  // (see this function's error/submitted returns below).
  let approvalTx: { txHash: string; explorerUrl: string } | null = null;
  // The most recent leg that fully confirmed ON-CHAIN (a real receipt, from
  // the wallet's own RPC — independent of whether this file's OWN settle
  // call to /api/swap/confirm afterward succeeds, hiccups, or never gets
  // reached). Only ever set for a Nad.Fun-through-MON multi-hop trade
  // (lib/monad/tradeQuote.ts's buildNadFunMultiHopSteps) — an ordinary
  // single-leg trade's only settleLeg-carrying step IS its last step, so
  // this never gets a chance to matter for one. Exists so that "leg A
  // genuinely succeeded, then leg B's signature was rejected or its own
  // broadcast never happened" reports an honest, specific error — real
  // funds already moved, with a real txHash to prove it — instead of
  // reusing "submitted" (which claims an outcome is still pending, when
  // leg A's outcome is already fully known and leg B never even broadcast).
  let completedLeg: { txHash: string; explorerUrl: string } | null = null;
  try {
    let lastHash = "";
    for (let i = 0; i < steps.length; i++) {
      broadcastHash = null;
      broadcastIsFinalStep = false;
      const step = steps[i].label;
      const isLast = i === steps.length - 1;
      // The last step always settles — its own real settleLeg tag when
      // present (every trade prepareTradeExecution builds carries one), or
      // the whole trade's own numbers as a defensive fallback so a settle
      // call is never simply skipped if that tag is ever absent. An
      // intermediate step with no tag has nothing to settle yet.
      const effectiveLeg = steps[i].settleLeg ?? (isLast
        ? { fromToken: freshData.spend.token, toToken: freshData.receive.token, amountIn: Number(freshData.spend.amount), amountOut: Number(freshData.receive.amount), provider: freshData.route.provider }
        : null);
      onProgress?.(
        steps.length > 1
          ? `Step ${i + 1} of ${steps.length}: waiting for your signature (${step}) — nothing has moved yet.`
          : "Waiting for your signature — nothing has moved yet.",
      );
      lastHash = await wallet.sendTransaction(steps[i].tx);
      broadcastHash = lastHash;
      broadcastIsFinalStep = isLast;
      if (effectiveLeg) {
        // A real leg (single-leg trades tag only their last step; a
        // multi-hop trade tags the last step of EACH leg) — its own
        // pending-settlement record, in ITS real terms, so the reconciler
        // can resolve exactly what this specific transaction was.
        savePendingSettlement({
          kind: "swap", walletAddress, txHash: lastHash,
          fromToken: effectiveLeg.fromToken, toToken: effectiveLeg.toToken,
          amountIn: effectiveLeg.amountIn, amountOut: effectiveLeg.amountOut, savedAt: Date.now(),
        });
      }
      onProgress?.(
        steps.length > 1
          ? `Step ${i + 1} of ${steps.length}: confirming on-chain…`
          : "Signed — confirming on-chain…",
      );
      await wallet.waitForReceipt(lastHash);
      if (!isLast && steps[i].kind === "approve") {
        approvalConfirmed = true;
        approvalTx = { txHash: lastHash, explorerUrl: configExplorerTx(lastHash) };
      }
      if (!effectiveLeg) continue;

      if (!isLast) {
        // An intermediate leg's OWN on-chain confirmation just succeeded —
        // real, independent of this file's settle call below. Recorded
        // before attempting that call, so a network hiccup calling
        // /api/swap/confirm still leaves an honest, provable "this much
        // already happened" if the NEXT leg then fails.
        completedLeg = { txHash: lastHash, explorerUrl: configExplorerTx(lastHash) };
      }

      onProgress?.(isLast ? "Finalizing trade…" : `Confirming ${effectiveLeg.provider}…`);
      const r = await fetch("/api/swap/confirm", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          walletAddress, txHash: lastHash, fromToken: effectiveLeg.fromToken, toToken: effectiveLeg.toToken,
          amountIn: effectiveLeg.amountIn, amountOut: effectiveLeg.amountOut,
          feature: "trade", provider: effectiveLeg.provider,
          // The received token's REAL address, recorded only on the leg that
          // actually ends the trade — settleLeg's own tokens are display
          // symbols, which can't be resolved back to an arbitrary token's
          // contract. Without this the portfolio had no record of what was
          // just acquired and could only rediscover it by scanning chain
          // logs (see TxLogEntry.outputTokenAddress). Sent only when it
          // really is an address: a curated-symbol trade (MON/USDC) has no
          // arbitrary contract to remember and is already a base asset.
          ...(isLast && ADDRESS_RE.test(request.outputToken)
            ? { outputTokenAddress: request.outputToken }
            : {}),
        }),
      });
      const cj = (await r.json()) as { explorerUrl?: string; error?: string; success?: boolean; reverted?: boolean };

      if (!isLast) {
        // Intermediate leg: only a CONFIRMED revert is fatal — the trade
        // never got past this leg, so the next one is never signed. Any
        // other settlement outcome (including "couldn't confirm yet") does
        // NOT block progress: wallet.waitForReceipt above already proved
        // this leg succeeded on-chain from the wallet's own independent
        // read, so it's safe to keep going — the pending-settlement
        // reconciler catches up the record later if needed.
        if (cj.reverted) {
          clearPendingSettlement();
          const error: OperationError = {
            message: prefixApprovalContext(cj.error || "This trade failed on-chain. No tokens were traded.", approvalTx),
            code: "REVERTED", txHash: lastHash, explorerUrl: cj.explorerUrl, approvalTx: approvalTx ?? undefined,
          };
          return { ...operation, status: "error", intent: { ...operation.intent, data: freshData }, error };
        }
        if (cj.explorerUrl) completedLeg = { txHash: lastHash, explorerUrl: cj.explorerUrl };
        continue;
      }

      // The LAST step overall — its settlement result decides the whole
      // operation's returned status, exactly as a single-leg trade always has.
      if (!cj.success) {
        // Same classification as executeSwapIntent: only a confirmed revert is a
        // failure; "couldn't confirm yet" is submitted-but-pending (keep the
        // pending settlement so the reconciler resolves it).
        if (cj.reverted) {
          clearPendingSettlement();
          const error: OperationError = {
            message: prefixApprovalContext(cj.error || "This trade failed on-chain. No tokens were traded.", approvalTx),
            code: "REVERTED", txHash: lastHash, explorerUrl: cj.explorerUrl, approvalTx: approvalTx ?? undefined,
          };
          return { ...operation, status: "error", intent: { ...operation.intent, data: freshData }, error };
        }
        return { ...operation, status: "submitted", intent: { ...operation.intent, data: freshData }, submitted: { txHash: lastHash, explorerUrl: cj.explorerUrl || configExplorerTx(lastHash), approvalConfirmed, approvalTx: approvalTx ?? undefined, step: "main" } };
      }
      clearPendingSettlement();
      const result: TransactionResult = { txHash: lastHash, explorerUrl: cj.explorerUrl ?? "" };
      return { ...operation, status: "success", intent: { ...operation.intent, data: freshData }, result };
    }
    // Unreachable in practice — the last step always carries settleLeg (see
    // prepareTradeExecution), so the loop above always returns from inside
    // its isLast branch. Kept only so this function has an exhaustive
    // return path if that invariant is ever violated upstream.
    const error: OperationError = { message: "Couldn't finalize that trade.", code: "BUILD_FAILED" };
    return { ...operation, status: "error", intent: { ...operation.intent, data: freshData }, error };
  } catch (e) {
    // P1.4: broadcastHash is reset every iteration now (see its own doc
    // above), so if it's set here it can only be THIS (failing) step's own
    // fresh broadcast — never a stale hash left over from an earlier one.
    // The `!== completedLeg?.txHash` check below is accordingly now a
    // defensive belt-and-suspenders comparison rather than the only thing
    // preventing misattribution, kept for the multi-hop case where a
    // completed leg and the current failing step could otherwise be
    // conflated by coincidence.
    if (broadcastHash && broadcastHash !== completedLeg?.txHash) {
      // Broadcast happened but confirmation timed out — submitted, not failed.
      // Keep the pending settlement, never rebroadcast.
      return {
        ...operation, status: "submitted", intent: { ...operation.intent, data: freshData },
        submitted: { txHash: broadcastHash, explorerUrl: configExplorerTx(broadcastHash), approvalConfirmed, approvalTx: approvalTx ?? undefined, step: broadcastIsFinalStep ? "main" : "approval" },
      };
    }
    if (completedLeg) {
      // An EARLIER leg already fully confirmed on-chain — real funds moved —
      // and this later step's signature was then rejected, or its own
      // broadcast never happened. The overall trade did not complete, but
      // it did NOT simply time out either: there is nothing left pending to
      // wait for, so this is an honest, specific error carrying the earlier
      // leg's real, provable txHash — never the vague "submitted" a single
      // in-flight transaction gets.
      const error: OperationError = {
        message: `Part of this trade completed on-chain, but the next step wasn't signed, so the trade didn't finish. Check ${completedLeg.txHash} on the explorer for what actually moved — you can trade from there directly.`,
        code: "PARTIAL_MULTI_HOP", txHash: completedLeg.txHash, explorerUrl: completedLeg.explorerUrl, approvalTx: approvalTx ?? undefined,
      };
      return { ...operation, status: "error", intent: { ...operation.intent, data: freshData }, error };
    }
    // Neither this step nor any earlier leg produced anything pending or
    // completed — a clean pre-broadcast failure. If an approval already
    // confirmed earlier in this same attempt, say so explicitly.
    const error: OperationError = {
      message: prefixApprovalContext(friendlyError(e instanceof Error ? e.message : "Trade failed.", "Trade"), approvalTx),
      code: "NOT_SENT", approvalTx: approvalTx ?? undefined,
    };
    return { ...operation, status: "error", error };
  }
}

async function dispatchSchedule(
  kind: "schedule_payment" | "recurring_payment",
  slots: { amount?: string | null; asset?: string | null; recipient?: string | null; when?: string | null; frequency?: "daily" | "weekly" | "monthly" | null },
  walletAddress: string | null,
): Promise<AskMessage> {
  if (!walletAddress) return assistantText("Connect your wallet so I can look up your recipient and set this up.");
  // Carries the schedule the person gave (day/date/phrase) in words the
  // engine reads — see scheduleText.ts for why "every weekly" was a bug.
  const canonical = scheduleRequestText(kind, { amount: slots.amount ?? null, asset: slots.asset ?? null, recipient: slots.recipient ?? null, when: slots.when ?? null, frequency: slots.frequency ?? null });
  let json: AgentApiResponse | null = null;
  try {
    const r = await fetch("/api/agent", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: canonical, walletAddress, idempotencyKey: idemKey("sched") }),
    });
    json = await r.json();
  } catch {
    return assistantText("Couldn't reach PayAI to set that up. Try again in a moment.");
  }
  if (!json) return assistantText("Couldn't set that up. Try again.");

  if (json.decision === "automation_prefill" && json.prefill) {
    const p = json.prefill;
    const handoff: AutomationHandoff = { prefill: p };
    const startIso = new Date(p.nextRun ?? Date.now()).toISOString();
    const intent: ScheduledPaymentIntent | RecurringPaymentIntent =
      kind === "recurring_payment"
        ? { kind: "recurring_payment", network: "monad", token: p.token, amount: String(p.amount), recipient: p.recipient, recipientDomain: p.domain ?? null, frequency: p.cadence === "daily" || p.cadence === "weekly" || p.cadence === "monthly" ? p.cadence : "weekly", startDate: startIso, handoff }
        : { kind: "scheduled_payment", network: "monad", token: p.token, amount: String(p.amount), recipient: p.recipient, recipientDomain: p.domain ?? null, startDate: startIso, handoff };
    const operation: Operation = { id: nextId("op"), intent, status: "ready", confirmLabel: "Review & activate", confirmIcon: "go" };
    return {
      id: nextId("msg"), role: "assistant",
      content: "Here's the automation I prepared. Review & activate opens the setup right here — choose how it's funded, then sign once to activate. Nothing runs until you approve it.",
      createdAt: Date.now(), operation,
    };
  }
  return assistantText(json.error || "I couldn't set that up. Try again in a moment.");
}

/** The handoff's only action — no signature, no execution, just carrying
 *  the already-validated fields to the real creator (which still requires
 *  its own wallet signature before anything goes live). */
export function handoffToAutomations(handoff: AutomationHandoff) {
  try {
    sessionStorage.setItem("payai_automation_prefill", JSON.stringify(handoff.prefill));
  } catch {
    /* storage unavailable — the automations page still works without a prefill */
  }
  window.location.href = "/dashboard/automations";
}

/** PayAI's chat-driven balance lookup only covers these two — real on-chain
 *  reads via the same /api/agent path everything else in the dashboard
 *  uses (lib/monad/balance.ts), never a mock number. */
const SUPPORTED_BALANCE_ASSETS = ["MON", "USDC"];
const NO_WALLET_MESSAGE = "Connect (or create) your PayAI wallet and I can look that up.";

function shortHash(h: string): string {
  return h.length > 14 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h;
}
function explorerFor(txHash: string): string {
  return `https://explorer.monad.xyz/tx/${txHash}`;
}
function formatWhen(at: number): string {
  return new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}
/** A logged transaction only ever reflects a settled outcome — "executed"
 *  is the one decision that means real, on-chain success; every other
 *  logged decision (blocked/refused/error/needs_review) means it did not
 *  move funds. A truly in-flight (broadcast, not yet confirmed) transaction
 *  never reaches this at all — it isn't recorded until confirm succeeds or
 *  definitively reverts, so that case is handled separately via
 *  pendingSettlement (see resolveTransaction). */
function statusFromDecision(decision: TxHistoryRow["decision"]): "success" | "failed" {
  return decision === "executed" ? "success" : "failed";
}
function txTypeLabel(action: string): string {
  if (action === "pay_invoice") return "Invoice payment";
  if (action === "create_payment_link" || action === "create_checkout_link") return "Payment link";
  if (action === "trade") return "Trade";
  if (action === "swap") return "Swap";
  return "Payment";
}
function toTransactionView(row: TxHistoryRow, walletAddress: string): WalletTransactionView {
  return {
    type: txTypeLabel(row.action),
    asset: row.token,
    amount: row.amount != null ? String(row.amount) : "—",
    sender: walletAddress,
    recipient: row.recipient ?? "—",
    status: statusFromDecision(row.decision),
    timestamp: formatWhen(row.at),
    txHash: row.txHash,
    explorerUrl: row.explorerUrl,
    outputAmount: row.outputAmount != null ? String(row.outputAmount) : null,
    outputToken: row.outputToken ?? null,
    provider: row.provider ?? null,
  };
}

/** `null` return means the request itself failed (RPC/network) — distinct
 *  from a real, empty `[]` history, so callers never conflate "couldn't
 *  check" with "nothing there". */
async function fetchHistory(walletAddress: string): Promise<TxHistoryRow[] | null> {
  try {
    const r = await fetch("/api/agent", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "show my transaction history", walletAddress, idempotencyKey: idemKey("hist") }),
    });
    const json = (await r.json()) as AgentApiResponse;
    return json.history ?? [];
  } catch {
    return null;
  }
}

type ResolvedTx =
  | { row: TxHistoryRow }
  | { pendingTxHash: string }
  | { notFound: true }
  | { empty: true }
  | { rpcError: true };

/** Resolves "that transaction" against real data — never a guess. A
 *  specific hash (read back from context by the classifier) is matched
 *  exactly or reported not-found; with no hash, the most recent real entry
 *  is used, UNLESS a payment has broadcast but not yet settled (tracked
 *  client-side in pendingSettlement) and so hasn't reached the log yet —
 *  that's still the most recent activity and takes priority. */
async function resolveTransaction(txHashHint: string | null | undefined, walletAddress: string): Promise<ResolvedTx> {
  const pending = getPendingSettlement(walletAddress);
  if (txHashHint && pending && pending.txHash.toLowerCase() === txHashHint.toLowerCase()) {
    return { pendingTxHash: pending.txHash };
  }
  const rows = await fetchHistory(walletAddress);
  if (rows === null) return { rpcError: true };
  if (txHashHint) {
    const match = rows.find((r) => r.txHash?.toLowerCase() === txHashHint.toLowerCase());
    return match ? { row: match } : { notFound: true };
  }
  if (pending && !rows.some((r) => r.txHash?.toLowerCase() === pending.txHash.toLowerCase())) {
    return { pendingTxHash: pending.txHash };
  }
  if (rows.length === 0) return { empty: true };
  return { row: rows[0] }; // newest-first — see lib/platform/store.ts's listTx
}

function transactionCard(view: WalletTransactionView): { intent: WalletOperationIntent; operation: Operation } {
  const intent: WalletOperationIntent = { kind: "wallet_operation", network: "monad", operation: "transaction", transaction: view };
  return { intent, operation: { id: nextId("op"), intent, status: "success" } };
}

async function dispatchWalletBalance(walletAddress: string | null): Promise<AskMessage> {
  if (!walletAddress) return assistantText(NO_WALLET_MESSAGE);
  let json: AgentApiResponse | null = null;
  try {
    const r = await fetch("/api/agent", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "show my balance", walletAddress, idempotencyKey: idemKey("bal") }),
    });
    json = await r.json();
  } catch {
    return assistantText("Couldn't reach Monad to check your balance. Try again.");
  }
  if (!json?.balance) return assistantText(json?.error || "Couldn't read your balance right now.");
  const intent: WalletOperationIntent = {
    kind: "wallet_operation", network: "monad", operation: "balance",
    balances: [{ token: "MON", amount: json.balance.mon.toFixed(4) }, { token: "USDC", amount: json.balance.usdc.toFixed(2) }],
    totalValueUsd: await fetchTotalValueUsd(walletAddress),
  };
  const operation: Operation = { id: nextId("op"), intent, status: "success" };
  return { id: nextId("msg"), role: "assistant", content: "Here's what's in your wallet.", createdAt: Date.now(), operation };
}

/** Best-effort total USD value from the existing wallet-intelligence
 *  endpoint (real MON price via the same DEX quoter the swap engine uses —
 *  see lib/monad/wallet-intel.ts). Never blocks or fails the balance card:
 *  unconfigured, no price, or a network hiccup all just mean no total line —
 *  enforced with a hard timeout, since dispatchWalletBalance() awaits this
 *  AFTER the real mon/usdc numbers already came back; without a bound here,
 *  a slow /api/wallet-intelligence (it walks tx history via getLogs/getBlock)
 *  would hang the whole "show my balance" reply, not just the total line. */
async function fetchTotalValueUsd(walletAddress: string): Promise<string | null> {
  try {
    const r = await fetch(`/api/wallet-intelligence?address=${encodeURIComponent(walletAddress)}`, {
      signal: AbortSignal.timeout(5000),
    });
    const json = (await r.json()) as { ok?: boolean; configured?: boolean; totalValueUsd?: number | null };
    return json.ok && json.configured && json.totalValueUsd != null ? json.totalValueUsd.toFixed(2) : null;
  } catch {
    return null;
  }
}

async function dispatchTokenBalance(slots: { asset?: string | null }, walletAddress: string | null): Promise<AskMessage> {
  if (!walletAddress) return assistantText(NO_WALLET_MESSAGE);
  const asset = (slots.asset ?? "").toUpperCase();
  if (!SUPPORTED_BALANCE_ASSETS.includes(asset)) {
    return assistantText(`PayAI currently tracks MON and USDC balances — I don't have balance data for ${slots.asset ?? "that token"} yet.`);
  }
  let json: AgentApiResponse | null = null;
  try {
    const r = await fetch("/api/agent", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "show my balance", walletAddress, idempotencyKey: idemKey("bal") }),
    });
    json = await r.json();
  } catch {
    return assistantText("Couldn't reach Monad to check your balance. Try again.");
  }
  if (!json?.balance) return assistantText(json?.error || "Couldn't read your balance right now.");
  const amount = asset === "MON" ? json.balance.mon.toFixed(4) : json.balance.usdc.toFixed(2);
  return assistantText(`You have ${amount} ${asset}.`);
}

async function dispatchTransactionHistoryCard(slots: { asset?: string | null }, walletAddress: string | null): Promise<AskMessage> {
  if (!walletAddress) return assistantText(NO_WALLET_MESSAGE);
  const rows = await fetchHistory(walletAddress);
  if (rows === null) return assistantText("Couldn't reach PayAI to load your history. Try again.");
  const filtered = slots.asset ? rows.filter((r) => r.token.toUpperCase() === slots.asset!.toUpperCase()) : rows;
  if (filtered.length === 0) {
    return assistantText(slots.asset ? `No recorded ${slots.asset.toUpperCase()} transactions yet.` : "You don't have any recorded transactions yet.");
  }
  const intent: WalletOperationIntent = {
    kind: "wallet_operation", network: "monad", operation: "recent_payments",
    payments: filtered.slice(0, 5).map((r) => ({
      to: r.recipient ?? "—", amount: r.amount != null ? String(r.amount) : "—", token: r.token,
      when: formatWhen(r.at), status: statusFromDecision(r.decision), txHash: r.txHash, explorerUrl: r.explorerUrl,
      outputAmount: r.outputAmount != null ? String(r.outputAmount) : null, outputToken: r.outputToken ?? null, provider: r.provider ?? null,
    })),
  };
  const operation: Operation = { id: nextId("op"), intent, status: "success" };
  return { id: nextId("msg"), role: "assistant", content: `You have ${filtered.length} recorded transaction${filtered.length === 1 ? "" : "s"}.`, createdAt: Date.now(), operation };
}

const AMBIGUOUS_TX_REPLY = "I couldn't find that specific transaction in your recent activity — could you tell me more (who it was to, roughly how much, or roughly when)?";

async function dispatchTransactionStatus(slots: { txHash?: string | null }, walletAddress: string | null): Promise<AskMessage> {
  if (!walletAddress) return assistantText(NO_WALLET_MESSAGE);
  const resolved = await resolveTransaction(slots.txHash, walletAddress);
  if ("rpcError" in resolved) return assistantText("Couldn't reach Monad to check that. Try again in a moment.");
  if ("empty" in resolved) return assistantText("You don't have any recorded transactions yet.");
  if ("notFound" in resolved) return assistantText(AMBIGUOUS_TX_REPLY);
  if ("pendingTxHash" in resolved) {
    return assistantText(`Still confirming on-chain — nothing's wrong, just waiting for the block. ${shortHash(resolved.pendingTxHash)} · ${explorerFor(resolved.pendingTxHash)}`);
  }
  const view = toTransactionView(resolved.row, walletAddress);
  const lead = view.status === "success" ? "Yes — that went through." : "That one failed on-chain — no funds moved.";
  const { operation } = transactionCard(view);
  return { id: nextId("msg"), role: "assistant", content: lead, createdAt: Date.now(), operation };
}

async function dispatchTransactionDetails(slots: { txHash?: string | null }, walletAddress: string | null): Promise<AskMessage> {
  if (!walletAddress) return assistantText(NO_WALLET_MESSAGE);
  const resolved = await resolveTransaction(slots.txHash, walletAddress);
  if ("rpcError" in resolved) return assistantText("Couldn't reach Monad to look that up. Try again in a moment.");
  if ("empty" in resolved) return assistantText("You don't have any recorded transactions yet.");
  if ("notFound" in resolved) return assistantText(AMBIGUOUS_TX_REPLY);
  if ("pendingTxHash" in resolved) {
    return assistantText(`That one's still confirming on-chain — I won't have full details until it settles. ${shortHash(resolved.pendingTxHash)} · ${explorerFor(resolved.pendingTxHash)}`);
  }
  const view = toTransactionView(resolved.row, walletAddress);
  const { operation } = transactionCard(view);
  return { id: nextId("msg"), role: "assistant", content: "Here's what I found.", createdAt: Date.now(), operation };
}

async function dispatchAutomations(walletAddress: string | null): Promise<AskMessage> {
  if (!walletAddress) return assistantText("Connect your wallet and I can show your automations.");
  try {
    const r = await fetch(`/api/automations?wallet=${encodeURIComponent(walletAddress)}`);
    // /api/automations returns `automations` and `schedules` as the same
    // array (the latter kept for older callers) — read exactly one of them
    // for both the count and the active tally so they can never diverge.
    const json = (await r.json()) as { automations?: { active?: boolean }[] };
    const list = json.automations ?? [];
    if (list.length === 0) return assistantText("You don't have any Payment Automations set up yet — want me to help start one?");
    const active = list.filter((a) => a.active !== false).length;
    return assistantText(`You have ${list.length} automation${list.length === 1 ? "" : "s"} (${active} active). Manage them from the Automations dashboard for full detail.`);
  } catch {
    return assistantText("Couldn't load your automations right now.");
  }
}

function dispatchDistribution(slots: { amount?: string | null; asset?: string | null; recipientCount?: number | null }): AskMessage {
  // Reached only when the LLM classified a multi-recipient payment that had
  // no "split"/"distribute" verb (those are handled deterministically before
  // any model call — lib/ask/intent/split.ts). The model never supplies split
  // recipients, so this never executes anything: it says exactly how to
  // phrase a split the deterministic path can resolve.
  const desc = `${slots.amount ?? "an amount"}${slots.asset ? ` ${slots.asset}` : ""} to ${slots.recipientCount ?? "several"} recipients`;
  return assistantText(
    `I understand — ${desc}. I can do that as one split payment if you list who gets what, for example "split 100 USDC between 0x… and bob.nad" or "split 100 USDC: 60 to 0x… and 40 to bob.nad". Recipients can be 0x addresses, .nad names or configured payees.`,
  );
}

/** /api/ask/token's response shape — mirrors lib/monad/tokenIntelligence.ts's
 *  TokenInspection exactly (this module never reshapes what the server
 *  already validated). */
interface TokenLookupApiResponse {
  status: "invalid" | "wallet" | "unknown_contract" | "token";
  error?: string;
  data?: TokenData;
}

function tokenIntelligenceCard(address: string, status: "wallet" | "unknown_contract" | "token", data?: TokenData): { intent: TokenIntelligenceIntent; operation: Operation } {
  const intent: TokenIntelligenceIntent = { kind: "token_intelligence", network: "monad", address, status, data };
  return { intent, operation: { id: nextId("op"), intent, status: "success" } };
}

/** The generic "what did we find" summary — used whenever the follow-up
 *  wasn't asking about one specific pair or amount. Deliberately simple and
 *  deterministic (no Anthropic call): the card itself shows every field, so
 *  this is just an honest one-line summary, never a guess at which specific
 *  thing the user was asking about. */
function tokenLookupLead(data: TokenData): string {
  const idLine = `${data.symbol} — ${data.name}${data.verified ? " (verified)" : ""}.`;
  if (!data.isTradable) return `${idLine} No usable trading route found — this token may not be tradable yet.`;
  const dexes = Array.from(new Set(data.market.routes.map((r) => r.provider))).join(", ");
  if (!data.market.price) return `${idLine} A trading route exists (via ${dexes}), but the price isn't reliable enough to show — the pool looks too thin to trust.`;
  return `${idLine} ≈ $${data.market.price} per ${data.symbol}, via ${dexes}.`;
}

/** "Can I trade it with USDC?" — answers the SPECIFIC pair asked about,
 *  reusing whatever the general market probe already found rather than a
 *  second call: routes only ever contains pairs that genuinely resolved, so
 *  "not in the list" already means "no route", never a guess either way. */
function pairLead(data: TokenData, quoteAsset: string): string {
  const route = data.market.routes.find((r) => r.outputToken.toUpperCase() === quoteAsset.toUpperCase());
  if (!route) return `No usable ${quoteAsset} route was found for ${data.symbol} right now.`;
  return `Yes — ${data.symbol}/${quoteAsset} trades via ${route.provider}, ≈ ${route.estimatedOutput} ${quoteAsset} per ${data.symbol}${route.priceImpact ? ` (est. price impact ${route.priceImpact})` : ""}.`;
}

/** "How much would I get for 50?" — a real quote for that specific amount
 *  (see lib/monad/tokenIntelligence's quoteRequest), never scaled up from
 *  the 1-unit reference price, which would silently ignore price impact. */
function amountLead(data: TokenData, amount: string): string {
  const q = data.quote;
  if (!q || !q.route) return `I couldn't find a usable route to quote ${amount} ${data.symbol} right now.`;
  return `${amount} ${data.symbol} ≈ ${q.route.estimatedOutput} ${q.route.outputToken}, via ${q.route.provider}${q.route.priceImpact ? ` (est. price impact ${q.route.priceImpact})` : ""}.`;
}

async function dispatchTokenLookup(
  slots: { tokenAddress?: string | null; amount?: string | null; toAsset?: string | null },
  walletAddress: string | null,
): Promise<AskMessage> {
  const address = slots.tokenAddress;
  if (!address) return assistantText("I couldn't find a valid contract address in that message.");

  let json: TokenLookupApiResponse | null = null;
  try {
    const r = await fetch("/api/ask/token", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        address, walletAddress,
        ...(slots.amount ? { amount: slots.amount, quoteAsset: slots.toAsset ?? null } : {}),
      }),
    });
    json = await r.json();
  } catch {
    return assistantText("Couldn't reach Monad to look up that address. Try again in a moment.");
  }
  if (!json) return assistantText("Couldn't look that up right now.");

  if (json.status === "invalid") return assistantText(json.error || "That doesn't look like a valid Monad address.");
  if (json.status === "wallet") {
    const { operation } = tokenIntelligenceCard(address, "wallet");
    return { id: nextId("msg"), role: "assistant", content: "This address is a wallet address, not a token contract.", createdAt: Date.now(), operation };
  }
  if (json.status === "unknown_contract") {
    const { operation } = tokenIntelligenceCard(address, "unknown_contract");
    return { id: nextId("msg"), role: "assistant", content: "This is a contract on Monad, but I couldn't identify it as an ERC-20 token.", createdAt: Date.now(), operation };
  }
  if (!json.data) return assistantText("Couldn't read that token's data right now. Try again in a moment.");

  const lead = slots.amount ? amountLead(json.data, slots.amount)
    : slots.toAsset ? pairLead(json.data, slots.toAsset)
    : tokenLookupLead(json.data);
  const { operation } = tokenIntelligenceCard(address, "token", json.data);
  return { id: nextId("msg"), role: "assistant", content: lead, createdAt: Date.now(), operation };
}

/** /api/ask/trade's response shape — mirrors lib/monad/tradeQuote.ts's
 *  TradePreviewResult exactly: FLAT (ok + the preview fields directly on
 *  the same object), never wrapped in a `data` property. */
type TradePreviewApiResponse = ({ ok: true } & TradePreviewData) | { ok: false; message: string };

type TradeRequest = NonNullable<TradePreviewIntent["execution"]>["request"];

/**
 * `request` is present only when a wallet was connected — it's what lets
 * executeTradeIntent re-quote and build real steps at confirm-time (see
 * /api/ask/trade/build). Its presence is what actually decides the card's
 * status: "ready" (real confirm funnel, wallet signs) when execution is
 * buildable, "success" (informational-only, same pattern
 * wallet_operation/token_intelligence use — no execution field, no signer
 * to build against) when there's no wallet to trade with yet. See
 * OperationCard's isInfo for the render-side half of this.
 */
function tradePreviewCard(data: TradePreviewData, request: TradeRequest | null): { intent: TradePreviewIntent; operation: Operation } {
  const intent: TradePreviewIntent = { kind: "trade_preview", network: "monad", data, ...(request ? { execution: { request } } : {}) };
  const status: Operation["status"] = request ? "ready" : "success";
  const operation: Operation = { id: nextId("op"), intent, status, ...(request ? { confirmLabel: "Confirm trade" } : {}) };
  return { intent, operation };
}

/** Deliberately simple and deterministic (no Anthropic call) -- every field
 *  on the card itself is the real quote; this is just the one-line summary
 *  above it. */
function tradePreviewLead(data: TradePreviewData): string {
  const verb = data.action === "buy" ? "Buying" : "Selling";
  const warn = data.highPriceImpact ? " ⚠ high price impact." : "";
  return `${verb} ${data.spend.amount} ${data.spend.token} → ≈ ${data.receive.amount} ${data.receive.token}, via ${data.route.provider}.${warn}`;
}

async function dispatchTrade(
  slots: {
    tradeAction?: "buy" | "sell" | null;
    fromAsset?: string | null;
    toAsset?: string | null;
    amount?: string | null;
    amountType?: "exact_input" | "exact_output" | "usd" | "percentage" | "balance_all" | null;
    slippage?: string | null;
  },
  walletAddress: string | null,
): Promise<AskMessage> {
  if (!slots.tradeAction || !slots.fromAsset || !slots.toAsset) {
    return assistantText("I need a bit more detail to quote that trade.");
  }
  const amountType = slots.amountType ?? "exact_input";
  const amount = slots.amount ?? "";
  const slippage = slots.slippage ?? null;

  let json: TradePreviewApiResponse | null = null;
  try {
    const r = await fetch("/api/ask/trade", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: slots.tradeAction, inputToken: slots.fromAsset, outputToken: slots.toAsset,
        amount, amountType, slippage, walletAddress,
      }),
    });
    json = await r.json();
  } catch {
    return assistantText("Couldn't reach Monad to quote that trade. Try again in a moment.");
  }
  if (!json) return assistantText("Couldn't quote that trade right now.");
  if (!json.ok) return assistantText(json.message);

  const { ok: _ok, ...data } = json;
  // Only a wallet-connected preview carries the request needed to actually
  // execute it — see tradePreviewCard's own doc.
  const request: TradeRequest | null = walletAddress
    ? { action: slots.tradeAction, inputToken: slots.fromAsset, outputToken: slots.toAsset, amount, amountType, slippage }
    : null;
  const { operation } = tradePreviewCard(data, request);
  return { id: nextId("msg"), role: "assistant", content: tradePreviewLead(data), createdAt: Date.now(), operation };
}

/* ── SDK protocol actions (Phase 2) ─────────────────────────────────────────
 * dispatchProtocolAction previews a REGISTERED action's quote (client-side,
 * via /api/ask/action — the SDK registry is server-only, so nothing here
 * touches it directly). executeProtocolActionIntent, on an explicit confirm,
 * builds the real steps server-side (/api/ask/action/build, which runs Layer
 * A + Layer B) and drives them through the SAME wallet.sendTransaction /
 * waitForReceipt loop every other execution path uses — no second signer, no
 * second sender. It never sees a private key and never builds calldata
 * itself. */

interface ProtocolActionPreviewResponse {
  ok: boolean;
  message?: string;
  protocol?: { id: string; name: string; logoUrl?: string | null };
  action?: { id: string; name: string; description: string; version: string };
  chainId?: number;
  inputs?: ActionInputs;
  summary?: string;
  details?: Record<string, string>;
  quotedAt?: number;
  quoteToken?: string;
  quoteId?: string;
  warnings?: string[];
}

async function dispatchProtocolAction(
  slots: { protocolId?: string | null; actionId?: string | null; actionVersion?: string | null; amount?: string | null; actionInputs?: ActionInputs | null; recipientLabels?: Record<string, string> | null },
  walletAddress: string | null,
): Promise<AskMessage> {
  if (!slots.protocolId || !slots.actionId || !slots.actionVersion) {
    return assistantText("I couldn't identify that protocol action.");
  }
  // Aave's supply/withdraw actions require an explicit destination address
  // (onBehalfOf / to) that the deterministic detector deliberately never
  // supplies (see classify.ts's detectAaveAction) — it has no wallet
  // context and must never invent one. This dispatch function is the first
  // point that legitimately knows the REAL connected wallet, so it is the
  // one place that fills it in — never a placeholder, never module-level
  // state, just this call's own `walletAddress` parameter. Without a
  // connected wallet there is no real address to use, so this refuses
  // outright rather than sending an empty/fake destination.
  if (slots.protocolId === "aave-v3-monad" && !walletAddress) {
    return assistantText("Connect your wallet to use Aave — I need to know where the funds should go.");
  }
  // A multi-input action (e.g. split_payment) carries its full input map in
  // slots.actionInputs, populated deterministically by the detector; a
  // single-input action (WMON) uses the scalar `amount` slot. Either way the
  // server re-validates every field against the action's schema (Layer A), so
  // nothing here is trusted — this only forwards what the detector resolved.
  const inputs: Record<string, ActionInputValue> = slots.actionInputs
    ? { ...slots.actionInputs }
    : {};
  if (!slots.actionInputs && slots.amount) inputs.amount = slots.amount;
  if (slots.protocolId === "aave-v3-monad" && walletAddress) {
    if (slots.actionId === "supply" && !inputs.onBehalfOf) inputs.onBehalfOf = walletAddress;
    if (slots.actionId === "withdraw" && !inputs.to) inputs.to = walletAddress;
  }

  let json: ProtocolActionPreviewResponse | null = null;
  try {
    const r = await fetch("/api/ask/action", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ protocolId: slots.protocolId, actionId: slots.actionId, version: slots.actionVersion, inputs }),
    });
    json = await r.json();
  } catch {
    return assistantText("Couldn't reach Monad to prepare that action. Try again in a moment.");
  }
  if (!json || !json.ok || !json.protocol || !json.action || json.chainId == null || !json.quoteToken) {
    return assistantText(json?.message ?? "Couldn't prepare that action right now.");
  }

  const data: ProtocolActionData = {
    protocol: json.protocol,
    action: json.action,
    chainId: json.chainId,
    network: "Monad",
    inputs: json.inputs ?? inputs,
    summary: json.summary ?? "",
    details: json.details ?? {},
    quotedAt: json.quotedAt ?? Date.now(),
    ...(slots.recipientLabels ? { recipientLabels: { ...slots.recipientLabels } } : {}),
    ...(json.warnings && json.warnings.length > 0 ? { warnings: json.warnings } : {}),
  };
  // Only a wallet-connected preview carries the request needed to execute —
  // same rule as tradePreviewCard. Without a wallet it's an informational
  // preview that never enters the confirm funnel.
  const execution = walletAddress
    ? { request: { protocolId: json.protocol.id, actionId: json.action.id, version: json.action.version, inputs: data.inputs, chainId: json.chainId }, quoteToken: json.quoteToken }
    : undefined;
  const intent: ProtocolActionIntent = { kind: "protocol_action", network: "monad", data, ...(execution ? { execution } : {}) };
  const operation: Operation = {
    id: nextId("op"), intent,
    status: execution ? "ready" : "success",
    ...(execution ? { confirmLabel: `Confirm ${json.action.name}` } : {}),
  };
  return { id: nextId("msg"), role: "assistant", content: json.summary ?? `${json.action.name} ready.`, createdAt: Date.now(), operation };
}

interface ProtocolActionBuildResponse {
  ok: boolean;
  message?: string;
  code?: string;
  steps?: { kind: "approve" | "action"; label: string; tx: { to: string; data: string; value: string } }[];
  summary?: string;
  details?: Record<string, string>;
  quoteId?: string;
}

/**
 * Executes a previewed protocol action after explicit confirmation. Builds
 * real steps server-side (which re-resolves the EXACT pinned version, re-runs
 * Layer A + Layer B), then signs/broadcasts each step through the existing
 * wallet interface and verifies the outcome via /api/ask/action/confirm.
 * Mirrors executeTradeIntent's status handling (submitted vs error vs
 * success) so the UI lifecycle is identical.
 */
export async function executeProtocolActionIntent(
  operation: Operation,
  wallet: SendPaymentWallet & { isWrongNetwork?: boolean },
  walletAddress: string,
): Promise<Operation> {
  if (operation.intent.kind !== "protocol_action" || !operation.intent.execution) return operation;
  const { request, quoteToken } = operation.intent.execution;

  if (wallet.isWrongNetwork) {
    return { ...operation, status: "error", error: { message: "You're connected to the wrong network — switch your wallet to Monad and try again.", code: "WRONG_NETWORK" } };
  }

  let build: ProtocolActionBuildResponse | null = null;
  try {
    const r = await fetch("/api/ask/action/build", {
      method: "POST", headers: { "content-type": "application/json" },
      // quotedAt is deliberately NOT sent: build takes it only from the
      // signed quoteToken, so a client can never refresh a stale quote.
      body: JSON.stringify({ protocolId: request.protocolId, actionId: request.actionId, version: request.version, inputs: request.inputs, walletAddress, quoteToken }),
    });
    build = await r.json();
  } catch {
    return { ...operation, status: "error", error: { message: "Couldn't reach Monad to prepare that action. Try again in a moment.", code: "BUILD_FAILED" } };
  }
  if (!build || !build.ok || !build.steps || build.steps.length === 0 || !build.quoteId) {
    return { ...operation, status: "error", error: { message: build?.message ?? "Couldn't prepare that action.", code: build?.code ?? "BUILD_FAILED" } };
  }

  const steps = build.steps;
  const quoteId = build.quoteId;
  let broadcastHash: string | null = null;
  // An ERC-20 split is two wallet actions: approve, then splitPayment. Track
  // the approval's OWN hash so it is NEVER shown as the settlement hash, and so
  // a split that fails AFTER a successful approval can say exactly that.
  let approvalTx: { txHash: string; explorerUrl: string } | null = null;
  let approvalConfirmed = false;
  let broadcastIsApproval = false;
  try {
    let lastHash = "";
    for (let i = 0; i < steps.length; i++) {
      const isLast = i === steps.length - 1;
      const isApprove = steps[i].kind === "approve";
      broadcastHash = null;
      broadcastIsApproval = isApprove && !isLast;
      lastHash = await wallet.sendTransaction(steps[i].tx);
      broadcastHash = lastHash;
      const receipt = (await wallet.waitForReceipt(lastHash)) as { status?: string | number } | undefined;

      // A pre-settlement approval MUST actually confirm before we sign the
      // split. If it reverted, stop here — never sign the settlement against a
      // failed allowance, and never imply the split happened.
      if (isApprove && !isLast) {
        const st = receipt?.status;
        const approvalOk = st === undefined || st === "success" || st === 1 || st === "0x1";
        if (!approvalOk) {
          return { ...operation, status: "error", error: { message: "The token approval reverted on-chain. No funds moved.", code: "APPROVAL_FAILED", txHash: lastHash, explorerUrl: configExplorerTx(lastHash) } };
        }
        approvalConfirmed = true;
        approvalTx = { txHash: lastHash, explorerUrl: configExplorerTx(lastHash) };
      }
    }

    // Verify the FINAL (settlement) transaction on-chain + parse its real result.
    let confirm: { ok?: boolean; success?: boolean; reverted?: boolean; explorerUrl?: string; message?: string; details?: Record<string, string> } | null = null;
    try {
      const r = await fetch("/api/ask/action/confirm", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ protocolId: request.protocolId, actionId: request.actionId, version: request.version, txHash: lastHash, walletAddress, quoteId }),
      });
      confirm = await r.json();
    } catch {
      // Settlement broadcast succeeded but our own verify call failed to reach
      // the server — submitted, not failed. Never rebroadcast. Approval (if
      // any) already confirmed and is carried distinctly.
      return { ...operation, status: "submitted", submitted: { txHash: lastHash, explorerUrl: configExplorerTx(lastHash), step: "main", approvalConfirmed, approvalTx: approvalTx ?? undefined } };
    }

    if (confirm?.reverted) {
      // Settlement reverted. If an approval already succeeded, say so — the two
      // hashes stay distinct and no false whole-operation success is implied.
      return { ...operation, status: "error", error: { message: prefixApprovalContext(confirm.message || "The split reverted on-chain. No funds moved.", approvalTx), code: "REVERTED", txHash: lastHash, explorerUrl: confirm.explorerUrl, approvalTx: approvalTx ?? undefined } };
    }
    if (!confirm?.ok || !confirm.success) {
      return { ...operation, status: "submitted", submitted: { txHash: lastHash, explorerUrl: confirm?.explorerUrl || configExplorerTx(lastHash), step: "main", approvalConfirmed, approvalTx: approvalTx ?? undefined } };
    }
    // confirm.details is the action's own parseResult() output, computed
    // server-side from the REAL, receipt-verified logs — never the quote's
    // predicted numbers. Carried into result.confirmedDetails specifically
    // so the UI can render it as what actually happened, distinct from
    // operation.intent.data.details (the pre-execution prediction), rather
    // than silently falling back to showing the prediction as if it were
    // the outcome. The settlement result uses the SETTLEMENT hash only; the
    // approval hash was surfaced separately above.
    return {
      ...operation, status: "success",
      result: { txHash: lastHash, explorerUrl: confirm.explorerUrl ?? configExplorerTx(lastHash), confirmedDetails: confirm.details },
    };
  } catch (e) {
    if (broadcastHash) {
      // Broadcast happened but confirmation timed out — submitted, not failed.
      // Name WHICH transaction is pending so an approval is never mislabeled as
      // the settlement.
      return { ...operation, status: "submitted", submitted: { txHash: broadcastHash, explorerUrl: configExplorerTx(broadcastHash), step: broadcastIsApproval ? "approval" : "main", approvalConfirmed, approvalTx: approvalTx ?? undefined } };
    }
    return { ...operation, status: "error", error: { message: prefixApprovalContext(friendlyError(e instanceof Error ? e.message : "Action failed.", "Action"), approvalTx), code: "NOT_SENT", approvalTx: approvalTx ?? undefined } };
  }
}
