"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { MessageSquare, ShieldCheck, Fingerprint, Zap, CheckCircle2 } from "lucide-react";
import { MonadMark } from "@/components/MonadMark";

/** The real Send Payment lifecycle, animated the same way as the automation
 *  showcase: describe → verify → approve → confirmed. Not a mock; this is
 *  exactly how a wallet-signed instant payment settles on Monad. */
const STAGES = [
  { key: "describe", icon: MessageSquare, label: "Describe payment" },
  { key: "verify", icon: ShieldCheck, label: "Verify recipient" },
  { key: "approve", icon: Fingerprint, label: "Approve" },
  { key: "confirmed", icon: CheckCircle2, label: "Confirmed" },
] as const;

export function SendPaymentWorkflow({ active = true }: { active?: boolean }) {
  const reduce = useReducedMotion();
  const [i, setI] = useState(0);

  useEffect(() => {
    if (reduce || !active) { setI(STAGES.length - 1); return; }
    const t = setInterval(() => setI((n) => (n + 1) % STAGES.length), 2600);
    return () => clearInterval(t);
  }, [reduce, active]);

  const stage = STAGES[i];

  return (
    <div className="relative">
      <div className="overflow-hidden rounded-2xl surface-purple">
        <div className="flex items-center gap-2 border-b border-border bg-background px-4 py-2.5">
          <span className="h-2 w-2 rounded-full bg-border" />
          <span className="h-2 w-2 rounded-full bg-border" />
          <span className="h-2 w-2 rounded-full bg-border" />
          <div className="ml-2 flex items-center gap-1.5 rounded-full border border-border bg-panel px-2 py-0.5 text-[10px] text-muted-foreground">
            usepayai.xyz/dashboard/payments
          </div>
        </div>

        <div className="grid grid-cols-[128px_1fr]">
          <div className="border-r border-border bg-background/40 p-3">
            {STAGES.map((s, idx) => {
              const done = idx < i;
              const now = idx === i;
              const Icon = s.icon;
              return (
                <div key={s.key} className="flex items-center gap-2 py-2">
                  <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full transition-colors duration-300 ${now ? "bg-primary text-primary-foreground" : done ? "bg-primary/20 text-primary-ink" : "bg-input text-muted-foreground/50"}`}>
                    <Icon size={11} />
                  </span>
                  <span className={`text-[10px] leading-tight transition-colors duration-300 ${now ? "font-medium text-foreground" : done ? "text-muted-foreground" : "text-muted-foreground/50"}`}>{s.label}</span>
                </div>
              );
            })}
          </div>

          <div className="relative min-h-[268px] p-5">
            <AnimatePresence mode="wait">
              <motion.div
                key={stage.key}
                initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.3, ease: "easeOut" }}
              >
                {stage.key === "describe" && (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 text-sm font-semibold text-foreground"><MessageSquare size={15} className="text-primary-ink" /> Ask PayAI</div>
                    <div className="rounded-lg border border-border bg-gradient-to-b from-primary/[0.05] to-transparent p-3 text-xs text-foreground">
                      &ldquo;Send 50 USDC to gentle.nad&rdquo;
                    </div>
                    <div className="h-8 rounded-lg border border-dashed border-border" />
                  </div>
                )}

                {stage.key === "verify" && (
                  <div className="space-y-2.5">
                    {[
                      { k: "Recipient", v: "gentle.nad" },
                      { k: "Resolved address", v: "0x0264…38F7f" },
                      { k: "Amount", v: "50 USDC" },
                    ].map((row, ri) => (
                      <motion.div key={row.k} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: ri * 0.12 }} className="flex items-center justify-between rounded-lg border border-border bg-gradient-to-b from-primary/[0.05] to-transparent px-3 py-2.5">
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{row.k}</span>
                        <span className="text-xs font-semibold text-primary-ink">{row.v}</span>
                      </motion.div>
                    ))}
                    <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground"><ShieldCheck size={11} className="text-primary-ink" /> Compliance checked, cleared</div>
                  </div>
                )}

                {stage.key === "approve" && (
                  <div className="flex flex-col items-center justify-center gap-3 py-6 text-center">
                    <motion.span initial={{ scale: 0.85 }} animate={{ scale: 1 }} className="flex h-14 w-14 items-center justify-center text-primary"><Fingerprint size={32} /></motion.span>
                    <p className="text-sm font-semibold text-foreground">Approve in your wallet</p>
                    <p className="max-w-[200px] text-[11px] text-muted-foreground">You confirm every payment yourself. Nothing sends without it.</p>
                    <div className="mt-1 rounded-lg bg-primary px-4 py-2 text-[11px] font-medium text-primary-foreground">Sign</div>
                  </div>
                )}

                {stage.key === "confirmed" && (
                  <div className="flex flex-col items-center justify-center gap-3 py-5 text-center">
                    <motion.span initial={{ scale: 0.7, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 260, damping: 16 }} className="flex h-14 w-14 items-center justify-center rounded-2xl bg-success/12 text-success"><Zap size={26} /></motion.span>
                    <p className="text-sm font-semibold text-foreground">Sent in seconds</p>
                    <div className="flex items-center gap-1.5 rounded-full border border-border bg-panel px-2.5 py-1 text-[10px] text-muted-foreground">
                      <MonadMark size={10} /> 0x7ab1…c93d
                    </div>
                    <p className="text-[11px] text-muted-foreground">Recorded on-chain. Receipt saved to history.</p>
                  </div>
                )}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
        <span>Describe it</span><span className="text-muted-foreground/40">→</span><span>Approve once</span><span className="text-muted-foreground/40">→</span><span className="text-primary-ink">Arrives in seconds</span>
      </div>
    </div>
  );
}
