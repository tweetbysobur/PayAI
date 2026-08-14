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
import { linkMessage, unlinkMessage } from "@/lib/platform/linkMessages";
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
   * `created` tells the caller which happened, so first-run onboarding (and
   * its username prompt) only shows for an actually-new wallet, never a
   * returning user just unlocking theirs.
   */
  setUpEmbeddedWallet: (opts?: { create?: boolean }) => Promise<{ address: string; created: boolean }>;
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

  /* ── Two wallets at once ───────────────────────────────────────────────── */
  /**
   * Which wallet is currently acting — signing, paying, being shown as "you".
   *
   * Connecting an external wallet used to take over: the PayAI Wallet simply
   * stopped being the one in use, with no way back short of disconnecting.
   * That is backwards. The PayAI Wallet is the account; an external wallet is
   * something the account has. Both stay connected and the user chooses.
   */
  activeKind: WalletProviderKind | null;
  /** The PayAI Wallet's address whenever this device has one unlocked or
   *  remembered, whether or not it is the active wallet. */
  accountAddress: string | null;
  /** The connected external wallet's address, whether or not it is active. */
  externalAddress: string | null;
  /** True when both a PayAI Wallet and an external wallet are available, i.e.
   *  when switching is a thing the user can do. */
  canSwitchWallets: boolean;
  /** Make a wallet the acting one. Persisted per device, so coming back lands
   *  where you left off. */
  switchWallet: (kind: WalletProviderKind) => void;

  /* ── Linked wallets ────────────────────────────────────────────────────── */
  /** External wallets attached to this account. Public addresses; the link
   *  grants nothing on its own. */
  linkedWallets: LinkedWalletView[];
  linkedLoading: boolean;
  /** Attaches the connected external wallet to this account. Costs two
   *  approvals — the external wallet's and the passkey's — because both ends
   *  have to prove themselves. Returns the updated list. */
  linkExternalWallet: (label?: string) => Promise<LinkedWalletView[]>;
  /** Detaches a wallet. Only the account approves: someone who has lost
   *  access to an external wallet still needs to be able to remove it. */
  unlinkWallet: (address: string) => Promise<LinkedWalletView[]>;
  /** Re-read the linked list — after a rename, or any change made outside
   *  this context. */
  refreshLinkedWallets: () => Promise<void>;
  /**
   * Sends from a specific wallet rather than whichever is active — what
   * moving funds from a connected wallet into the PayAI Wallet needs, since
   * the destination is the wallet you would otherwise be sending as.
   */
  sendTransactionFrom: (
    kind: WalletProviderKind,
    tx: { to: string; data?: string; value?: string },
  ) => Promise<string>;
}

export interface LinkedWalletView {
  address: string;
  label: string;
  linkedAt: number;
  /** When this wallet was last seen connected, if ever. */
  lastConnectedAt?: number;
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

/** Which wallet the user last chose to act as. Per device, because that is
 *  where the choice was made and where it should be remembered. */
const ACTIVE_KIND_KEY = "payai_active_wallet";

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
  // Which wallet is acting. Null until the user has expressed a preference,
  // at which point the default below stops applying.
  const [chosenKind, setChosenKind] = useState<WalletProviderKind | null>(null);
  const [linkedWallets, setLinkedWallets] = useState<LinkedWalletView[]>([]);
  const [linkedLoading, setLinkedLoading] = useState(false);

  // Passkey support is a browser capability, so it can only be read on the
  // client — never from the server's config.
  useEffect(() => {
    setEmbeddedSupported(provider.isSupported());
    setHasEmbeddedCredential(provider.hasLocalCredential());
    setLastKnownAddress(provider.lastKnownAddress());
    try {
      const saved = localStorage.getItem(ACTIVE_KIND_KEY);
      if (saved === "embedded" || saved === "external") setChosenKind(saved);
    } catch {
      /* private mode — the default below applies every load */
    }
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
  // Locked describes the ACCOUNT, and nothing else. It used to also require
  // that no external wallet was connected, which was only ever true because a
  // connected external wallet replaced the account outright. Now that both
  // coexist, "my PayAI Wallet is locked" and "I am currently paying with
  // MetaMask" are separate facts, and conflating them left a locked account
  // with no visible way back in.
  const isLocked = !wallet && hasEmbeddedCredential;

  /**
   * The account's own address — the PayAI Wallet — whether or not it is the
   * one currently acting. Falls back to the remembered address while locked,
   * so linking and switching still know which account they belong to.
   */
  const accountAddress = wallet?.address ?? (hasEmbeddedCredential ? lastKnownAddress : null);

  /**
   * Which wallet acts.
   *
   * The default is the account: connecting MetaMask alongside a PayAI Wallet
   * should not quietly demote the PayAI Wallet to something you can only get
   * back to by disconnecting. An explicit choice wins over the default, and a
   * choice that is no longer possible (the chosen wallet went away) falls back
   * to whatever is actually there.
   */
  const embeddedUsable = !!wallet;
  const externalUsable = !!external.address;
  const activeKind: WalletProviderKind | null =
    chosenKind === "external" && externalUsable ? "external"
      : chosenKind === "embedded" && embeddedUsable ? "embedded"
      : embeddedUsable ? "embedded"
      : externalUsable ? "external"
      : null;

  const usingEmbedded = activeKind === "embedded" && !!wallet;

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
    async (opts?: { create?: boolean }): Promise<{ address: string; created: boolean }> => {
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

        return { address: handle.address, created: shouldCreate };
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

  /** Disconnects the wallet currently acting, leaving the other one alone.
   *  With both connected, "Disconnect" while using MetaMask means MetaMask —
   *  it must not also sign you out of your account. */
  const disconnect = useCallback(async () => {
    if (usingEmbedded) {
      await signOutEmbedded();
      return;
    }
    if (external.address) {
      await external.disconnect();
      return;
    }
    await signOutEmbedded();
  }, [usingEmbedded, external, signOutEmbedded]);

  const switchWallet = useCallback((next: WalletProviderKind) => {
    setChosenKind(next);
    try { localStorage.setItem(ACTIVE_KIND_KEY, next); } catch { /* private mode */ }
  }, []);

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

  /**
   * Sends from a named wallet rather than whichever is active.
   *
   * Moving funds from a connected wallet into the PayAI Wallet needs this:
   * the destination is the account, so the source has to be addressed
   * explicitly instead of being "whoever is acting".
   */
  const sendTransactionFrom = useCallback(
    async (from: WalletProviderKind, tx: { to: string; data?: string; value?: string }): Promise<string> => {
      if (from === "embedded") {
        if (!wallet) throw new Error("Unlock your PayAI Wallet to send from it.");
        return wallet.sendTransaction(tx);
      }
      if (!external.address) throw new Error("Connect an external wallet to send from it.");
      return external.sendTransaction(tx);
    },
    [wallet, external],
  );

  const refreshLinked = useCallback(async (accountFor: string | null) => {
    if (!accountFor) { setLinkedWallets([]); return; }
    setLinkedLoading(true);
    try {
      const r = await fetch(`/api/linked-wallets?account=${accountFor}`);
      const j = await r.json();
      setLinkedWallets(Array.isArray(j?.wallets) ? j.wallets : []);
    } catch {
      setLinkedWallets([]);
    } finally {
      setLinkedLoading(false);
    }
  }, []);

  /**
   * Attaches the connected external wallet to this account.
   *
   * Two approvals, in this order: the external wallet first (it is the one
   * being vouched for, and the cheaper prompt to abandon), then the passkey.
   * Both are required server-side — see lib/platform/linkedWallets.ts.
   */
  const linkExternalWallet = useCallback(
    async (label?: string): Promise<LinkedWalletView[]> => {
      const accountFor = wallet?.address;
      if (!accountFor) throw new Error("Unlock your PayAI Wallet to link a wallet to it.");
      if (!external.address) throw new Error("Connect the wallet you want to link first.");
      if (external.address.toLowerCase() === accountFor.toLowerCase()) {
        throw new Error("That's this account's own wallet — there's nothing to link.");
      }

      const message = linkMessage(accountFor, external.address);
      const externalSignature = await external.signMessage(message);
      const accountSignature = await wallet.signMessage(message);

      const r = await fetch("/api/linked-wallets", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          account: accountFor,
          external: external.address,
          label: label ?? "",
          accountSignature,
          externalSignature,
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Could not link that wallet.");
      const list = Array.isArray(j?.wallets) ? j.wallets : [];
      setLinkedWallets(list);
      return list;
    },
    [wallet, external],
  );

  const unlinkWalletFn = useCallback(
    async (target: string): Promise<LinkedWalletView[]> => {
      const accountFor = wallet?.address;
      if (!accountFor) throw new Error("Unlock your PayAI Wallet to change its linked wallets.");
      const accountSignature = await wallet.signMessage(unlinkMessage(accountFor, target));
      const r = await fetch("/api/linked-wallets", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account: accountFor, external: target, accountSignature }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j?.error || "Could not remove that wallet.");
      const list = Array.isArray(j?.wallets) ? j.wallets : [];
      setLinkedWallets(list);
      return list;
    },
    [wallet],
  );

  const switchNetwork = useCallback(async () => {
    // An embedded wallet signs for whichever chain PayAI is configured for —
    // there is no wrong network to switch away from.
    if (usingEmbedded) return;
    return external.switchNetwork();
  }, [usingEmbedded, external]);

  useEffect(() => {
    void refreshLinked(accountAddress);
  }, [accountAddress, refreshLinked]);

  const address = usingEmbedded ? wallet?.address ?? null : external.address ?? wallet?.address ?? null;
  const providerId: WalletProviderId | null = usingEmbedded ? provider.id : external.address ? "injected" : wallet ? provider.id : null;
  const kind: WalletProviderKind | null = activeKind;

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
    // The address of whatever is acting; when nothing is, the account's last
    // known one so read-only surfaces keep working while it is locked.
    readAddress: address ?? (isLocked ? lastKnownAddress : null),
    activeKind,
    accountAddress,
    externalAddress: external.address ?? null,
    canSwitchWallets: !!accountAddress && externalUsable,
    switchWallet,
    linkedWallets,
    linkedLoading,
    linkExternalWallet,
    unlinkWallet: unlinkWalletFn,
    refreshLinkedWallets: () => refreshLinked(accountAddress),
    sendTransactionFrom,
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
