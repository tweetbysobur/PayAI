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

import { friendlyError, type AgentResult } from "@/lib/hooks/useAgentConsole";
import { clearPendingSettlement, getPendingSettlement, savePendingSettlement } from "@/lib/hooks/pendingSettlement";
import type { AskMessage, AutomationHandoff, Operation, OperationError, RecurringPaymentIntent, ScheduledPaymentIntent, SwapIntent, TokenData, TokenIntelligenceIntent, TradePreviewData, TradePreviewIntent, TransactionResult, WalletOperationIntent, WalletTransactionView } from "@/lib/ask/types";
import { respondToSendPayment, type SendPaymentWallet } from "@/lib/ask/sendPayment/orchestrator";
import type { ConversationTurn } from "./classify";
import type { Understanding } from "./types";

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
export async function classifyMessage(text: string, history: ConversationTurn[], pending: Understanding | null): Promise<Understanding> {
  try {
    const r = await fetch("/api/ask/understand", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, history, pending }),
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

/** The only function allowed to request a wallet signature for a swap —
 *  called exclusively from an explicit "Confirm" click on a card this
 *  module already built and the server already quoted. */
export async function executeSwapIntent(
  operation: Operation, wallet: SendPaymentWallet, walletAddress: string,
  onProgress?: (label: string) => void,
): Promise<Operation> {
  if (operation.intent.kind !== "swap" || !operation.intent.execution) return operation;
  const { plan } = operation.intent.execution;
  let broadcastHash: string | null = null;
  try {
    let lastHash = "";
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i].label;
      onProgress?.(
        plan.steps.length > 1
          ? `Step ${i + 1} of ${plan.steps.length}: waiting for your signature (${step}) — nothing has moved yet.`
          : "Waiting for your signature — nothing has moved yet.",
      );
      lastHash = await wallet.sendTransaction(plan.steps[i].tx);
      broadcastHash = lastHash;
      if (i === plan.steps.length - 1) {
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
    }
    onProgress?.("Finalizing swap…");
    const r = await fetch("/api/swap/confirm", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ walletAddress, txHash: lastHash, fromToken: plan.quote.fromToken, toToken: plan.quote.toToken, amountIn: plan.quote.amountIn, amountOut: plan.quote.amountOut }),
    });
    const cj = (await r.json()) as { explorerUrl?: string; error?: string; success?: boolean; reverted?: boolean };
    if (!cj.success) {
      clearPendingSettlement();
      const message = cj.reverted ? (cj.error || "This swap failed on-chain. No tokens were swapped.") : friendlyError(cj.error || "The swap could not be confirmed.", "Swap");
      const error: OperationError = { message, code: cj.reverted ? "REVERTED" : "CONFIRM_FAILED", txHash: lastHash, explorerUrl: cj.explorerUrl };
      return { ...operation, status: "error", error };
    }
    clearPendingSettlement();
    const result: TransactionResult = { txHash: lastHash, explorerUrl: cj.explorerUrl ?? "" };
    return { ...operation, status: "success", result };
  } catch (e) {
    if (broadcastHash) {
      const error: OperationError = {
        message: `Your swap was sent (${broadcastHash.slice(0, 10)}…) but we couldn't confirm it yet. Don't resend it — check Transactions for the latest status.`,
        code: "UNCONFIRMED",
      };
      return { ...operation, status: "error", error };
    }
    const error: OperationError = { message: friendlyError(e instanceof Error ? e.message : "Swap failed.", "Swap"), code: "NOT_SENT" };
    return { ...operation, status: "error", error };
  }
}

/** /api/ask/trade/build's response shape — mirrors lib/monad/tradeQuote.ts's
 *  TradeExecutionResult exactly: flat, same convention as
 *  TradePreviewApiResponse above. */
type TradeBuildApiResponse =
  | { ok: true; status: "ready"; preview: TradePreviewData & { ok?: true }; steps: { kind: "approve" | "swap"; label: string; tx: { to: string; data: string; value: string } }[] }
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
  let broadcastHash: string | null = null;
  try {
    let lastHash = "";
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i].label;
      onProgress?.(
        steps.length > 1
          ? `Step ${i + 1} of ${steps.length}: waiting for your signature (${step}) — nothing has moved yet.`
          : "Waiting for your signature — nothing has moved yet.",
      );
      lastHash = await wallet.sendTransaction(steps[i].tx);
      broadcastHash = lastHash;
      if (i === steps.length - 1) {
        savePendingSettlement({
          kind: "swap", walletAddress, txHash: lastHash,
          fromToken: freshData.spend.token, toToken: freshData.receive.token,
          amountIn: Number(freshData.spend.amount), amountOut: Number(freshData.receive.amount), savedAt: Date.now(),
        });
      }
      onProgress?.(
        steps.length > 1
          ? `Step ${i + 1} of ${steps.length}: confirming on-chain…`
          : "Signed — confirming on-chain…",
      );
      await wallet.waitForReceipt(lastHash);
    }
    onProgress?.("Finalizing trade…");
    const r = await fetch("/api/swap/confirm", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        walletAddress, txHash: lastHash, fromToken: freshData.spend.token, toToken: freshData.receive.token,
        amountIn: Number(freshData.spend.amount), amountOut: Number(freshData.receive.amount),
        feature: "trade", provider: freshData.route.provider,
      }),
    });
    const cj = (await r.json()) as { explorerUrl?: string; error?: string; success?: boolean; reverted?: boolean };
    if (!cj.success) {
      clearPendingSettlement();
      const message = cj.reverted ? (cj.error || "This trade failed on-chain. No tokens were traded.") : friendlyError(cj.error || "The trade could not be confirmed.", "Trade");
      const error: OperationError = { message, code: cj.reverted ? "REVERTED" : "CONFIRM_FAILED", txHash: lastHash, explorerUrl: cj.explorerUrl };
      return { ...operation, status: "error", intent: { ...operation.intent, data: freshData }, error };
    }
    clearPendingSettlement();
    const result: TransactionResult = { txHash: lastHash, explorerUrl: cj.explorerUrl ?? "" };
    return { ...operation, status: "success", intent: { ...operation.intent, data: freshData }, result };
  } catch (e) {
    if (broadcastHash) {
      const error: OperationError = {
        message: `Your trade was sent (${broadcastHash.slice(0, 10)}…) but we couldn't confirm it yet. Don't resend it — check Transactions for the latest status.`,
        code: "UNCONFIRMED",
      };
      return { ...operation, status: "error", error };
    }
    const error: OperationError = { message: friendlyError(e instanceof Error ? e.message : "Trade failed.", "Trade"), code: "NOT_SENT" };
    return { ...operation, status: "error", error };
  }
}

async function dispatchSchedule(
  kind: "schedule_payment" | "recurring_payment",
  slots: { amount?: string | null; asset?: string | null; recipient?: string | null; when?: string | null; frequency?: "daily" | "weekly" | "monthly" | null },
  walletAddress: string | null,
): Promise<AskMessage> {
  if (!walletAddress) return assistantText("Connect your wallet so I can look up your recipient and set this up.");
  const canonical = kind === "recurring_payment"
    ? `Schedule ${slots.amount} ${slots.asset} to ${slots.recipient} every ${slots.frequency}`
    : `Schedule ${slots.amount} ${slots.asset} to ${slots.recipient} on ${slots.when}`;
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
  const desc = `${slots.amount ?? "an amount"}${slots.asset ? ` ${slots.asset}` : ""} to ${slots.recipientCount ?? "multiple"} recipients`;
  return assistantText(
    `I understand — ${desc}. Bulk distributions aren't executable from this chat yet; you can set one up from the dashboard, or I can send individual payments here one at a time.`,
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
