"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { PlusCircle, SlidersHorizontal, Fingerprint, Repeat, Zap, CheckCircle2, ArrowRight } from "lucide-react";
import { MonadMark } from "@/components/MonadMark";

/** The six lifecycle stages of a real PayAI automation, animated in a
 *  dashboard-framed showcase. Not a mock illustration — it mirrors the exact
 *  flow the product runs: create → configure → approve → active → execute →
 *  confirmed. Auto-advances; respects reduced-motion by holding on the
 *  "confirmed" state. */
const STAGES = [
  { key: "create", icon: PlusCircle, label: "Create Automation" },
  { key: "configure", icon: SlidersHorizontal, label: "Configure payment" },
  { key: "approve", icon: Fingerprint, label: "Approve" },
  { key: "active", icon: Repeat, label: "Automation Active" },
  { key: "execute", icon: Zap, label: "Payment Executes" },
  { key: "confirmed", icon: CheckCircle2, label: "Transaction Confirmed" },
] as const;

export function AutomationWorkflow({ active = true }: { active?: boolean }) {
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
      <div className="overflow-hidden rounded-2xl border border-border bg-panel shadow-2xl">
        {/* Browser chrome */}
        <div className="flex items-center gap-2 border-b border-border bg-background px-4 py-2.5">
          <span className="h-2 w-2 rounded-full bg-border" />
          <span className="h-2 w-2 rounded-full bg-border" />
          <span className="h-2 w-2 rounded-full bg-border" />
          <div className="ml-2 flex items-center gap-1.5 rounded-full border border-border bg-panel px-2 py-0.5 text-[10px] text-muted-foreground">
            usepayai.xyz/dashboard/automations
          </div>
        </div>

        <div className="grid grid-cols-[128px_1fr]">
          {/* Stage rail */}
          <div className="border-r border-border bg-background/40 p-3">
            {STAGES.map((s, idx) => {
              const done = idx < i;
              const now = idx === i;
              const Icon = s.icon;
              return (
                <div key={s.key} className="flex items-center gap-2 py-1.5">
                  <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full transition-colors duration-300 ${now ? "bg-primary text-primary-foreground" : done ? "bg-primary/20 text-primary-ink" : "bg-input text-muted-foreground/50"}`}>
                    <Icon size={11} />
                  </span>
                  <span className={`text-[10px] leading-tight transition-colors duration-300 ${now ? "font-medium text-foreground" : done ? "text-muted-foreground" : "text-muted-foreground/50"}`}>{s.label}</span>
                </div>
              );
            })}
          </div>

          {/* Stage content */}
          <div className="relative min-h-[268px] p-5">
            <AnimatePresence mode="wait">
              <motion.div
                key={stage.key}
                initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.3, ease: "easeOut" }}
              >
                {stage.key === "create" && (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 text-sm font-semibold text-foreground"><PlusCircle size={15} className="text-primary-ink" /> New automation</div>
                    <div className="grid grid-cols-2 gap-2">
                      {["Wallet Automation", "Reserved Funds"].map((m, mi) => (
                        <div key={m} className={`rounded-lg border p-3 text-[11px] font-medium ${mi === 0 ? "border-primary/50 bg-primary/[0.06] text-foreground" : "border-border text-muted-foreground"}`}>{m}</div>
                      ))}
                    </div>
                    <div className="h-8 rounded-lg border border-dashed border-border" />
                  </div>
                )}

                {stage.key === "configure" && (
                  <div className="space-y-2.5">
                    {[
                      { k: "Recipient", v: "gentle.nad" },
                      { k: "Amount", v: "250 USDC" },
                      { k: "Schedule", v: "Every 1st, monthly" },
                    ].map((row, ri) => (
                      <motion.div key={row.k} initial={{ opacity: 0, x: 8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: ri * 0.12 }} className="flex items-center justify-between rounded-lg border border-border bg-gradient-to-b from-primary/[0.05] to-transparent px-3 py-2.5">
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{row.k}</span>
                        <span className="text-xs font-semibold text-primary-ink">{row.v}</span>
                      </motion.div>
                    ))}
                  </div>
                )}

                {stage.key === "approve" && (
                  <div className="flex flex-col items-center justify-center gap-3 py-6 text-center">
                    <motion.span initial={{ scale: 0.85 }} animate={{ scale: 1 }} className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/12 text-primary-ink"><Fingerprint size={26} /></motion.span>
                    <p className="text-sm font-semibold text-foreground">Approve in your wallet</p>
                    <p className="max-w-[200px] text-[11px] text-muted-foreground">One signature authorizes the schedule. Your keys never leave your wallet.</p>
                    <div className="mt-1 rounded-lg bg-primary px-4 py-2 text-[11px] font-medium text-primary-foreground">Sign</div>
                  </div>
                )}

                {stage.key === "active" && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold text-foreground">Payroll · 250 USDC</span>
                      <span className="rounded-md bg-primary/12 px-2 py-0.5 text-[10px] font-medium text-primary-ink">Active</span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-[11px]">
                      <div className="rounded-lg border border-border bg-gradient-to-b from-primary/[0.05] to-transparent px-3 py-2"><p className="text-muted-foreground">Next run</p><p className="mt-0.5 font-semibold text-primary-ink">Aug 1, 09:00</p></div>
                      <div className="rounded-lg border border-border bg-gradient-to-b from-primary/[0.05] to-transparent px-3 py-2"><p className="text-muted-foreground">Recipient</p><p className="mt-0.5 font-semibold text-primary-ink">gentle.nad</p></div>
                    </div>
                    <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground"><span className="h-1.5 w-1.5 rounded-full bg-primary" /> PayAI is monitoring this automation</div>
                  </div>
                )}

                {stage.key === "execute" && (
                  <div className="flex flex-col items-center justify-center gap-3 py-6 text-center">
                    <motion.span animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 1.1, ease: "linear" }} className="flex h-14 w-14 items-center justify-center rounded-full border-2 border-primary/30 border-t-primary text-primary-ink"><Zap size={22} /></motion.span>
                    <p className="text-sm font-semibold text-foreground">Executing on Monad</p>
                    <p className="text-[11px] text-muted-foreground">Sending 250 USDC → gentle.nad</p>
                  </div>
                )}

                {stage.key === "confirmed" && (
                  <div className="flex flex-col items-center justify-center gap-3 py-5 text-center">
                    <motion.span initial={{ scale: 0.7, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 260, damping: 16 }} className="flex h-14 w-14 items-center justify-center rounded-2xl bg-success/12 text-success"><CheckCircle2 size={28} /></motion.span>
                    <p className="text-sm font-semibold text-foreground">Payment confirmed</p>
                    <div className="flex items-center gap-1.5 rounded-full border border-border bg-panel px-2.5 py-1 text-[10px] text-muted-foreground">
                      <MonadMark size={10} /> 0x9f3c…a71b
                    </div>
                    <p className="text-[11px] text-muted-foreground">Recorded on-chain. Receipt saved to history.</p>
                  </div>
                )}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </div>

      {/* Caption */}
      <div className="mt-3 flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
        <span>Create</span><ArrowRight size={10} /><span>Approve once</span><ArrowRight size={10} /><span className="text-primary-ink">Runs on its own</span>
      </div>
    </div>
  );
}
