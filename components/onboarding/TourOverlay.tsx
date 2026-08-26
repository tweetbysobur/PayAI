"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { X, ArrowRight, ArrowLeft } from "lucide-react";

const START_EVENT = "payai:start-guided-tour";

/** Fired from the onboarding modal's final step (and anywhere else that wants
 *  to launch it — e.g. a future "Take a tour" sidebar link) to open the
 *  guided sidebar walkthrough. Mirrors reopenOnboarding()'s own
 *  window-event pattern in lib/hooks/useOnboarding.ts. */
export function startGuidedTour() {
  window.dispatchEvent(new Event(START_EVENT));
}

/** Each step spotlights one real sidebar item via its `data-tour` attribute
 *  (see components/dashboard/Sidebar.tsx) — this never lists a page the
 *  sidebar doesn't actually have, since it targets the live DOM element
 *  rather than duplicating a second copy of the nav. */
interface TourStep {
  target: string;
  title: string;
  body: string;
}

const STEPS: TourStep[] = [
  { target: "ask", title: "Ask PayAI", body: "Trade, swap DeFi tokens, check balances, or send a payment — just describe what you want in plain English." },
  { target: "payments", title: "Send Payment", body: "Pay any wallet address or .nad name directly, without going through Ask PayAI." },
  { target: "automations", title: "Automations", body: "Set up a payment that runs on a schedule or a trigger, so you don't have to come back and send it manually." },
  { target: "wallets", title: "Wallets", body: "Manage every wallet linked to your account, and switch which one is active." },
  { target: "help", title: "Help Center", body: "Come back here any time — FAQs, security details, and support live here." },
];

interface Rect { top: number; left: number; width: number; height: number }

function measure(selector: string): Rect | null {
  const el = document.querySelector<HTMLElement>(`[data-tour="${selector}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

/** Guided overlay walkthrough — a small, self-contained spotlight tour, not a
 *  general-purpose library. Opt-in only (launched via startGuidedTour()),
 *  never auto-starts, and degrades gracefully: a step whose target isn't in
 *  the DOM (e.g. the sidebar is hidden below the `lg` breakpoint) is simply
 *  skipped rather than breaking the tour. */
export function TourOverlay() {
  const [open, setOpen] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);

  useEffect(() => {
    const start = () => { setStepIndex(0); setOpen(true); };
    window.addEventListener(START_EVENT, start);
    return () => window.removeEventListener(START_EVENT, start);
  }, []);

  useEffect(() => {
    if (!open) return;
    function reposition() {
      // Skip forward past any step whose target isn't currently rendered
      // (e.g. the sidebar is hidden on a narrow viewport) instead of showing
      // a spotlight pointing at nothing.
      let i = stepIndex;
      let found = measure(STEPS[i].target);
      while (!found && i < STEPS.length - 1) {
        i += 1;
        found = measure(STEPS[i].target);
      }
      if (i !== stepIndex) { setStepIndex(i); return; }
      if (!found) { setOpen(false); return; }
      setRect(found);
    }
    reposition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [open, stepIndex]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
      if (e.key === "ArrowRight") next();
      if (e.key === "ArrowLeft") back();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, stepIndex]);

  function next() {
    if (stepIndex >= STEPS.length - 1) { setOpen(false); return; }
    setStepIndex((i) => i + 1);
  }
  function back() {
    setStepIndex((i) => Math.max(0, i - 1));
  }

  if (!open || !rect) return null;
  const step = STEPS[stepIndex];
  const pad = 8;

  // Tooltip prefers sitting to the right of the sidebar item (the sidebar is
  // a fixed left column), clamped so it never overflows the bottom of the
  // viewport.
  const tooltipTop = Math.min(rect.top, window.innerHeight - 220);
  const tooltipLeft = rect.left + rect.width + 20;

  return (
    <AnimatePresence>
      <motion.div
        key="tour-backdrop"
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="fixed inset-0 z-[80]"
        onClick={() => setOpen(false)}
      >
        {/* Spotlight cutout — a box-shadow "hole" around the target element,
            dimming everything else on the page. */}
        <motion.div
          key={`spot-${stepIndex}`}
          initial={false}
          animate={{ top: rect.top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }}
          transition={{ duration: 0.25, ease: "easeOut" }}
          className="pointer-events-none absolute rounded-lg"
          style={{ boxShadow: "0 0 0 9999px rgba(0,0,0,0.6)" }}
        />
      </motion.div>

      <motion.div
        key={`tooltip-${stepIndex}`}
        initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        className="fixed z-[81] w-72 rounded-xl border border-border bg-panel p-4 shadow-2xl"
        style={{ top: tooltipTop, left: tooltipLeft }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-semibold text-foreground">{step.title}</p>
          <button onClick={() => setOpen(false)} aria-label="Close tour" className="text-muted-foreground transition hover:text-foreground">
            <X size={15} />
          </button>
        </div>
        <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{step.body}</p>
        <div className="mt-3.5 flex items-center justify-between">
          <span className="text-[11px] text-muted-foreground">{stepIndex + 1} of {STEPS.length}</span>
          <div className="flex items-center gap-1.5">
            {stepIndex > 0 && (
              <button onClick={back} className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition hover:bg-input hover:text-foreground">
                <ArrowLeft size={12} /> Back
              </button>
            )}
            <button onClick={next} className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition hover:opacity-90">
              {stepIndex === STEPS.length - 1 ? "Done" : "Next"} <ArrowRight size={12} />
            </button>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}
