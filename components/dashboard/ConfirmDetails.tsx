"use client";

import { Fingerprint } from "lucide-react";
import type { PendingConfirmation } from "@/lib/hooks/useAgentConsole";
import type { WalletProviderKind } from "@/lib/wallet-service/types";
import { AmountHero, RecipientBlock, ReceiptRow, ReceiptRows, ReceiptTotal } from "@/components/receipt/ReceiptKit";

/**
 * The details a payment is confirmed against on the Send Payment page, in
 * the same layout as every other review and receipt (components/receipt).
 *
 * The recipient block is the reason this exists. Paying a `.nad` name is the
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
  const fee = pending.platformFee;

  return (
    <>
      <div className="rounded-xl surface-purple px-4 pb-3 pt-4">
        <AmountHero eyebrow="You're sending" amount={pending.amount} token={pending.token} />

        <ReceiptRows className="mt-3 border-t border-border/70">
          <RecipientBlock
            domain={pending.domain}
            address={pending.recipient}
            note={pending.domain ? "Resolved on-chain — this address is what gets paid." : undefined}
          />
          <ReceiptRow label="When">Now</ReceiptRow>
          <ReceiptRow label="Signed with">{embedded ? "Your passkey" : "Your wallet"}</ReceiptRow>
          {fee && <ReceiptRow label={`PayAI fee (${fee.percent})`} value={`${fee.amount} ${fee.token}`} />}
          <ReceiptRow label="Network fee" muted>{embedded ? "Paid in MON" : "Shown in your wallet"}</ReceiptRow>
        </ReceiptRows>

        {fee && (
          <dl className="mt-1">
            <ReceiptTotal label="Total" value={`${fee.total} ${fee.token}`} note="+ network fee" />
          </dl>
        )}
      </div>

      {embedded && (
        <p className="mt-3 flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
          <Fingerprint size={14} className="mt-px shrink-0 text-primary-ink" aria-hidden />
          Confirming asks for your passkey. Nothing can be signed without it.
        </p>
      )}
    </>
  );
}
