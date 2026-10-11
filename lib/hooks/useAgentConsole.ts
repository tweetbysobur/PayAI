"use client";

import { useEffect, useState } from "react";
import { useWalletService as useWallet } from "@/lib/wallet-service/WalletServiceContext";
import { useWalletBalances } from "@/lib/hooks/useWalletBalances";
import { savePendingSettlement, getPendingSettlement, clearPendingSettlement, type PendingSettlement } from "@/lib/hooks/pendingSettlement";
import { useSync } from "@/lib/hooks/useSync";
// feeMath.ts is the pure, env-free half of the fee engine (see its own doc
// comment) — safe to import here. See lib/agent/types.ts's
// AgentResult.receipt doc comment for why the receipt itself must always
// come FROM the API response, never be recomputed here.
import type { Receipt } from "@/lib/payment/feeMath";

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
  // Interactive ERC-20 payments through PayAIForwarder are a two-step:
  // approve the EXACT amount first, then forward. Present only when the
  // current allowance is short (native MON and sufficient-allowance ERC-20
  // both omit it). See app/api/agent/route.ts.
  approvalTx?: { to: string; data: string; value?: string; from: string } | null;
  approvalLabel?: string | null;
  /** PayAI's fee, charged on top of the amount (see app/api/agent/route.ts). */
  platformFee?: { amount: string; total: string; token: string; percent: string } | null;
  /** The real receipt, computed server-side. Render this directly — never
   *  recompute a receipt client-side (see the import comment above). */
  receipt?: Receipt;
}
export interface Health {
  model: string;
  intentEngine: { engine: string };
  payment: { engine: string; connected: boolean; detail: string };
  // Deliberately excludes the agent wallet's address/balance — /api/health is
  // public and unauthenticated; only whether a signer is configured + the
  // active network are exposed.
  wallet: { configured: boolean; network: string; chainId: number } | null;
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
/**
 * What the AI Confirmation screen shows before a signature is ever
 * requested — Recipient / Token / Amount / Schedule / Execution Mode /
 * Estimated Fees — with Edit / Cancel / Confirm. Nothing gets signed until
 * the user explicitly confirms (see confirmSign() below); "Edit" just
 * cancels back to the input so the user can retype the request.
 */
export interface PendingConfirmation {
  unsignedTx: { to: string; data: string; value?: string; from: string };
  confirmRawText: string;
  requestId?: string;
  recipient: string | null;
  domain?: string | null;
  token: string;
  amount: number | null;
  network: string;
  // When set, this ERC-20 payment routes through PayAIForwarder and needs a
  // one-time exact-amount approval signed BEFORE the forward (see confirmSign).
  approvalTx?: { to: string; data: string; value?: string; from: string } | null;
  approvalLabel?: string | null;
  /** PayAI's fee on top of `amount`; null when none. */
  platformFee?: { amount: string; total: string; token: string; percent: string } | null;
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
  priceImpact: number | null;
}
export interface SwapPlanView { quote: SwapQuoteView; steps: SwapStep[]; summary: string }
/**
 * Where a swap actually is.
 *
 * "signing" covered everything from building the transaction to waiting for a
 * block, which meant a user watching a spinner had no idea whether their
 * wallet was about to ask them something, whether money had moved, or whether
 * it was safe to walk away. Each of these is a distinct thing to be waiting
 * for, and they fail differently.
 */
export type SwapPhase =
  | "ready"       // quoted, nothing signed
  | "preparing"   // building the transaction
  | "awaiting"    // the wallet is asking; nothing has moved
  | "submitting"  // signed and being broadcast
  | "confirming"  // on-chain, waiting for a block
  | "done"
  | "error";

export const SWAP_PHASE_LABEL: Record<SwapPhase, string> = {
  ready: "Review swap",
  preparing: "Preparing swap",
  awaiting: "Awaiting signature",
  submitting: "Submitting",
  confirming: "Confirming",
  done: "Completed",
  error: "Failed",
};

/** The ordered stages a swap passes through, for a progress readout. */
export const SWAP_STAGES: SwapPhase[] = ["preparing", "awaiting", "submitting", "confirming", "done"];

export interface SwapState {
  phase: SwapPhase;
  plan: SwapPlanView;
  provider?: string;
  stepIndex: number;
  txHash?: string;
  explorerUrl?: string;
  error?: string;
  /** True once a transaction has broadcast. A failure after this point is NOT
   *  safe to blindly retry — the swap may already have settled. */
  broadcast?: boolean;
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
  ready_to_sign: { label: "Awaiting your signature", tone: "neutral" },
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
export function friendlyError(message: string, noun: string = "Payment"): string {
  const m = message.toLowerCase();
  if (m.includes("user rejected") || m.includes("user denied") || (m.includes("denied") && m.includes("signature"))) {
    return `${noun} not sent — you canceled it in your wallet.`;
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
  const { sync } = useSync();
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
  // Non-null exactly when a wallet signature already broadcast a real transaction
  // but the app hasn't yet confirmed/recorded it — e.g. an RPC hiccup or the tab
  // closing between broadcast and confirm. Never treat this as a failed payment.
  const [pendingRecovery, setPendingRecovery] = useState<PendingSettlement | null>(null);
  const [recovering, setRecovering] = useState(false);
  // Set the moment the pipeline approves a payment but before any signature
  // is requested — the AI Confirmation screen renders from this and nothing
  // else. Cleared by confirmSign() (which then signs) or cancelConfirm().
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirmation | null>(null);

  function loadOnchain() {
    fetch("/api/onchain").then((r) => r.json()).then(setOnchain).catch(() => {});
  }
  useEffect(() => {
    fetch("/api/health").then((r) => r.json()).then(setHealth).catch(() => {});
    loadOnchain();
  }, []);

  // On mount (and whenever the connected wallet changes), silently try to
  // finish confirming any settlement that broadcast but never got recorded.
  useEffect(() => {
    const pending = getPendingSettlement(wallet.address);
    if (!pending) { setPendingRecovery(null); return; }
    setPendingRecovery(pending);
    void confirmPending(pending, { silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet.address]);

  /** Re-attempt confirming a broadcast tx we never finished recording. Safe to
   *  call repeatedly — /api/agent/confirm and /api/swap/confirm are both
   *  idempotent on txHash, so this can never double-record or double-charge. */
  async function confirmPending(pending: PendingSettlement, opts: { silent?: boolean } = {}) {
    setRecovering(true);
    try {
      if (pending.kind === "payment") {
        const r = await fetch("/api/agent/confirm", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ rawText: pending.rawText, walletAddress: pending.walletAddress, txHash: pending.txHash, requestId: pending.requestId }),
        });
        const json = (await r.json()) as AgentResult & { error?: string; reverted?: boolean };
        if (!json.intent) {
          if (json.reverted) {
            // Definitely mined and definitely failed on-chain — this is a real,
            // final outcome (gas spent, no funds moved), not "try again later".
            // Safe to clear the pending record; the user can retry fresh.
            clearPendingSettlement(pending.txHash);
            // More than one broadcast may be waiting: bring the next into view and
            // work on it too (each record is cleared only by its own outcome).
            const next = getPendingSettlement(wallet.address);
            setPendingRecovery(next);
            if (next) void confirmPending(next, { silent: true });
            setErr(json.error || "This payment failed on-chain. No funds were transferred.");
            return;
          }
          // Not confirmable yet (e.g. not mined) or genuinely doesn't match —
          // keep the pending record so the user (or the next mount) can retry.
          if (!opts.silent) setErr(friendlyError(json.error || "Could not confirm the payment yet."));
          return;
        }
        clearPendingSettlement(pending.txHash);
        // More than one broadcast may be waiting: bring the next into view and
        // work on it too (each record is cleared only by its own outcome).
        const next = getPendingSettlement(wallet.address);
        setPendingRecovery(next);
        if (next) void confirmPending(next, { silent: true });
        setRes(json);
        pushHistory(json);
        loadOnchain();
        balances.refresh();
      } else {
        const r = await fetch("/api/swap/confirm", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            walletAddress: pending.walletAddress, txHash: pending.txHash,
            fromToken: pending.fromToken, toToken: pending.toToken, amountIn: pending.amountIn, amountOut: pending.amountOut,
          }),
        });
        const cj = (await r.json()) as { explorerUrl?: string; error?: string; success?: boolean; reverted?: boolean };
        if (!cj.success) {
          if (cj.reverted) {
            // Definite, mined revert — gas spent, no tokens moved. A real final
            // outcome, safe to clear and let the user try a fresh swap.
            clearPendingSettlement(pending.txHash);
            // More than one broadcast may be waiting: bring the next into view and
            // work on it too (each record is cleared only by its own outcome).
            const next = getPendingSettlement(wallet.address);
            setPendingRecovery(next);
            if (next) void confirmPending(next, { silent: true });
            setErr(cj.error || "This swap failed on-chain. No tokens were swapped.");
            return;
          }
          if (!opts.silent) setErr(friendlyError(cj.error || "Could not confirm the swap yet."));
          return;
        }
        clearPendingSettlement(pending.txHash);
        // More than one broadcast may be waiting: bring the next into view and
        // work on it too (each record is cleared only by its own outcome).
        const next = getPendingSettlement(wallet.address);
        setPendingRecovery(next);
        if (next) void confirmPending(next, { silent: true });
        loadOnchain();
        balances.refresh();
      }
    } catch {
      if (!opts.silent) setErr("Still couldn't reach Monad to confirm. Your transaction is safe — try again shortly.");
    } finally {
      setRecovering(false);
    }
  }

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

  /**
   * Signs and settles. The return value says how far it got, which matters
   * because the two failure modes are opposites: a signature that was never
   * given (declined passkey, not enough gas) is safe to offer again, while
   * one that broadcast must never be re-offered — that is how someone pays
   * twice.
   */
  async function signAndConfirm(
    unsignedTx: { to: string; data: string; value?: string; from: string },
    confirmRawText: string,
    requestId?: string,
    approvalTx?: { to: string; data: string; value?: string; from: string } | null,
  ): Promise<"settled" | "broadcast" | "not-sent"> {
    setWalletBusy(true);
    let broadcastHash: string | null = null;
    try {
      // Interactive ERC-20 through the forwarder is a two-step: approve the
      // EXACT amount first, then forward. This runs BEFORE the payment is
      // broadcast, so a declined or reverted approval moves no funds and is
      // always safe to retry — only after it confirms do we sign the payment.
      // (Native MON and sufficient-allowance ERC-20 send no approvalTx.)
      if (approvalTx) {
        const approvalHash = await wallet.sendTransaction(approvalTx);
        const approvalReceipt = await wallet.waitForReceipt(approvalHash);
        if ((approvalReceipt as { status?: string })?.status === "reverted") {
          setErr("The token approval failed on-chain. No funds were transferred — you can safely try again.");
          return "not-sent";
        }
      }
      const hash = await wallet.sendTransaction(unsignedTx);
      broadcastHash = hash;
      // The wallet has now broadcast a REAL transaction — persist immediately,
      // before anything else can fail. If the tab closes or a request times out
      // from this point on, the next load recovers this instead of losing it.
      const pending: PendingSettlement = { kind: "payment", walletAddress: unsignedTx.from, txHash: hash, rawText: confirmRawText, requestId, savedAt: Date.now() };
      savePendingSettlement(pending);
      setPendingRecovery(pending);

      await wallet.waitForReceipt(hash);
      const r = await fetch("/api/agent/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rawText: confirmRawText, walletAddress: unsignedTx.from, txHash: hash, requestId }),
      });
      const json = (await r.json()) as AgentResult & { error?: string; reverted?: boolean };
      if (!json.intent) {
        if (json.reverted) {
          // Definite, mined revert — a real final outcome (gas spent, no funds
          // moved), not "unconfirmed". Safe to clear and let the user retry.
          clearPendingSettlement(hash);
          setPendingRecovery(getPendingSettlement(wallet.address));
          setErr(json.error || "This payment failed on-chain. No funds were transferred.");
          return "broadcast";
        }
        throw new Error(json.error || "Could not confirm the payment.");
      }
      clearPendingSettlement(hash);
      setPendingRecovery(getPendingSettlement(wallet.address));
      setRes(json);
      pushHistory(json);
      loadOnchain();
      void sync();
      return "settled";
    } catch (e) {
      if (broadcastHash) {
        // The transaction was signed and broadcast — funds may already have
        // moved. Never say "failed" here: that invites a user to resend and
        // genuinely pay twice. The pending record survives for auto-recovery.
        setErr(`Your payment was sent (${broadcastHash.slice(0, 10)}…) but we couldn't confirm it yet. Do not resend — we'll keep checking, or tap Retry.`);
        return "broadcast";
      }
      setErr(e instanceof Error ? e.message : "Wallet payment failed.");
      return "not-sent";
    } finally {
      setWalletBusy(false);
    }
  }

  /** Manually re-attempt whatever settlement is pending (the retry button
   *  shown alongside the "we couldn't confirm it yet" message). */
  function retryPendingConfirm() {
    if (!pendingRecovery) return;
    setErr(null);
    void confirmPending(pendingRecovery);
  }

  /** Sign the swap's steps in order (approval first when present), verify the
   *  final tx on-chain, then refresh balances. Non-custodial — the wallet signs. */
  async function executeSwap(plan: SwapPlanView, provider?: string) {
    setSwap({ phase: "preparing", plan, provider, stepIndex: 0 });
    let lastHash = "";
    try {
      for (let i = 0; i < plan.steps.length; i++) {
        // "Awaiting signature" is its own stage because it is the only one
        // where the user has something to do, and the only one where nothing
        // has happened yet if they walk away.
        setSwap((s) => (s ? { ...s, stepIndex: i, phase: "awaiting" } : s));
        lastHash = await wallet.sendTransaction(plan.steps[i].tx);
        setSwap((s) => (s ? { ...s, phase: "submitting", txHash: lastHash, broadcast: true } : s));
        // Persist after EVERY broadcast step, not just the last: an approval
        // step broadcasting then the swap step failing still leaves the swap
        // itself unswapped, but if the final swap tx broadcasts and only the
        // confirm call afterward fails, this is what recovers it.
        if (i === plan.steps.length - 1 && wallet.address) {
          const pending: PendingSettlement = {
            kind: "swap", walletAddress: wallet.address, txHash: lastHash,
            fromToken: plan.quote.fromToken, toToken: plan.quote.toToken,
            amountIn: plan.quote.amountIn, amountOut: plan.quote.amountOut, savedAt: Date.now(),
          };
          savePendingSettlement(pending);
          setPendingRecovery(pending);
        }
        setSwap((s) => (s ? { ...s, phase: "confirming" } : s));
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
      const cj = (await r.json()) as { explorerUrl?: string; error?: string; success?: boolean; reverted?: boolean };
      if (!cj.success) {
        if (cj.reverted) {
          // Definite, mined revert — gas spent, no tokens moved. A real final
          // outcome; safe to clear the pending record and let the user retry.
          clearPendingSettlement(lastHash);
          setPendingRecovery(getPendingSettlement(wallet.address));
          setSwap((s) => (s ? { ...s, phase: "error", error: cj.error || "This swap failed on-chain. No tokens were swapped." } : s));
          return;
        }
        throw new Error(cj.error || "The swap could not be confirmed.");
      }
      clearPendingSettlement(lastHash);
      setPendingRecovery(getPendingSettlement(wallet.address));
      setSwap((s) => (s ? { ...s, phase: "done", txHash: lastHash, explorerUrl: cj.explorerUrl } : s));
      loadOnchain();
      // The whole dashboard, not just this hook's balances: a swap changes the
      // portfolio, the activity feed and the notification bell too, and the
      // user should never have to reload to see any of it. Everything that
      // registered a refresher updates itself — see lib/hooks/useSync.tsx.
      void sync();
    } catch (e) {
      const msg = lastHash
        ? `Your swap transaction was sent (${lastHash.slice(0, 10)}…) but we couldn't confirm it yet. Do not resend — we'll keep checking, or tap Retry.`
        : friendlyError(e instanceof Error ? e.message : "Swap failed.");
      setSwap((s) => (s ? { ...s, phase: "error", error: msg } : s));
    }
  }

  /**
   * Re-run a swap that never reached the chain. Deliberately refuses once a
   * transaction has broadcast: at that point the swap may already have
   * settled, and re-signing is how someone swaps twice.
   */
  function retrySwap() {
    // Read from state directly. Reaching for the current value inside a
    // setState updater looks tidier, but an updater must be pure: React calls
    // it twice under Strict Mode, which would have fired a second swap from a
    // single tap on Retry.
    if (!swap || swap.broadcast) return;
    void executeSwap(swap.plan, swap.provider);
  }

  /** Clear everything back to the idle prompt — used after a command finishes
   *  so the bar returns to its start state instead of holding the old result. */
  function reset() {
    setIntent(""); setRes(null); setInfo(null); setSwap(null); setErr(null); setLoading(false); setPendingConfirm(null);
  }

  /** "Cancel" (or "Edit") on the AI Confirmation screen — no signature was ever
   *  requested, so there's nothing to undo, just clear back to idle. */
  function cancelConfirm() {
    setPendingConfirm(null);
    setRes(null);
  }

  /**
   * "Confirm" on the AI Confirmation screen — the ONLY path that reaches
   * signAndConfirm(), i.e. the only place a signature is ever requested.
   *
   * A PayAI Wallet asks for a passkey at this point, and declining it is a
   * normal thing to do. If nothing was sent, the confirmation comes back so
   * the user can approve again instead of retyping the whole payment. It is
   * deliberately NOT restored once a transaction has broadcast — re-offering
   * Confirm there is how someone ends up paying twice.
   */
  async function confirmSign() {
    if (!pendingConfirm) return;
    const pending = pendingConfirm;
    setPendingConfirm(null);
    const outcome = await signAndConfirm(pending.unsignedTx, pending.confirmRawText, pending.requestId, pending.approvalTx);
    if (outcome === "not-sent") setPendingConfirm(pending);
  }

  /** "Cancel" on the swap review card — nothing has been signed yet (the
   *  quote is display-only until this point), so there's nothing to undo. */
  function cancelSwapConfirm() {
    setSwap(null);
  }

  /**
   * "Confirm" on the swap review card — the ONLY path from a quoted swap
   * (SwapPhase "ready") into executeSwap(), mirroring confirmSign() for
   * payments: quote -> slippage/minOut/price-impact already computed and
   * shown -> explicit user confirmation -> only THEN does a wallet signature
   * get requested.
   */
  function confirmSwap() {
    if (!swap || swap.phase !== "ready") return;
    void executeSwap(swap.plan, swap.provider);
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
      if (decision === "schedule_error") {
        setErr(json.error || "Couldn't create the automation.");
        return;
      }
      if (decision === "automation_prefill") {
        // The AI never creates a Payment Automation on its own — it hands the
        // fully-resolved fields to the real dashboard creator, which still
        // requires one wallet signature before anything goes live. Stash the
        // draft and send the user there instead of faking a "done" state here.
        const prefill = (json as { prefill?: unknown }).prefill;
        if (prefill && typeof window !== "undefined") {
          sessionStorage.setItem("payai_automation_prefill", JSON.stringify(prefill));
          window.location.href = "/dashboard/automations";
        }
        return;
      }
      if (decision === "swap_ready" && json.swap) {
        setLoading(false);
        // Quote, slippage, minimum output and price impact are already
        // computed and shown here — nothing is signed until the user
        // explicitly hits Confirm (confirmSwap()), same gate the payment
        // pipeline uses for pendingConfirm/confirmSign.
        setSwap({ phase: "ready", plan: json.swap, provider: json.provider, stepIndex: 0 });
        return;
      }
      if (!("intent" in json) || !json.intent) throw new Error(json.error || "Request failed");
      setRes(json);
      if (json.decision === "ready_to_sign" && json.unsignedTx && json.confirmRawText) {
        // AI CONFIRMATION: show Recipient/Token/Amount/Schedule/Execution
        // Mode/Fees and require an explicit Confirm — signAndConfirm() (the
        // only place that requests a wallet signature) is never called from
        // here directly.
        setPendingConfirm({
          unsignedTx: json.unsignedTx,
          confirmRawText: json.confirmRawText,
          requestId: (json as { requestId?: string }).requestId,
          recipient: json.intent.recipient,
          domain: json.intent.domain,
          token: json.intent.token,
          amount: json.intent.amount,
          network: json.intent.network,
          approvalTx: json.approvalTx ?? null,
          approvalLabel: json.approvalLabel ?? null,
          platformFee: json.platformFee ?? null,
        });
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
    // Recovery for a signed-and-broadcast transaction whose confirm step never
    // completed — never treat this as a failed payment. See lib/hooks/pendingSettlement.ts.
    pendingRecovery, recovering, retryPendingConfirm,
    // AI Confirmation screen — see PendingConfirmation above.
    pendingConfirm, confirmSign, cancelConfirm,
    retrySwap, confirmSwap, cancelSwapConfirm,
  };
}
