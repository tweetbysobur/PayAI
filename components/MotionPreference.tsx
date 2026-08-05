"use client";

import { MotionConfig } from "motion/react";
import type { ReactNode } from "react";

/**
 * Honours "reduce motion" across every animation in the app.
 *
 * `app/globals.css` already zeroes CSS animation and transition durations for
 * `prefers-reduced-motion`, which covers hover states, spinners and anything
 * animated with a class. It does nothing at all for Framer, which animates by
 * writing transforms from JavaScript on every frame — CSS has no say in it.
 *
 * Since most movement in this product is Framer (cards sliding in, the deposit
 * alert springing down, list items reordering, the command bar opening), a
 * user who asked for less motion was still getting essentially all of it. For
 * someone with vestibular sensitivity that setting is not a preference, and
 * "we respect it" was true of the small half and false of the large half.
 *
 * `reducedMotion="user"` defers to the OS setting: transform and layout
 * animations are dropped while opacity still cross-fades, so interfaces
 * continue to feel responsive rather than snapping between states.
 */
export function MotionPreference({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
