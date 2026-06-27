"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { Sparkles, X } from "lucide-react";
import { PipelineStepper } from "@/components/PipelineStepper";
import { Badge } from "@/components/ui";
import { useAgentConsole, DECISION, short } from "@/lib/hooks/useAgentConsole";

const EXAMPLES = ["Send 5 MON to gentle.nads", "Create invoice for 50 USDC", "Show today's transactions"];

/**
 * AI Command Bar — Cmd+K (or the floating button) opens a focused overlay
 * that runs ONE command through the real agent pipeline and shows the
 * result inline, then closes. This is the AI surface the spec calls for:
 * an assistant feature living on top of the dashboard, not a chat page that
 * replaces it.
 */
export function CommandBar() {
  const [open, setOpen] = useState(false);
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
    if (open) setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-40 flex items-center gap-2 rounded-full bg-primary px-4 py-3 text-sm font-medium text-primary-foreground shadow-lg shadow-primary/30 transition hover:opacity-90"
      >
        <Sparkles size={16} />
        Ask PayAI
        <kbd className="ml-1 rounded border border-primary-foreground/30 px-1.5 py-0.5 text-[10px] opacity-80">⌘K</kbd>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[12vh]"
            onClick={() => setOpen(false)}
          >
            <motion.div
              initial={{ opacity: 0, y: -16, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -16, scale: 0.98 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-lg rounded-xl border border-border bg-panel shadow-2xl"
            >
              <div className="flex items-center gap-2 border-b border-border px-4 py-3">
                <Sparkles size={16} className="text-primary" />
                <input
                  ref={inputRef}
                  value={c.intent} onChange={(e) => c.setIntent(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && c.intent && c.run(c.intent)}
                  placeholder="Send 5 MON to gentle.nads…"
                  className="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
                />
                <button onClick={() => setOpen(false)} aria-label="Close" className="text-muted-foreground hover:text-foreground"><X size={16} /></button>
              </div>

              <div className="max-h-[50vh] overflow-y-auto p-4">
                {!c.res && !c.info && !c.loading && (
                  <div className="flex flex-wrap gap-2">
                    {EXAMPLES.map((ex) => (
                      <button key={ex} onClick={() => { c.setIntent(ex); c.run(ex); }}
                        className="rounded-full border border-border bg-input px-3 py-1.5 text-xs text-muted-foreground hover:border-primary/50 hover:text-primary">{ex}</button>
                    ))}
                  </div>
                )}

                {c.loading && (
                  <div className="py-2">
                    <PipelineStepper steps={c.steps} />
                  </div>
                )}

                {c.err && <p className="text-sm text-danger">{c.err}</p>}

                {c.res && (
                  <div>
                    <div className="mb-2 flex items-center gap-2">
                      <Badge tone={DECISION[c.res.decision].tone}>{DECISION[c.res.decision].label}</Badge>
                      <span className="text-xs text-muted-foreground">{Math.round(c.res.confidence * 100)}% confidence</span>
                    </div>
                    <p className="text-sm text-foreground">{c.res.intent.summary}</p>
                    {c.res.transaction?.txHash && (
                      <a href={c.res.transaction.explorerUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block font-mono text-xs text-primary hover:underline">
                        {short(c.res.transaction.txHash)} — verify on-chain ↗
                      </a>
                    )}
                    {c.res.guardrail.violations.length > 0 && <p className="mt-2 text-xs text-danger">{c.res.guardrail.violations.join(" ")}</p>}
                  </div>
                )}

                {c.info && (
                  <div className="text-sm text-foreground">
                    {c.info.query === "show_history"
                      ? `${c.info.count ?? c.info.history?.length ?? 0} recorded transaction(s).`
                      : c.info.compliance ? `${Math.round(c.info.compliance.approvalRate * 100)}% approval rate.` : "No data."}
                  </div>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
