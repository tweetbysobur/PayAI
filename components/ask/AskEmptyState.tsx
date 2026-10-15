"use client";

import { motion } from "motion/react";
import { Send, ArrowLeftRight, Clock3, Wallet } from "lucide-react";
import { AskLogo } from "@/components/AskMark";

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

/**
 * Ask PayAI's empty chat: the logo, one line on what it does, and one line on
 * how it works. Nothing else — no tips, no examples, no buttons.
 */
export function AskEmptyState() {
  return (
    // Centred in a short panel (the command bar), but on a very tall screen
    // the space above is capped so the text doesn't float mid-screen: the
    // top spacer stops growing at 10rem, the bottom one takes the rest.
    <div className="flex min-h-full flex-col items-center px-4 py-6 sm:py-10">
      <div aria-hidden className="max-h-40 min-h-0 flex-1 basis-0" />
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25, ease: "easeOut" }}
        className="flex w-full max-w-md items-start gap-3"
      >
        <AskLogo size={26} className="mt-0.5 shrink-0 text-primary" />
        <div className="min-w-0">
          <p className="text-[15px] font-medium tracking-tight text-foreground sm:text-base">Say what you want done.</p>
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground sm:text-sm">
            Send, swap or schedule on Monad in plain words. You review the plan before anything runs.
          </p>
        </div>
      </motion.div>
      <div aria-hidden className="min-h-0 flex-1 basis-0" />
    </div>
  );
}
