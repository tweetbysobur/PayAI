"use client";

import { useCallback, useEffect, useState } from "react";

const DONE_PREFIX = "payai_onboarding_done_";
const REOPEN_EVENT = "payai:reopen-onboarding";

function doneKey(address: string) {
  return `${DONE_PREFIX}${address.toLowerCase()}`;
}

/** Per-wallet onboarding completion, gated on the wallet actually being
 *  connected — a fresh wallet always sees onboarding once, a returning one
 *  never sees it again. `reopenOnboarding()` (used by the sidebar's "Getting
 *  Started" link) forces it back open regardless of completion state. */
export function useOnboarding(address?: string | null) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!address) { setOpen(false); return; }
    const done = typeof window !== "undefined" && localStorage.getItem(doneKey(address)) === "1";
    setOpen(!done);
  }, [address]);

  useEffect(() => {
    const reopen = () => setOpen(true);
    window.addEventListener(REOPEN_EVENT, reopen);
    return () => window.removeEventListener(REOPEN_EVENT, reopen);
  }, []);

  const complete = useCallback(() => {
    if (address) localStorage.setItem(doneKey(address), "1");
    setOpen(false);
  }, [address]);

  return { open, complete };
}

/** Fired from anywhere (the sidebar's "Getting Started" link) to bring the
 *  onboarding flow back up on demand. */
export function reopenOnboarding() {
  window.dispatchEvent(new Event(REOPEN_EVENT));
}
