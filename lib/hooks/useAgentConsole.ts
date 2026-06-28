"use client";

import { useEffect, useState } from "react";
import { useWallet } from "@/lib/wallet/useWallet";
import { useWalletBalances } from "@/lib/hooks/useWalletBalances";

/* Client-side mirror of the API result shapes — identical contract used by
   every command-center layout, so all three variants stay functionally real
   (same /api/agent, /api/health, /api/onchain calls) and only differ visually. */
export interface Check { id: string; label: string; passed: boolean; detail: string; severity: string }
export interface Factor { id: string; label: string; points: number; detail: string }
export interface TraceEntry { step: string; status: "ok" | "warn" | "blocked" | "info"; detail: string }
export interface Txn {
  status: string; detail: string; mode: string;
  txHash?: string; explorerUrl?: string; link?: string;
  gasFee?: string; gasEstimate?: string; blockNumber?: number; blockTimestamp?: number; sender?: string;
  amount?: number; token?: string; recipient?: string;
}
export interface AgentResult {
  success: boolean;
  decision: "executed" | "needs_review" | "blocked" | "refused" | "error" | "ready_to_sign";
  source: string;
  intent: {
    action: string; amount: number | null; token: string;
    recipient: string | null; purpose: string | null; network: string;
    summary: string; confidence: number; domain?: string;
  };
  guardrail: { allowed: boolean; violations: string[] };
  compliance: { status: string; summary: string; checks: Check[] } | null;
  risk: { score: number; level: string; factors: Factor[] } | null;
  transaction: Txn | null;
  confidence: number;
  riskScore: number | null;
  trace: TraceEntry[];
  error?: string;
  unsignedTx?: { to: string; data: string; value?: string; from: string };
  confirmRawText?: string;
}
export interface Health {
  model: string;
  cleanverse: { engine: string };
  verigate: { mode: string; connected: boolean; detail: string };
  wallet: {
    configured: boolean; address: string | null; network: string;
    chainId: number; nativeBalance: string | null; symbol: string;
  } | null;
}
export interface HistoryRow {
  at: string; decision: string; summary: string;
  amount: number | null; token: string; risk: number | null;
  txHash?: string; explorerUrl?: string; gasFee?: string;
}
export interface OnchainPayment {
  id: number; merchant: string; amount: number; riskScore: number; compliance: number; timestamp: number;
}
export interface OnchainMerchant {
  wallet: string; name: string; active: boolean; volume: number; paymentCount: number;
}
export interface OnchainRequest {
  id: number; merchant: string; amount: number; paid: boolean; paymentId: number;
}
export interface Onchain {
  configured: boolean;
  contracts?: { paymentExecutor: string; merchantRegistry: string; executorExplorer: string };
  stats: { payments: number; volume: number; approved: number; rejected: number; requests: number } | null;
  payments: OnchainPayment[];
  merchants: OnchainMerchant[];
  requests: OnchainRequest[];
  explorerTxBase?: string;
}
export interface InfoResult {
  decision: "info";
  query: "show_history" | "check_compliance" | "show_balance" | "scheduled_payment";
  count?: number;
  history?: { at: number; decision: string; summary: string; amount: number | null; token: string; txHash?: string; explorerUrl?: string }[];
  compliance?: { approved: number; rejected: number; review: number; blocked: number; approvalRate: number };
  balance?: { mon: number; usdc: number };
  error?: string;
}

/* ── Swap (DEX) ─────────────────────────────────────────────────────────────
   Swaps don't use the payment pipeline — they read a live DEX quote and sign
   one or two transactions (optional approval + the swap). Its own state shape. */
export interface SwapStep { kind: "approve" | "swap"; label: string; tx: { to: string; data: string; value: string } }
export interface SwapQuoteView {
  fromToken: string; toToken: string; amountIn: number;
  amountOut: number; minAmountOut: number; feeTier: number; slippage: number; rate: number;
}
export interface SwapPlanView { quote: SwapQuoteView; steps: SwapStep[]; summary: string }
export interface SwapState {
  phase: "ready" | "signing" | "done" | "error";
  plan: SwapPlanView;
  provider?: string;
  stepIndex: number;
  txHash?: string;
  explorerUrl?: string;
  error?: string;
}

export const STAGE_LABEL: Record<string, string> = {
  intent: "Understanding the request",
  guardrails: "Safety checks",
  compliance: "Compliance review",
  risk: "Risk scoring",
  execution: "Settlement",
};
export const PIPELINE_ORDER = ["intent", "guardrails", "compliance", "risk", "execution"];

export const DECISION: Record<string, { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  executed: { label: "Executed", tone: "success" },
  needs_review: { label: "Needs review", tone: "warning" },
  blocked: { label: "Blocked", tone: "danger" },
  refused: { label: "Refused", tone: "danger" },
  error: { label: "Error", tone: "neutral" },
  ready_to_sign: { label: "Awaiting your signature", tone: "warning" },
};

export const short = (s?: string | null) => (s ? `${s.slice(0, 8)}…${s.slice(-6)}` : "—");

/**
 * The parsed intent summary is present-tense ("Send 1 MON to…") because it
 * describes the requested action. Once a payment is actually executed, a
 * receipt should read in the past tense ("Sent 1 MON to…"). Non-executed
 * outcomes keep the original wording — the action didn't happen.
 */
export function phraseSummary(summary: string, decision: string): string {
  if (decision !== "executed") return summary;
  return summary
    .replace(/^Send\b/, "Sent")
    .replace(/^Pay\b/, "Paid")
    .replace(/^Create(?:\sa)?\b/, "Created");
}

/** Compact relative time ("just now", "3m ago", "2h ago", "5d ago") from a ms timestamp. */
export function timeAgo(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/**
 * Maps raw wallet/network error strings to plain language. API error messages
 * are already user-facing copy and pass through unchanged — this only catches
 * the cases that otherwise leak provider/fetch internals to the screen.
 */
export function friendlyError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes("user rejected") || m.includes("user denied") || (m.includes("denied") && m.includes("signature"))) {
    return "Payment not sent — you canceled it in your wallet.";
  }
  if (m.includes("failed to fetch") || m.includes("networkerror") || m.includes("network request failed")) {
    return "Couldn't reach the network. Check your connection and try again.";
  }
  if (m === "request failed") {
    return "Something went wrong on our side. Please try again.";
  }
  return message;
}

/**
 * All state + side effects shared by every command-center layout variant.
 * Identical wiring to /api/agent, /api/agent/confirm, /api/health, /api/onchain
 * — only presentation differs between variants.
 */
export function useAgentConsole() {
  const wallet = useWallet();
  const balances = useWalletBalances(wallet.address);
  const [walletBusy, setWalletBusy] = useState(false);
  const [intent, setIntent] = useState("");
  const [loading, setLoading] = useState(false);
  const [res, setRes] = useState<AgentResult | null>(null);
  const [info, setInfo] = useState<InfoResult | null>(null);
  const [swap, setSwap] = useState<SwapState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [onchain, setOnchain] = useState<Onchain | null>(null);

  function loadOnchain() {
    fetch("/api/onchain").then((r) => r.json()).then(setOnchain).catch(() => {});
  }
  useEffect(() => {
    fetch("/api/health").then((r) => r.json()).then(setHealth).catch(() => {});
    loadOnchain();
  }, []);

  function pushHistory(json: AgentResult) {
    setHistory((h) => [{
      at: new Date().toLocaleTimeString(),
      decision: json.decision,
      summary: json.intent.summary,
      amount: json.intent.amount,
      token: json.intent.token,
      risk: json.riskScore,
      txHash: json.transaction?.txHash,
      explorerUrl: json.transaction?.explorerUrl,
      gasFee: json.transaction?.gasFee ?? json.transaction?.gasEstimate,
    }, ...h].slice(0, 10));
  }

  async function signAndConfirm(unsignedTx: { to: string; data: string; value?: string; from: string }, confirmRawText: string) {
    setWalletBusy(true);
    try {
      const hash = await wallet.sendTransaction(unsignedTx);
      await wallet.waitForReceipt(hash);
      const r = await fetch("/api/agent/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rawText: confirmRawText, walletAddress: unsignedTx.from, txHash: hash }),
      });
      const json = (await r.json()) as AgentResult & { error?: string };
      if (!json.intent) throw new Error(json.error || "Could not confirm the payment.");
      setRes(json);
      pushHistory(json);
      loadOnchain();
      balances.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Wallet payment failed.");
    } finally {
      setWalletBusy(false);
    }
  }

  /** Sign the swap's steps in order (approval first when present), verify the
   *  final tx on-chain, then refresh balances. Non-custodial — the wallet signs. */
  async function executeSwap(plan: SwapPlanView, provider?: string) {
    setSwap({ phase: "signing", plan, provider, stepIndex: 0 });
    try {
      let lastHash = "";
      for (let i = 0; i < plan.steps.length; i++) {
        setSwap((s) => (s ? { ...s, stepIndex: i } : s));
        lastHash = await wallet.sendTransaction(plan.steps[i].tx);
        await wallet.waitForReceipt(lastHash);
      }
      const r = await fetch("/api/swap/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          walletAddress: wallet.address,
          txHash: lastHash,
          fromToken: plan.quote.fromToken,
          toToken: plan.quote.toToken,
          amountIn: plan.quote.amountIn,
          amountOut: plan.quote.amountOut,
        }),
      });
      const cj = (await r.json()) as { explorerUrl?: string; error?: string; success?: boolean };
      if (!cj.success) throw new Error(cj.error || "The swap could not be confirmed.");
      setSwap((s) => (s ? { ...s, phase: "done", txHash: lastHash, explorerUrl: cj.explorerUrl } : s));
      loadOnchain();
      balances.refresh();
    } catch (e) {
      setSwap((s) => (s ? { ...s, phase: "error", error: friendlyError(e instanceof Error ? e.message : "Swap failed.") } : s));
    }
  }

  /** Clear everything back to the idle prompt — used after a command finishes
   *  so the bar returns to its start state instead of holding the old result. */
  function reset() {
    setIntent(""); setRes(null); setInfo(null); setSwap(null); setErr(null); setLoading(false);
  }

  async function run(text: string) {
    // Empty the input the moment a command is dispatched — like a real command
    // bar, the typed prompt shouldn't linger over the result.
    setIntent("");
    setLoading(true); setErr(null); setRes(null); setInfo(null); setSwap(null);
    // Reuse the same idempotencyKey for an identical in-flight request — this
    // is what makes "double-click Send" or "close tab, reopen, click Send
    // again before the first request resolves" safe: the resubmission
    // collides with the original on the server (which replays its cached
    // result or returns 409) instead of minting a second real payment
    // request. The slot clears once this flow fully settles (see finally
    // below), so a deliberately repeated payment afterward gets a fresh key.
    const inflightSlot = `payai_inflight:${wallet.address ?? "anon"}:${text}`;
    let idempotencyKey = sessionStorage.getItem(inflightSlot);
    if (!idempotencyKey) {
      idempotencyKey = `console-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      sessionStorage.setItem(inflightSlot, idempotencyKey);
    }
    try {
      const r = await fetch("/api/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent: text, walletAddress: wallet.address, idempotencyKey }),
      });
      const json = (await r.json()) as (AgentResult | InfoResult) & { error?: string; swap?: SwapPlanView; provider?: string };
      const decision = json.decision as string;
      if (decision === "info") {
        setInfo(json as InfoResult);
        return;
      }
      if (decision === "swap_error") {
        setErr(json.error || "Couldn't build the swap.");
        return;
      }
      if (decision === "swap_ready" && json.swap) {
        setLoading(false);
        await executeSwap(json.swap, json.provider);
        return;
      }
      if (!("intent" in json) || !json.intent) throw new Error(json.error || "Request failed");
      setRes(json);
      if (json.decision === "ready_to_sign" && json.unsignedTx && json.confirmRawText) {
        await signAndConfirm(json.unsignedTx, json.confirmRawText);
        return;
      }
      pushHistory(json);
      loadOnchain();
      balances.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Request failed");
    } finally {
      setLoading(false);
      sessionStorage.removeItem(inflightSlot);
    }
  }

  const firstUnresolvedIdx = res ? PIPELINE_ORDER.findIndex((s) => !res.trace.find((t) => t.step === s)) : 0;
  const steps = PIPELINE_ORDER.map((key, i) => {
    const t = res?.trace.find((x) => x.step === key);
    const state = !t?.status
      ? (loading && i === firstUnresolvedIdx ? "active" : "pending")
      : t.status === "ok" ? "ok" : t.status === "warn" ? "warn" : t.status === "blocked" ? "blocked" : "ok";
    return { key, label: STAGE_LABEL[key], state: state as "pending" | "active" | "ok" | "warn" | "blocked", detail: t?.detail };
  });

  return {
    wallet, balances, walletBusy, setWalletBusy,
    intent, setIntent, loading, res, info, swap, setSwap, err, health, history, onchain,
    loadOnchain, run, reset, steps,
  };
}
