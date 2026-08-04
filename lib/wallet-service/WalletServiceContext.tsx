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
 * Internally this is a thin router: an "external" account still goes through
 * the real EIP-1193 hook underneath (unchanged); an "embedded" account calls
 * the server (`/api/wallet-service/embedded/*`), which is the only place
 * that ever talks to Mera (see lib/wallet-service/providers/mera.ts). No
 * provider SDK, embedded or external, is imported here.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useWallet as useExternalWallet, type WalletState as ExternalWalletState } from "@/lib/wallet/useWallet";
import { MONAD_CHAIN_ID } from "@/lib/monad/public";
import type { AuthMethod, WalletProviderId, WalletProviderKind } from "./types";
import type { EthProvider } from "@/lib/wallet/provider";

interface EmbeddedSession {
  userId: string;
  authMethod: AuthMethod;
  label: string;
  address: string;
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
  /** Two-step email sign-in: request a code, then verify it. */
  requestEmailCode: (email: string) => Promise<void>;
  verifyEmailCode: (email: string, code: string) => Promise<string>;
  embeddedBusy: boolean;
  /** Explicit alias for connecting an external wallet — same as `connect`. */
  connectExternal: (provider?: EthProvider) => Promise<string>;
}

const emptyAuthMethods: AuthMethodAvailability = { google: false, apple: false, x: false, email: false };

function useWalletServiceState(): WalletServiceState {
  const external = useExternalWallet();
  const [embedded, setEmbedded] = useState<EmbeddedSession | null>(null);
  const [embeddedAvailable, setEmbeddedAvailable] = useState(false);
  const [authMethods, setAuthMethods] = useState<AuthMethodAvailability>(emptyAuthMethods);
  const [embeddedBusy, setEmbeddedBusy] = useState(false);
  const [embeddedError, setEmbeddedError] = useState<string | null>(null);

  // Probe capability + restore an embedded session on load. An external
  // wallet connecting later (see below) always wins — a user actively
  // picking "Connect Existing Wallet" is a deliberate switch away from
  // embedded, not a conflict to resolve.
  useEffect(() => {
    fetch("/api/wallet-service/status")
      .then((r) => r.json())
      .then((j) => {
        setEmbeddedAvailable(!!j.embedded?.available);
        setAuthMethods(j.authMethods ?? emptyAuthMethods);
        if (j.session) setEmbedded(j.session);
      })
      .catch(() => {});
  }, []);

  const usingEmbedded = !external.address && !!embedded;

  // Fire-and-forget wallet_connected/wallet_disconnected notifications for
  // the external provider — embedded already records wallet_connected
  // server-side (see the OAuth/email callback routes) at the moment the
  // wallet is actually created or recovered, which this effect must not
  // duplicate.
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
        body: JSON.stringify({ sender: cur, type: "wallet_connected", title: "External wallet connected", detail: "Connected an external wallet to PayAI." }),
      }).catch(() => {});
    } else if (!cur && prev) {
      fetch("/api/wallet-events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sender: prev, type: "wallet_disconnected", title: "External wallet disconnected", detail: "Disconnected your external wallet from PayAI." }),
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

  const verifyEmailCodeFn = useCallback(async (email: string, code: string): Promise<string> => {
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
      const session: EmbeddedSession = { userId: `email:${email.toLowerCase()}`, authMethod: "email", label: email, address: j.address };
      setEmbedded(session);
      return j.address as string;
    } catch (e) {
      setEmbeddedError(e instanceof Error ? e.message : "Could not verify the code.");
      throw e;
    } finally {
      setEmbeddedBusy(false);
    }
  }, []);

  const disconnect = useCallback(async () => {
    if (external.address) {
      await external.disconnect();
      return;
    }
    if (embedded) {
      await fetch("/api/auth/session", { method: "DELETE" }).catch(() => {});
      fetch("/api/wallet-events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sender: embedded.address, type: "wallet_disconnected", providerId: "mera", title: "Embedded wallet disconnected", detail: "Signed out of your PayAI Wallet." }),
      }).catch(() => {});
      setEmbedded(null);
    }
  }, [external, embedded]);

  const signMessage = useCallback(async (message: string): Promise<string> => {
    if (usingEmbedded) {
      const r = await fetch("/api/wallet-service/embedded/sign-message", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Signing failed.");
      return j.signature as string;
    }
    return external.signMessage(message);
  }, [usingEmbedded, external]);

  const sendTransaction = useCallback(async (tx: { to: string; data?: string; value?: string }): Promise<string> => {
    if (usingEmbedded) {
      const r = await fetch("/api/wallet-service/embedded/send-transaction", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(tx),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Transaction failed.");
      return j.txHash as string;
    }
    return external.sendTransaction(tx);
  }, [usingEmbedded, external]);

  const switchNetwork = useCallback(async () => {
    // Embedded wallets always operate on the one chain the server is
    // configured for — there's no wrong network to switch away from.
    if (usingEmbedded) return;
    return external.switchNetwork();
  }, [usingEmbedded, external]);

  const address = external.address ?? embedded?.address ?? null;
  const providerId: WalletProviderId | null = external.address ? "injected" : embedded ? "mera" : null;
  const kind: WalletProviderKind | null = external.address ? "external" : embedded ? "embedded" : null;

  return {
    ...external,
    address,
    chainId: usingEmbedded ? MONAD_CHAIN_ID : external.chainId,
    isWrongNetwork: usingEmbedded ? false : external.isWrongNetwork,
    error: usingEmbedded ? embeddedError : external.error,
    providerId,
    kind,
    authMethod: embedded?.authMethod ?? null,
    label: external.address ? external.address : embedded?.label ?? null,
    embeddedAvailable,
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
  };
}

const WalletServiceContext = createContext<WalletServiceState | null>(null);

/** Mount once, inside the existing <WalletProvider> (root layout). */
export function WalletServiceProvider({ children }: { children: ReactNode }) {
  const state = useWalletServiceState();
  return <WalletServiceContext.Provider value={state}>{children}</WalletServiceContext.Provider>;
}

/** The provider-agnostic wallet hook. Drop-in replacement for
 *  `useWallet()` — same fields, plus `kind`/`providerId`/embedded sign-in. */
export function useWalletService(): WalletServiceState {
  const ctx = useContext(WalletServiceContext);
  if (!ctx) {
    throw new Error("useWalletService() must be used within <WalletServiceProvider> — check the root layout.");
  }
  return ctx;
}
