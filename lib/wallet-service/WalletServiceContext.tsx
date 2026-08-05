"use client";

/**
 * The Wallet Service — the ONE hook every client component should use to
 * touch a wallet. It exposes the exact same shape `useWallet()` (the
 * pre-existing EIP-1193 hook, still the "external" provider underneath)
 * already had — `address`, `signMessage`, `sendTransaction`, etc. — so every
 * call site that used to `import { useWallet } from "@/lib/wallet/useWallet"`
 * can switch to `useWalletService` with no other changes, and gains embedded
 * wallets for free.
 *
 * Internally this is a thin router: an "external" account goes through the
 * real EIP-1193 hook underneath (unchanged); an "embedded" account goes
 * through the registry's active provider. Neither provider's SDK is imported
 * here — the registry owns that, which is why swapping the embedded provider
 * for one that works completely differently (a passkey-derived key instead
 * of a hosted signing API) changed nothing in this file's public shape and
 * nothing at all in its consumers.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useWallet as useExternalWallet, type WalletState as ExternalWalletState } from "@/lib/wallet/useWallet";
import { MONAD_CHAIN_ID } from "@/lib/monad/public";
import { getEmbeddedProvider } from "./registry";
import type { AuthMethod, EmbeddedWalletHandle, WalletProviderId, WalletProviderKind } from "./types";
import type { EthProvider } from "@/lib/wallet/provider";

/** The signed-in PayAI account. Identity only — the wallet address is NOT
 *  part of it, because the server never learns it. */
interface AccountSession {
  userId: string;
  authMethod: AuthMethod;
  label: string;
}

export interface AuthMethodAvailability {
  google: boolean;
  apple: boolean;
  x: boolean;
  email: boolean;
}

export interface WalletServiceState extends ExternalWalletState {
  /** null until a wallet (of either kind) is connected. */
  providerId: WalletProviderId | null;
  kind: WalletProviderKind | null;
  authMethod: AuthMethod | null;
  /** Display label for the connected account — the wallet address for an
   *  external wallet, or the login identity (email/handle) for embedded. */
  label: string | null;
  embeddedAvailable: boolean;
  authMethods: AuthMethodAvailability;
  /** Kicks off the redirect-based OAuth flow for google/apple/x. Leaves the
   *  page — there is nothing to await. */
  connectEmbeddedOAuth: (method: "google" | "apple" | "x") => void;
  /** Two-step email sign-in: request a code, then verify it. Establishes the
   *  ACCOUNT; call `setUpEmbeddedWallet` afterwards to derive the wallet. */
  requestEmailCode: (email: string) => Promise<void>;
  verifyEmailCode: (email: string, code: string) => Promise<void>;
  embeddedBusy: boolean;
  /** Explicit alias for connecting an external wallet — same as `connect`. */
  connectExternal: (provider?: EthProvider) => Promise<string>;

  /* ── Embedded wallet (passkey) ─────────────────────────────────────────── */
  /** The signed-in PayAI account, if any. Present without a wallet during
   *  the brief window between signing in and completing the passkey step. */
  account: AccountSession | null;
  /** Whether this browser can do passkey-derived wallets at all. */
  embeddedSupported: boolean;
  /** True when this device already has a passkey for PayAI, so the natural
   *  action is "unlock" rather than "create". */
  hasEmbeddedCredential: boolean;
  /**
   * Derives the embedded wallet: creates a passkey for a first-time user, or
   * re-derives the existing one for a returning user. Deterministic — a
   * returning user always lands on the same address, never a duplicate.
   */
  setUpEmbeddedWallet: (opts?: { create?: boolean }) => Promise<string>;
  /** Signs out of the embedded wallet and zeroes its in-memory key. */
  signOutEmbedded: () => Promise<void>;
  /** This device has a wallet, but its key isn't in memory right now (after a
   *  reload or a new tab). One passkey check restores it — the wallet is
   *  locked, not lost. */
  isLocked: boolean;
  /**
   * The connected address, or the last one this device unlocked while the
   * wallet is locked. `address` stays null when locked — signing genuinely
   * isn't possible — but read-only surfaces (balances, history, deposit
   * alerts) shouldn't go blind just because the key was cleared. An address
   * is public, so nothing is exposed by remembering it.
   */
  readAddress: string | null;
  /** Re-derives the raw private key for export. Always costs a fresh passkey
   *  check. The caller must show it and drop it — never persist it. */
  exportEmbeddedKey: () => Promise<`0x${string}`>;
}

/**
 * How long an unlocked embedded wallet stays unlocked without interaction.
 *
 * The key lives in memory, so an abandoned tab is a live signing key on an
 * unattended screen. Fifteen minutes matches what banking apps do, and costs
 * a returning user one biometric tap rather than anything they'd notice.
 * External wallets are untouched — their own app owns that decision.
 */
const IDLE_LOCK_MS = 15 * 60 * 1000;

const emptyAuthMethods: AuthMethodAvailability = { google: false, apple: false, x: false, email: false };

function useWalletServiceState(): WalletServiceState {
  const external = useExternalWallet();
  const provider = getEmbeddedProvider();

  const [account, setAccount] = useState<AccountSession | null>(null);
  const [wallet, setWallet] = useState<EmbeddedWalletHandle | null>(null);
  const [authMethods, setAuthMethods] = useState<AuthMethodAvailability>(emptyAuthMethods);
  const [embeddedSupported, setEmbeddedSupported] = useState(false);
  const [hasEmbeddedCredential, setHasEmbeddedCredential] = useState(false);
  const [lastKnownAddress, setLastKnownAddress] = useState<string | null>(null);
  const [embeddedBusy, setEmbeddedBusy] = useState(false);
  const [embeddedError, setEmbeddedError] = useState<string | null>(null);

  // Passkey support is a browser capability, so it can only be read on the
  // client — never from the server's config.
  useEffect(() => {
    setEmbeddedSupported(provider.isSupported());
    setHasEmbeddedCredential(provider.hasLocalCredential());
    setLastKnownAddress(provider.lastKnownAddress());
  }, [provider]);

  // Restore the account session (identity only). The wallet itself is NOT
  // restored here: its key lives in memory and a reload ends that session by
  // design, so the next signature re-prompts for the passkey.
  useEffect(() => {
    fetch("/api/wallet-service/status")
      .then((r) => r.json())
      .then((j) => {
        setAuthMethods(j.authMethods ?? emptyAuthMethods);
        if (j.session) setAccount(j.session);
      })
      .catch(() => {});
  }, []);

  /**
   * True when this device has a wallet but the in-memory key is gone — after
   * a reload, a new tab, or an explicit lock. The wallet has NOT disappeared;
   * it needs one passkey check to come back. Surfaced so the UI can say
   * "locked" instead of "not connected", which reads like data loss.
   *
   * The key is deliberately never persisted to storage: keeping it in memory
   * only is what stops a stolen localStorage dump, or injected script reading
   * storage, from walking away with the wallet.
   */
  const isLocked = !external.address && !wallet && hasEmbeddedCredential;

  const usingEmbedded = !external.address && !!wallet;

  // Idle auto-lock. Zeroes the in-memory key after a period of no
  // interaction; the wallet then reads as "locked" and one passkey check
  // brings it back. Nothing is signed out — the account session survives.
  useEffect(() => {
    if (!wallet) return;
    let timer: ReturnType<typeof setTimeout>;
    const lock = () => {
      wallet.end();
      setWallet(null);
    };
    const restart = () => {
      clearTimeout(timer);
      timer = setTimeout(lock, IDLE_LOCK_MS);
    };
    // Deliberately cheap, passive listeners: this must not cost anything on
    // scroll-heavy pages.
    const events: (keyof WindowEventMap)[] = ["pointerdown", "keydown", "touchstart", "focus"];
    for (const e of events) window.addEventListener(e, restart, { passive: true });
    restart();
    return () => {
      clearTimeout(timer);
      for (const e of events) window.removeEventListener(e, restart);
    };
  }, [wallet]);

  // Fire-and-forget wallet_connected/wallet_disconnected notifications for
  // the external provider. The embedded side reports its own events from
  // setUpEmbeddedWallet, where "created" and "recovered" are distinguishable.
  const prevExternalAddress = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevExternalAddress.current;
    const cur = external.address;
    if (prev === cur) return;
    prevExternalAddress.current = cur;
    if (cur && !prev) {
      fetch("/api/wallet-events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sender: cur, type: "wallet_connected", providerId: "injected" }),
      }).catch(() => {});
    } else if (!cur && prev) {
      fetch("/api/wallet-events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sender: prev, type: "wallet_disconnected", providerId: "injected" }),
      }).catch(() => {});
    }
  }, [external.address]);

  const connectEmbeddedOAuth = useCallback((method: "google" | "apple" | "x") => {
    if (typeof window !== "undefined") window.location.href = `/api/auth/${method}`;
  }, []);

  const requestEmailCode = useCallback(async (email: string) => {
    setEmbeddedError(null);
    const r = await fetch("/api/auth/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || "Could not send the code.");
  }, []);

  const verifyEmailCodeFn = useCallback(async (email: string, code: string) => {
    setEmbeddedBusy(true);
    setEmbeddedError(null);
    try {
      const r = await fetch("/api/auth/email/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, code }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Invalid code.");
      setAccount({ userId: `email:${email.toLowerCase()}`, authMethod: "email", label: email });
    } catch (e) {
      setEmbeddedError(e instanceof Error ? e.message : "Could not verify the code.");
      throw e;
    } finally {
      setEmbeddedBusy(false);
    }
  }, []);

  /**
   * The one passkey ceremony. `create` forces a brand-new passkey; otherwise
   * a device that already has one recovers from it. Recovery is deterministic
   * inside the provider, so this can never mint a second wallet for someone
   * who already has one.
   */
  const setUpEmbeddedWallet = useCallback(
    async (opts?: { create?: boolean }): Promise<string> => {
      setEmbeddedBusy(true);
      setEmbeddedError(null);
      try {
        const shouldCreate = opts?.create ?? !provider.hasLocalCredential();
        const handle = shouldCreate
          ? await provider.create(account?.label ?? "PayAI Wallet")
          : await provider.recover();
        setWallet(handle);
        setHasEmbeddedCredential(true);

        fetch("/api/wallet-events", {
          method: "POST",
          headers: { "content-type": "application/json" },
          // Wording is the server's, not ours — a caller that could choose it
          // could put any words into a PayAI notification. See the route.
          body: JSON.stringify({
            sender: handle.address,
            providerId: provider.id,
            type: shouldCreate ? "wallet_created" : "wallet_connected",
          }),
        }).catch(() => {});

        return handle.address;
      } catch (e) {
        setEmbeddedError(provider.friendlyError(e));
        throw e;
      } finally {
        setEmbeddedBusy(false);
      }
    },
    [provider, account?.label],
  );

  const exportEmbeddedKey = useCallback(async () => {
    return provider.exportPrivateKey();
  }, [provider]);

  const signOutEmbedded = useCallback(async () => {
    const address = wallet?.address;
    wallet?.end(); // zeroes the in-memory key
    setWallet(null);
    setAccount(null);
    await fetch("/api/auth/session", { method: "DELETE" }).catch(() => {});
    if (address) {
      fetch("/api/wallet-events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sender: address, providerId: provider.id, type: "wallet_disconnected" }),
      }).catch(() => {});
    }
  }, [wallet, provider.id]);

  const disconnect = useCallback(async () => {
    if (external.address) {
      await external.disconnect();
      return;
    }
    await signOutEmbedded();
  }, [external, signOutEmbedded]);

  const signMessage = useCallback(
    async (message: string): Promise<string> => {
      if (usingEmbedded && wallet) return wallet.signMessage(message);
      return external.signMessage(message);
    },
    [usingEmbedded, wallet, external],
  );

  const sendTransaction = useCallback(
    async (tx: { to: string; data?: string; value?: string }): Promise<string> => {
      if (usingEmbedded && wallet) return wallet.sendTransaction(tx);
      return external.sendTransaction(tx);
    },
    [usingEmbedded, wallet, external],
  );

  const switchNetwork = useCallback(async () => {
    // An embedded wallet signs for whichever chain PayAI is configured for —
    // there is no wrong network to switch away from.
    if (usingEmbedded) return;
    return external.switchNetwork();
  }, [usingEmbedded, external]);

  const address = external.address ?? wallet?.address ?? null;
  const providerId: WalletProviderId | null = external.address ? "injected" : wallet ? provider.id : null;
  const kind: WalletProviderKind | null = external.address ? "external" : wallet ? "embedded" : null;

  return {
    ...external,
    address,
    chainId: usingEmbedded ? MONAD_CHAIN_ID : external.chainId,
    isWrongNetwork: usingEmbedded ? false : external.isWrongNetwork,
    error: usingEmbedded || (!external.address && embeddedError) ? embeddedError : external.error,
    providerId,
    kind,
    authMethod: account?.authMethod ?? null,
    label: external.address ? external.address : account?.label ?? wallet?.address ?? null,
    embeddedAvailable: embeddedSupported,
    authMethods,
    disconnect,
    signMessage,
    sendTransaction,
    switchNetwork,
    connectExternal: external.connect,
    connectEmbeddedOAuth,
    requestEmailCode,
    verifyEmailCode: verifyEmailCodeFn,
    embeddedBusy,
    account,
    embeddedSupported,
    hasEmbeddedCredential,
    setUpEmbeddedWallet,
    signOutEmbedded,
    exportEmbeddedKey,
    isLocked,
    readAddress: address ?? (isLocked ? lastKnownAddress : null),
  };
}

const WalletServiceContext = createContext<WalletServiceState | null>(null);

/** Mount once, inside the existing <WalletProvider> (root layout). */
export function WalletServiceProvider({ children }: { children: ReactNode }) {
  const state = useWalletServiceState();
  return <WalletServiceContext.Provider value={state}>{children}</WalletServiceContext.Provider>;
}

/** The provider-agnostic wallet hook. Drop-in replacement for `useWallet()` —
 *  same fields, plus `kind`/`providerId` and the embedded sign-in surface. */
export function useWalletService(): WalletServiceState {
  const ctx = useContext(WalletServiceContext);
  if (!ctx) {
    throw new Error("useWalletService() must be used within <WalletServiceProvider> — check the root layout.");
  }
  return ctx;
}
