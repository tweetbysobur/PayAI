"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Sparkles, X, CheckCircle2, Clock3, XCircle, AlertTriangle,
  ExternalLink, CornerDownLeft, ArrowUpRight, FileText, ListChecks,
  ArrowLeftRight, Loader2, Wallet,
} from "lucide-react";
import { PipelineStepper } from "@/components/PipelineStepper";
import { useAgentConsole, DECISION, short, phraseSummary } from "@/lib/hooks/useAgentConsole";

const EXAMPLES = [
  { label: "Swap 1 MON to USDC", icon: ArrowLeftRight },
  { label: "Send 5 MON to alex.nads", icon: ArrowUpRight },
  { label: "Create invoice for 50 USDC", icon: FileText },
  { label: "Show today's transactions", icon: ListChecks },
];

/** What Ask PayAI can do — surfaced so the bar advertises its full range. */
const CAPABILITIES: { verb: string; example: string }[] = [
  { verb: "Swap", example: "swap 1 MON to USDC" },
  { verb: "Send", example: "send 5 MON to alex.nads" },
  { verb: "Schedule", example: "schedule 10 USDC to alex.nads every Friday" },
  { verb: "Invoice", example: "create invoice for 50 USDC" },
  { verb: "Balance", example: "what's my balance" },
  { verb: "History", example: "show today's transactions" },
];

const STATUS_ICON: Record<string, typeof CheckCircle2> = {
  executed: CheckCircle2,
  needs_review: Clock3,
  blocked: XCircle,
  refused: XCircle,
  error: AlertTriangle,
  ready_to_sign: Clock3,
};
const STATUS_RING: Record<string, string> = {
  executed: "bg-success/12 text-success",
  needs_review: "bg-warning/12 text-warning",
  blocked: "bg-danger/12 text-danger",
  refused: "bg-danger/12 text-danger",
  error: "bg-input text-muted-foreground",
  ready_to_sign: "bg-warning/12 text-warning",
};

/**
 * AI Command Bar — Cmd+K (or the floating button) opens a focused overlay that
 * runs ONE command through the real agent pipeline and shows the result inline.
 * The AI surface lives on top of the dashboard, not as a separate chat page.
 */
export function CommandBar() {
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const c = useAgentConsole();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (open) { setSel(0); setTimeout(() => inputRef.current?.focus(), 50); }
    // Closing always returns the bar to its idle start state — reopening should
    // never show a stale result or the previous prompt.
    else c.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function startOver() {
    c.reset();
    setSel(0);
    setTimeout(() => inputRef.current?.focus(), 10);
  }

  // Arrow-key navigation over the example suggestions, shown only while idle.
  const showExamples = !c.res && !c.info && !c.swap && !c.loading && !c.err;

  function onInputKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (showExamples && !c.intent) {
      if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => (s + 1) % EXAMPLES.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => (s - 1 + EXAMPLES.length) % EXAMPLES.length); return; }
      if (e.key === "Enter") { e.preventDefault(); const ex = EXAMPLES[sel].label; c.setIntent(ex); c.run(ex); return; }
    }
    if (e.key === "Enter" && c.intent && !c.loading) c.run(c.intent);
  }

  const res = c.res;
  const StatusIcon = res ? STATUS_ICON[res.decision] ?? AlertTriangle : null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-40 flex items-center gap-2 rounded-full bg-primary px-4 py-3 text-sm font-medium text-primary-foreground shadow-lg shadow-primary/30 transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <Sparkles size={16} />
        Ask PayAI
        <kbd className="ml-1 hidden rounded border border-primary-foreground/30 px-1.5 py-0.5 text-[10px] opacity-80 sm:inline-block">⌘K</kbd>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-start justify-center bg-background/85 px-4 pt-[12vh] sm:bg-background/70 sm:backdrop-blur-sm"
            onClick={() => setOpen(false)}
          >
            <motion.div
              initial={{ opacity: 0, y: -16, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -16, scale: 0.98 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-xl overflow-hidden rounded-2xl border border-border bg-panel shadow-2xl ring-1 ring-primary/5"
            >
              {/* Search row */}
              <div className="flex items-center gap-3 border-b border-border bg-gradient-to-b from-primary/[0.04] to-transparent px-4 py-3.5">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary">
                  <Sparkles size={15} />
                </span>
                <input
                  ref={inputRef}
                  value={c.intent} onChange={(e) => c.setIntent(e.target.value)}
                  onKeyDown={onInputKey}
                  placeholder="Ask PayAI, e.g. Send 5 MON to alex.nads"
                  className="flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground/70"
                />
                <button onClick={() => setOpen(false)} aria-label="Close" className="shrink-0 rounded-md p-1 text-muted-foreground transition hover:bg-input hover:text-foreground"><X size={16} /></button>
              </div>

              <div className="max-h-[52vh] overflow-y-auto p-4">
                {/* Idle — suggestions */}
                {showExamples && (
                  <div>
                    <p className="mb-2.5 px-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">Try</p>
                    <div className="space-y-1.5">
                      {EXAMPLES.map((ex, i) => (
                        <button
                          key={ex.label}
                          onMouseEnter={() => setSel(i)}
                          onClick={() => { c.setIntent(ex.label); c.run(ex.label); }}
                          className={`group flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left text-sm transition ${
                            sel === i && !c.intent
                              ? "border-primary/40 bg-input text-foreground"
                              : "border-transparent text-foreground hover:border-border hover:bg-input"
                          }`}
                        >
                          <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-input transition ${sel === i && !c.intent ? "text-primary" : "text-muted-foreground group-hover:text-primary"}`}>
                            <ex.icon size={14} />
                          </span>
                          <span className="flex-1">{ex.label}</span>
                          {sel === i && !c.intent && (
                            <CornerDownLeft size={13} className="shrink-0 text-muted-foreground" />
                          )}
                        </button>
                      ))}
                    </div>
                    <div className="mt-4 flex flex-wrap gap-1.5 border-t border-border pt-3">
                      {CAPABILITIES.map((cap) => (
                        <button
                          key={cap.verb}
                          onClick={() => { c.setIntent(cap.example); inputRef.current?.focus(); }}
                          className="rounded-full border border-border px-2.5 py-1 text-[11px] text-muted-foreground transition hover:border-primary/40 hover:text-foreground"
                          title={cap.example}
                        >
                          {cap.verb}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {c.loading && (
                  <div className="py-2">
                    <PipelineStepper steps={c.steps} />
                  </div>
                )}

                {/* Swap (DEX) — its own flow, not the payment pipeline */}
                {c.swap && (
                  <motion.div
                    initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, ease: "easeOut" }}
                    className="rounded-xl border border-border bg-input/30 p-4"
                  >
                    <div className="flex items-center gap-3">
                      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${c.swap.phase === "done" ? "bg-success/12 text-success" : c.swap.phase === "error" ? "bg-danger/12 text-danger" : "bg-primary/12 text-primary"}`}>
                        {c.swap.phase === "signing" ? <Loader2 size={18} className="animate-spin" /> : c.swap.phase === "done" ? <CheckCircle2 size={18} /> : c.swap.phase === "error" ? <XCircle size={18} /> : <ArrowLeftRight size={18} />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-foreground">
                          {c.swap.phase === "signing" ? "Swapping…" : c.swap.phase === "done" ? "Swap complete" : c.swap.phase === "error" ? "Swap failed" : "Review swap"}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          via {c.swap.provider ?? "Uniswap v3"} · {c.swap.plan.quote.feeTier / 10000}% pool · {(c.swap.plan.quote.slippage * 100).toFixed(2)}% max slippage
                        </p>
                      </div>
                    </div>

                    <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-border bg-panel px-3 py-3">
                      <div className="text-center">
                        <p className="text-base font-semibold tracking-tight text-foreground [font-variant-numeric:tabular-nums]">{c.swap.plan.quote.amountIn}</p>
                        <p className="text-[11px] text-muted-foreground">{c.swap.plan.quote.fromToken}</p>
                      </div>
                      <ArrowLeftRight size={15} className="shrink-0 text-muted-foreground" />
                      <div className="text-center">
                        <p className="text-base font-semibold tracking-tight text-foreground [font-variant-numeric:tabular-nums]">
                          ≈ {c.swap.plan.quote.amountOut.toFixed(c.swap.plan.quote.toToken === "USDC" ? 2 : 4)}
                        </p>
                        <p className="text-[11px] text-muted-foreground">{c.swap.plan.quote.toToken}</p>
                      </div>
                    </div>

                    {c.swap.phase === "signing" && c.swap.plan.steps.length > 1 && (
                      <p className="mt-2.5 text-xs text-muted-foreground">
                        Step {c.swap.stepIndex + 1} of {c.swap.plan.steps.length}: {c.swap.plan.steps[c.swap.stepIndex]?.label}
                      </p>
                    )}
                    {c.swap.phase === "signing" && (
                      <p className="mt-2.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Wallet size={12} /> Approve in your wallet. Settles on Monad in seconds.
                      </p>
                    )}
                    {c.swap.phase === "error" && c.swap.error && (
                      <p className="mt-2.5 text-xs text-danger">{c.swap.error}</p>
                    )}
                    {c.swap.phase === "done" && c.swap.explorerUrl && (
                      <a
                        href={c.swap.explorerUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 font-mono text-xs text-primary transition hover:border-primary/40"
                      >
                        {short(c.swap.txHash)} <ExternalLink size={11} />
                      </a>
                    )}
                  </motion.div>
                )}

                {c.err && (
                  <div className="flex items-start gap-2.5 rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger">
                    <AlertTriangle size={15} className="mt-0.5 shrink-0" /> {c.err}
                  </div>
                )}

                {res && !c.loading && (
                  <motion.div
                    initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, ease: "easeOut" }}
                    className="rounded-xl border border-border bg-input/30 p-4"
                  >
                    <div className="flex items-center gap-3">
                      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${STATUS_RING[res.decision] ?? "bg-input text-muted-foreground"}`}>
                        {StatusIcon && <StatusIcon size={18} />}
                      </span>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-foreground">{DECISION[res.decision].label}</p>
                        <p className="text-xs text-muted-foreground">{Math.round(res.confidence * 100)}% confidence</p>
                      </div>
                      {res.intent.amount != null && (
                        <span className="ml-auto shrink-0 text-right text-base font-semibold tracking-tight text-foreground [font-variant-numeric:tabular-nums]">
                          {res.intent.amount} <span className="text-xs font-medium text-muted-foreground">{res.intent.token}</span>
                        </span>
                      )}
                    </div>

                    <p className="mt-3 text-sm text-muted-foreground">{phraseSummary(res.intent.summary, res.decision)}</p>

                    {res.guardrail.violations.length > 0 && (
                      <p className="mt-2 text-xs text-danger">{res.guardrail.violations.join(" ")}</p>
                    )}

                    {res.transaction?.txHash && (
                      <a
                        href={res.transaction.explorerUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 font-mono text-xs text-primary transition hover:border-primary/40"
                      >
                        {short(res.transaction.txHash)} <ExternalLink size={11} />
                      </a>
                    )}
                  </motion.div>
                )}

                {c.info && !c.loading && c.info.query === "scheduled" && (
                  <div className="rounded-xl border border-success/30 bg-success/10 p-4">
                    <div className="flex items-center gap-2 text-sm font-semibold text-success">
                      <CheckCircle2 size={16} /> Payment scheduled
                    </div>
                    <p className="mt-1.5 text-sm text-foreground">{c.info.scheduleSummary}</p>
                    <a href="/dashboard/scheduled" className="mt-2.5 inline-block text-xs text-primary hover:underline">Manage scheduled payments →</a>
                  </div>
                )}

                {c.info && !c.loading && c.info.query !== "scheduled" && (
                  <div className="rounded-xl border border-border bg-input/30 p-4 text-sm text-foreground">
                    {c.info.query === "show_history"
                      ? `You have ${c.info.count ?? c.info.history?.length ?? 0} recorded transaction${(c.info.count ?? 0) === 1 ? "" : "s"}.`
                      : c.info.query === "show_balance"
                        ? c.info.balance
                          ? `Your wallet holds ${c.info.balance.mon.toFixed(4)} MON and ${c.info.balance.usdc.toFixed(2)} USDC.`
                          : c.info.error ?? "Couldn't read your balance."
                        : c.info.query === "scheduled_payment"
                          ? c.info.error ?? "Scheduled payments aren't available yet."
                          : c.info.compliance
                            ? `${Math.round(c.info.compliance.approvalRate * 100)}% approval rate across your payments.`
                            : "No data yet."}
                  </div>
                )}

                {/* Once a command reaches a terminal state, offer a clean reset
                    back to the start instead of leaving the old result sitting. */}
                {((res && !c.loading) || c.info || c.err || (c.swap && (c.swap.phase === "done" || c.swap.phase === "error"))) && (
                  <motion.button
                    initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.1 }}
                    onClick={startOver}
                    className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition hover:opacity-90"
                  >
                    <Sparkles size={14} /> New command
                  </motion.button>
                )}
              </div>

              {/* Footer hints */}
              <div className="flex items-center justify-between border-t border-border px-4 py-2.5 text-[11px] text-muted-foreground">
                <div className="flex items-center gap-4">
                  <span className="flex items-center gap-1.5">
                    <kbd className="inline-flex items-center gap-0.5 rounded border border-border px-1.5 py-0.5"><CornerDownLeft size={10} /> Enter</kbd> run
                  </span>
                  {showExamples && !c.intent && (
                    <span className="hidden items-center gap-1.5 sm:flex">
                      <kbd className="rounded border border-border px-1.5 py-0.5">↑↓</kbd> navigate
                    </span>
                  )}
                </div>
                <span className="flex items-center gap-1.5">
                  <kbd className="rounded border border-border px-1.5 py-0.5">Esc</kbd> close
                </span>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
