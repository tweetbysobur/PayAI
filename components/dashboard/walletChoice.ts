/**
 * The decisions behind "which wallet acts" when a PayAI account (passkey
 * wallet) and an external wallet are both present — kept pure and separate
 * from the components so they can be tested without a browser.
 *
 * All of them go through the wallet service's own operations (switchWallet,
 * setUpEmbeddedWallet); none signs or sends anything.
 */
import type { WalletProviderKind } from "@/lib/wallet-service/types";

export interface WalletChoicePort {
  accountAddress: string | null;
  externalAddress: string | null;
  isLocked: boolean;
  activeKind: WalletProviderKind | null;
  switchWallet: (kind: WalletProviderKind) => void;
  setUpEmbeddedWallet: (opts?: { create?: boolean }) => Promise<unknown>;
}

/** After an external wallet connects IN PLACE: an unlocked account stays the
 *  wallet that acts — connecting is not choosing. A locked account can't act
 *  until unlocked, so nothing is forced; the person is asked next. */
export function afterExternalConnect(w: WalletChoicePort): void {
  if (w.accountAddress && !w.isLocked) w.switchWallet("embedded");
}

/** The account is locked and the app has fallen back to the external wallet. */
export function showAccountReturn(w: Pick<WalletChoicePort, "accountAddress" | "externalAddress" | "isLocked" | "activeKind">, dismissed: boolean): boolean {
  return !!w.accountAddress && !!w.externalAddress && w.isLocked && w.activeKind === "external" && !dismissed;
}

/** Choose where funds come from. Choosing a locked account unlocks it first
 *  (one passkey check) — otherwise the choice would silently not apply. If
 *  the unlock fails, nothing changes. */
export async function chooseFundingSource(w: WalletChoicePort, kind: WalletProviderKind): Promise<void> {
  if (kind === "embedded" && w.isLocked) await w.setUpEmbeddedWallet({ create: false });
  w.switchWallet(kind);
}
