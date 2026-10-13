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
import { ensureWalletGrant } from "@/lib/auth/ensureWalletGrant";
import type { ApprovalLimits, ApprovalSession, EmbeddedWalletHandle, EmbeddedWalletProvider, UnsignedTx, WalletProviderId } from "./types";

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
    // The key from this ceremony signs the read grant. Doing it here, once,
    // avoids a second passkey prompt. The grant cannot move funds.
    await ensureWalletGrant(outcome.value.address, (message) => outcome.value.account.signMessage({ message }));
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

  /** Signs and broadcasts one transaction with already-approved key material. */
  async function send(w: mera.MeraWallet, tx: UnsignedTx): Promise<string> {
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
  }

  return {
    address: wallet.address,
    credentialId: wallet.credentialId,
    async openApprovalSession(limits: ApprovalLimits): Promise<ApprovalSession> {
      return openApprovalSession(wallet.address, limits, send);
    },
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
      // The affordability check gets a short head start. If it already knows
      // the send will fail, no biometric is spent on it. If the network is
      // slow (several RPC round trips with retries), the passkey prompt opens
      // anyway and the check finishes while the user approves: waiting it out
      // delayed the prompt by seconds on mobile networks, long enough for
      // phone browsers to block a prompt that no longer follows the tap. An
      // unaffordable transaction is still never signed — the check is awaited
      // before signing, and the derived key is zeroed.
      const affordable = assertCanAfford(wallet.address, tx);
      affordable.catch(() => {}); // awaited below; avoid an unhandled rejection meanwhile
      await Promise.race([affordable, new Promise<void>((r) => setTimeout(r, AFFORD_HEAD_START_MS))]);
      return approved(async (w) => {
        await affordable;
        return send(w, tx);
      });
    },
    end() {
      wallet.session.end();
    },
  };
}

/**
 * One passkey approval covering one approved plan.
 *
 * Every other signature in PayAI costs its own passkey check (see
 * `approved` above). A plan is different: the user has just reviewed every
 * action in it and tapped Approve once, and asking again for each step made
 * a five-step plan five more fingerprints. So the plan gets one ceremony,
 * and the key it derives is held — in memory only — for that run, bounded
 * three ways:
 *
 *   - only the returned session can use it (the handle's sendTransaction,
 *     and every other screen, still prompt every time);
 *   - at most `maxTransactions` signatures (the plan's own steps and their
 *     token approvals);
 *   - at most `ttlMs`, and `end()` — called when the run finishes, fails or
 *     is cancelled — zeroes it immediately.
 *
 * What gets signed is still decided by the plan runner, which only signs
 * transactions the server built for this approved plan.
 */
export const APPROVAL_SESSION_MAX_TTL_MS = 10 * 60 * 1000;
export const APPROVAL_SESSION_MAX_TRANSACTIONS = 64;

export async function openApprovalSession(
  address: `0x${string}`,
  limits: ApprovalLimits,
  send: (w: mera.MeraWallet, tx: UnsignedTx) => Promise<string>,
  authorize: (address: `0x${string}`) => Promise<mera.MeraWallet> = mera.authorizeWallet,
  now: () => number = Date.now,
): Promise<ApprovalSession> {
  const max = Math.max(1, Math.min(APPROVAL_SESSION_MAX_TRANSACTIONS, Math.floor(limits.maxTransactions)));
  const ttl = Math.max(1, Math.min(APPROVAL_SESSION_MAX_TTL_MS, limits.ttlMs));
  let w: mera.MeraWallet | null;
  try {
    w = await authorize(address);
  } catch (e) {
    throw new Error(mera.friendlyApprovalError(e));
  }
  const expires = now() + ttl;
  let used = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const end = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (w) { w.session.end(); w = null; }
  };
  timer = setTimeout(end, ttl);
  return {
    async sendTransaction(tx: UnsignedTx): Promise<string> {
      if (!w || now() > expires) {
        end();
        throw new Error("This approval has expired. Nothing more was signed — approve again to continue.");
      }
      if (used >= max) throw new Error("This approval covers no more transactions. Nothing more was signed.");
      used += 1;
      const key = w;
      await assertCanAfford(address, tx);
      if (w !== key) throw new Error("This approval ended before the transaction was signed. Nothing was sent.");
      return send(key, tx);
    },
    end,
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
/** How long the affordability check may hold the passkey prompt back. */
export const AFFORD_HEAD_START_MS = 400;

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
