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

/** Remembering the credential id is what turns a returning user's sign-in
 *  into a single biometric prompt instead of an authenticator picker. It is
 *  a public identifier, not a secret — losing it only costs a picker. */
const CREDENTIAL_KEY = "payai_mera_credential";

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
  return window.location.hostname;
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
  } catch {
    /* nothing to clean up */
  }
}

/** PRF output is 32 bytes of authenticator-bound entropy — used directly as
 *  the secp256k1 scalar, exactly as Mera intends. */
function walletFrom(prfOutput: Uint8Array, credentialId: string): MeraWallet {
  const session = createSecp256k1SigningSession({ privateKey: prfOutput });
  return {
    address: getEvmAddress(session.publicKey),
    credentialId,
    account: toViemAccount(session),
    session,
  };
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
  rememberCredential({ credentialId: result.credentialId, transports: result.transports });
  return walletFrom(result.prfOutput, result.credentialId);
}

/**
 * Re-derives an existing wallet from a passkey the user already has. Returns
 * the SAME address every time — that is a property of the PRF, not of any
 * bookkeeping PayAI does, so a returning user can never end up with a second
 * wallet.
 */
export async function recoverWallet(): Promise<MeraWallet> {
  const known = storedCredential();
  const result = await getPasskeyPrfOutput({
    rpId: relyingPartyId(),
    // Omitted on a fresh device so the browser offers whatever passkeys the
    // user has synced for this domain.
    ...(known ? { credential: known } : {}),
  });
  rememberCredential({ credentialId: result.credentialId });
  return walletFrom(result.prfOutput, result.credentialId);
}

/** A viem wallet client bound to this session's account, for broadcasting.
 *  Signing happens locally and shows no passkey prompt — the session already
 *  holds the key, which is what keeps the send flow to a single approval. */
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
