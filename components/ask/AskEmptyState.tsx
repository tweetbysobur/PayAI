"use client";

import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { Send, ArrowLeftRight, Clock3, Wallet, ArrowUpRight, ShieldCheck } from "lucide-react";
import { AskLogo } from "@/components/AskMark";
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

/** The three things a request needs. */
const HOW_TO_ASK = [
  "Say the action, the amount and the token.",
  "Name who it\u2019s for \u2014 a 0x address, a .nad name or a saved payee.",
  "Join steps with \u201Cand\u201D or \u201Cthen\u201D \u2014 they run in order.",
];

const HOW_TO_SEEN_KEY = "payai_ask_howto_seen";

/**
 * Ask PayAI's empty chat. One line on what it does; the first time only, the
 * three points of how to ask (no worked examples — the full guide is linked).
 * After that the points are not shown again, so the chat stays quiet.
 * Moderate type on phone and desktop.
 */
export function AskEmptyState() {
  // null until read on the client, so the server render and the first client
  // render agree and the points never flash for a returning user.
  const [showHowTo, setShowHowTo] = useState<boolean | null>(null);
  useEffect(() => {
    let seen = false;
    try { seen = localStorage.getItem(HOW_TO_SEEN_KEY) === "1"; } catch { /* storage blocked */ }
    setShowHowTo(!seen);
    if (!seen) { try { localStorage.setItem(HOW_TO_SEEN_KEY, "1"); } catch { /* storage blocked */ } }
  }, []);

  return (
    <div className="flex min-h-full flex-col items-center justify-center px-4 py-6 sm:py-10">
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25, ease: "easeOut" }}
        className="w-full max-w-md text-center"
      >
        <AskLogo size={30} className="mx-auto text-primary" />
        <p className="mt-3 text-[15px] font-medium tracking-tight text-foreground sm:text-base">Turn a sentence into onchain execution.</p>
        <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground sm:text-sm">
          Describe what you want done. You review the plan before anything runs.
        </p>

        {showHowTo && (
          <section aria-labelledby="ask-how-title" className="mt-5 rounded-xl border border-border bg-panel/60 p-4 text-left">
            <h2 id="ask-how-title" className="font-mono text-[11px] font-medium uppercase tracking-[0.12em] text-primary-ink">How to ask</h2>
            <ol className="mt-3 space-y-2">
              {HOW_TO_ASK.map((t, i) => (
                <li key={t} className="flex gap-2.5 text-[13px] leading-relaxed text-foreground/90 sm:text-sm">
                  <span aria-hidden className="mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-primary text-[10px] font-semibold text-white">{i + 1}</span>
                  <span>{t}</span>
                </li>
              ))}
            </ol>
          </section>
        )}

        <div className="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
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
            How to ask <ArrowUpRight size={12} aria-hidden />
          </a>
        </div>
      </motion.div>
    </div>
  );
}
