"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { EthProvider } from "./provider";
import { MONAD_CHAIN_ID, MONAD_CHAIN_ID_HEX, MONAD_CHAIN_NAME, MONAD_RPC_URLS, MONAD_EXPLORER } from "@/lib/monad/public";

const STORAGE_KEY = "veripay_wallet_connected";

export interface WalletState {
  address: string | null;
  chainId: number | null;
  error: string | null;
  connect: () => Promise<string>;
  disconnect: () => Promise<void>;
  switchNetwork: () => Promise<void>;
  sendTransaction: (tx: { to: string; data?: string; value?: string }) => Promise<string>;
  waitForReceipt: (hash: string) => Promise<unknown>;
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
  // eth_accounts comes back empty after that and this won't reconnect).
  useEffect(() => {
    const eth = window.ethereum;
    if (!eth || localStorage.getItem(STORAGE_KEY) !== "1") return;
    (async () => {
      const accounts = (await eth.request({ method: "eth_accounts" })) as string[];
      if (accounts[0]) {
        setAddress(accounts[0]);
        connectedRef.current = true;
        await readChain(eth);
      } else {
        // Permission was revoked elsewhere — clear the stale flag.
        localStorage.removeItem(STORAGE_KEY);
      }
    })().catch(() => {});
  }, [readChain]);

  useEffect(() => {
    const eth = window.ethereum;
    if (!eth?.on) return;
    const onAccounts = (...args: unknown[]) => {
      // Ignore wallet account events until the user has explicitly connected
      // this session — otherwise the app could silently connect off a stray
      // accountsChanged event from a previously-authorized wallet.
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
  }, []);

  const connect = useCallback(async (): Promise<string> => {
    setError(null);
    const eth = window.ethereum;
    if (!eth) {
      setError("No wallet found. Install MetaMask or another Monad-compatible wallet.");
      throw new Error("No wallet found.");
    }
    const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
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
    setAddress(null);
    setChainId(null);
    connectedRef.current = false;
    localStorage.removeItem(STORAGE_KEY);
    const eth = window.ethereum;
    try {
      await eth?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] });
    } catch {
      // Wallet doesn't support EIP-2255 revoke — local disconnect already done.
    }
  }, []);

  const switchNetwork = useCallback(async () => {
    const eth = window.ethereum;
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
  }, [readChain]);

  /** Sign and broadcast a raw transaction with the connected wallet. Supports
   *  both native value transfers (MON: pass `value`, no `data`) and contract
   *  calls (USDC transfer: pass `data`, no `value`). */
  const sendTransaction = useCallback(async (tx: { to: string; data?: string; value?: string }): Promise<string> => {
    const eth = window.ethereum;
    if (!eth || !address) throw new Error("Wallet not connected.");
    const params: { from: string; to: string; data?: string; value?: string } = { from: address, to: tx.to };
    if (tx.data && tx.data !== "0x") params.data = tx.data;
    if (tx.value && tx.value !== "0x0") params.value = tx.value;
    return (await eth.request({
      method: "eth_sendTransaction",
      params: [params],
    })) as string;
  }, [address]);

  // Awaiting the receipt is our own RPC read (not the wallet's), so it gets
  // the same fallback treatment as the server: try every configured URL.
  // Capped at 90s (matches the server's custodial-path timeout) so a dead RPC
  // can't hang the UI forever — the tx is still broadcast; the user just gets
  // a clear "still pending" message instead of an infinite spinner.
  const waitForReceipt = useCallback(async (hash: string) => {
    const { createPublicClient, fallback, http } = await import("viem");
    const client = createPublicClient({
      chain: {
        id: MONAD_CHAIN_ID,
        name: MONAD_CHAIN_NAME,
        nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
        rpcUrls: { default: { http: MONAD_RPC_URLS } },
      },
      transport: MONAD_RPC_URLS.length > 1
        ? fallback(MONAD_RPC_URLS.map((u) => http(u, { retryCount: 3, retryDelay: 500, timeout: 12_000 })), { rank: false })
        : http(MONAD_RPC_URLS[0], { retryCount: 4, retryDelay: 500, timeout: 12_000 }),
    });
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
