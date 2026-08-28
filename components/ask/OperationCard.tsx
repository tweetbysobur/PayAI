"use client";

import { useEffect, useState } from "react";
import { motion } from "motion/react";
import Link from "next/link";
import {
  Send, Clock3, Repeat, ArrowLeftRight, Users, Wallet, Search,
  CheckCircle2, XCircle, Loader2, ExternalLink, Fingerprint, ArrowUpRight, ArrowDownRight,
  Coins, ShieldCheck, TrendingUp, AlertTriangle, Lock, RefreshCw,
} from "lucide-react";
import { TokenLogo } from "@/components/TokenLogo";
import {
  FREQUENCY_LABEL, NETWORK_LABEL, WALLET_OP_LABEL,
  type Operation, type OperationError, type OperationStatus, type WalletTransactionView,
} from "@/lib/ask/types";

/**
 * OperationCard — the one place a blockchain action is ever shown. Renders
 * from a typed `Operation`, never from a string the model wrote — this is
 * the enforcement point for the safety model described in lib/ask/types.ts:
 * every field is present-and-typed before this ever mounts, and every state
 * transition (preview -> ready -> confirming -> success/error) happens only
 * in response to a real click passed in via the on* callbacks, never on a
 * timer or on mount.
 *
 * `onAdvance`/`onCancel` are owned by the caller (the workspace page), which
 * is where the eventual real signing/execution call will live — this
 * component only ever asks for the next step, it never performs one.
 */

const short = (s: string) => (s.length > 14 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s);

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return iso;
  }
}

/** "Updated Xs/Xm ago" for a market-data snapshot — makes a short-lived
 *  cache hit honest rather than implying every render just hit the chain. */
function agoLabel(at: number): string {
  const secs = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  return `${Math.round(secs / 60)}m ago`;
}

/** Nad.Fun status labels, matching the task brief's own wording exactly —
 *  never fabricated, straight from lib/monad/nadfun's getNadFunStatus. */
const NADFUN_STATUS_LABEL: Record<string, string> = {
  bonding_curve: "Bonding Curve",
  graduated: "Graduated",
  locked: "Locked",
  unsupported: "No active route",
};
const NADFUN_STATUS_TONE: Record<string, string> = {
  bonding_curve: "border-primary/30 bg-primary/10 text-primary-ink",
  graduated: "border-success/30 bg-success/10 text-success",
  locked: "border-warning/30 bg-warning/10 text-warning",
  unsupported: "border-border bg-input text-muted-foreground",
};

const KIND_META: Record<Operation["intent"]["kind"], { icon: typeof Send; title: string }> = {
  payment: { icon: Send, title: "Payment" },
  scheduled_payment: { icon: Clock3, title: "Scheduled Payment" },
  recurring_payment: { icon: Repeat, title: "Recurring Payment" },
  swap: { icon: ArrowLeftRight, title: "Swap" },
  distribution: { icon: Users, title: "Distribution" },
  wallet_operation: { icon: Wallet, title: "" }, // overridden per-operation below
  token_intelligence: { icon: Coins, title: "Token Info" },
  trade_preview: { icon: TrendingUp, title: "Trade Preview" },
};

/** What "Review ___" should say — a swap isn't a payment, a distribution
 *  isn't either, so the one generic label from the spec's payment example
 *  doesn't fit every card. wallet_operation never reaches this (see isInfo). */
const REVIEW_NOUN: Record<Operation["intent"]["kind"], string> = {
  payment: "payment",
  scheduled_payment: "payment",
  recurring_payment: "automation",
  swap: "swap",
  distribution: "distribution",
  wallet_operation: "",
  token_intelligence: "",
  trade_preview: "trade",
};

const STATUS_CHIP: Record<OperationStatus, { label: string; tone: string }> = {
  preview: { label: "Preview", tone: "border-border bg-input text-muted-foreground" },
  ready: { label: "Ready to approve", tone: "border-primary bg-primary text-primary-foreground" },
  // "Executing"/"Verified" name the intent → plan → review → approve → execute
  // → verify flow the product is built around. "Verified" is honest for every
  // success state here: the card only ever reaches it with a confirmed
  // on-chain transaction hash, which is the verification.
  confirming: { label: "Executing", tone: "border-primary/30 bg-primary/10 text-primary-ink" },
  success: { label: "Verified", tone: "border-success/30 bg-success/10 text-success" },
  error: { label: "Failed", tone: "border-danger/30 bg-danger/10 text-danger" },
};

/** The execution lifecycle as four legible steps, derived ONLY from state
 *  that has actually occurred — never a timer, never ahead of the real
 *  progress. `phase` is computed by the caller from the live
 *  progressLabel/status:
 *    0 = request sent to the wallet, awaiting your signature (nothing signed)
 *    2 = signed, broadcast, confirming on-chain
 *    3 = confirmed on-chain — the success state, where we hold the tx hash
 *  Each step is "done" once `phase` reaches its `doneAt`; the single "active"
 *  step is the first not-yet-done one (only while still executing). "Signed"
 *  becomes done at phase 2 because the execution layer reports the signature
 *  through the same "confirming on-chain" update — we never mark "Signed"
 *  complete before there is evidence the signature happened. "Verified" is
 *  reached only at phase 3, when a confirmed transaction hash exists. */
const EXEC_STEPS = [
  { label: "Request", doneAt: 0 },
  { label: "Signed", doneAt: 2 },
  { label: "On-chain", doneAt: 3 },
  { label: "Verified", doneAt: 3 },
] as const;

function ExecutionSteps({ phase }: { phase: number }) {
  const firstPending = EXEC_STEPS.findIndex((s) => phase < s.doneAt);
  const activeLabel = firstPending === -1 ? "complete" : EXEC_STEPS[firstPending].label;
  return (
    <div className="flex items-center gap-1" aria-label={`Execution progress: ${activeLabel}`}>
      {EXEC_STEPS.map((s, i) => {
        const done = phase >= s.doneAt;
        const active = i === firstPending && phase < 3;
        return (
          <div key={s.label} className="flex items-center gap-1">
            <span className="flex items-center gap-1">
              {done ? (
                <CheckCircle2 size={12} className="shrink-0 text-primary-ink" />
              ) : active ? (
                <Loader2 size={12} className="shrink-0 animate-spin text-primary-ink" />
              ) : (
                <span className="h-[7px] w-[7px] shrink-0 rounded-full border border-border" />
              )}
              <span className={`text-[10px] font-medium ${done || active ? "text-foreground" : "text-muted-foreground/60"}`}>{s.label}</span>
            </span>
            {i < EXEC_STEPS.length - 1 && <span className={`h-px w-3 ${done ? "bg-primary/40" : "bg-border"}`} />}
          </div>
        );
      })}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right text-sm font-medium text-foreground">{children}</span>
    </div>
  );
}

export function OperationCard({
  operation,
  onAdvance,
  onCancel,
  onRetry,
  onQuickAction,
  progressLabel,
}: {
  operation: Operation;
  /** Called when the user takes the card's primary action for its current
   *  status (Review -> Confirm -> [real signature happens in the caller]). */
  onAdvance: (operationId: string) => void;
  onCancel?: (operationId: string) => void;
  /** "Try again" on a failed card — only rendered when provided. Re-running
   *  the request from scratch (not resending a stale signed artifact) is the
   *  caller's job; this only signals the click. */
  onRetry?: (operationId: string) => void;
  /** Sends a follow-up message as if the user had typed it — the same
   *  `send()` the empty-state capability tiles already use. Powers the
   *  Buy/Sell/Refresh quick actions on a token intelligence card so a user
   *  who just pasted a fresh CA can act without typing anything (TG-bot
   *  style). Never builds or signs a transaction directly — it only ever
   *  re-enters the normal classify -> confirm funnel. */
  onQuickAction?: (text: string) => void;
  /** What's actually happening right now during "confirming" — signature
   *  requested vs. signed-and-broadcasting vs. on-chain confirmation vs.
   *  finalizing. Undefined falls back to a generic "waiting for signature"
   *  message so a card never regresses to blank if the caller doesn't wire
   *  this up. See useAskChat's `progress` map for where this comes from. */
  progressLabel?: string;
}) {
  const { intent, status } = operation;
  const meta = KIND_META[intent.kind];
  const Icon = meta.icon;
  const title = intent.kind === "wallet_operation" ? WALLET_OP_LABEL[intent.operation] : meta.title;
  // Info surfaces (balance, history, an explainer, a token lookup) never
  // moved money, so "Sent"/"Preview"/etc. from the real confirm funnel would
  // misdescribe them — they get their own neutral label. A trade preview is
  // "info" too, but only until a wallet is connected: `execution` is only
  // ever attached once there's a real signer to build against (see
  // orchestrate.ts's tradePreviewCard) — once it's there, this card is a
  // real confirm-funnel card like payment/swap, not an info surface.
  const isInfo = intent.kind === "wallet_operation" || intent.kind === "token_intelligence" || (intent.kind === "trade_preview" && !intent.execution);
  // A created automation isn't a settled single transaction — it's a live
  // schedule — so it gets its own "Active" chip rather than the confirm
  // funnel's "Verified".
  const chip = operation.automation && status === "success"
    ? { label: "Active", tone: "border-success/30 bg-success/10 text-success" }
    : intent.kind === "trade_preview" && isInfo
    ? { label: "Pre-execution", tone: "border-warning/30 bg-warning/10 text-warning" }
    : isInfo ? { label: "Live", tone: "border-border bg-input text-muted-foreground" } : STATUS_CHIP[status];

  return (
    <motion.div
      initial={{ opacity: 0, y: 8, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.25, ease: "easeOut" }}
      className="w-full max-w-md overflow-hidden rounded-2xl border border-border bg-panel shadow-sm"
    >
      <div className="flex items-center gap-2.5 border-b border-border/70 px-4 py-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary-ink">
          <Icon size={15} />
        </span>
        <p className="flex-1 text-sm font-semibold text-foreground">{title}</p>
        <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium ${chip.tone}`}>{chip.label}</span>
      </div>

      <div className="px-4 py-3">
        {status === "error" && operation.error ? (
          <ErrorBody error={operation.error} />
        ) : status === "success" && operation.automation ? (
          <AutomationCreatedBody automation={operation.automation} />
        ) : status === "success" && operation.result && !isInfo ? (
          <SuccessBody intent={intent} result={operation.result} />
        ) : (
          <IntentBody intent={intent} onQuickAction={onQuickAction} />
        )}
      </div>

      {!isInfo && status !== "error" && (
        <CardFooter operation={operation} onAdvance={onAdvance} onCancel={onCancel} progressLabel={progressLabel} />
      )}
      {status === "error" && onRetry && (
        <div className="flex border-t border-border/70 px-4 py-3">
          <button
            onClick={() => onRetry(operation.id)}
            className="flex-1 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground transition hover:opacity-90"
          >
            Try again
          </button>
        </div>
      )}
    </motion.div>
  );
}

function IntentBody({ intent, onQuickAction }: { intent: Operation["intent"]; onQuickAction?: (text: string) => void }) {
  switch (intent.kind) {
    case "payment":
    case "scheduled_payment":
      return (
        <>
          <div className="mb-2.5 flex items-center gap-2">
            <TokenLogo token={intent.token} size={22} />
            <span className="text-xl font-semibold tracking-tight text-foreground [font-variant-numeric:tabular-nums] sm:text-2xl">{intent.amount}</span>
            <span className="text-sm font-medium text-muted-foreground">{intent.token}</span>
          </div>
          <div className="divide-y divide-border/60">
            <Row label="Recipient">
              {intent.recipientDomain ? (
                <span className="text-primary-ink">{intent.recipientDomain}</span>
              ) : (
                <span className="font-mono">{short(intent.recipient)}</span>
              )}
            </Row>
            {intent.kind === "scheduled_payment" && <Row label="Runs on">{fmtDate(intent.startDate)}</Row>}
            <Row label="Network">{NETWORK_LABEL[intent.network]}</Row>
            {intent.estimatedFee && <Row label="Estimated network fee">{intent.estimatedFee}</Row>}
          </div>
        </>
      );
    case "recurring_payment":
      return (
        <>
          <div className="mb-2.5 flex items-center gap-2">
            <TokenLogo token={intent.token} size={22} />
            <span className="text-xl font-semibold tracking-tight text-foreground [font-variant-numeric:tabular-nums] sm:text-2xl">{intent.amount}</span>
            <span className="text-sm font-medium text-muted-foreground">{intent.token}</span>
            <span className="text-xs text-muted-foreground">/ {FREQUENCY_LABEL[intent.frequency].toLowerCase()}</span>
          </div>
          <div className="divide-y divide-border/60">
            <Row label="Recipient">
              {intent.recipientDomain ? <span className="text-primary-ink">{intent.recipientDomain}</span> : <span className="font-mono">{short(intent.recipient)}</span>}
            </Row>
            <Row label="Frequency">{FREQUENCY_LABEL[intent.frequency]}</Row>
            <Row label="Starts">{fmtDate(intent.startDate)}</Row>
            <Row label="Ends">{intent.endDate ? fmtDate(intent.endDate) : "Until cancelled"}</Row>
            <Row label="Network">{NETWORK_LABEL[intent.network]}</Row>
          </div>
        </>
      );
    case "swap":
      return (
        <>
          <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-input/30 px-3 py-3">
            <div className="text-center">
              <p className="flex items-center justify-center gap-1.5 text-base font-semibold tracking-tight text-foreground sm:text-lg">
                <TokenLogo token={intent.fromToken} size={18} /> {intent.fromAmount}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">{intent.fromToken}</p>
            </div>
            <ArrowLeftRight size={15} className="shrink-0 text-muted-foreground" />
            <div className="text-center">
              <p className="flex items-center justify-center gap-1.5 text-base font-semibold tracking-tight text-foreground sm:text-lg">
                <TokenLogo token={intent.toToken} size={18} /> ≈ {intent.toAmountEstimate ?? "—"}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">{intent.toToken}</p>
            </div>
          </div>
          <div className="mt-1 divide-y divide-border/60">
            {intent.slippage && <Row label="Max slippage">{intent.slippage}</Row>}
            <Row label="Network">{NETWORK_LABEL[intent.network]}</Row>
          </div>
        </>
      );
    case "distribution":
      return (
        <>
          <div className="mb-2.5 flex items-center gap-2">
            <TokenLogo token={intent.token} size={22} />
            <span className="text-xl font-semibold tracking-tight text-foreground [font-variant-numeric:tabular-nums] sm:text-2xl">{intent.totalAmount}</span>
            <span className="text-sm font-medium text-muted-foreground">{intent.token}</span>
          </div>
          <div className="divide-y divide-border/60">
            <Row label="Recipients">{intent.recipientCount.toLocaleString()}</Row>
            {intent.amountPerRecipient && <Row label="Per recipient">{intent.amountPerRecipient} {intent.token}</Row>}
            <Row label="Network">{NETWORK_LABEL[intent.network]}</Row>
          </div>
        </>
      );
    case "wallet_operation":
      return <WalletOperationBody intent={intent} />;
    case "token_intelligence":
      return <TokenIntelligenceBody intent={intent} onQuickAction={onQuickAction} />;
    case "trade_preview":
      return <TradePreviewBody intent={intent} />;
  }
}

const TX_STATUS_META: Record<WalletTransactionView["status"], { icon: typeof CheckCircle2; tone: string; label: string }> = {
  success: { icon: CheckCircle2, tone: "bg-success/12 text-success", label: "Success" },
  pending: { icon: Loader2, tone: "bg-warning/12 text-warning", label: "Pending" },
  failed: { icon: XCircle, tone: "bg-danger/12 text-danger", label: "Failed" },
};

/** Read-only info surfaces — no signature, no funds movement, so these
 *  render their answer directly rather than entering the confirm funnel.
 *  Every value here comes from the intent's own fields, populated by the
 *  orchestrator from real API data — this component never fills a gap with
 *  a placeholder number. */
function WalletOperationBody({ intent }: { intent: Extract<Operation["intent"], { kind: "wallet_operation" }> }) {
  if (intent.operation === "balance") {
    const rows = intent.balances ?? [];
    if (rows.length === 0) return <p className="text-sm text-muted-foreground">No balance data available.</p>;
    return (
      <div>
        <div className="grid grid-cols-2 gap-2.5">
          {rows.map((b) => (
            <div key={b.token} className="rounded-lg border border-border bg-input/30 px-3 py-2.5">
              <div className="flex items-center gap-1.5"><TokenLogo token={b.token} size={15} /><span className="text-xs text-muted-foreground">{b.token}</span></div>
              <p className="mt-1 text-base font-semibold tabular-nums text-foreground sm:text-lg">{b.amount}</p>
            </div>
          ))}
        </div>
        {intent.totalValueUsd && (
          <p className="mt-2.5 text-xs text-muted-foreground">≈ ${intent.totalValueUsd} total (approximate)</p>
        )}
      </div>
    );
  }
  if (intent.operation === "recent_payments") {
    const rows = intent.payments ?? [];
    if (rows.length === 0) return <p className="text-sm text-muted-foreground">No recorded transactions yet.</p>;
    return (
      <div className="divide-y divide-border/60">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center justify-between py-1.5 text-sm">
            <span className="min-w-0 truncate text-foreground">
              {r.outputToken ? `${r.token} → ${r.outputToken}${r.provider ? ` · ${r.provider}` : ""}` : r.to}
            </span>
            <span className="shrink-0 text-muted-foreground">
              {r.outputAmount ? `${r.amount} → ${r.outputAmount} ${r.outputToken}` : `${r.amount} ${r.token}`} · {r.when}
            </span>
          </div>
        ))}
        <div className="pt-2">
          <Link href="/dashboard/transactions" className="inline-flex items-center gap-1 text-xs font-medium text-primary-ink hover:underline">
            View all transactions <ExternalLink size={10} />
          </Link>
        </div>
      </div>
    );
  }
  // "transaction" — a single resolved transaction (status or details request)
  const t = intent.transaction;
  if (!t) return <p className="text-sm text-muted-foreground">No transaction data available.</p>;
  const meta = TX_STATUS_META[t.status];
  const StatusIcon = meta.icon;
  return (
    <div>
      <div className="mb-3 flex items-center gap-2.5">
        <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${meta.tone}`}>
          <StatusIcon size={16} className={t.status === "pending" ? "animate-spin" : undefined} />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">
            {t.type} · {t.amount} {t.asset}{t.outputAmount ? ` → ${t.outputAmount} ${t.outputToken}` : ""}
          </p>
          <p className="text-xs text-muted-foreground">{t.timestamp}</p>
        </div>
      </div>
      <div className="divide-y divide-border/60">
        {t.outputToken ? (
          <>
            <Row label="Route">{t.asset} → {t.outputToken}</Row>
            {t.provider && <Row label="DEX">{t.provider}</Row>}
          </>
        ) : (
          <>
            <Row label="From">{short(t.sender)}</Row>
            <Row label="To">{short(t.recipient)}</Row>
          </>
        )}
        <Row label="Status">{meta.label}</Row>
      </div>
      {t.txHash && t.explorerUrl && (
        <a href={t.explorerUrl} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 font-mono text-xs text-primary-ink hover:underline">
          {short(t.txHash)} <ExternalLink size={11} />
        </a>
      )}
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-input/30 px-3 py-2">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="mt-0.5 truncate text-sm font-medium tabular-nums text-foreground">{value}</p>
    </div>
  );
}

const UNAVAILABLE = "Unavailable";

/** Human-readable labels for lib/monad/tokenIntelligence's descriptive
 *  signal tags — never a verdict ("scam"/"safe"), just what was observed. */
const SIGNAL_LABEL: Record<string, string> = {
  no_liquidity: "No liquidity found",
  no_route: "No trade route found",
  quote_unavailable: "Price unavailable",
  high_price_impact: "High price impact",
  very_low_liquidity: "Very low liquidity",
  unsupported_trading_pair: "Some pairs unsupported",
};

/** Read-only lookup of an arbitrary Monad address — populated entirely from
 *  lib/monad/tokenIntelligence's real on-chain reads (see
 *  orchestrate.ts's dispatchTokenLookup). Never a confirm funnel: there's
 *  nothing to sign here, just information. */
function TokenIntelligenceBody({
  intent,
  onQuickAction,
}: {
  intent: Extract<Operation["intent"], { kind: "token_intelligence" }>;
  onQuickAction?: (text: string) => void;
}) {
  if (intent.status === "wallet") {
    return <p className="text-sm text-muted-foreground">This address is a wallet address, not a token contract.</p>;
  }
  if (intent.status === "unknown_contract") {
    return <p className="text-sm text-muted-foreground">This is a contract on Monad, but I couldn&apos;t identify it as an ERC-20 token.</p>;
  }
  const d = intent.data;
  if (!d) return <p className="text-sm text-muted-foreground">No token data available.</p>;

  return (
    <div>
      <div className="mb-3 flex items-center gap-2.5">
        <TokenLogo token={d.symbol} size={34} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="truncate text-sm font-semibold text-foreground">{d.name}</p>
            {d.verified && <ShieldCheck size={13} className="shrink-0 text-primary-ink" aria-label="Verified" />}
          </div>
          <p className="truncate font-mono text-xs text-muted-foreground">{d.symbol} · {short(intent.address)}</p>
        </div>
        <span
          className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium ${
            d.isTradable ? "border-primary/30 bg-primary/10 text-primary-ink" : "border-border bg-input text-muted-foreground"
          }`}
        >
          {d.isTradable ? "Tradable" : "No route found"}
        </span>
      </div>

      {/* Quick actions — same idea as a Telegram trading bot's inline
          buttons: a fresh CA paste shouldn't require typing a follow-up.
          Each button only ever calls onQuickAction (== useAskChat's send()),
          the exact function the empty-state capability tiles already use —
          it re-enters the normal classify -> confirm funnel, never signs
          anything directly. Buy/Sell need a real route; Refresh re-runs
          this same lookup regardless. */}
      {onQuickAction && (
        <div className="mb-2.5 flex items-center gap-2">
          {d.isTradable && (
            <>
              <button
                type="button"
                onClick={() => onQuickAction("Buy this token")}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-success/30 bg-success/10 px-3 py-2 text-xs font-semibold text-success transition hover:bg-success/20"
              >
                <ArrowUpRight size={13} /> Buy
              </button>
              <button
                type="button"
                onClick={() => onQuickAction("Sell this token")}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-xs font-semibold text-danger transition hover:bg-danger/20"
              >
                <ArrowDownRight size={13} /> Sell
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => onQuickAction(intent.address)}
            aria-label="Refresh token info"
            className={`flex items-center justify-center gap-1.5 rounded-xl border border-border bg-input/30 px-3 py-2 text-xs font-medium text-muted-foreground transition hover:text-foreground ${d.isTradable ? "" : "flex-1"}`}
          >
            <RefreshCw size={13} /> Refresh
          </button>
        </div>
      )}

      {d.nadFun && (
        <div className="mb-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="rounded-full border border-border bg-input px-2 py-0.5 text-[11px] font-medium text-muted-foreground">Nad.Fun</span>
            <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${NADFUN_STATUS_TONE[d.nadFun.status]}`}>
              {NADFUN_STATUS_LABEL[d.nadFun.status]}
            </span>
            {d.nadFun.availableToBuy && (
              <span className="text-[11px] text-muted-foreground">{d.nadFun.availableToBuy} {d.symbol} left on curve</span>
            )}
          </div>
          {/* Progress only makes sense pre-graduation — a graduated token has
              no curve left to fill, so this row simply doesn't render for one
              (progressPct is null by construction; see tokenIntelligence.ts). */}
          {d.nadFun.progressPct != null && (
            <div className="mt-1.5">
              <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
                <span>Bonding Curve</span>
                <span className="tabular-nums text-foreground">{d.nadFun.progressPct.toFixed(2)}%</span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-input">
                <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, Math.max(0, d.nadFun.progressPct))}%` }} />
              </div>
            </div>
          )}
        </div>
      )}

      <div className="mb-2.5 rounded-xl border border-border bg-input/30 px-3 py-2.5">
        <div className="mb-0.5 flex items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">Price</p>
          <p className="text-[10px] text-muted-foreground">Updated {agoLabel(d.market.lastUpdated)}</p>
        </div>
        <p className="text-base font-semibold tabular-nums text-foreground sm:text-lg">
          {d.market.price ? `$${d.market.price}` : UNAVAILABLE}
          {d.market.priceMon && <span className="ml-1.5 text-xs font-normal text-muted-foreground">≈ {d.market.priceMon} MON</span>}
        </p>
        {/* A route can exist even when price is null (too thin to price
            honestly) — say so, rather than let "Unavailable" read as "not
            tradable" when the routes list right below says otherwise. */}
        {!d.market.price && d.isTradable && (
          <p className="mt-0.5 text-[11px] text-muted-foreground">Liquidity data unavailable, but a trading route was found.</p>
        )}
        {/* The mirror case: a real, indexed Nad.Fun pool (price and liquidity
            both real) that this app still couldn't find an executable route
            through — verified live against JAMES, where the Lens's own quote
            fails for a reason unrelated to this app. Without this, the price
            shown right above directly contradicts "No trade route found"
            below. */}
        {d.market.price && !d.isTradable && d.nadFun && (
          <p className="mt-0.5 text-[11px] text-muted-foreground">Price estimated from the Nad.Fun pool&apos;s own reserves — no executable trade route was found yet.</p>
        )}
      </div>

      {d.quote?.route && (
        <div className="mb-2.5 rounded-xl border border-primary/30 bg-primary/5 px-3 py-2.5">
          <p className="mb-0.5 text-xs text-muted-foreground">{d.quote.amount} {d.symbol} ≈</p>
          <p className="text-base font-semibold tabular-nums text-foreground">
            {d.quote.route.estimatedOutput} {d.quote.route.outputToken}
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">via {d.quote.route.provider}</span>
          </p>
        </div>
      )}
      {d.quote && !d.quote.route && (
        <div className="mb-2.5 rounded-xl border border-border bg-input/30 px-3 py-2.5">
          <p className="text-xs text-muted-foreground">No usable route to quote {d.quote.amount} {d.symbol} in {d.quote.quoteAsset}.</p>
        </div>
      )}

      <div className="mb-2.5 grid grid-cols-2 gap-2.5">
        <MiniStat label="Market Cap" value={d.market.marketCapUsd ? `$${d.market.marketCapUsd}` : UNAVAILABLE} />
        <MiniStat label="FDV" value={d.market.fdvUsd ? `$${d.market.fdvUsd}` : UNAVAILABLE} />
        <MiniStat
          label={d.market.liquidity?.label ?? "Liquidity"}
          value={d.market.liquidity ? (d.market.liquidity.usd ? `$${d.market.liquidity.usd}` : `${d.market.liquidity.mon} MON`) : UNAVAILABLE}
        />
        <MiniStat label="24h Change" value={d.market.priceChange24h ?? UNAVAILABLE} />
        <MiniStat label="24h Volume" value={d.market.volume24h ? `$${d.market.volume24h}` : UNAVAILABLE} />
        <MiniStat label="Total Supply" value={d.totalSupply ?? UNAVAILABLE} />
        {d.market.transactions24h != null && (
          <MiniStat
            label="24h Transactions"
            value={`${d.market.buys24h?.toLocaleString() ?? "—"} buys · ${d.market.sells24h?.toLocaleString() ?? "—"} sells`}
          />
        )}
      </div>

      {d.userBalance != null && (
        <div className="mb-2.5 rounded-lg border border-border bg-input/30 px-3 py-2">
          <p className="text-xs text-muted-foreground">Your balance</p>
          <p className="text-sm font-semibold tabular-nums text-foreground">{d.userBalance} {d.symbol}</p>
        </div>
      )}

      {d.market.routes.length > 0 && (
        <div className="mb-2.5">
          <p className="mb-1.5 text-xs text-muted-foreground">Trading routes</p>
          <div className="space-y-1.5">
            {d.market.routes.map((r, i) => (
              <div key={i} className="flex items-center justify-between gap-2 rounded-lg border border-border bg-input/30 px-3 py-2 text-xs">
                <span className="min-w-0 truncate font-medium text-foreground">{r.inputToken}/{r.outputToken}</span>
                <span className="shrink-0 text-muted-foreground">{r.provider}</span>
                <span className="shrink-0 tabular-nums text-foreground">≈ {r.estimatedOutput} {r.outputToken}</span>
                {r.priceImpact && <span className="shrink-0 text-muted-foreground">{r.priceImpact} impact</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {d.market.signals.length > 0 && (
        <div className="mb-2.5 flex flex-wrap gap-1.5">
          {d.market.signals.map((s) => (
            <span key={s} className="rounded-full border border-border bg-input px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              {SIGNAL_LABEL[s] ?? s.replace(/_/g, " ")}
            </span>
          ))}
        </div>
      )}

      <div className="divide-y divide-border/60">
        <Row label="Decimals">{d.decimals}</Row>
        <Row label="Network">Monad</Row>
        <Row label="Available markets">{d.market.quoteAssetsChecked.join(", ") || "None checked"}</Row>
        <Row label="Route">{d.market.routes.length > 0 ? Array.from(new Set(d.market.routes.map((r) => r.provider))).join(", ") : "No active route"}</Row>
        <Row label="Status">{d.isTradable ? "Tradable" : "Not tradable"}</Row>
        {/* Creator/pool/created only ever come from a Nad.Fun CurveCreate
            log (see tokenIntelligence.ts) -- absent, not "Unavailable", for
            every other token rather than implying a lookup was attempted
            and failed. */}
        {d.createdAt != null && <Row label="Created">{new Date(d.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</Row>}
        {d.creator && <Row label="Creator">{short(d.creator)}</Row>}
        {d.pool && <Row label="Pool">{short(d.pool)}</Row>}
      </div>

      <a href={d.explorerUrl} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs text-primary-ink hover:underline">
        View contract <ExternalLink size={11} />
      </a>
    </div>
  );
}

/**
 * A real, just-fetched trade quote. Every value here comes from
 * lib/monad/tradeQuote.ts's actual quote (see orchestrate.ts's
 * dispatchTrade), never a hardcoded example. When a wallet is connected
 * (intent.execution present), this renders inside the real confirm funnel —
 * CardFooter's "Confirm trade" button drives executeTradeIntent, which
 * re-quotes fresh and never signs the numbers shown here directly (see that
 * function's own doc). With no wallet connected, there's nothing to execute
 * against yet, so this stays informational-only (see OperationCard's isInfo).
 */
/** Matches the existing swap card's own staleness window. */
const QUOTE_STALE_AFTER_MS = 60_000;

function TradePreviewBody({ intent }: { intent: Extract<Operation["intent"], { kind: "trade_preview" }> }) {
  const d = intent.data;
  // Staleness has to be a live value, not a render-time snapshot. This card
  // sits in a chat transcript and can stay on screen indefinitely without
  // anything re-rendering it, so a plain `Date.now() - quotedAt > window`
  // computed during render would leave a minutes-old quote still presenting
  // itself as fresh — in a trading flow, exactly when the warning matters
  // most. One timer, scheduled for the precise moment the quote crosses the
  // window and then done (no polling): a quote only ever goes stale, never
  // back to fresh.
  const [isStale, setIsStale] = useState(() => Date.now() - d.quotedAt > QUOTE_STALE_AFTER_MS);
  useEffect(() => {
    if (isStale) return;
    const t = setTimeout(() => setIsStale(true), Math.max(0, d.quotedAt + QUOTE_STALE_AFTER_MS - Date.now()));
    return () => clearTimeout(t);
  }, [d.quotedAt, isStale]);
  return (
    <div>
      <div className="mb-3 flex items-center justify-center gap-3 rounded-xl border border-border bg-input/30 px-3 py-3">
        <div className="text-center">
          <p className="mb-1 text-[11px] text-muted-foreground">Spend</p>
          <p className="flex items-center justify-center gap-1.5 text-base font-semibold tracking-tight text-foreground sm:text-lg">
            <TokenLogo token={d.spend.token} size={18} /> {d.spend.amount}
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{d.spend.token}</p>
        </div>
        <ArrowLeftRight size={15} className="shrink-0 text-muted-foreground" />
        <div className="text-center">
          <p className="mb-1 text-[11px] text-muted-foreground">Receive</p>
          <p className="flex items-center justify-center gap-1.5 text-base font-semibold tracking-tight text-foreground sm:text-lg">
            <TokenLogo token={d.receive.token} size={18} /> {d.receive.amount}
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{d.receive.token}</p>
        </div>
      </div>

      {d.highPriceImpact && (
        <div className="mb-2.5 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" />
          <p className="text-xs text-warning">This trade would move the pool price significantly — double-check the amount before proceeding in a future step.</p>
        </div>
      )}
      {isStale && (
        <div className="mb-2.5 rounded-lg border border-border bg-input/30 px-3 py-2">
          <p className="text-xs text-muted-foreground">This quote is more than a minute old — prices may have moved. Ask again for a fresh one.</p>
        </div>
      )}

      <div className="divide-y divide-border/60">
        <Row label="Rate">{d.rate}</Row>
        <Row label="Minimum received">{d.minimumReceived}</Row>
        {d.fee && <Row label="PayAI fee">{d.fee.percent}</Row>}
        <Row label="Price impact">{d.priceImpact ?? "Unavailable"}</Row>
        <Row label="Route">{d.route.path.join(" → ")}</Row>
        <Row label="DEX">{d.route.provider}</Row>
        <Row label="Slippage">{d.slippage}</Row>
        <Row label="Network">{d.network}</Row>
      </div>

      {!intent.execution && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-border bg-input/30 px-3 py-2">
          <Lock size={13} className="shrink-0 text-muted-foreground" />
          <p className="text-xs text-muted-foreground">Connect your wallet to trade this route.</p>
        </div>
      )}
    </div>
  );
}

/** What actually happened, in one line — the whole reason this exists is
 *  that a bare tx hash doesn't tell anyone what they just did. Only
 *  payment and swap ever reach "success" with a result (scheduled/
 *  recurring hand off to Automations instead of executing in-chat, and
 *  distribution isn't executable from chat at all yet — see
 *  dispatchDistribution) — every other kind falls through to null and the
 *  card shows just the transaction, which is still honest, just terser. */
function ResultSummary({ intent }: { intent: Operation["intent"] }) {
  if (intent.kind === "payment") {
    return (
      <div className="mb-3 flex items-center gap-2 rounded-xl border border-border bg-input/30 px-3 py-2.5">
        <TokenLogo token={intent.token} size={20} />
        <span className="text-base font-semibold tracking-tight text-foreground [font-variant-numeric:tabular-nums] sm:text-lg">{intent.amount}</span>
        <span className="text-sm font-medium text-muted-foreground">{intent.token}</span>
        <ArrowUpRight size={13} className="mx-0.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-sm font-medium text-foreground">
          {intent.recipientDomain ?? short(intent.recipient)}
        </span>
      </div>
    );
  }
  if (intent.kind === "swap") {
    return (
      <div className="mb-3 flex items-center justify-center gap-2.5 rounded-xl border border-border bg-input/30 px-3 py-2.5">
        <span className="flex items-center gap-1.5 text-base font-semibold tracking-tight text-foreground">
          <TokenLogo token={intent.fromToken} size={18} /> {intent.fromAmount} {intent.fromToken}
        </span>
        <ArrowLeftRight size={14} className="shrink-0 text-muted-foreground" />
        <span className="flex items-center gap-1.5 text-base font-semibold tracking-tight text-foreground">
          <TokenLogo token={intent.toToken} size={18} /> ≈ {intent.toAmountEstimate ?? "—"} {intent.toToken}
        </span>
      </div>
    );
  }
  if (intent.kind === "trade_preview") {
    const d = intent.data;
    return (
      <div className="mb-3 flex items-center justify-center gap-2.5 rounded-xl border border-border bg-input/30 px-3 py-2.5">
        <span className="flex items-center gap-1.5 text-base font-semibold tracking-tight text-foreground">
          <TokenLogo token={d.spend.token} size={18} /> {d.spend.amount} {d.spend.token}
        </span>
        <ArrowLeftRight size={14} className="shrink-0 text-muted-foreground" />
        <span className="flex items-center gap-1.5 text-base font-semibold tracking-tight text-foreground">
          <TokenLogo token={d.receive.token} size={18} /> ≈ {d.receive.amount} {d.receive.token}
        </span>
      </div>
    );
  }
  return null;
}

function SuccessBody({ intent, result }: { intent: Operation["intent"]; result: NonNullable<Operation["result"]> }) {
  return (
    <div>
      <div className="mb-3 flex items-center gap-2.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-success/12 text-success"><CheckCircle2 size={18} /></span>
        <div>
          <p className="text-sm font-semibold text-foreground">
            {intent.kind === "swap" ? "Swap complete"
              : intent.kind === "trade_preview" ? "Trade completed"
              : intent.kind === "distribution" ? "Distribution sent"
              : intent.kind === "recurring_payment" ? "Automation created"
              : intent.kind === "scheduled_payment" ? "Payment scheduled"
              : "Payment sent"}
          </p>
          {/* The verification claim is exactly the evidence we hold and no
              more: a confirmed transaction on Monad, linked below. Scheduled/
              recurring don't settle here (they hand off to Automations), so
              they don't make the on-chain claim. */}
          <p className="flex items-center gap-1 text-xs text-success">
            <ShieldCheck size={11} className="shrink-0" />
            {intent.kind === "scheduled_payment" || intent.kind === "recurring_payment"
              ? "Set up — runs on-chain on schedule"
              : "Executed and verified on-chain"}
          </p>
          {result.gasFee && <p className="mt-0.5 text-xs text-muted-foreground">Network fee: {result.gasFee}</p>}
        </div>
      </div>
      <ResultSummary intent={intent} />
      {intent.kind === "trade_preview" && (
        <div className="mb-2.5 divide-y divide-border/60">
          <Row label="Route">{intent.data.route.path.join(" → ")}</Row>
          <Row label="DEX">{intent.data.route.provider}</Row>
          <Row label="Network">{intent.data.network}</Row>
        </div>
      )}
      <div className="rounded-lg border border-border bg-input/40 p-3">
        <p className="mb-1 text-[11px] text-muted-foreground">Transaction</p>
        <a href={result.explorerUrl} target="_blank" rel="noreferrer" className="block break-all font-mono text-xs text-primary-ink hover:underline">
          {result.txHash}
        </a>
      </div>
      <a href={result.explorerUrl} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs text-primary-ink hover:underline">
        View transaction <ExternalLink size={11} />
      </a>
    </div>
  );
}

/** Full weekday + date + time for a scheduled next run — the concrete moment
 *  the automation first fires, from the real saved record. */
function fmtDateTime(ms: number): string {
  try {
    return new Date(ms).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
  } catch {
    return new Date(ms).toISOString();
  }
}

const CADENCE_LABEL: Record<string, string> = { once: "One-time", daily: "Daily", weekly: "Weekly", monthly: "Monthly" };

/** The in-chat success state after a scheduled/recurring automation is created
 *  through the AutomationCreator modal. Every value is the real data the
 *  creation returned (nextRun is the saved record's own next run) — nothing is
 *  invented, and this never claims a single settled transaction, because
 *  creating an automation is a signature + approval, not one on-chain send. */
function AutomationCreatedBody({ automation }: { automation: NonNullable<Operation["automation"]> }) {
  return (
    <div>
      <div className="mb-3 flex items-center gap-2.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-success/12 text-success"><CheckCircle2 size={18} /></span>
        <div>
          <p className="text-sm font-semibold text-foreground">Automation created</p>
          <p className="flex items-center gap-1 text-xs text-success">
            <ShieldCheck size={11} className="shrink-0" /> Runs on-chain on your schedule
          </p>
        </div>
      </div>
      <div className="mb-3 flex items-center gap-2 rounded-xl border border-border bg-input/30 px-3 py-2.5">
        <TokenLogo token={automation.token} size={20} />
        <span className="text-base font-semibold tracking-tight text-foreground [font-variant-numeric:tabular-nums] sm:text-lg">{automation.amount}</span>
        <span className="text-sm font-medium text-muted-foreground">{automation.token}</span>
        <ArrowUpRight size={13} className="mx-0.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-sm font-medium text-foreground">{automation.domain ?? short(automation.recipient)}</span>
      </div>
      <div className="divide-y divide-border/60">
        <Row label="Frequency">{CADENCE_LABEL[automation.cadence] ?? automation.cadence}</Row>
        <Row label="Next run">{fmtDateTime(automation.nextRun)}</Row>
      </div>
      <Link href="/dashboard/automations" className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary-ink hover:underline">
        Manage in Automations <ExternalLink size={11} />
      </Link>
    </div>
  );
}

function ErrorBody({ error }: { error: OperationError }) {
  return (
    <div>
      <div className="flex items-start gap-2.5 rounded-lg border border-danger/25 bg-danger/5 p-3">
        <XCircle size={15} className="mt-0.5 shrink-0 text-danger" />
        <p className="text-sm leading-relaxed text-foreground">{error.message}</p>
      </div>
      {error.txHash && error.explorerUrl && (
        <a
          href={error.explorerUrl} target="_blank" rel="noreferrer"
          className="mt-2 flex items-center gap-1 font-mono text-xs text-primary-ink hover:underline"
        >
          {short(error.txHash)} <ExternalLink size={11} />
        </a>
      )}
    </div>
  );
}

function CardFooter({
  operation, onAdvance, onCancel, progressLabel,
}: {
  operation: Operation;
  onAdvance: (id: string) => void;
  onCancel?: (id: string) => void;
  progressLabel?: string;
}) {
  const [busy, setBusy] = useState(false);
  const { status, id, intent } = operation;

  if (status === "success") return null;

  if (status === "confirming") {
    // progressLabel tracks the REAL step (signature requested -> signed,
    // broadcasting -> confirming on-chain -> finalizing) — falling back to
    // a generic waiting message only for the instant before the first real
    // update lands, never staying stuck on "waiting for your signature"
    // after the user has already signed (see executeSwapIntent/
    // executeSendPayment's onProgress calls).
    const waitingLabel = progressLabel ?? (operation.confirmIcon === "go" ? "Opening…" : "Waiting for your signature — nothing has moved yet.");
    const onChain = !!progressLabel && /confirming on-chain|finalizing/i.test(progressLabel);
    // Phase drives the step indicator: 2 once the label proves the signature
    // happened and it's confirming on-chain, 0 while still awaiting signature.
    // Never higher than the real state — "Verified" (phase 3) belongs only to
    // the success state below.
    const phase = onChain ? 2 : 0;
    return (
      <div className="flex flex-col gap-2 border-t border-border/70 bg-primary/[0.03] px-4 py-3">
        <ExecutionSteps phase={phase} />
        <div className="flex items-center gap-2.5">
          {onChain ? (
            <Loader2 size={14} className="shrink-0 animate-spin text-primary-ink" />
          ) : (
            <Fingerprint size={14} className="shrink-0 animate-pulse text-primary-ink" />
          )}
          <p className="text-xs text-muted-foreground">{waitingLabel}</p>
        </div>
      </div>
    );
  }

  const label = status === "preview" ? `Review ${REVIEW_NOUN[intent.kind]}` : operation.confirmLabel ?? "Confirm with passkey";

  return (
    <div className="flex gap-2 border-t border-border/70 px-4 py-3">
      {onCancel && (
        <button
          onClick={() => onCancel(id)}
          className="flex-1 rounded-lg border border-border px-3 py-2 text-xs font-medium text-muted-foreground transition hover:border-danger/40 hover:text-danger"
        >
          Cancel
        </button>
      )}
      <button
        onClick={async () => {
          setBusy(true);
          await Promise.resolve(onAdvance(id));
          setBusy(false);
        }}
        disabled={busy}
        className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
      >
        {busy ? <Loader2 size={13} className="animate-spin" /> : status === "ready" ? (operation.confirmIcon === "go" ? <ArrowUpRight size={13} /> : <Fingerprint size={13} />) : <Search size={13} />}
        {label}
      </button>
    </div>
  );
}
