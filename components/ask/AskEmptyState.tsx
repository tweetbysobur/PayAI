"use client";

import { motion } from "motion/react";
import { Sparkles, Send, ArrowLeftRight, Clock3, Wallet } from "lucide-react";

/**
 * Optional, entirely bypassable on-ramps — never a form, never a hint at
 * required wording. Clicking one sends its label as an ordinary chat message
 * through the exact same understanding pipeline as anything typed by hand;
 * there is no special-cased path for these four strings. A user who ignores
 * every one of them and types something completely different is the normal
 * case, not a degraded one.
 */
export interface CapabilityShortcut {
  label: string;
  icon: typeof Send;
}

export const CAPABILITY_SHORTCUTS: CapabilityShortcut[] = [
  { label: "Send payment", icon: Send },
  { label: "Swap tokens", icon: ArrowLeftRight },
  { label: "Schedule payment", icon: Clock3 },
  { label: "Check balance", icon: Wallet },
];

export function AskEmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-4 py-12">
      <motion.div
        initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: "easeOut" }}
        className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/12 text-primary-ink sm:h-14 sm:w-14"
      >
        <Sparkles size={22} className="sm:hidden" />
        <Sparkles size={26} className="hidden sm:block" />
      </motion.div>
      <motion.h1
        initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05, duration: 0.35 }}
        className="mt-3 text-xl font-semibold tracking-tight text-foreground sm:mt-4 sm:text-2xl"
      >
        Ask PayAI
      </motion.h1>
      <motion.p
        initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1, duration: 0.35 }}
        className="mt-2 max-w-md text-center text-xs leading-relaxed text-muted-foreground sm:text-sm"
      >
        Tell me what you want to do, in your own words. Nothing moves until you confirm and sign.
      </motion.p>

      <motion.div
        initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15, duration: 0.35 }}
        className="mt-8 flex flex-wrap items-center justify-center gap-2"
      >
        {CAPABILITY_SHORTCUTS.map((s, i) => {
          const Icon = s.icon;
          return (
            <motion.button
              key={s.label}
              initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.18 + i * 0.04, duration: 0.3 }}
              onClick={() => onPick(s.label)}
              className="group flex items-center gap-1.5 rounded-full border border-border bg-panel px-3.5 py-1.5 text-xs font-medium text-muted-foreground transition-all duration-150 hover:-translate-y-0.5 hover:border-primary/40 hover:bg-input/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Icon size={13} className="text-muted-foreground transition group-hover:text-primary-ink" />
              {s.label}
            </motion.button>
          );
        })}
      </motion.div>
    </div>
  );
}
