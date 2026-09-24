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
import { classifyPasskeyFailure, runPasskeyOpen } from "./passkey-plan";
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
  lastKnownAddress: () => mera.storedAddress(),
  friendlyError: (e) => mera.friendlyMeraError(e),
  forget: () => mera.forgetCredential(),
  exportPrivateKey: () => mera.exportPrivateKey(),
  create: (label) => mera.createWallet(label).then(toHandle),
  // Discoverable on purpose. Pinning the saved credential id hid the original
  // passkey after a second, empty one had been stored on this browser.
  recover: () => mera.recoverWallet({ discoverable: true }).then(toHandle),
  open: async (input) => {
    const immediate = await mera.immediateMediationAvailable();
    const outcome = await runPasskeyOpen(
      {
        mode: input.mode,
        remembered: mera.storedCredential() !== null,
        signedIn: input.signedIn,
        serverHasWallet: input.serverHasWallet,
        immediate,
        serverAddress: input.serverAddress,
      },
      {
        discover: (mediation) => mera.recoverWallet({ discoverable: true, mediation }),
        create: () => mera.createWallet(input.label),
        failureKind: classifyPasskeyFailure,
      },
    );
    return { handle: toHandle(outcome.value), created: outcome.created };
  },
};

function toHandle(wallet: mera.MeraWallet): EmbeddedWalletHandle {
  /**
   * Runs one operation under a fresh user approval.
   *
   * An external wallet puts a confirmation pop-up in front of every
   * signature; unlocking once and then signing silently would make the
   * embedded wallet the weaker of the two, which is exactly backwards for the
   * option we recommend to newcomers. So every signature re-authenticates:
   * the user approves with their passkey, key material is derived for that
   * one operation, and it is zeroed as soon as the operation finishes.
   *
   * The session created at unlock is never used to sign — it only marks the
   * wallet as unlocked and carries its address.
   */
  async function approved<T>(run: (w: mera.MeraWallet) => Promise<T>): Promise<T> {
    let session: mera.MeraWallet;
    try {
      session = await mera.authorizeWallet(wallet.address);
    } catch (e) {
      throw new Error(mera.friendlyApprovalError(e));
    }
    try {
      return await run(session);
    } finally {
      session.session.end();
    }
  }

  return {
    address: wallet.address,
    credentialId: wallet.credentialId,
    async signMessage(message: string) {
      return approved((w) => w.account.signMessage({ message }));
    },
    async sendTransaction(tx: UnsignedTx) {
      // Affordability first, so a transaction that cannot succeed never costs
      // the user a biometric prompt. An embedded wallet is brand new, so the
      // single most likely first action — create a wallet, immediately send
      // something — hits a wallet with zero MON and no way to pay gas. Left
      // unguarded that surfaces as a raw RPC error ("insufficient funds for
      // gas * price + value"), which tells a new user nothing.
      await assertCanAfford(wallet.address, tx);
      return approved(async (w) => {
        const client = await mera.walletClientFor(w);
        // `chain` is deliberately NOT passed. This is a local (Mera) account,
        // so viem signs the transaction here rather than handing it to a
        // wallet — it needs the chain to put a chainId in the signature
        // (EIP-155 replay protection). Passing `chain: null` would suppress
        // that; omitting it inherits the client's configured Monad chain,
        // which is what we want.
        return client.sendTransaction({
          account: w.account,
          to: tx.to as `0x${string}`,
          data: (tx.data ?? undefined) as `0x${string}` | undefined,
          value: tx.value ? BigInt(tx.value) : undefined,
        });
      });
    },
    end() {
      wallet.session.end();
    },
  };
}

/** Formats wei as MON with just enough precision to be useful, never
 *  scientific notation. */
function mon(wei: bigint): string {
  const whole = Number(wei) / 1e18;
  return whole < 0.0001 && whole > 0 ? whole.toExponential(2) : whole.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

/**
 * Refuses a send the wallet cannot pay for, with a message a person can act
 * on. Never blocks on its own uncertainty: if the network can't be reached to
 * estimate, the send proceeds and the RPC decides — a guard that fails closed
 * on a flaky connection would be worse than the error it replaces.
 */
async function assertCanAfford(address: `0x${string}`, tx: UnsignedTx): Promise<void> {
  const { getBrowserPublicClient } = await import("@/lib/monad/browserClient");
  const value = tx.value ? BigInt(tx.value) : 0n;

  let balance: bigint;
  try {
    balance = await (await getBrowserPublicClient()).getBalance({ address });
  } catch {
    return; // can't check — let the network answer rather than guess
  }

  if (balance === 0n) {
    throw new Error(
      "Your PayAI Wallet has no MON yet. Add some MON to cover network fees before sending — every Monad transaction needs a small amount of it.",
    );
  }

  let fee = 0n;
  try {
    const pub = await getBrowserPublicClient();
    const [gas, fees] = await Promise.all([
      pub.estimateGas({ account: address, to: tx.to as `0x${string}`, data: tx.data as `0x${string}` | undefined, value }),
      pub.estimateFeesPerGas(),
    ]);
    fee = gas * (fees.maxFeePerGas ?? fees.gasPrice ?? 0n);
  } catch {
    // Estimation commonly fails for exactly the reason we're checking, so a
    // failure here is not proof of anything — fall through to the value-only
    // check below rather than inventing a fee figure.
  }

  const needed = value + fee;
  if (needed > balance) {
    const forFees = fee > 0n ? ` (including about ${mon(fee)} MON in network fees)` : "";
    throw new Error(
      `Not enough MON. This transaction needs about ${mon(needed)} MON${forFees}, but your wallet holds ${mon(balance)} MON.`,
    );
  }
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
