"use client";

import { motion } from "motion/react";
import { Send, ArrowLeftRight, Clock3, Wallet, ArrowRight, ShieldCheck } from "lucide-react";
import { AskLogo } from "@/components/AskMark";

/**
 * Optional, entirely bypassable on-ramps — never a form, never a hint at
 * required wording. Clicking one sends its LABEL as an ordinary chat message
 * through the exact same understanding pipeline as anything typed by hand;
 * there is no special-cased path for these four strings. A user who ignores
 * every one of them and types something completely different is the normal
 * case, not a degraded one.
 *
 * `hint` is display-only and is never sent — the label alone is the message.
 * Keeping them separate is what lets the tile say more than the user has to.
 *
 * ── The labels are phrased as intents, and that is load-bearing ─────────────
 * Each label reads the way someone would actually say it out loud, because the
 * product's whole premise is "tell me what you want, in your own words" — a
 * row of terse console commands argues against that on the very first screen.
 *
 * "Trade" replaces the old "Swap tokens" for both reasons. It is the plainer
 * word, and it names the better of two genuinely different capabilities:
 * `swap` is a mechanical MON/USDC-style exchange, while `trade` produces a
 * real quote preview for ANY Monad token and understands buy/sell direction,
 * dollar amounts and percentage-of-balance. The tile should open the richer
 * door, and its hint names that breadth — buy or sell, any token — rather than
 * quoting a worked example with a figure in it. Every hint here describes what
 * the tile reaches, never what to type: a concrete "buy $50 of X" reads as a
 * command to copy, which is the opposite of "say it in your own words", and it
 * puts an arbitrary amount in front of someone who has not chosen one yet.
 *
 * Every label here was run through the real classifier rather than assumed.
 * All four reach Anthropic in production (routeRequest returns anthropic=true),
 * so the phrasing is understood semantically. Two of them — "Trade a token"
 * and "Automate a payment" — previously dead-ended at `unclear` in the
 * key-free fallback, so that path was taught to recognize them too (see
 * TRADE_SIGNAL_RE's anchored trade clause in lib/ask/intent/classify.ts and
 * `automate` in lib/agent/brain.ts's schedule detector). A shortcut should not
 * become a dead end just because the model is briefly unreachable.
 */
export interface CapabilityShortcut {
  label: string;
  hint: string;
  icon: typeof Send;
}

export const CAPABILITY_SHORTCUTS: CapabilityShortcut[] = [
  { label: "Send a payment", hint: "To any wallet or .nad name.", icon: Send },
  { label: "Trade a token", hint: "Buy or sell any token on Monad.", icon: ArrowLeftRight },
  { label: "Automate a payment", hint: "Set it once, it runs on its own.", icon: Clock3 },
  { label: "Check my balance", hint: "See everything your wallet holds.", icon: Wallet },
];

export function AskEmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-4 py-10 sm:py-12">
      {/* The identity block. Mirrors the dashboard's welcome card and the
          landing hero — a purple wash behind the mark, then confident display
          type — rather than the flat icon-and-paragraph this used to be. */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: "easeOut" }}
        className="relative flex flex-col items-center"
      >
        {/* Decorative glow. Sits behind the mark and is inert to pointers so it
            can never intercept a click meant for the tiles below. */}
        <div
          aria-hidden
          className="pointer-events-none absolute -top-10 left-1/2 h-32 w-56 -translate-x-1/2 rounded-full bg-primary/20 blur-3xl"
        />
        <AskLogo size={48} className="relative text-primary" />
      </motion.div>

      <motion.h1
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.05, duration: 0.35 }}
        className="mt-5 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl"
      >
        Ask PayAI
      </motion.h1>

      <motion.p
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1, duration: 0.35 }}
        className="mt-2 max-w-md text-center text-sm leading-relaxed text-muted-foreground"
      >
        Tell me what you want to do, in your own words.
      </motion.p>

      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15, duration: 0.35 }}
        className="mt-8 grid w-full max-w-xl grid-cols-1 gap-2.5 sm:grid-cols-2"
      >
        {CAPABILITY_SHORTCUTS.map((s, i) => {
          const Icon = s.icon;
          return (
            <motion.button
              key={s.label}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.18 + i * 0.04, duration: 0.3 }}
              onClick={() => onPick(s.label)}
              className="group flex items-start gap-3 rounded-xl border border-border bg-panel p-3.5 text-left transition-all duration-150 hover:-translate-y-0.5 hover:border-primary/40 hover:bg-input/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary-ink transition group-hover:bg-primary/20">
                <Icon size={16} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
                  {s.label}
                  <ArrowRight
                    size={13}
                    className="shrink-0 text-muted-foreground transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-primary-ink"
                  />
                </span>
                <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{s.hint}</span>
              </span>
            </motion.button>
          );
        })}
      </motion.div>

      {/* The non-custodial promise, stated once where it reassures rather than
          buried in the composer's fine print alone. */}
      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.34, duration: 0.35 }}
        className="mt-7 flex items-center gap-1.5 text-xs text-muted-foreground/80"
      >
        <ShieldCheck size={13} className="shrink-0 text-primary-ink" />
        Nothing moves until you confirm and sign.
      </motion.p>
    </div>
  );
}
