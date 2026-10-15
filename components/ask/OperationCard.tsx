"use client";

import { useEffect, useState } from "react";
import { motion } from "motion/react";
import Link from "next/link";
import {
  Send, Clock3, Repeat, ArrowLeftRight, Users, Wallet, Search,
  CheckCircle2, XCircle, Loader2, ExternalLink, Fingerprint, ArrowUpRight, ArrowDownRight,
  Coins, ShieldCheck, TrendingUp, AlertTriangle, Lock, RefreshCw, Blocks,
} from "lucide-react";
import { TokenLogo } from "@/components/TokenLogo";
import { AmountHero, Eyebrow, RecipientBlock, ReceiptTotal, StatusText, TxLink, type StatusTone } from "@/components/receipt/ReceiptKit";
import { formatAmountText, roundingForLabel } from "@/lib/format/tokenAmount";
import { isSafeToRetry } from "@/lib/ask/retryPolicy";
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

/** A scheduled run, stated in the timezone it is actually scheduled in (UTC)
 *  and then in the viewer's own — so "Fri, Oct 16 · 09:00 UTC" is never read
 *  as 9 AM local. Exported for tests. */
export function fmtRunTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const utc = d.toLocaleString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric", year: "numeric" });
  const hhmm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
  let local = "";
  try {
    local = d.toLocaleString(undefined, { hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  } catch { /* no Intl timezone support — UTC alone is still exact */ }
  return local && !/\bUTC\b/.test(local) ? `${utc} · ${hhmm} (${local} your time)` : `${utc} · ${hhmm}`;
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
  protocol_action: { icon: Blocks, title: "Protocol Action" },
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
  protocol_action: "action",
};

/** The card's status, said plainly (dot + word, no tinted pill). "Confirmed"
 *  is honest for every success state here: the card only reaches it with a
 *  confirmed on-chain transaction hash. "Submitted" is neutral, never a claim
 *  that it succeeded or failed — the transaction is on-chain, awaiting
 *  confirmation. */
const STATUS_TEXT: Record<OperationStatus, { label: string; tone: StatusTone }> = {
  preview: { label: "Preview", tone: "neutral" },
  ready: { label: "Ready to approve", tone: "active" },
  confirming: { label: "Executing", tone: "active" },
  submitted: { label: "Submitted", tone: "neutral" },
  success: { label: "Confirmed", tone: "success" },
  error: { label: "Failed", tone: "danger" },
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
  { label: "Confirmed", doneAt: 3 },
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

/** One label/value line, in the shared review/receipt style
 *  (components/receipt/ReceiptKit.tsx): values wrap instead of being cut
 *  off, and a text value has its amounts rounded by what the label means
 *  (what you pay up, what you get down), with the exact text as tooltip. */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  const exact = typeof children === "string" ? children : null;
  const text = exact != null ? formatAmountText(exact, { round: roundingForLabel(label) }) : null;
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5">
      <span className="shrink-0 text-[13px] text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right text-sm font-medium text-foreground [font-variant-numeric:tabular-nums] [overflow-wrap:anywhere]">
        {text != null ? <span title={text !== exact ? exact ?? undefined : undefined}>{text}</span> : children}
      </span>
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
  const chip: { label: string; tone: StatusTone } = operation.automation && status === "success"
    ? { label: "Active", tone: "success" }
    : intent.kind === "trade_preview" && isInfo
    ? { label: "Quote", tone: "neutral" }
    : isInfo ? { label: "Live", tone: "neutral" } : STATUS_TEXT[status];

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }}
      transition={{ duration: 0.15 }}
      className="w-full max-w-md overflow-hidden rounded-xl border border-border bg-panel"
    >
      <div className="flex items-center gap-2.5 border-b border-border/70 px-4 py-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center text-primary">
          <Icon size={18} />
        </span>
        <p className="flex-1 text-sm font-semibold text-foreground">{title}</p>
        <StatusText tone={chip.tone}>{chip.label}</StatusText>
      </div>

      <div className="px-4 py-3">
        {status === "error" && operation.error ? (
          <ErrorBody error={operation.error} intent={intent} />
        ) : status === "submitted" && operation.submitted ? (
          <SubmittedBody submitted={operation.submitted} intent={intent} />
        ) : status === "success" && operation.automation ? (
          <AutomationCreatedBody automation={operation.automation} />
        ) : status === "success" && operation.result && !isInfo ? (
          <SuccessBody intent={intent} result={operation.result} onQuickAction={onQuickAction} />
        ) : (
          <IntentBody intent={intent} onQuickAction={onQuickAction} />
        )}
      </div>

      {/* A submitted (broadcast, awaiting-confirmation) card is terminal for
          now — no action button, exactly like success — its own body carries
          the explorer link. */}
      {!isInfo && status !== "error" && status !== "submitted" && (
        <CardFooter operation={operation} onAdvance={onAdvance} onCancel={onCancel} progressLabel={progressLabel} />
      )}
      {/* Retry starts a NEW payment, so it is offered only when the failed
          attempt provably moved nothing — never because a caller passed a
          handler (lib/ask/retryPolicy.ts). */}
      {status === "error" && onRetry && isSafeToRetry(operation) && (
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
          <div className="divide-y divide-border/60 border-t border-border/60">
            <RecipientBlock domain={intent.recipientDomain} address={intent.recipient} />
            {intent.kind === "scheduled_payment" && <Row label="Runs on">{fmtRunTime(intent.startDate)}</Row>}
            <Row label="Network">{NETWORK_LABEL[intent.network]}</Row>
            {intent.kind === "payment" && intent.platformFee && (
              <Row label={`PayAI fee (${intent.platformFee.percent})`}>{`${intent.platformFee.amount} ${intent.platformFee.token}`}</Row>
            )}
            {intent.estimatedFee && <Row label="Network fee (est.)">{intent.estimatedFee}</Row>}
          </div>
          {intent.kind === "payment" && intent.platformFee && (
            <dl className="mt-1">
              <ReceiptTotal label="Total" value={`${intent.platformFee.total} ${intent.platformFee.token}`} note={intent.estimatedFee ? "+ network fee" : undefined} />
            </dl>
          )}
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
          <div className="divide-y divide-border/60 border-t border-border/60">
            <RecipientBlock domain={intent.recipientDomain} address={intent.recipient} />
            <Row label="Frequency">{FREQUENCY_LABEL[intent.frequency]}</Row>
            <Row label="Starts">{fmtRunTime(intent.startDate)}</Row>
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
    case "protocol_action":
      return <ProtocolActionBody intent={intent} />;
  }
}

/** SDK protocol-action preview (Phase 2). Every value comes from the
 *  server-produced ProtocolActionData (the registered action's real quote +
 *  validated inputs) — nothing is invented here. Uses the existing card
 *  language (the same Row/label treatment payment and trade previews use),
 *  and shows the one thing a protocol action adds over a plain trade: an
 *  explicit protocol identity and the action being run. */
function ProtocolActionBody({ intent }: { intent: Extract<Operation["intent"], { kind: "protocol_action" }> }) {
  const d = intent.data;
  return (
    <>
      <div className="mb-2.5 flex items-center gap-2">
        {/* Real protocol identity — name from the registry, never a
            fabricated logo. WMON's amounts render with the existing TokenLogo
            (MON) treatment the rest of the app already uses. */}
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary-ink"><Blocks size={14} /></span>
        <span className="text-sm font-semibold text-foreground">{d.protocol.name}</span>
        <span className="text-xs text-muted-foreground">· {d.action.name}</span>
      </div>
      {d.summary && <p className="mb-2.5 text-sm text-foreground">{d.summary}</p>}
      <div className="divide-y divide-border/60">
        {Object.entries(d.inputs)
          // Only scalar inputs render here. A list input (split's
          // `recipients`, in raw base units) and the raw `token` (a zero
          // sentinel for native, or a bare ERC-20 address) are shown, already
          // formatted with the token symbol, in `details` below. A
          // single-input action (WMON's `amount`) still renders here.
          .filter((e): e is [string, string] => typeof e[1] === "string" && e[0] !== "token")
          .map(([k, v]) => (
            <Row key={`in-${k}`} label={k.charAt(0).toUpperCase() + k.slice(1)}>{v}</Row>
          ))}
        {Object.entries(d.details).map(([k, v]) => {
          // A recipient the user wrote as a .nad name or configured payee
          // shows that name beside the address it resolved to — the address
          // is what gets signed, so it is always shown in full.
          const label = /^recipient \d+$/.test(k) ? d.recipientLabels?.[v.toLowerCase()] : undefined;
          return (
            <Row key={`det-${k}`} label={k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase())}>
              {label ? <span><span className="font-medium">{label}</span> <span className="break-all text-muted-foreground">{v}</span></span> : v}
            </Row>
          );
        })}
        <Row label="Network">{d.network}</Row>
        <Row label="Version">{d.action.version}</Row>
      </div>
      {d.warnings && d.warnings.length > 0 && (
        <div className="mt-2.5 flex items-start gap-1.5 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>{d.warnings.join(" ")}</span>
        </div>
      )}
    </>
  );
}

const TX_STATUS_META: Record<WalletTransactionView["status"], { icon: typeof CheckCircle2; tone: string; label: string }> = {
  success: { icon: CheckCircle2, tone: "bg-success/12 text-success", label: "Success" },
  pending: { icon: Loader2, tone: "bg-input text-muted-foreground", label: "Pending" },
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

  const change = d.market.priceChange24h;
  const changeTone = change == null ? "" : change.startsWith("-") ? "text-danger" : "text-success";
  const providers = Array.from(new Set(d.market.routes.map((r) => r.provider)));

  return (
    <div>
      {/* Identity and price */}
      <div className="flex items-start gap-3">
        <TokenLogo token={d.symbol} size={40} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <p className="truncate text-[15px] font-semibold text-foreground">{d.name}</p>
            {d.verified && <ShieldCheck size={14} className="shrink-0 text-primary-ink" aria-label="Verified" />}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            <span className="font-medium text-foreground/80">{d.symbol}</span>
            <span className="mx-1">·</span>
            <span className="font-mono">{short(intent.address)}</span>
          </p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-[15px] font-semibold tabular-nums text-foreground">{d.market.price ? `$${d.market.price}` : "—"}</p>
          {change ? (
            <p className={`text-xs font-medium tabular-nums ${changeTone}`}>{change} <span className="font-normal text-muted-foreground">24h</span></p>
          ) : d.market.priceMon ? (
            <p className="text-xs tabular-nums text-muted-foreground">≈ {d.market.priceMon} MON</p>
          ) : null}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${d.isTradable ? "border-success/30 bg-success/10 text-success" : "border-border bg-input text-muted-foreground"}`}>
          {d.isTradable ? "Tradable" : "No route found"}
        </span>
        {providers.map((p) => (
          <span key={p} className="rounded-full border border-border bg-input/40 px-2 py-0.5 text-[11px] text-muted-foreground">{p}</span>
        ))}
        {d.nadFun && (
          <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${NADFUN_STATUS_TONE[d.nadFun.status]}`}>
            Nad.Fun · {NADFUN_STATUS_LABEL[d.nadFun.status]}
          </span>
        )}
        <span className="ml-auto text-[10px] text-muted-foreground">Updated {agoLabel(d.market.lastUpdated)}</span>
      </div>
      {!d.market.price && d.isTradable && (
        <p className="mt-1.5 text-[11px] text-muted-foreground">Price unavailable — the pool is too thin to price honestly, but a trading route was found.</p>
      )}
      {d.market.price && !d.isTradable && d.nadFun && (
        <p className="mt-1.5 text-[11px] text-muted-foreground">Price estimated from the Nad.Fun pool&apos;s reserves — no executable trade route was found yet.</p>
      )}

      {/* Buy / Sell — only for a token with a real route, and only ever by
          sending a chat message (onQuickAction == useAskChat's send()): the
          trade then goes through the normal quote -> review -> wallet
          confirm funnel. Nothing here signs or executes. */}
      {onQuickAction && d.isTradable && (
        <TokenTradePanel address={intent.address} symbol={d.symbol} balance={d.userBalance} onQuickAction={onQuickAction} />
      )}

      {d.quote?.route && (
        <div className="mt-3 rounded-xl border border-primary/30 bg-primary/5 px-3 py-2.5">
          <p className="mb-0.5 text-xs text-muted-foreground">{d.quote.amount} {d.symbol} ≈</p>
          <p className="text-base font-semibold tabular-nums text-foreground">
            {d.quote.route.estimatedOutput} {d.quote.route.outputToken}
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">via {d.quote.route.provider}</span>
          </p>
        </div>
      )}
      {d.quote && !d.quote.route && (
        <p className="mt-3 rounded-xl border border-border bg-input/30 px-3 py-2.5 text-xs text-muted-foreground">No usable route to quote {d.quote.amount} {d.symbol} in {d.quote.quoteAsset}.</p>
      )}

      {d.nadFun?.progressPct != null && (
        <div className="mt-3">
          <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
            <span>Bonding curve{d.nadFun.availableToBuy ? ` · ${d.nadFun.availableToBuy} ${d.symbol} left` : ""}</span>
            <span className="tabular-nums text-foreground">{d.nadFun.progressPct.toFixed(2)}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-input">
            <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, Math.max(0, d.nadFun.progressPct))}%` }} />
          </div>
        </div>
      )}

      {/* Market */}
      <dl className="mt-3 grid grid-cols-3 overflow-hidden rounded-xl border border-border">
        <TokenStat label="Market cap" value={d.market.marketCapUsd ? `$${d.market.marketCapUsd}` : "—"} />
        <TokenStat label={d.market.liquidity?.label === "Bonding Curve Liquidity" ? "Curve liquidity" : "Liquidity"} value={d.market.liquidity ? (d.market.liquidity.usd ? `$${d.market.liquidity.usd}` : `${d.market.liquidity.mon} MON`) : "—"} />
        <TokenStat label="24h volume" value={d.market.volume24h ? `$${d.market.volume24h}` : "—"} />
        <TokenStat label="FDV" value={d.market.fdvUsd ? `$${d.market.fdvUsd}` : "—"} border />
        <TokenStat label="Supply" value={d.totalSupply ? compactNumber(d.totalSupply) : "—"} border />
        <TokenStat label="24h trades" value={d.market.transactions24h != null ? `${d.market.buys24h ?? "—"} / ${d.market.sells24h ?? "—"}` : "—"} hint={d.market.transactions24h != null ? "buys / sells" : undefined} border />
      </dl>

      {d.market.signals.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {d.market.signals.map((s) => (
            <span key={s} className="rounded-full border border-warning/30 bg-warning/10 px-2 py-0.5 text-[10px] font-medium text-warning">
              {SIGNAL_LABEL[s] ?? s.replace(/_/g, " ")}
            </span>
          ))}
        </div>
      )}

      <details className="group mt-3 rounded-xl border border-border">
        <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground">
          Token details
          <span className="transition group-open:rotate-180">▾</span>
        </summary>
        <div className="divide-y divide-border/60 border-t border-border/70 px-3">
          {d.market.routes.map((r, i) => (
            <Row key={i} label={`${r.inputToken}/${r.outputToken} · ${r.provider}`}>{`≈ ${r.estimatedOutput} ${r.outputToken}${r.priceImpact ? ` · ${r.priceImpact} impact` : ""}`}</Row>
          ))}
          <Row label="Decimals">{String(d.decimals)}</Row>
          <Row label="Network">Monad</Row>
          <Row label="Markets checked">{d.market.quoteAssetsChecked.join(", ") || "None"}</Row>
          {d.createdAt != null && <Row label="Created">{new Date(d.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</Row>}
          {d.creator && <Row label="Creator">{short(d.creator)}</Row>}
          {d.pool && <Row label="Pool">{short(d.pool)}</Row>}
          <Row label="Contract">{short(intent.address)}</Row>
        </div>
      </details>

      <div className="mt-3 flex items-center justify-between">
        <a href={d.explorerUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-primary-ink hover:underline">
          View on explorer <ExternalLink size={11} />
        </a>
        {onQuickAction && (
          <button
            type="button"
            onClick={() => onQuickAction(intent.address)}
            aria-label="Refresh token info"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground transition hover:text-foreground"
          >
            <RefreshCw size={12} /> Refresh
          </button>
        )}
      </div>
    </div>
  );
}

function TokenStat({ label, value, hint, border }: { label: string; value: string; hint?: string; border?: boolean }) {
  return (
    <div className={`min-w-0 px-3 py-2 [&:not(:nth-child(3n+1))]:border-l [&:not(:nth-child(3n+1))]:border-border ${border ? "border-t border-border" : ""}`}>
      <dt className="truncate text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-[13px] font-medium tabular-nums text-foreground">{value}</dd>
      {hint && <dd className="truncate text-[10px] text-muted-foreground">{hint}</dd>}
    </div>
  );
}

/** "1234567.89" -> "1.23M" — a token's raw supply can run to 18 digits. */
function compactNumber(v: string): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  return n.toLocaleString("en-US", { notation: n >= 1e6 ? "compact" : "standard", maximumFractionDigits: 2 });
}

const BUY_PRESETS: Record<"MON" | "USDC", string[]> = { MON: ["1", "5", "10", "25"], USDC: ["5", "10", "25", "50"] };
const SELL_PRESETS = [25, 50, 75, 100];

/**
 * Buy / Sell for a token identified by its contract address. Bought with MON
 * or USDC; sold into MON. Every action only SENDS a chat message — "Buy 0x…
 * with 5 MON", "Sell 50% of 0x…" — which PayAI's deterministic trading rules
 * turn into a live quote the user reviews and confirms with their wallet.
 * Nothing here signs, approves or executes.
 */
export function tokenTradeMessage(
  side: "buy" | "sell", address: string,
  opts: { amount?: string; pay?: "MON" | "USDC"; percent?: number | null },
): string | null {
  const amt = (opts.amount ?? "").trim();
  const validAmt = /^(?:\d+\.?\d*|\.\d+)$/.test(amt) && Number(amt) > 0;
  if (side === "buy") return validAmt && opts.pay ? `Buy ${address} with ${amt} ${opts.pay}` : null;
  if (opts.percent != null) return opts.percent >= 100 ? `Sell all of ${address}` : `Sell ${opts.percent}% of ${address}`;
  return validAmt ? `Sell ${amt} of ${address}` : null;
}

function TokenTradePanel({ address, symbol, balance, onQuickAction }: {
  address: string; symbol: string; balance: string | null; onQuickAction: (text: string) => void;
}) {
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [pay, setPay] = useState<"MON" | "USDC">("MON");
  const [amount, setAmount] = useState("");
  const [percent, setPercent] = useState<number | null>(null);
  const held = balance != null ? Number(balance) : null;
  const heldLabel = held != null && Number.isFinite(held) ? held.toLocaleString("en-US", { maximumFractionDigits: held < 1 ? 6 : 4 }) : null;
  const cannotSell = side === "sell" && (held == null || !(held > 0));
  const message = cannotSell ? null : tokenTradeMessage(side, address, { amount, pay, percent: side === "sell" ? percent : null });

  const tab = (s: "buy" | "sell", label: string) => (
    <button
      type="button"
      onClick={() => { setSide(s); setAmount(""); setPercent(null); }}
      className={`flex-1 rounded-md py-1.5 text-xs font-semibold transition ${side === s ? (s === "buy" ? "bg-success text-white shadow-sm" : "bg-danger text-white shadow-sm") : "text-muted-foreground hover:text-foreground"}`}
    >
      {label}
    </button>
  );
  const chip = (label: string, active: boolean, onClick: () => void) => (
    <button
      key={label}
      type="button"
      onClick={onClick}
      className={`flex-1 rounded-lg border px-2 py-1.5 text-xs font-medium tabular-nums transition ${active ? "border-primary bg-primary/10 text-primary-ink" : "border-border bg-input/30 text-foreground hover:border-primary/40"}`}
    >
      {label}
    </button>
  );

  return (
    <div className="mt-3 rounded-xl border border-border bg-input/20 p-3">
      <div className="flex gap-1 rounded-lg bg-input/60 p-0.5">
        {tab("buy", "Buy")}
        {tab("sell", "Sell")}
      </div>

      {side === "buy" ? (
        <>
          <div className="mt-3 flex items-center justify-between">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Pay with</span>
            <div className="flex gap-1">
              {(["MON", "USDC"] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => { setPay(p); setAmount(""); }}
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium transition ${pay === p ? "border-primary bg-primary/10 text-primary-ink" : "border-border text-muted-foreground hover:text-foreground"}`}
                >
                  <TokenLogo token={p} size={14} /> {p}
                </button>
              ))}
            </div>
          </div>
          <label className="mt-2.5 flex items-center rounded-lg border border-border bg-panel px-3 focus-within:border-primary">
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
              inputMode="decimal"
              placeholder="0.00"
              aria-label={`Amount of ${pay} to spend`}
              className="h-10 min-w-0 flex-1 bg-transparent text-sm font-medium tabular-nums text-foreground outline-none placeholder:text-muted-foreground/60"
            />
            <span className="text-xs font-medium text-muted-foreground">{pay}</span>
          </label>
          <div className="mt-2 flex gap-1.5">
            {BUY_PRESETS[pay].map((v) => chip(`${v} ${pay}`, amount === v, () => setAmount(v)))}
          </div>
        </>
      ) : (
        <>
          <div className="mt-3 flex items-center justify-between text-[11px]">
            <span className="font-medium uppercase tracking-wide text-muted-foreground">Sell into MON</span>
            <span className="tabular-nums text-muted-foreground">{heldLabel != null ? `Balance ${heldLabel} ${symbol}` : "Balance —"}</span>
          </div>
          <div className="mt-2.5 flex gap-1.5">
            {SELL_PRESETS.map((p) => chip(p === 100 ? "Max" : `${p}%`, percent === p, () => { setPercent(p); setAmount(""); }))}
          </div>
          <label className="mt-2 flex items-center rounded-lg border border-border bg-panel px-3 focus-within:border-primary">
            <input
              value={amount}
              onChange={(e) => { setAmount(e.target.value.replace(/[^\d.]/g, "")); setPercent(null); }}
              inputMode="decimal"
              placeholder="Or an exact amount"
              aria-label={`Amount of ${symbol} to sell`}
              className="h-10 min-w-0 flex-1 bg-transparent text-sm font-medium tabular-nums text-foreground outline-none placeholder:text-muted-foreground/60"
            />
            <span className="text-xs font-medium text-muted-foreground">{symbol}</span>
          </label>
          {cannotSell && (
            <p className="mt-2 text-[11px] text-muted-foreground">{held == null ? "Connect your wallet to sell this token." : `You don't hold any ${symbol} yet.`}</p>
          )}
        </>
      )}

      <button
        type="button"
        disabled={!message}
        onClick={() => message && onQuickAction(message)}
        className={`mt-3 w-full rounded-lg py-2.5 text-sm font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-40 ${side === "buy" ? "bg-success hover:opacity-90" : "bg-danger hover:opacity-90"}`}
      >
        {side === "buy" ? `Review buy${message ? ` · ${amount} ${pay}` : ""}` : `Review sell${message ? (percent != null ? ` · ${percent === 100 ? "all" : `${percent}%`}` : ` · ${amount} ${symbol}`) : ""}`}
      </button>
      <p className="mt-2 text-center text-[10px] text-muted-foreground">You&apos;ll see the live quote and confirm with your wallet before anything is signed.</p>
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
        <Row label="Price impact">{d.priceImpact ?? "Unavailable"}</Row>
        <Row label="Route">{d.route.path.join(" → ")}</Row>
        <Row label="DEX">{d.route.provider}</Row>
        <Row label="Slippage">{d.slippage}</Row>
        <Row label="Network">{d.network}</Row>
        {d.fee?.total && <Row label="You pay">{`${d.fee.total} ${d.fee.token}`}</Row>}
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

/** The single, opt-in next action offered after a result — never more than
 *  one, never auto-triggered, and only for an action PayAI genuinely
 *  supports from here. After a completed BUY it's "Sell what you received";
 *  the button only ever re-enters the normal classify → confirm funnel via
 *  onQuickAction (the same send() the composer uses), matching the exact
 *  phrasing useAskChat's deterministic SELL_JUST_BOUGHT_RE already resolves
 *  against the last confirmed trade — no new execution path, no fresh
 *  Anthropic call. Deliberately not offered after a SELL (there's nothing
 *  obvious to chain), nor for payment/swap successes. */
function SuccessFollowUp({ intent, onQuickAction }: { intent: Operation["intent"]; onQuickAction?: (text: string) => void }) {
  if (!onQuickAction || intent.kind !== "trade_preview" || intent.data.action !== "buy") return null;
  return (
    <button
      type="button"
      onClick={() => onQuickAction("Can I sell what I just bought?")}
      className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg border border-border bg-input/30 px-3 py-2 text-xs font-medium text-muted-foreground transition hover:border-primary/40 hover:text-foreground"
    >
      <ArrowDownRight size={13} /> Sell what you received
    </button>
  );
}

/** Past-tense eyebrow for a confirmed result. */
function doneLabel(intent: Operation["intent"]): string {
  switch (intent.kind) {
    case "swap": return "Swapped";
    case "trade_preview": return intent.data.action === "sell" ? "Sold" : intent.data.action === "buy" ? "Bought" : "Traded";
    case "protocol_action": return `${intent.data.action.name} · done`;
    case "distribution": return "Distributed";
    case "recurring_payment": return "Automation set up";
    case "scheduled_payment": return "Scheduled";
    default: return "Sent";
  }
}

/** A confirmed result, laid out as a receipt: what moved, to whom, what it
 *  cost, and the transaction. Everything shown comes from the intent the
 *  user approved and the confirmed result — nothing is estimated here except
 *  where the row says so. */
function SuccessBody({ intent, result, onQuickAction }: { intent: Operation["intent"]; result: NonNullable<Operation["result"]>; onQuickAction?: (text: string) => void }) {
  const eyebrow = doneLabel(intent);
  return (
    <div>
      {intent.kind === "payment" || intent.kind === "scheduled_payment" || intent.kind === "recurring_payment" ? (
        <AmountHero eyebrow={eyebrow} amount={intent.amount} token={intent.token} />
      ) : intent.kind === "distribution" ? (
        <AmountHero eyebrow={eyebrow} amount={intent.totalAmount} token={intent.token} />
      ) : intent.kind === "swap" ? (
        <AmountHero eyebrow={eyebrow} amount={intent.fromAmount} token={intent.fromToken} />
      ) : intent.kind === "trade_preview" ? (
        <AmountHero eyebrow={eyebrow} amount={intent.data.spend.amount} token={intent.data.spend.token} />
      ) : intent.kind === "protocol_action" ? (
        <><Eyebrow>{eyebrow}</Eyebrow><p className="mt-1.5 text-base font-semibold text-foreground">{intent.data.protocol.name}</p></>
      ) : (
        <Eyebrow>{eyebrow}</Eyebrow>
      )}

      <div className="mt-3 divide-y divide-border/60 border-t border-border/60">
        {(intent.kind === "payment" || intent.kind === "scheduled_payment" || intent.kind === "recurring_payment") && (
          <RecipientBlock domain={intent.recipientDomain} address={intent.recipient} />
        )}
        {intent.kind === "swap" && <Row label="Received (est.)">{`${intent.toAmountEstimate ?? "—"} ${intent.toToken}`}</Row>}
        {intent.kind === "trade_preview" && (
          <>
            <Row label="Received (est.)">{`${intent.data.receive.amount} ${intent.data.receive.token}`}</Row>
            <Row label="Route">{intent.data.route.path.join(" → ")}</Row>
            <Row label="Venue">{intent.data.route.provider}</Row>
          </>
        )}
        {intent.kind === "protocol_action" && <Row label="Action">{intent.data.action.name}</Row>}
        {/* CONFIRMED on-chain figures only — result.confirmedDetails comes from
            the action's own parseResult() over the real, receipt-verified
            logs (see orchestrate.ts's executeProtocolActionIntent), never from
            the pre-execution quote (intent.data.details, which this success
            view deliberately never renders). Absent when parseResult had
            nothing to report, so nothing is ever invented to fill the gap. */}
        {intent.kind === "protocol_action" && result.confirmedDetails && Object.entries(result.confirmedDetails)
          .filter(([k]) => k !== "status")
          .map(([k, v]) => (
            <Row key={k} label={k.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase())}>{v}</Row>
          ))}
        <Row label="Network">Monad</Row>
        {result.gasFee && <Row label="Network fee">{result.gasFee}</Row>}
        <Row label="Transaction"><TxLink hash={result.txHash} href={result.explorerUrl} /></Row>
      </div>
      <SuccessFollowUp intent={intent} onQuickAction={onQuickAction} />
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
  const cadence = CADENCE_LABEL[automation.cadence] ?? automation.cadence;
  return (
    <div>
      <AmountHero eyebrow="Automation set up" amount={automation.amount} token={automation.token} suffix={automation.cadence === "once" ? undefined : `/ ${cadence.toLowerCase()}`} />
      <div className="mt-3 divide-y divide-border/60 border-t border-border/60">
        <RecipientBlock domain={automation.domain} address={automation.recipient} />
        <Row label="Frequency">{cadence}</Row>
        <Row label="Next run">{fmtDateTime(automation.nextRun)}</Row>
      </div>
      <Link href="/dashboard/automations" className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary-ink hover:underline">
        Manage in Automations <ExternalLink size={11} />
      </Link>
    </div>
  );
}

/** The broadcast-but-unconfirmed state: the transaction is on-chain (real
 *  txHash) but confirmation hasn't been observed. Amber, honest — it never
 *  claims success and never claims failure. The explorer link is always
 *  clickable so the user can check the real transaction themselves; the
 *  background settlement reconciler resolves the final outcome. No spinner:
 *  nothing is actively happening in this tab that a spinner would represent.
 *
 *  P1.4: when a separate approval already confirmed (`submitted.approvalTx`),
 *  it gets its OWN small, clearly-labeled, already-confirmed transaction
 *  block — never merged into the still-pending one below it, and never
 *  described as having moved funds (an approval only ever sets an
 *  allowance). `submitted.step` says whether the transaction that's
 *  actually still pending IS that same approval (nothing else has been
 *  attempted yet) or the trade/swap itself. */
function SubmittedBody({
  submitted, intent,
}: {
  submitted: NonNullable<Operation["submitted"]>;
  intent: Operation["intent"];
}) {
  const noun = intent.kind === "trade_preview" ? "Trade" : intent.kind === "swap" ? "Swap" : "Transaction";
  const approvalPending = submitted.step === "approval";
  const headline = approvalPending ? "Approval submitted" : `${noun} submitted`;
  const subline = approvalPending
    ? "Checking your token approval on Monad…"
    : submitted.approvalTx
    ? "Approval complete. Checking confirmation on Monad…"
    : "Checking confirmation on Monad…";
  return (
    <div>
      <Eyebrow>{headline}</Eyebrow>
      <p className="mt-1 text-sm text-foreground">{subline}</p>
      <div className="mt-3 divide-y divide-border/60 border-t border-border/60">
        {submitted.approvalTx && !approvalPending && (
          <Row label="Approval · confirmed"><TxLink hash={submitted.approvalTx.txHash} href={submitted.approvalTx.explorerUrl} /></Row>
        )}
        <Row label={approvalPending ? "Approval" : noun}><TxLink hash={submitted.txHash} href={submitted.explorerUrl} /></Row>
      </div>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        {submitted.approvalTx && !approvalPending ? "The approval already happened — no need to approve again. " : ""}
        It may already be on-chain — this updates once it confirms. No need to resend.
      </p>
    </div>
  );
}

/** P1.4: when a separate approval already confirmed before whatever failed
 *  (`error.approvalTx`), it gets its own small, clearly-labeled block —
 *  never conflated with the failing step's own `error.txHash`/`explorerUrl`
 *  below it, and labeled by which real transaction it is ("Trade
 *  transaction" / "Swap transaction") once there are two to tell apart. */
function ErrorBody({ error, intent }: { error: OperationError; intent: Operation["intent"] }) {
  const noun = intent.kind === "trade_preview" ? "Trade" : intent.kind === "swap" ? "Swap" : "Transaction";
  return (
    <div>
      <div className="flex items-start gap-2.5 rounded-lg border border-danger/25 bg-danger/5 p-3">
        <XCircle size={15} className="mt-0.5 shrink-0 text-danger" />
        <p className="text-sm leading-relaxed text-foreground">{error.message}</p>
      </div>
      {(error.approvalTx || (error.txHash && error.explorerUrl)) && (
        <div className="mt-2 divide-y divide-border/60">
          {error.approvalTx && (
            <Row label="Approval · confirmed"><TxLink hash={error.approvalTx.txHash} href={error.approvalTx.explorerUrl} /></Row>
          )}
          {error.txHash && error.explorerUrl && (
            <Row label={error.approvalTx ? noun : "Transaction"}><TxLink hash={error.txHash} href={error.explorerUrl} /></Row>
          )}
        </div>
      )}
      {error.approvalTx && <p className="mt-1 text-xs text-muted-foreground">The approval already happened — no need to approve again.</p>}
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
