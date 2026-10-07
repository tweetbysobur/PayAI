"use client";

import { PlansPanel } from "@/components/plans/PlansPanel";

/**
 * /dashboard/plans — review, approve and run multi-step plans. Execution goes
 * through the Plan Runner only (see components/plans/PlansPanel.tsx).
 */
export default function PlansPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">Plans</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Describe what you want done. Review every step, approve it, then each transaction is signed in your own wallet.
        </p>
      </div>
      <PlansPanel />
    </div>
  );
}
