"use client";

import { useCallback, useRef, useState } from "react";
import { useToast } from "@/components/Toast";

/**
 * Copy to the clipboard, and say what actually happened.
 *
 * Six places did this by hand and each handled failure differently: some
 * announced success before the write resolved, some swallowed the rejection
 * and announced success anyway, some said nothing at all. The clipboard fails
 * for ordinary reasons — an insecure origin, a denied permission, an
 * in-app browser — and in this product the thing being copied is usually a
 * wallet address or a transaction hash. Telling someone an address is on their
 * clipboard when it isn't means they paste whatever was there before, into a
 * payment.
 *
 * So: confirm only on success, say so plainly on failure, and never guess.
 */
export function useCopy(): {
  /** Copies, toasts the outcome, and returns whether it worked. */
  copy: (text: string, label?: string) => Promise<boolean>;
  /** The value copied most recently, for a tick or a "Copied!" label. Clears
   *  itself, so a caller only has to render it. */
  copied: string | null;
} {
  const { toast } = useToast();
  const [copied, setCopied] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const copy = useCallback(
    async (text: string, label = "Copied"): Promise<boolean> => {
      try {
        if (!navigator.clipboard) throw new Error("clipboard unavailable");
        await navigator.clipboard.writeText(text);
        setCopied(text);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(null), 1600);
        toast(label);
        return true;
      } catch {
        toast("Couldn't copy — select the text and copy it manually.", "error");
        return false;
      }
    },
    [toast],
  );

  return { copy, copied };
}
