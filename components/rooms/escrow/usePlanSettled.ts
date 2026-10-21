"use client";

import { useEffect, useRef } from "react";
import { getPlanWithReview } from "@/lib/plans-client/api";

/**
 * Watches one plan and calls `onCompleted` once when the server reports it
 * COMPLETED (its transaction confirmed and settled). It never treats a
 * submitted-but-unconfirmed transaction as done: the room records the
 * outcome only after this fires AND the server re-verifies the receipt.
 */
export function usePlanSettled(planId: string | null, onCompleted: () => void, intervalMs = 4000): void {
  const fired = useRef<string | null>(null);
  const cb = useRef(onCompleted);
  useEffect(() => { cb.current = onCompleted; });
  useEffect(() => {
    if (!planId) return;
    let stop = false;
    const tick = async () => {
      if (stop || fired.current === planId) return;
      const r = await getPlanWithReview(planId).catch(() => null);
      const state = (r?.body as { plan?: { state?: string } } | null)?.plan?.state;
      if (r?.status === 200 && state === "completed" && fired.current !== planId) {
        fired.current = planId;
        cb.current();
      }
    };
    void tick();
    const t = setInterval(() => void tick(), intervalMs);
    return () => { stop = true; clearInterval(t); };
  }, [planId, intervalMs]);
}
