"use client";

import { useEffect, useRef } from "react";

/**
 * The keyboard/scroll contract every PayAI modal shares.
 *
 * Before this, only the command bar handled Escape — every other overlay
 * (automation detail/edit/create, Bulk Payment wizard, template picker,
 * receive modal, mobile nav) could only be dismissed by clicking, which
 * strands keyboard and screen-reader users inside a dialog they can't close.
 * Body scroll was also left unlocked, so the page behind an open modal
 * scrolled under it on both desktop and touch.
 *
 * Pair this with `role="dialog" aria-modal="true"` and an `aria-label` (or
 * `aria-labelledby`) on the panel element so assistive tech announces the
 * overlay as a dialog rather than as inline page content.
 */
export function useModalA11y(open: boolean, onClose: () => void): void {
  // Callers overwhelmingly pass an inline arrow (`onClose={() => setOpen(false)}`),
  // so `onClose` is a fresh function on every parent render. Depending on it
  // directly made this effect tear down and re-run constantly — which RELEASED
  // THE SCROLL LOCK while the modal was still open (caught in browser
  // testing: body overflow reverted to unset with the dialog still mounted).
  // Holding it in a ref keeps the latest callback while letting the effect
  // depend only on `open`, so setup/cleanup happen exactly once per open.
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    document.addEventListener("keydown", onKeyDown);

    // Lock background scroll while the overlay is up, restoring whatever the
    // page had before (not a hardcoded "" ) so nested/sequential modals can't
    // leave the body permanently unscrollable.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);
}
