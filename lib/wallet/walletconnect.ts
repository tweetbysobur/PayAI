"use client";

import type { EthProvider } from "./provider";
import { MONAD_CHAIN_ID, MONAD_RPC } from "@/lib/monad/public";

/**
 * WalletConnect (Reown) support — lets any mobile wallet connect over a QR code
 * or a one-tap deep link, straight from a normal browser (no "open in wallet
 * app" hop). The heavy SDK is imported lazily so it only loads when a user
 * actually chooses WalletConnect.
 *
 * Requires a public project id from https://dashboard.reown.com, exposed as
 * NEXT_PUBLIC_WC_PROJECT_ID. The feature is hidden when it isn't set.
 */
export const WC_PROJECT_ID = process.env.NEXT_PUBLIC_WC_PROJECT_ID || "";

export function walletConnectAvailable(): boolean {
  return !!WC_PROJECT_ID;
}

// A WalletConnect provider is EIP-1193 plus a few session methods we use.
export type WalletConnectProvider = EthProvider & {
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  session?: unknown;
  accounts?: string[];
};

let cached: WalletConnectProvider | null = null;

/** Init (once) and return the WalletConnect EIP-1193 provider. */
export async function getWalletConnectProvider(): Promise<WalletConnectProvider> {
  if (cached) return cached;
  if (!WC_PROJECT_ID) throw new Error("WalletConnect isn't configured on this deployment.");

  const { EthereumProvider } = await import("@walletconnect/ethereum-provider");
  const provider = await EthereumProvider.init({
    projectId: WC_PROJECT_ID,
    chains: [MONAD_CHAIN_ID],
    optionalChains: [MONAD_CHAIN_ID],
    showQrModal: true,
    rpcMap: { [MONAD_CHAIN_ID]: MONAD_RPC },
    metadata: {
      name: "PayAI",
      description: "Pay on Monad by typing what you want.",
      url: "https://usepayai.xyz",
      icons: ["https://usepayai.xyz/payai-logo-256.png"],
    },
  });

  cached = provider as unknown as WalletConnectProvider;
  return cached;
}

/**
 * Open the WalletConnect modal (QR / mobile deep link) and establish a session.
 * Returns the connected EIP-1193 provider to hand to the shared wallet state.
 */
export async function openWalletConnect(): Promise<WalletConnectProvider> {
  const provider = await getWalletConnectProvider();
  if (!provider.session) await provider.connect();
  return provider;
}
