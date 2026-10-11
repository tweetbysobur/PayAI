"use client";

import { motion } from "motion/react";
import { Send, ArrowLeftRight, Clock3, Wallet, ArrowUpRight, PencilLine, ShieldCheck } from "lucide-react";
import { AskLogo } from "@/components/AskMark";
import { ASK_STARTERS } from "@/components/landing/intentExamples";
import { MARKETING_ORIGIN } from "@/lib/hosts";

/**
 * CAPABILITY_SHORTCUTS: the four spoken on-ramps ("Send a payment", "Trade a
 * token"…). The welcome screen no longer shows them — it teaches how to ask
 * and offers real prompts instead (AskEmptyState below) — but the hidden
 * "coming soon" placeholder on /dashboard/ask still lists them, and their
 * labels stay valid requests: each one, typed, still reaches the right intent
 * (test/ask-swap-trade-entry.test.ts, test/ask-trade.test.ts). A hint
 * describes what the tile reaches, never what to type.
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

/** The three things a request needs, shown on the welcome screen. */
const HOW_TO_ASK = [
  "Say the action, the amount and the token.",
  "Name who it\u2019s for \u2014 a 0x address, a .nad name or a saved payee.",
  "Join steps with \u201Cand\u201D or \u201Cthen\u201D \u2014 they run in order.",
];

/**
 * Ask PayAI's welcome screen: how to phrase a request, and real prompts to
 * start from. It teaches the one thing the product does — turn a sentence
 * into onchain execution — instead of offering a menu of features.
 *
 * Picking a prompt FILLS the message box (onFill) and focuses it; it is never
 * sent as is. The names in the prompts are examples, and sending one straight
 * away would start a plan to pay someone the user never chose. Every prompt
 * comes from ASK_STARTERS and is checked against the real product in
 * test/intent-examples.test.ts.
 *
 * Type sizes stay moderate on both phone and desktop (sm/base headings, 13–14px
 * body) so the screen reads as a note, not a poster, and fits a phone without
 * a long scroll.
 */
export function AskEmptyState({ onFill }: { onFill: (text: string) => void }) {
  function pick(text: string) {
    onFill(text);
    // Hand the cursor to the box the prompt went into, so editing the example
    // names is the obvious next step.
    requestAnimationFrame(() => {
      const boxes = [...document.querySelectorAll<HTMLTextAreaElement>('textarea[aria-label="Message Ask PayAI"]')];
      const box = boxes.reverse().find((b) => b.offsetParent !== null);
      if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
    });
  }

  return (
    <div className="flex min-h-full flex-col items-center justify-center px-4 py-5 sm:py-8">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: "easeOut" }}
        className="w-full max-w-xl"
      >
        {/* The surrounding page or command bar already names Ask PayAI; this
            opens with what it does instead of repeating the name. */}
        <div className="flex items-start gap-3">
          <AskLogo size={26} className="mt-0.5 shrink-0 text-primary" />
          <div className="min-w-0">
            <p className="text-[15px] font-medium tracking-tight text-foreground sm:text-base">Turn a sentence into onchain execution.</p>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground sm:text-sm">
              Describe what you want done on Monad. PayAI turns it into a plan you review before anything runs.
            </p>
          </div>
        </div>

        <section aria-labelledby="ask-how-title" className="mt-5 rounded-xl border border-border bg-panel/60 p-4">
          <h2 id="ask-how-title" className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-primary-ink">How to ask</h2>
          <ol className="mt-3 space-y-2">
            {HOW_TO_ASK.map((t, i) => (
              <li key={t} className="flex gap-2.5 text-[13px] leading-relaxed text-foreground/90 sm:text-sm">
                <span aria-hidden className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-border font-mono text-[10px] text-muted-foreground">{i + 1}</span>
                <span>{t}</span>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="ask-try-title" className="mt-5">
          <div className="flex items-baseline justify-between gap-3">
            <h2 id="ask-try-title" className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">Start from a prompt</h2>
            <span className="text-[11px] text-muted-foreground/80">Opens in the box to edit</span>
          </div>
          <ul className="mt-2 divide-y divide-border overflow-hidden rounded-xl border border-border">
            {ASK_STARTERS.map((s) => (
              <li key={s.say}>
                <button
                  type="button"
                  onClick={() => pick(s.say)}
                  className="group flex w-full items-center gap-3 bg-background/40 px-3.5 py-2.5 text-left transition-colors hover:bg-input/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-[11px] text-muted-foreground">{s.label}</span>
                    <span className="mt-0.5 block break-words font-mono text-[12.5px] leading-snug text-foreground sm:text-[13px]">{s.say}</span>
                  </span>
                  <PencilLine size={14} aria-hidden className="shrink-0 text-muted-foreground transition-colors group-hover:text-primary-ink" />
                </button>
              </li>
            ))}
          </ul>
        </section>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs text-muted-foreground">
          <p className="flex items-center gap-1.5">
            <ShieldCheck size={13} aria-hidden className="shrink-0 text-primary-ink" />
            Nothing moves until you review and sign.
          </p>
          <a
            href={`${MARKETING_ORIGIN}/intents`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-sm font-medium text-primary-ink transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            More examples <ArrowUpRight size={12} aria-hidden />
          </a>
        </div>
      </motion.div>
    </div>
  );
}
