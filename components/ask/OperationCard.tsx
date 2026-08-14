"use client";

import { useState } from "react";
import { motion } from "motion/react";
import Link from "next/link";
import {
  Send, Clock3, Repeat, ArrowLeftRight, Users, Wallet, Search,
  CheckCircle2, XCircle, Loader2, ExternalLink, Fingerprint, AlertTriangle, ArrowUpRight,
} from "lucide-react";
import { TokenLogo } from "@/components/TokenLogo";
import {
  FREQUENCY_LABEL, NETWORK_LABEL, WALLET_OP_LABEL,
  type Operation, type OperationStatus,
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

const KIND_META: Record<Operation["intent"]["kind"], { icon: typeof Send; title: string }> = {
  payment: { icon: Send, title: "Payment" },
  scheduled_payment: { icon: Clock3, title: "Scheduled Payment" },
  recurring_payment: { icon: Repeat, title: "Recurring Payment" },
  swap: { icon: ArrowLeftRight, title: "Swap" },
  distribution: { icon: Users, title: "Distribution" },
  wallet_operation: { icon: Wallet, title: "" }, // overridden per-operation below
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
};

const STATUS_CHIP: Record<OperationStatus, { label: string; tone: string }> = {
  preview: { label: "Preview", tone: "border-border bg-input text-muted-foreground" },
  ready: { label: "Ready to confirm", tone: "border-warning/30 bg-warning/10 text-warning" },
  confirming: { label: "Confirming", tone: "border-primary/30 bg-primary/10 text-primary-ink" },
  success: { label: "Sent", tone: "border-success/30 bg-success/10 text-success" },
  error: { label: "Failed", tone: "border-danger/30 bg-danger/10 text-danger" },
};

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
}) {
  const { intent, status } = operation;
  const meta = KIND_META[intent.kind];
  const Icon = meta.icon;
  const title = intent.kind === "wallet_operation" ? WALLET_OP_LABEL[intent.operation] : meta.title;
  const isInfo = intent.kind === "wallet_operation";
  // Info surfaces (balance, history, an explainer) never moved money, so
  // "Sent"/"Preview"/etc. would misdescribe them — they get their own
  // neutral label instead of borrowing a transactional one.
  const chip = isInfo ? { label: "Live", tone: "border-border bg-input text-muted-foreground" } : STATUS_CHIP[status];

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
          <ErrorBody message={operation.error.message} />
        ) : status === "success" && operation.result && !isInfo ? (
          <SuccessBody intent={intent} result={operation.result} />
        ) : (
          <IntentBody intent={intent} />
        )}
      </div>

      {!isInfo && status !== "error" && (
        <CardFooter operation={operation} onAdvance={onAdvance} onCancel={onCancel} />
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

function IntentBody({ intent }: { intent: Operation["intent"] }) {
  switch (intent.kind) {
    case "payment":
    case "scheduled_payment":
      return (
        <>
          <div className="mb-2.5 flex items-center gap-2">
            <TokenLogo token={intent.token} size={22} />
            <span className="text-2xl font-semibold tracking-tight text-foreground [font-variant-numeric:tabular-nums]">{intent.amount}</span>
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
            <span className="text-2xl font-semibold tracking-tight text-foreground [font-variant-numeric:tabular-nums]">{intent.amount}</span>
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
              <p className="flex items-center justify-center gap-1.5 text-lg font-semibold tracking-tight text-foreground">
                <TokenLogo token={intent.fromToken} size={18} /> {intent.fromAmount}
              </p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">{intent.fromToken}</p>
            </div>
            <ArrowLeftRight size={15} className="shrink-0 text-muted-foreground" />
            <div className="text-center">
              <p className="flex items-center justify-center gap-1.5 text-lg font-semibold tracking-tight text-foreground">
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
            <span className="text-2xl font-semibold tracking-tight text-foreground [font-variant-numeric:tabular-nums]">{intent.totalAmount}</span>
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
  }
}

/** Read-only info surfaces — no signature, no funds movement, so these
 *  render their answer directly rather than entering the confirm funnel. */
function WalletOperationBody({ intent }: { intent: Extract<Operation["intent"], { kind: "wallet_operation" }> }) {
  if (intent.operation === "balance") {
    return (
      <div className="grid grid-cols-2 gap-2.5">
        {[{ token: "MON", amount: "128.42" }, { token: "USDC", amount: "1,240.00" }].map((b) => (
          <div key={b.token} className="rounded-lg border border-border bg-input/30 px-3 py-2.5">
            <div className="flex items-center gap-1.5"><TokenLogo token={b.token} size={15} /><span className="text-xs text-muted-foreground">{b.token}</span></div>
            <p className="mt-1 text-lg font-semibold tabular-nums text-foreground">{b.amount}</p>
          </div>
        ))}
      </div>
    );
  }
  if (intent.operation === "recent_payments") {
    const rows = [
      { to: "alex.nad", amount: "50 USDC", when: "2h ago" },
      { to: "0x9f2a…c41e", amount: "12.5 MON", when: "Yesterday" },
      { to: "contributor.nad", amount: "100 USDC", when: "3d ago" },
    ];
    return (
      <div className="divide-y divide-border/60">
        {rows.map((r, i) => (
          <div key={i} className="flex items-center justify-between py-1.5 text-sm">
            <span className="text-foreground">{r.to}</span>
            <span className="text-muted-foreground">{r.amount} · {r.when}</span>
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
  // explain_transaction
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-warning/25 bg-warning/5 p-3">
      <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" />
      <p className="text-sm leading-relaxed text-foreground">{intent.detail}</p>
    </div>
  );
}

function SuccessBody({ intent, result }: { intent: Operation["intent"]; result: NonNullable<Operation["result"]> }) {
  return (
    <div>
      <div className="mb-3 flex items-center gap-2.5">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-success/12 text-success"><CheckCircle2 size={18} /></span>
        <div>
          <p className="text-sm font-semibold text-foreground">
            {intent.kind === "swap" ? "Swap complete"
              : intent.kind === "distribution" ? "Distribution sent"
              : intent.kind === "recurring_payment" ? "Automation created"
              : intent.kind === "scheduled_payment" ? "Payment scheduled"
              : "Payment sent"}
          </p>
          {result.gasFee && <p className="text-xs text-muted-foreground">Network fee: {result.gasFee}</p>}
        </div>
      </div>
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

function ErrorBody({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-danger/25 bg-danger/5 p-3">
      <XCircle size={15} className="mt-0.5 shrink-0 text-danger" />
      <p className="text-sm leading-relaxed text-foreground">{message}</p>
    </div>
  );
}

function CardFooter({
  operation, onAdvance, onCancel,
}: {
  operation: Operation;
  onAdvance: (id: string) => void;
  onCancel?: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const { status, id, intent } = operation;

  if (status === "success") return null;

  if (status === "confirming") {
    const waitingLabel = operation.confirmIcon === "go" ? "Opening…" : "Waiting for your signature — nothing has moved yet.";
    return (
      <div className="flex items-center gap-2.5 border-t border-border/70 bg-primary/[0.03] px-4 py-3">
        <Fingerprint size={16} className="shrink-0 animate-pulse text-primary-ink" />
        <p className="text-xs text-muted-foreground">{waitingLabel}</p>
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
