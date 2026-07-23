"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { EthProvider } from "./provider";
import { MONAD_CHAIN_ID, MONAD_CHAIN_ID_HEX, MONAD_CHAIN_NAME, MONAD_RPC_URLS, MONAD_EXPLORER } from "@/lib/monad/public";

const STORAGE_KEY = "veripay_wallet_connected";

export interface WalletState {
  address: string | null;
  chainId: number | null;
  error: string | null;
  connect: (provider?: EthProvider) => Promise<string>;
  disconnect: () => Promise<void>;
  switchNetwork: () => Promise<void>;
  sendTransaction: (tx: { to: string; data?: string; value?: string }) => Promise<string>;
  waitForReceipt: (hash: string) => Promise<unknown>;
  signMessage: (message: string) => Promise<string>;
  isWrongNetwork: boolean;
}

/**
 * The real EIP-1193 wallet logic — connect/disconnect/persistence, network
 * detect+switch, and raw transaction signing. This is an internal
 * implementation detail: every consumer should use `useWallet()` below
 * (backed by WalletProvider), NOT this hook directly, otherwise it gets its
 * own disconnected copy of the wallet state instead of the shared one — the
 * exact bug that meant connecting from the top bar didn't update the page
 * content underneath it.
 */
function useWalletState(): WalletState {
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The specific EIP-1193 provider the user connected with (a chosen wallet
  // from EIP-6963 discovery, or the default injected one). All requests and
  // event listeners use this, not a global, so the app talks to the exact
  // wallet the user picked.
  const [activeProvider, setActiveProvider] = useState<EthProvider | null>(null);
  // True only after the user explicitly connects this session — guards the
  // accountsChanged listener so a wallet event can never silently connect a
  // session the user never opted into.
  const connectedRef = useRef(false);

  const readChain = useCallback(async (eth: EthProvider) => {
    const hex = (await eth.request({ method: "eth_chainId" })) as string;
    setChainId(parseInt(hex, 16));
  }, []);

  // Silent reconnect on load — only if the user connected before AND hasn't
  // explicitly disconnected (Disconnect revokes the wallet permission, so
  // eth_accounts comes back empty after that and this won't reconnect). Uses
  // the default injected provider; the /connect picker is how a specific
  // wallet is chosen on a fresh connect.
  useEffect(() => {
    const eth = window.ethereum;
    if (!eth || localStorage.getItem(STORAGE_KEY) !== "1") return;
    (async () => {
      const accounts = (await eth.request({ method: "eth_accounts" })) as string[];
      if (accounts[0]) {
        setActiveProvider(eth);
        setAddress(accounts[0]);
        connectedRef.current = true;
        await readChain(eth);
      } else {
        // Permission was revoked elsewhere — clear the stale flag.
        localStorage.removeItem(STORAGE_KEY);
      }
    })().catch(() => {});
  }, [readChain]);

  // Bind account/chain listeners to whichever provider is currently active.
  useEffect(() => {
    const eth = activeProvider;
    if (!eth?.on) return;
    const onAccounts = (...args: unknown[]) => {
      if (!connectedRef.current) return;
      const accounts = args[0] as string[];
      if (accounts[0]) setAddress(accounts[0]);
      else { setAddress(null); connectedRef.current = false; }
    };
    const onChain = (...args: unknown[]) => setChainId(parseInt(args[0] as string, 16));
    eth.on("accountsChanged", onAccounts);
    eth.on("chainChanged", onChain);
    return () => {
      eth.removeListener?.("accountsChanged", onAccounts);
      eth.removeListener?.("chainChanged", onChain);
    };
  }, [activeProvider]);

  const connect = useCallback(async (provider?: EthProvider): Promise<string> => {
    setError(null);
    const eth = provider ?? window.ethereum;
    if (!eth) {
      setError("No wallet found. Install MetaMask, Rabby, or another Monad-compatible wallet.");
      throw new Error("No wallet found.");
    }
    let accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
    if (!accounts?.length) {
      // Some wallets return an empty array instead of re-prompting once
      // permission was revoked (e.g. right after Disconnect) — this used to
      // silently "succeed" with address = undefined, leaving the UI stuck on
      // "Connect wallet" with no error. Force a fresh permission request and
      // retry once before giving up for real.
      await eth.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] }).catch(() => {});
      accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
    }
    if (!accounts?.length) {
      setError("Your wallet didn't return an account. Open your wallet extension and approve the connection.");
      throw new Error("No accounts returned by wallet.");
    }
    setActiveProvider(eth);
    setAddress(accounts[0]);
    connectedRef.current = true;
    localStorage.setItem(STORAGE_KEY, "1");
    await readChain(eth);
    return accounts[0];
  }, [readChain]);

  // The true opposite of connect: connect *grants* the eth_accounts permission,
  // so disconnect *revokes* it (EIP-2255 wallet_revokePermissions). The wallet
  // forgets the authorization, so the next connect asks for fresh approval and
  // no silent reconnect can bring the session back. Local state is cleared
  // regardless, so wallets that don't support revoke still disconnect cleanly.
  const disconnect = useCallback(async () => {
    const eth = activeProvider ?? window.ethereum;
    setAddress(null);
    setChainId(null);
    connectedRef.current = false;
    setActiveProvider(null);
    localStorage.removeItem(STORAGE_KEY);
    try {
      await eth?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] });
    } catch {
      // Wallet doesn't support EIP-2255 revoke — local disconnect already done.
    }
  }, [activeProvider]);

  const switchNetwork = useCallback(async () => {
    const eth = activeProvider ?? window.ethereum;
    if (!eth) return;
    setError(null);
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: MONAD_CHAIN_ID_HEX }] });
      await readChain(eth);
    } catch (e) {
      const code = (e as { code?: number })?.code;
      if (code !== 4902) {
        setError(e instanceof Error ? e.message : "Could not switch network.");
        throw e;
      }
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: MONAD_CHAIN_ID_HEX,
          chainName: MONAD_CHAIN_NAME,
          nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
          rpcUrls: MONAD_RPC_URLS,
          blockExplorerUrls: [MONAD_EXPLORER],
        }],
      });
      await readChain(eth);
    }
  }, [readChain, activeProvider]);

  /** Sign and broadcast a raw transaction with the connected wallet. Supports
   *  both native value transfers (MON: pass `value`, no `data`) and contract
   *  calls (USDC transfer: pass `data`, no `value`). */
  const sendTransaction = useCallback(async (tx: { to: string; data?: string; value?: string }): Promise<string> => {
    const eth = activeProvider ?? window.ethereum;
    if (!eth || !address) throw new Error("Wallet not connected.");
    const params: { from: string; to: string; data?: string; value?: string } = { from: address, to: tx.to };
    if (tx.data && tx.data !== "0x") params.data = tx.data;
    if (tx.value && tx.value !== "0x0") params.value = tx.value;
    return (await eth.request({
      method: "eth_sendTransaction",
      params: [params],
    })) as string;
  }, [address, activeProvider]);

  /** personal_sign through the wallet the user actually connected with, not
   *  a bare `window.ethereum` — with multiple wallet extensions installed,
   *  that global can silently resolve to a DIFFERENT extension than the one
   *  connected, sending the signature request to the wrong (or a
   *  disconnected) wallet. */
  const signMessage = useCallback(async (message: string): Promise<string> => {
    const eth = activeProvider ?? window.ethereum;
    if (!eth || !address) throw new Error("Wallet not connected.");
    const signature = (await eth.request({ method: "personal_sign", params: [message, address] })) as string | undefined;
    if (!signature) throw new Error("Wallet confirmation was cancelled.");
    return signature;
  }, [address, activeProvider]);

  // Awaiting the receipt is our own RPC read (not the wallet's), so it gets
  // the same fallback treatment as the server: try every configured URL.
  // Capped at 90s (matches the server's custodial-path timeout) so a dead RPC
  // can't hang the UI forever — the tx is still broadcast; the user just gets
  // a clear "still pending" message instead of an infinite spinner.
  const waitForReceipt = useCallback(async (hash: string) => {
    const { getBrowserPublicClient } = await import("@/lib/monad/browserClient");
    const client = await getBrowserPublicClient();
    try {
      return await client.waitForTransactionReceipt({ hash: hash as `0x${string}`, timeout: 90_000 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      if (msg.toLowerCase().includes("timed out") || msg.toLowerCase().includes("timeout")) {
        throw new Error(
          `Your transaction was broadcast (${hash}) but confirmation is taking longer than expected. Check the explorer — it may still confirm.`,
        );
      }
      throw e;
    }
  }, []);

  return {
    address,
    chainId,
    error,
    connect,
    disconnect,
    switchNetwork,
    sendTransaction,
    waitForReceipt,
    signMessage,
    isWrongNetwork: address != null && chainId != null && chainId !== MONAD_CHAIN_ID,
  };
}

const WalletContext = createContext<WalletState | null>(null);

/**
 * Wraps the app once (root layout) so every component — top bar, payment
 * composer, wallets page, connect page — shares ONE real wallet connection
 * instead of each independently re-implementing eth_accounts/eth_chainId.
 * Connecting anywhere updates everywhere immediately, with no dependency on
 * every consumer having separately registered its own provider-event
 * listener in time.
 */
export function WalletProvider({ children }: { children: ReactNode }) {
  const state = useWalletState();
  return <WalletContext.Provider value={state}>{children}</WalletContext.Provider>;
}

/** The shared wallet connection — must be used under <WalletProvider> (mounted in the root layout). */
export function useWallet(): WalletState {
  const ctx = useContext(WalletContext);
  if (!ctx) {
    throw new Error("useWallet() must be used within <WalletProvider> — check that it's mounted in the root layout.");
  }
  return ctx;
}
