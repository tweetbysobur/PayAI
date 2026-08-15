"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { motion, AnimatePresence, useMotionValue } from "motion/react";
import {
  Sparkles, X, CheckCircle2, Clock3, XCircle, AlertTriangle,
  ExternalLink, CornerDownLeft, ArrowUpRight,
  ArrowLeftRight, Loader2, Wallet, Fingerprint,
} from "lucide-react";
import { PipelineStepper } from "@/components/PipelineStepper";
import { ConfirmDetails } from "@/components/dashboard/ConfirmDetails";
import { useAgentConsole, DECISION, short, phraseSummary, SWAP_PHASE_LABEL, SWAP_STAGES } from "@/lib/hooks/useAgentConsole";
import { AssistantBriefing, useAssistantContext } from "@/components/dashboard/AssistantBriefing";

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

/** Screen edges the button can never be dragged past, so it can't be dropped
 *  under the sidebar/topbar or off-screen where it becomes unreachable. */
const EDGE_MARGIN = 16;
const POS_KEY = "payai_ask_button_pos";

/** Fits a saved/measured position back inside the current viewport — the
 *  window may have resized or rotated since the position was saved. */
function clamp(pos: { x: number; y: number }, w: number, h: number) {
  return {
    x: Math.min(Math.max(pos.x, EDGE_MARGIN), window.innerWidth - w - EDGE_MARGIN),
    y: Math.min(Math.max(pos.y, EDGE_MARGIN), window.innerHeight - h - EDGE_MARGIN),
  };
}

/**
 * AI Command Bar — Cmd+K (or the floating button) opens a focused overlay that
 * runs ONE command through the real agent pipeline and shows the result inline.
 * The AI surface lives on top of the dashboard, not as a separate chat page.
 */
export function CommandBar() {
  const [open, setOpen] = useState(false);
  const c = useAgentConsole();
  // The dedicated Ask PayAI workspace (app/dashboard/ask) IS this feature,
  // full-page — floating a second, smaller "Ask PayAI" trigger on top of it
  // (and letting ⌘K pop the compact modal over the page already showing the
  // same thing) is redundant at best and visually collides with the page's
  // own content at worst. Suppressed only on that one route; every other
  // page keeps the trigger exactly as it was.
  const pathname = usePathname();
  const onAskPage = pathname === "/dashboard/ask";
  // What the assistant already knows when it opens — see AssistantBriefing.
  const { ctx, loading: ctxLoading } = useAssistantContext();
  const inputRef = useRef<HTMLInputElement>(null);

  // Draggable trigger — it used to sit permanently in the bottom-right
  // corner, which on a shorter page (or a phone) sat directly on top of
  // whatever content ended up there. x/y are absolute screen coordinates for
  // a top:0/left:0 element, so dragging it just means moving these.
  const triggerRef = useRef<HTMLButtonElement>(null);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const [positioned, setPositioned] = useState(false);
  // Only ever set inside effects, so it stays null through the server
  // render — `dragConstraints` reads `window` through this, never directly
  // in the render body, which is what keeps this component SSR-safe.
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  // Set on drag start/move, read (and reset) in onClick so a drag that
  // actually moved the button doesn't also open it — the two gestures start
  // identically (a pointer going down on the button) and only diverge once
  // movement happens.
  const draggedRef = useRef(false);

  useEffect(() => {
    const btn = triggerRef.current;
    if (!btn) return;
    const { width, height } = btn.getBoundingClientRect();
    setSize({ w: width, h: height });
    // Its ORIGINAL resting spot — bottom-6 right-6, i.e. 24px from each edge —
    // is the fallback so nothing jumps on first paint for someone who has
    // never dragged it.
    const fallback = { x: window.innerWidth - width - 24, y: window.innerHeight - height - 24 };
    let pos = fallback;
    try {
      const saved = localStorage.getItem(POS_KEY);
      if (saved) pos = clamp(JSON.parse(saved), width, height);
    } catch {
      /* corrupt/blocked storage — use the default corner */
    }
    x.set(pos.x);
    y.set(pos.y);
    setPositioned(true);

    // A resize (rotating a phone, un-maximizing a window) can leave a saved
    // position outside the new viewport entirely.
    function onResize() {
      if (!btn) return;
      const { width: w, height: h } = btn.getBoundingClientRect();
      setSize({ w, h });
      const next = clamp({ x: x.get(), y: y.get() }, w, h);
      x.set(next.x);
      y.set(next.y);
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Inert {0,0,0,0} until `size` is measured client-side — that keeps this
  // expression free of `window` during the server render, and a drag can't
  // happen before the button has painted with a real position anyway.
  const dragConstraints = size
    ? {
        left: EDGE_MARGIN, top: EDGE_MARGIN,
        right: Math.max(EDGE_MARGIN, window.innerWidth - size.w - EDGE_MARGIN),
        bottom: Math.max(EDGE_MARGIN, window.innerHeight - size.h - EDGE_MARGIN),
      }
    : { left: 0, top: 0, right: 0, bottom: 0 };

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        if (onAskPage) return;
        e.preventDefault();
        setOpen((o) => !o);
      }
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onAskPage]);

  useEffect(() => {
    if (open) { setTimeout(() => inputRef.current?.focus(), 50); }
    // Closing always returns the bar to its idle start state — reopening should
    // never show a stale result or the previous prompt.
    else c.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function startOver() {
    c.reset();
    setTimeout(() => inputRef.current?.focus(), 10);
  }

  /** Idle: nothing has been asked yet, so the briefing is what's on screen. */
  const showExamples = !c.res && !c.info && !c.swap && !c.loading && !c.err;

  const res = c.res;
  const StatusIcon = res ? STATUS_ICON[res.decision] ?? AlertTriangle : null;

  return (
    <>
      {!onAskPage && (
      <motion.button
        ref={triggerRef}
        drag
        dragMomentum={false}
        dragElastic={0}
        dragConstraints={dragConstraints}
        whileDrag={{ scale: 1.06 }}
        onDragStart={() => { draggedRef.current = true; }}
        onDragEnd={() => {
          try { localStorage.setItem(POS_KEY, JSON.stringify({ x: x.get(), y: y.get() })); } catch { /* private browsing */ }
          // The pointerup that ends a drag also fires a click in some
          // browsers; clear the flag just after so a REAL next tap still
          // opens the bar. requestAnimationFrame is one frame — long enough
          // to outlast that synthetic click, short enough nobody notices.
          requestAnimationFrame(() => { draggedRef.current = false; });
        }}
        onClick={() => { if (draggedRef.current) return; setOpen(true); }}
        style={{ x, y, opacity: positioned ? 1 : 0 }}
        className={`fixed left-0 top-0 z-40 flex cursor-grab items-center gap-2 touch-none rounded-full bg-primary px-4 py-3 text-sm font-medium text-primary-foreground shadow-lg shadow-primary/30 transition-opacity hover:opacity-90 active:cursor-grabbing focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${positioned ? "" : "pointer-events-none"}`}
        title="Ask PayAI — drag to move"
      >
        <Sparkles size={16} />
        Ask PayAI
        <kbd className="ml-1 hidden rounded border border-primary-foreground/30 px-1.5 py-0.5 text-[10px] opacity-80 sm:inline-block">⌘K</kbd>
      </motion.button>
      )}

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-stretch justify-center bg-background/85 sm:items-start sm:bg-background/70 sm:px-4 sm:pt-[12vh] sm:backdrop-blur-sm"
            onClick={() => setOpen(false)}
          >
            <motion.div
              // A modal overlay with no dialog role is invisible to a screen
              // reader as a modal — it reads as more page content, with no
              // signal that the rest is now inert.
              role="dialog"
              aria-modal="true"
              aria-label="Ask PayAI"
              initial={{ opacity: 0, y: -16, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -16, scale: 0.98 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              onClick={(e) => e.stopPropagation()}
              className="flex w-full flex-col overflow-hidden border-border bg-panel shadow-2xl ring-1 ring-primary/5 sm:max-w-xl sm:rounded-2xl sm:border"
            >
              {/* Search row */}
              <form
                onSubmit={(e) => { e.preventDefault(); if (c.intent.trim() && !c.loading) c.run(c.intent); }}
                className="flex items-center gap-2 border-b border-border bg-gradient-to-b from-primary/[0.04] to-transparent px-4 py-3.5"
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary-ink">
                  <Sparkles size={15} />
                </span>
                <input
                  ref={inputRef}
                  value={c.intent} onChange={(e) => c.setIntent(e.target.value)}
                  enterKeyHint="send"
                  placeholder="Tell me what to pay, swap, or automate…"
                  className="flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground/70"
                />
                {c.intent.trim() ? (
                  <button
                    type="submit"
                    disabled={c.loading}
                    aria-label="Run command"
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
                  >
                    {c.loading ? <Loader2 size={15} className="animate-spin" /> : <ArrowUpRight size={16} />}
                  </button>
                ) : (
                  <button type="button" onClick={() => setOpen(false)} aria-label="Close" className="shrink-0 rounded-md p-1 text-muted-foreground transition hover:bg-input hover:text-foreground"><X size={16} /></button>
                )}
              </form>

              <div className="flex-1 overflow-y-auto p-4 sm:max-h-[52vh] sm:flex-none">
                {/* Idle — the operator's briefing, not a blank prompt. */}
                {showExamples && (
                  <AssistantBriefing
                    ctx={ctx}
                    loading={ctxLoading}
                    onPrompt={(p) => {
                      c.setIntent(p);
                      // A complete instruction runs; a prefix (like "send ")
                      // waits for the part only the user can supply.
                      if (p.trim() && !p.endsWith(" ")) c.run(p);
                      inputRef.current?.focus();
                    }}
                  />
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
                      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${c.swap.phase === "done" ? "bg-success/12 text-success" : c.swap.phase === "error" ? "bg-danger/12 text-danger" : "bg-primary/12 text-primary-ink"}`}>
                        {c.swap.phase === "done" ? <CheckCircle2 size={18} /> : c.swap.phase === "error" ? <XCircle size={18} /> : c.swap.phase === "ready" ? <ArrowLeftRight size={18} /> : <Loader2 size={18} className="animate-spin" />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold text-foreground">
                          {SWAP_PHASE_LABEL[c.swap.phase]}
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

                    {/* Review before signing — nothing moves until Confirm is
                        pressed, same gate the payment pipeline uses. Minimum
                        output and price impact are shown here because this is
                        the ONLY point they can still be reviewed before a
                        wallet signature is requested. */}
                    {c.swap.phase === "ready" && (
                      <>
                        <div className="mt-3 space-y-1 text-xs text-muted-foreground">
                          <div className="flex items-center justify-between">
                            <span>Minimum received</span>
                            <span className="font-medium text-foreground [font-variant-numeric:tabular-nums]">
                              {c.swap.plan.quote.minAmountOut.toFixed(c.swap.plan.quote.toToken === "USDC" ? 2 : 4)} {c.swap.plan.quote.toToken}
                            </span>
                          </div>
                          {c.swap.plan.quote.priceImpact !== null && (
                            <div className="flex items-center justify-between">
                              <span>Price impact</span>
                              <span className={`font-medium [font-variant-numeric:tabular-nums] ${c.swap.plan.quote.priceImpact > 0.03 ? "text-warning" : "text-foreground"}`}>
                                ~{(c.swap.plan.quote.priceImpact * 100).toFixed(2)}%
                              </span>
                            </div>
                          )}
                        </div>
                        <div className="mt-3.5 flex gap-2">
                          <button
                            onClick={c.cancelSwapConfirm}
                            className="flex-1 rounded-lg border border-border px-3 py-2.5 text-sm font-medium text-muted-foreground transition hover:border-danger/40 hover:text-danger"
                          >
                            Cancel
                          </button>
                          <button
                            onClick={c.confirmSwap}
                            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2.5 text-sm font-medium text-primary-foreground transition hover:opacity-90"
                          >
                            {c.wallet.kind === "embedded" && <Fingerprint size={14} />} Confirm swap
                          </button>
                        </div>
                      </>
                    )}

                    {/* Every stage, so "what is it doing?" and "has my money
                        moved?" are answerable at a glance rather than from one
                        undifferentiated spinner. */}
                    {c.swap.phase !== "ready" && c.swap.phase !== "error" && (
                      <ol className="mt-3 flex items-center gap-1.5">
                        {SWAP_STAGES.map((stage) => {
                          const idx = SWAP_STAGES.indexOf(stage);
                          const at = SWAP_STAGES.indexOf(c.swap!.phase);
                          const state = at > idx ? "done" : at === idx ? "active" : "pending";
                          return (
                            <li key={stage} className="flex-1" title={SWAP_PHASE_LABEL[stage]}>
                              <span className={`block h-1 rounded-full transition-colors duration-300 ${
                                state === "done" ? "bg-success" : state === "active" ? "bg-primary" : "bg-border"
                              }`} />
                            </li>
                          );
                        })}
                      </ol>
                    )}
                    {c.swap.phase !== "ready" && c.swap.phase !== "error" && c.swap.plan.steps.length > 1 && (
                      <p className="mt-2 text-xs text-muted-foreground">
                        Step {c.swap.stepIndex + 1} of {c.swap.plan.steps.length}: {c.swap.plan.steps[c.swap.stepIndex]?.label}
                      </p>
                    )}
                    {c.swap.phase === "awaiting" && (
                      <p className="mt-2.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Wallet size={12} /> Approve in your wallet. Nothing has moved yet.
                      </p>
                    )}
                    {c.swap.phase === "error" && c.swap.error && (
                      <>
                        <p className="mt-2.5 text-xs text-danger">{c.swap.error}</p>
                        <div className="mt-2.5 flex items-center gap-2">
                          {/* Retry is offered only when nothing broadcast. After
                              a transaction is on the wire, "try again" is how
                              someone swaps twice. */}
                          {!c.swap.broadcast && (
                            <button
                              onClick={() => c.retrySwap()}
                              className="rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-foreground transition hover:border-primary/40"
                            >
                              Retry
                            </button>
                          )}
                          <a
                            href="/dashboard/support"
                            className="rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition hover:border-primary/40 hover:text-foreground"
                          >
                            Get help
                          </a>
                          {c.swap.txHash && c.swap.explorerUrl && (
                            <a
                              href={c.swap.explorerUrl} target="_blank" rel="noreferrer"
                              className="inline-flex items-center gap-1 text-xs text-muted-foreground transition hover:text-foreground"
                            >
                              Explorer <ExternalLink size={10} />
                            </a>
                          )}
                        </div>
                      </>
                    )}
                    {c.swap.phase === "done" && c.swap.explorerUrl && (
                      <a
                        href={c.swap.explorerUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 font-mono text-xs text-primary-ink transition hover:border-primary/40"
                      >
                        {short(c.swap.txHash)} <ExternalLink size={11} />
                      </a>
                    )}
                  </motion.div>
                )}

                {/* A signed transaction broadcast but confirmation didn't finish
                    yet — never a failed payment, so it gets its own reassuring
                    banner instead of the red error state. */}
                {c.pendingRecovery && (
                  <div className="flex items-start gap-2.5 rounded-lg border border-warning/30 bg-warning/10 p-3 text-sm text-warning">
                    <Loader2 size={15} className={`mt-0.5 shrink-0 ${c.recovering ? "animate-spin" : ""}`} />
                    <div className="flex-1">
                      Your transaction was sent and is safe on-chain. Confirming now, do not resend.
                    </div>
                    <button onClick={c.retryPendingConfirm} disabled={c.recovering} className="shrink-0 rounded-md border border-warning/30 px-2 py-1 text-xs disabled:opacity-50">
                      Retry
                    </button>
                  </div>
                )}

                {c.err && !c.pendingRecovery && (
                  <div className="flex items-start gap-2.5 rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger">
                    <AlertTriangle size={15} className="mt-0.5 shrink-0" /> {c.err}
                  </div>
                )}

                {/* AI CONFIRMATION — the pipeline approved this, but no
                    signature has been requested yet. Nothing signs until
                    Confirm is pressed. */}
                {c.pendingConfirm && !c.loading && (
                  <motion.div
                    initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25, ease: "easeOut" }}
                    className="rounded-xl border-2 border-primary/40 bg-gradient-to-b from-primary/[0.05] to-transparent p-4"
                  >
                    <div className="mb-3 flex items-center gap-2.5">
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-warning/12 text-warning"><Clock3 size={16} /></span>
                      <div>
                        <p className="text-sm font-semibold text-foreground">Confirm this payment</p>
                        <p className="text-xs text-muted-foreground">Review before signing — nothing moves until you confirm.</p>
                      </div>
                    </div>
                    <ConfirmDetails pending={c.pendingConfirm} kind={c.wallet.kind} />
                    <div className="mt-3.5 flex gap-2">
                      <button
                        onClick={() => { const raw = c.pendingConfirm!.confirmRawText; c.cancelConfirm(); c.setIntent(raw); inputRef.current?.focus(); }}
                        className="flex-1 rounded-lg border border-border px-3 py-2.5 text-sm font-medium text-foreground transition hover:bg-input/40"
                      >
                        Edit
                      </button>
                      <button onClick={c.cancelConfirm} className="flex-1 rounded-lg border border-border px-3 py-2.5 text-sm font-medium text-muted-foreground transition hover:border-danger/40 hover:text-danger">
                        Cancel
                      </button>
                      <button onClick={c.confirmSign} className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2.5 text-sm font-medium text-primary-foreground transition hover:opacity-90">
                        {c.wallet.kind === "embedded" && <Fingerprint size={14} />} Confirm
                      </button>
                    </div>
                  </motion.div>
                )}

                {/* The passkey prompt is a system dialog PayAI can't style, so
                    the bar says what it's waiting for — otherwise a dismissed
                    prompt leaves a panel that looks stuck. */}
                {c.walletBusy && !c.pendingConfirm && (
                  <div className="flex items-start gap-2.5 rounded-xl border border-primary/30 bg-primary/[0.04] p-4">
                    <Fingerprint size={16} className="mt-0.5 shrink-0 animate-pulse text-primary-ink" />
                    <div>
                      <p className="text-sm font-medium text-foreground">
                        {c.wallet.kind === "embedded" ? "Approve with your passkey" : "Confirm in your wallet"}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">Nothing is signed or sent until you do.</p>
                    </div>
                  </div>
                )}

                {res && !c.loading && !c.pendingConfirm && (
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
                        className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 font-mono text-xs text-primary-ink transition hover:border-primary/40"
                      >
                        {short(res.transaction.txHash)} <ExternalLink size={11} />
                      </a>
                    )}
                  </motion.div>
                )}

                {c.info && !c.loading && (
                  <div className="rounded-xl border border-border bg-input/30 p-4 text-sm text-foreground">
                    {c.info.query === "show_history"
                      ? `You have ${c.info.count ?? c.info.history?.length ?? 0} recorded transaction${(c.info.count ?? 0) === 1 ? "" : "s"}.`
                      : c.info.query === "show_balance"
                        ? c.info.balance
                          ? `Your wallet holds ${c.info.balance.mon.toFixed(4)} MON and ${c.info.balance.usdc.toFixed(2)} USDC.`
                          : c.info.error ?? "Couldn't read your balance."
                        : c.info.query === "scheduled_payment"
                          ? c.info.error ?? "Payment Automations are available in the Automations dashboard."
                          : c.info.compliance
                            ? `${Math.round(c.info.compliance.approvalRate * 100)}% approval rate across your payments.`
                            : "No data yet."}
                  </div>
                )}

                {/* Once a command reaches a terminal state, offer a clean reset
                    back to the start instead of leaving the old result sitting. */}
                {((res && !c.loading && !c.pendingConfirm) || c.info || c.err || (c.swap && (c.swap.phase === "done" || c.swap.phase === "error"))) && (
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
              <div className="flex items-center justify-between border-t border-border px-4 pb-[calc(0.625rem+env(safe-area-inset-bottom))] pt-2.5 text-[11px] text-muted-foreground">
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
