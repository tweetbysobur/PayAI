"use client";

/**
 * Wallet Service registry — the single place that knows which embedded
 * providers exist. Everything else asks the registry for "the active
 * embedded provider" and never imports a provider by name.
 *
 * Adding a second embedded provider: implement EmbeddedWalletProvider in a
 * new providers/<name>.ts and add it to EMBEDDED_PROVIDERS below. Nothing in
 * app/ or components/ changes.
 *
 * Runs in the browser, because that is where embedded wallets live — see the
 * note on EmbeddedWalletProvider in ./types.
 */
import * as mera from "./providers/mera";
import type { EmbeddedWalletHandle, EmbeddedWalletProvider, UnsignedTx, WalletProviderId } from "./types";

/** Wraps Mera's module-level functions in the provider contract, so the rest
 *  of the Wallet Service never touches passkey APIs directly. */
const meraProvider: EmbeddedWalletProvider = {
  id: "mera",
  kind: "embedded",
  label: "PayAI Wallet",
  isAvailable: () => mera.isMeraSupported(),
  isSupported: () => mera.isMeraSupported(),
  hasLocalCredential: () => mera.storedCredential() !== null,
  friendlyError: (e) => mera.friendlyMeraError(e),
  forget: () => mera.forgetCredential(),
  exportPrivateKey: () => mera.exportPrivateKey(),
  create: (label) => mera.createWallet(label).then(toHandle),
  recover: () => mera.recoverWallet().then(toHandle),
};

function toHandle(wallet: mera.MeraWallet): EmbeddedWalletHandle {
  return {
    address: wallet.address,
    async signMessage(message: string) {
      return wallet.account.signMessage({ message });
    },
    async sendTransaction(tx: UnsignedTx) {
      const client = await mera.walletClientFor(wallet);
      // `chain` is deliberately NOT passed. This is a local (Mera) account, so
      // viem signs the transaction here rather than handing it to a wallet —
      // it needs the chain to put a chainId in the signature (EIP-155 replay
      // protection). Passing `chain: null` would suppress that; omitting it
      // inherits the client's configured Monad chain, which is what we want.
      return client.sendTransaction({
        account: wallet.account,
        to: tx.to as `0x${string}`,
        data: (tx.data ?? undefined) as `0x${string}` | undefined,
        value: tx.value ? BigInt(tx.value) : undefined,
      });
    },
    end() {
      wallet.session.end();
    },
  };
}

const EMBEDDED_PROVIDERS: EmbeddedWalletProvider[] = [meraProvider];

/** The embedded provider PayAI currently offers. Today there is exactly one
 *  (Mera); when a second ships this becomes a real selection rather than
 *  "the only one". */
export function getEmbeddedProvider(): EmbeddedWalletProvider {
  return EMBEDDED_PROVIDERS[0];
}

export function findEmbeddedProvider(id: WalletProviderId): EmbeddedWalletProvider | null {
  return EMBEDDED_PROVIDERS.find((p) => p.id === id) ?? null;
}
