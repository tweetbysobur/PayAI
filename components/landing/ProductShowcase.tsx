"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { AutomationWorkflow } from "@/components/landing/AutomationWorkflow";
import { DashboardShowcase } from "@/components/landing/DashboardShowcase";
import { SendPaymentWorkflow } from "@/components/landing/SendPaymentWorkflow";

/**
 * The hero visual: the real product, cycling on its own with no chrome —
 * no tabs, no labels, just the screens. Each one is self-describing (the
 * workflows name their own stages, the dashboard is labelled in-frame), so
 * a strip of captions above them was redundant.
 *
 * Order is automation-first: the lifecycle leads, an instant payment
 * follows, and the wallet-balance dashboard is LAST so it never fronts the
 * page and never reads as "crypto wallet app."
 *
 * Each screen gets its OWN dwell time rather than one flat interval: a
 * workflow must finish its stage sequence before the rotation moves on
 * (AutomationWorkflow is 6 stages at 2.6s = 15.6s, so a flat 7s cycle used
 * to switch away before it ever reached "Transaction Confirmed").
 * DashboardShowcase has no stage sequence, just a dwell long enough to read
 * the live numbers.
 */
const SCREENS = [
  { key: "automation", durationMs: 6 * 2600 + 1200 },
  { key: "payment", durationMs: 4 * 2600 + 1200 },
  { key: "dashboard", durationMs: 6500 },
] as const;
type ScreenKey = (typeof SCREENS)[number]["key"];

export function ProductShowcase() {
  const [screen, setScreen] = useState<ScreenKey>("automation");
  // Defaults to TRUE and is only ever turned OFF by the observer. Starting
  // false looks like the safer choice but fails in exactly the wrong
  // direction: if IntersectionObserver never delivers a callback — which
  // happens in environments that aren't compositing frames, and was
  // reproduced here — the showcase stays frozen forever and the visitor sees
  // a dead component. Defaulting to true degrades to "always animating"
  // instead, which is merely the pre-visibility-gating behavior.
  const [inView, setInView] = useState(true);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // Every showcase animates on a timer, and DashboardShowcase also polls
  // /api/platform-stats. Gate all of it on visibility so nothing ticks,
  // repaints, or fetches while this section is scrolled off-screen.
  useEffect(() => {
    const el = rootRef.current;
    // No element or no observer support → leave inView as true (see above).
    if (!el || typeof IntersectionObserver === "undefined") return;
    const obs = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), { threshold: 0.15 });
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  // Re-armed on every screen change so each screen's own dwell time applies.
  useEffect(() => {
    if (!inView) return;
    const order = SCREENS.map((s) => s.key);
    const current = SCREENS.find((s) => s.key === screen)!;
    const t = setTimeout(() => {
      setScreen(order[(order.indexOf(screen) + 1) % order.length]);
    }, current.durationMs);
    return () => clearTimeout(t);
  }, [inView, screen]);

  return (
    <div ref={rootRef}>
      <AnimatePresence mode="wait">
        <motion.div
          key={screen}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.3, ease: "easeOut" }}
        >
          {screen === "automation" && <AutomationWorkflow active={inView} />}
          {screen === "payment" && <SendPaymentWorkflow active={inView} />}
          {screen === "dashboard" && <DashboardShowcase active={inView} />}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
