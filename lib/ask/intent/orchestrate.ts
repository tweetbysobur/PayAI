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
import { clearPendingSettlement, savePendingSettlement } from "@/lib/hooks/pendingSettlement";
import type { AskMessage, AutomationHandoff, Operation, OperationError, RecurringPaymentIntent, ScheduledPaymentIntent, SwapIntent, TransactionResult } from "@/lib/ask/types";
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
  history?: { summary: string; txHash?: string }[];
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
    case "send_payment": return { message: await dispatchSendPayment(u.slots, walletAddress), nextPending: null };
    case "swap": return { message: await dispatchSwap(u.slots, walletAddress), nextPending: null };
    case "schedule_payment": return { message: await dispatchSchedule("schedule_payment", u.slots, walletAddress), nextPending: null };
    case "recurring_payment": return { message: await dispatchSchedule("recurring_payment", u.slots, walletAddress), nextPending: null };
    case "check_balance": return { message: await dispatchBalance(walletAddress), nextPending: null };
    case "transaction_history": return { message: await dispatchHistory(walletAddress), nextPending: null };
    case "automation_management": return { message: await dispatchAutomations(walletAddress), nextPending: null };
    case "distribution": return { message: dispatchDistribution(u.slots), nextPending: null };
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
      execution: { plan, provider: json.provider },
    };
    const operation: Operation = { id: nextId("op"), intent, status: "ready" };
    return { id: nextId("msg"), role: "assistant", content: `Here's a live quote for that swap, via ${json.provider ?? "the DEX"}.`, createdAt: Date.now(), operation };
  }
  return assistantText(json.error || "I couldn't quote that swap. Try again in a moment.");
}

/** The only function allowed to request a wallet signature for a swap —
 *  called exclusively from an explicit "Confirm" click on a card this
 *  module already built and the server already quoted. */
export async function executeSwapIntent(operation: Operation, wallet: SendPaymentWallet, walletAddress: string): Promise<Operation> {
  if (operation.intent.kind !== "swap" || !operation.intent.execution) return operation;
  const { plan } = operation.intent.execution;
  let broadcastHash: string | null = null;
  try {
    let lastHash = "";
    for (let i = 0; i < plan.steps.length; i++) {
      lastHash = await wallet.sendTransaction(plan.steps[i].tx);
      broadcastHash = lastHash;
      if (i === plan.steps.length - 1) {
        savePendingSettlement({
          kind: "swap", walletAddress, txHash: lastHash,
          fromToken: plan.quote.fromToken, toToken: plan.quote.toToken,
          amountIn: plan.quote.amountIn, amountOut: plan.quote.amountOut, savedAt: Date.now(),
        });
      }
      await wallet.waitForReceipt(lastHash);
    }
    const r = await fetch("/api/swap/confirm", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ walletAddress, txHash: lastHash, fromToken: plan.quote.fromToken, toToken: plan.quote.toToken, amountIn: plan.quote.amountIn, amountOut: plan.quote.amountOut }),
    });
    const cj = (await r.json()) as { explorerUrl?: string; error?: string; success?: boolean; reverted?: boolean };
    if (!cj.success) {
      clearPendingSettlement();
      const message = cj.reverted ? (cj.error || "This swap failed on-chain. No tokens were swapped.") : friendlyError(cj.error || "The swap could not be confirmed.");
      const error: OperationError = { message, code: cj.reverted ? "REVERTED" : "CONFIRM_FAILED" };
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
    const error: OperationError = { message: friendlyError(e instanceof Error ? e.message : "Swap failed."), code: "NOT_SENT" };
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
    const operation: Operation = { id: nextId("op"), intent, status: "ready", confirmLabel: "Set up in Automations", confirmIcon: "go" };
    return {
      id: nextId("msg"), role: "assistant",
      content: "Payment Automations always get their own wallet signature, separate from this chat — I'll take you there with everything already filled in.",
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

async function dispatchBalance(walletAddress: string | null): Promise<AskMessage> {
  if (!walletAddress) return assistantText("Connect your wallet and I can check your balance.");
  try {
    const r = await fetch("/api/agent", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "show my balance", walletAddress, idempotencyKey: idemKey("bal") }),
    });
    const json = (await r.json()) as AgentApiResponse;
    if (json.balance) return assistantText(`You're holding ${json.balance.mon.toFixed(4)} MON and ${json.balance.usdc.toFixed(2)} USDC.`);
    return assistantText(json.error || "Couldn't read your balance right now.");
  } catch {
    return assistantText("Couldn't reach Monad to check your balance. Try again.");
  }
}

async function dispatchHistory(walletAddress: string | null): Promise<AskMessage> {
  if (!walletAddress) return assistantText("Connect your wallet and I can show your transaction history.");
  try {
    const r = await fetch("/api/agent", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "show my transaction history", walletAddress, idempotencyKey: idemKey("hist") }),
    });
    const json = (await r.json()) as AgentApiResponse;
    const count = json.count ?? json.history?.length ?? 0;
    if (count === 0) return assistantText("You don't have any recorded transactions yet.");
    const recent = (json.history ?? []).slice(0, 5).map((h) => `• ${h.summary}`).join("\n");
    return assistantText(`You have ${count} recorded transaction${count === 1 ? "" : "s"}. Most recent:\n${recent}`);
  } catch {
    return assistantText("Couldn't reach PayAI to load your history. Try again.");
  }
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
