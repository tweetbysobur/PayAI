"use client";

import Link from "next/link";
import { PageHeader } from "@/components/dashboard/primitives";
import { AskEntry } from "@/components/dashboard/AskEntry";

/**
 * Swap / Trade inside Payments & Automations. Swaps have no form of their
 * own: they run through Ask PayAI (quote → review → your wallet signs), so
 * this page hands off to it rather than growing a second swap path. Scheduled
 * swaps are Payment Automations.
 */
export default function SwapPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Swap"
        description="Swap between MON, USDC and other Monad tokens. Tell PayAI what you want; you review the exact quote and approve it in your wallet."
      />

      <AskEntry
        id="swap-entry"
        label="What do you want to swap?"
        placeholder="For example: swap 10 USDC to MON"
      />

      <div className="mt-8 border-t border-border pt-6">
        <h2 className="text-sm font-semibold text-foreground">Swap on a schedule</h2>
        <p className="mt-1 text-sm text-muted-foreground">Recurring swaps between MON and USDC are set up as a Payment Automation.</p>
        <Link href="/dashboard/automations" className="mt-3 inline-flex items-center gap-1.5 rounded-sm text-sm font-medium text-primary-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Go to Automations →
        </Link>
      </div>
    </div>
  );
}
