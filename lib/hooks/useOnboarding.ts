"use client";

import { useCallback, useEffect, useState } from "react";

const SHOWN_PREFIX = "payai_welcome_shown_day_";
const REOPEN_EVENT = "payai:reopen-onboarding";

function shownKey(address: string) {
  return `${SHOWN_PREFIX}${address.toLowerCase()}`;
}

/** The local calendar day, YYYY-MM-DD. */
export function localDay(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** The welcome shows at the first visit of each day — so a first-time user
 *  sees it, and so does anyone coming back after a day or more away. Once it
 *  has been shown (finished or skipped) it stays closed for the rest of that
 *  day. */
export function shouldShowWelcome(lastShownDay: string | null, today: string): boolean {
  return lastShownDay !== today;
}

/** Per-account welcome, gated on a wallet actually being connected.
 *  `reopenOnboarding()` (the sidebar's "Getting Started") forces it open. */
export function useOnboarding(address?: string | null) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!address) { setOpen(false); return; }
    let last: string | null = null;
    try { last = localStorage.getItem(shownKey(address)); } catch { /* storage blocked: show it */ }
    setOpen(shouldShowWelcome(last, localDay()));
  }, [address]);

  useEffect(() => {
    const reopen = () => setOpen(true);
    window.addEventListener(REOPEN_EVENT, reopen);
    return () => window.removeEventListener(REOPEN_EVENT, reopen);
  }, []);

  const complete = useCallback(() => {
    if (address) {
      try { localStorage.setItem(shownKey(address), localDay()); } catch { /* storage blocked */ }
    }
    setOpen(false);
  }, [address]);

  return { open, complete };
}

/** Fired from anywhere (the sidebar's "Getting Started" link) to bring the
 *  welcome back up on demand. */
export function reopenOnboarding() {
  window.dispatchEvent(new Event(REOPEN_EVENT));
}
