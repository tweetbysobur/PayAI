"use client";

import { motion } from "motion/react";
import { Sparkles, Send, Clock3, Wallet, ArrowLeftRight, Users, Search } from "lucide-react";

export interface SuggestedPrompt {
  label: string;
  prompt: string;
  icon: typeof Send;
}

export const SUGGESTED_PROMPTS: SuggestedPrompt[] = [
  { label: "Send a payment", prompt: "Send 50 USDC to alex.nad", icon: Send },
  { label: "Schedule a payment", prompt: "Schedule 100 USDC to my contributor every Friday", icon: Clock3 },
  { label: "Check my balance", prompt: "How much MON do I have?", icon: Wallet },
  { label: "Swap tokens", prompt: "Swap 20 MON to USDC", icon: ArrowLeftRight },
  { label: "Distribute to multiple wallets", prompt: "Send 10 USDC to these 100 wallets", icon: Users },
  { label: "Explain my last transaction", prompt: "Why did my last payment fail?", icon: Search },
];

export function AskEmptyState({ onPick }: { onPick: (prompt: string) => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-4 py-12">
      <motion.div
        initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: "easeOut" }}
        className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/12 text-primary-ink"
      >
        <Sparkles size={26} />
      </motion.div>
      <motion.h1
        initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05, duration: 0.35 }}
        className="mt-4 text-2xl font-semibold tracking-tight text-foreground"
      >
        Ask PayAI
      </motion.h1>
      <motion.p
        initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1, duration: 0.35 }}
        className="mt-2 max-w-md text-center text-sm leading-relaxed text-muted-foreground"
      >
        Describe what you want to do — send a payment, schedule one, swap tokens, pay a whole list of
        wallets — and PayAI prepares it for your review. Nothing moves until you confirm and sign.
      </motion.p>

      <motion.div
        initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15, duration: 0.35 }}
        className="mt-8 grid w-full max-w-2xl grid-cols-1 gap-2.5 sm:grid-cols-2"
      >
        {SUGGESTED_PROMPTS.map((p, i) => {
          const Icon = p.icon;
          return (
            <motion.button
              key={p.label}
              initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.18 + i * 0.04, duration: 0.3 }}
              onClick={() => onPick(p.prompt)}
              className="group flex items-center gap-3 rounded-xl border border-border bg-panel px-4 py-3.5 text-left transition-all duration-150 hover:-translate-y-0.5 hover:border-primary/40 hover:bg-input/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-input text-muted-foreground transition group-hover:bg-primary/12 group-hover:text-primary-ink">
                <Icon size={16} />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium text-foreground">{p.label}</span>
                <span className="block truncate text-xs text-muted-foreground">{p.prompt}</span>
              </span>
            </motion.button>
          );
        })}
      </motion.div>
    </div>
  );
}
