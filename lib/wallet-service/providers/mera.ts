"use client";

/**
 * Mera embedded-wallet provider — the first provider plugged into the Wallet
 * Service.
 *
 * This is the ONLY file in PayAI that knows Mera exists. Everything else
 * (the dashboard, the automation engine, the AI assistant) goes through
 * `useWalletService()`, whose interface is unchanged — which is the whole
 * point of the abstraction, and why swapping in a provider that works
 * nothing like the one originally sketched touched no call sites.
 *
 * ── How Mera actually works ────────────────────────────────────────────────
 * Mera (@category-labs/mera, by Category Labs) derives a standard secp256k1
 * EOA from a **passkey**, using the WebAuthn PRF extension. There is no
 * backend, no API key, no MPC service, and no custody:
 *
 *   createPasskeyWithPrfOutput() ─┐
 *   getPasskeyPrfOutput()  ───────┴─► 32-byte PRF output
 *                                       └─► createSecp256k1SigningSession()
 *                                             ├─► getEvmAddress(publicKey)
 *                                             └─► toViemAccount() → signing
 *
 * Two consequences shape everything below:
 *
 *   1. **The key never leaves the browser.** PayAI's server cannot sign for a
 *      user even if it wanted to — it never sees key material. This satisfies
 *      "never expose private keys / never store sensitive credentials inside
 *      PayAI" structurally rather than by policy.
 *
 *   2. **Recovery is deterministic, so duplicates are impossible.** The PRF
 *      output is a pure function of (credential, rpId, salt), so the same
 *      passkey always reproduces the same private key and therefore the same
 *      address — on any device that passkey syncs to. "Recover, don't
 *      re-create" needs no server-side account mapping at all.
 *
 * The signing session holds the key in memory only. It is deliberately NOT
 * persisted: a reload ends the session and the next signature re-prompts for
 * the passkey. `session.end()` zeroes the key on sign-out.
 */
import {
  createPasskeyWithPrfOutput,
  getPasskeyPrfOutput,
  createSecp256k1SigningSession,
  getEvmAddress,
  isMeraError,
  type PasskeyCredentialMetadata,
  type Secp256k1SigningSession,
} from "@category-labs/mera";
import { toViemAccount } from "@category-labs/mera/viem";
import type { LocalAccount } from "viem";
import { MONAD_CHAIN_ID, MONAD_CHAIN_NAME, MONAD_RPC_URLS } from "@/lib/monad/public";
import { passkeyRpId } from "@/lib/hosts";

/** Remembering the credential id is what turns a returning user's sign-in
 *  into a single biometric prompt instead of an authenticator picker. It is
 *  a public identifier, not a secret — losing it only costs a picker. */
const CREDENTIAL_KEY = "payai_mera_credential";
/** The wallet's address, remembered so balances, history and deposit alerts
 *  keep working while the wallet is LOCKED. An address is public — this is
 *  not key material, and nothing here can sign. */
const ADDRESS_KEY = "payai_mera_address";

export interface MeraWallet {
  address: `0x${string}`;
  credentialId: string;
  account: LocalAccount;
  session: Secp256k1SigningSession;
}

/** Relying-party id must be the registrable domain — passkeys are bound to
 *  it, so it must stay stable across deploys or every wallet becomes
 *  unrecoverable. Derived from the live origin rather than configured, so it
 *  can never drift from the domain the passkey was actually created on. */
function relyingPartyId(): string {
  return passkeyRpId(window.location.hostname);
}

/**
 * Whether this browser can do passkey-derived wallets at all. PRF is the
 * hard requirement — a passkey without it cannot derive a key. Reported
 * honestly so the UI can steer to an external wallet rather than dead-end
 * the user in a flow their device can't finish.
 */
export function isMeraSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential !== "undefined" &&
    typeof navigator?.credentials?.create === "function"
  );
}

export function storedCredential(): PasskeyCredentialMetadata | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(CREDENTIAL_KEY);
    return raw ? (JSON.parse(raw) as PasskeyCredentialMetadata) : null;
  } catch {
    return null;
  }
}

function rememberCredential(credential: PasskeyCredentialMetadata): void {
  try {
    localStorage.setItem(CREDENTIAL_KEY, JSON.stringify(credential));
  } catch {
    // Private-browsing quota failure. Non-fatal: the wallet still works this
    // session, and the next sign-in just shows a credential picker.
  }
}

export function forgetCredential(): void {
  try {
    localStorage.removeItem(CREDENTIAL_KEY);
    localStorage.removeItem(ADDRESS_KEY);
  } catch {
    /* nothing to clean up */
  }
}

/** The address of the wallet this device last unlocked, if any. */
export function storedAddress(): `0x${string}` | null {
  if (typeof window === "undefined") return null;
  try {
    const a = localStorage.getItem(ADDRESS_KEY);
    return a && /^0x[0-9a-fA-F]{40}$/.test(a) ? (a as `0x${string}`) : null;
  } catch {
    return null;
  }
}

/** PRF output is 32 bytes of authenticator-bound entropy — used directly as
 *  the secp256k1 scalar, exactly as Mera intends. Deliberately persists
 *  nothing: the callers below decide whether a derivation is one this device
 *  should remember. */
function walletFrom(prfOutput: Uint8Array, credentialId: string): MeraWallet {
  const session = createSecp256k1SigningSession({ privateKey: prfOutput });
  return {
    address: getEvmAddress(session.publicKey),
    credentialId,
    account: toViemAccount(session),
    session,
  };
}

/** Records what this device just unlocked. Both values are public — a
 *  credential id and an address — and neither can sign anything. */
function remember(wallet: MeraWallet, transports?: PasskeyCredentialMetadata["transports"]): void {
  rememberCredential({ credentialId: wallet.credentialId, ...(transports ? { transports } : {}) });
  try {
    localStorage.setItem(ADDRESS_KEY, wallet.address);
  } catch {
    /* private mode — balances just won't survive a lock */
  }
}

/**
 * Creates a brand-new passkey and derives the wallet from it. One biometric
 * prompt (two on authenticators that don't evaluate PRF at creation time,
 * which Mera handles internally with a fallback assertion).
 */
export async function createWallet(label: string): Promise<MeraWallet> {
  const result = await createPasskeyWithPrfOutput({
    rp: { id: relyingPartyId(), name: "PayAI" },
    user: { name: label, displayName: label },
  });
  const wallet = walletFrom(result.prfOutput, result.credentialId);
  remember(wallet, result.transports);
  return wallet;
}

/**
 * Re-derives an existing wallet from a passkey the user already has. Returns
 * the SAME address every time — that is a property of the PRF, not of any
 * bookkeeping PayAI does, so a returning user can never end up with a second
 * wallet.
 */
export async function recoverWallet(): Promise<MeraWallet> {
  const result = await getPasskeyPrfOutput({
    rpId: relyingPartyId(),
    // Omitted on a fresh device so the browser offers whatever passkeys the
    // user has synced for this domain.
    ...(storedCredential() ? { credential: storedCredential()! } : {}),
  });
  const wallet = walletFrom(result.prfOutput, result.credentialId);
  remember(wallet);
  return wallet;
}

/**
 * Re-authenticates the user and returns a wallet good for ONE operation.
 *
 * This is what puts a biometric check in front of every transaction. The
 * session created at unlock is never what signs: each signature runs its own
 * passkey ceremony and derives fresh key material, which is used once and
 * zeroed. So an unlocked tab left open, or a script that got hold of the page,
 * still cannot move money — every signature costs a deliberate human approval
 * on the device that owns the passkey.
 *
 * It is the passkey equivalent of MetaMask's confirmation pop-up, and it costs
 * the user a fingerprint instead of a window.
 *
 * `expected` is the address the caller believes it is signing for. A user with
 * several passkeys for this domain can pick the wrong one at the prompt, which
 * would derive a different (perfectly valid) wallet — signing from it would
 * silently spend from the wrong account, so a mismatch is refused and the
 * derived key discarded immediately.
 */
export async function authorizeWallet(expected: `0x${string}`): Promise<MeraWallet> {
  const result = await getPasskeyPrfOutput({
    rpId: relyingPartyId(),
    ...(storedCredential() ? { credential: storedCredential()! } : {}),
  });
  const wallet = walletFrom(result.prfOutput, result.credentialId);
  if (wallet.address.toLowerCase() !== expected.toLowerCase()) {
    wallet.session.end();
    throw new Error(
      `That passkey unlocks a different wallet (${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}). Approve with the passkey for ${expected.slice(0, 6)}…${expected.slice(-4)} to continue. Nothing was signed.`,
    );
  }
  remember(wallet);
  return wallet;
}

/**
 * Re-derives the wallet's raw private key for export.
 *
 * This is a safety feature, not a convenience one. A passkey-derived wallet
 * is unrecoverable if the passkey is lost — no seed phrase exists to fall
 * back on, and PayAI holds nothing that could restore it. Export is the only
 * escape hatch, and it also means a user is never locked into PayAI: the key
 * imports straight into MetaMask or Rabby.
 *
 * It deliberately runs a FRESH passkey ceremony rather than reading the live
 * session, so revealing a key always costs a biometric check even if the
 * wallet is already unlocked. The value is returned, never stored, logged, or
 * sent anywhere — the caller is responsible for showing it and dropping it.
 */
export async function exportPrivateKey(): Promise<`0x${string}`> {
  const known = storedCredential();
  const { prfOutput } = await getPasskeyPrfOutput({
    rpId: relyingPartyId(),
    ...(known ? { credential: known } : {}),
  });
  const hex = Array.from(prfOutput).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `0x${hex}`;
}

/** A viem wallet client bound to this session's account, for broadcasting.
 *  Callers pass the short-lived wallet returned by `authorizeWallet()`, so the
 *  key this signs with is one the user approved moments ago. */
export async function walletClientFor(wallet: MeraWallet) {
  const { createWalletClient, fallback, http } = await import("viem");
  return createWalletClient({
    account: wallet.account,
    chain: {
      id: MONAD_CHAIN_ID,
      name: MONAD_CHAIN_NAME,
      nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
      rpcUrls: { default: { http: MONAD_RPC_URLS } },
    },
    transport:
      MONAD_RPC_URLS.length > 1
        ? fallback(MONAD_RPC_URLS.map((u) => http(u, { retryCount: 3, retryDelay: 500, timeout: 12_000 })), { rank: false })
        : http(MONAD_RPC_URLS[0], { retryCount: 4, retryDelay: 500, timeout: 12_000 }),
  });
}

/**
 * Turns Mera's error codes into something a person can act on. A cancelled
 * biometric prompt is by far the most common outcome and is not an error
 * worth alarming anyone about.
 */
export function friendlyMeraError(e: unknown): string {
  if (isMeraError(e)) {
    switch (e.code) {
      case "PRF_UNAVAILABLE":
        return "This device's passkeys can't secure a wallet yet. Try another device, or connect an existing wallet instead.";
      case "PASSKEY_OPERATION_FAILED":
        return "Passkey sign-in was cancelled or didn't complete. You can try again.";
      case "CRYPTO_UNAVAILABLE":
        return "Secure crypto isn't available in this browser. PayAI Wallet needs a modern browser on a secure (https) connection.";
      case "SESSION_ENDED":
        return "Your wallet session ended. Sign in again to continue.";
      default:
        return e.message;
    }
  }
  return e instanceof Error ? e.message : "Something went wrong setting up your wallet.";
}

/**
 * The same mapping, phrased for the approval that gates a signature rather
 * than for signing in. A cancelled prompt here means the user changed their
 * mind about a transaction — it must read as "nothing happened", never as a
 * failure the user might respond to by trying to pay again.
 */
export function friendlyApprovalError(e: unknown): string {
  if (isMeraError(e)) {
    switch (e.code) {
      case "PASSKEY_OPERATION_FAILED":
        return "Not approved — the passkey check was cancelled or didn't finish. Nothing was signed and no funds moved.";
      case "SESSION_ENDED":
        return "Your wallet session ended before this could be signed. Unlock your wallet and try again — nothing was sent.";
      default:
        return friendlyMeraError(e);
    }
  }
  return friendlyMeraError(e);
}
