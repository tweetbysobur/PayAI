"use client";

import { ShieldCheck, Fingerprint } from "lucide-react";
import type { PendingConfirmation } from "@/lib/hooks/useAgentConsole";
import type { WalletProviderKind } from "@/lib/wallet-service/types";

/**
 * The details a payment is confirmed against, shared by the Send Payment page
 * and the command bar so the two can never drift apart.
 *
 * The recipient row is the reason this exists. Paying a `.nad` name is the
 * friendly path, but a name is not what gets paid — an address is. Showing
 * only "alice.nad" asks the user to trust a resolution they never saw, so the
 * name is shown with the address it resolved to directly beneath it, in full.
 * That address is what the signature authorises, and it's the last chance to
 * catch a typo'd or hijacked name before the payment is irreversible.
 */
export function ConfirmDetails({
  pending,
  kind,
}: {
  pending: PendingConfirmation;
  kind: WalletProviderKind | null;
}) {
  const embedded = kind === "embedded";
  const rows: [string, string][] = [
    ["Token", pending.token],
    ["Amount", pending.amount != null ? `${pending.amount} ${pending.token}` : "—"],
    ...(pending.platformFee
      ? ([
          ["You pay", `${pending.platformFee.total} ${pending.platformFee.token}`],
        ] as [string, string][])
      : []),
    ["Schedule", "Once — immediately"],
    [
      "Execution Mode",
      embedded
        ? "Non-custodial — approved with your passkey"
        : "Non-custodial — signed from your wallet",
    ],
    [
      "Network fee",
      embedded
        ? "Network fee in MON, from this wallet"
        : "Shown by your wallet at signing",
    ],
  ];

  return (
    <>
      <dl className="space-y-1.5 rounded-lg border border-border bg-panel px-3.5 py-3 text-sm">
        <div className="flex items-start justify-between gap-3 border-b border-border pb-2">
          <dt className="shrink-0 pt-0.5 text-xs text-muted-foreground">Recipient</dt>
          <dd className="min-w-0 text-right">
            {pending.domain && (
              <span className="flex items-center justify-end gap-1.5 font-medium text-foreground">
                <ShieldCheck size={12} className="shrink-0 text-success" />
                <span className="truncate">{pending.domain}</span>
              </span>
            )}
            {pending.recipient && (
              <span
                className={`mt-0.5 block break-all font-mono text-[11px] ${
                  pending.domain ? "text-muted-foreground" : "text-foreground"
                }`}
              >
                {pending.recipient}
              </span>
            )}
            {pending.domain && (
              <span className="mt-0.5 block text-[10px] text-muted-foreground">
                Resolved on-chain — this address is what gets paid
              </span>
            )}
          </dd>
        </div>

        {rows.map(([label, value]) => (
          <div key={label} className="flex items-center justify-between gap-3">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="truncate text-right font-medium text-foreground">{value}</dd>
          </div>
        ))}
      </dl>

      {embedded && (
        <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
          <Fingerprint size={12} className="mt-px shrink-0 text-primary-ink" />
          Confirming asks for your passkey. Every PayAI Wallet transaction needs
          one — nothing can be signed without it.
        </p>
      )}
    </>
  );
}
