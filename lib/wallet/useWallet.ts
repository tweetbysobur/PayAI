"use client";

import { useCallback, useEffect, useState } from "react";
import type { EthProvider } from "./provider";
import { MONAD_CHAIN_ID, MONAD_CHAIN_ID_HEX, MONAD_CHAIN_NAME, MONAD_RPC_URLS, MONAD_EXPLORER } from "@/lib/monad/public";

const STORAGE_KEY = "veripay_wallet_connected";

/**
 * Shared EIP-1193 wallet hook — connect/disconnect/persistence, network
 * detect+switch, and raw transaction signing. Used by the agent console (to
 * let a connected wallet sign its own payments) and the checkout page.
 */
export function useWallet() {
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const readChain = useCallback(async (eth: EthProvider) => {
    const hex = (await eth.request({ method: "eth_chainId" })) as string;
    setChainId(parseInt(hex, 16));
  }, []);

  // Silent reconnect on load — only if the user connected before (no popup).
  useEffect(() => {
    const eth = window.ethereum;
    if (!eth || localStorage.getItem(STORAGE_KEY) !== "1") return;
    (async () => {
      const accounts = (await eth.request({ method: "eth_accounts" })) as string[];
      if (accounts[0]) {
        setAddress(accounts[0]);
        await readChain(eth);
      }
    })().catch(() => {});
  }, [readChain]);

  useEffect(() => {
    const eth = window.ethereum;
    if (!eth?.on) return;
    const onAccounts = (...args: unknown[]) => {
      const accounts = args[0] as string[];
      if (accounts[0]) setAddress(accounts[0]);
      else { setAddress(null); localStorage.removeItem(STORAGE_KEY); }
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
    localStorage.setItem(STORAGE_KEY, "1");
    await readChain(eth);
    return accounts[0];
  }, [readChain]);

  const disconnect = useCallback(() => {
    setAddress(null);
    localStorage.removeItem(STORAGE_KEY);
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

  /** Sign and broadcast a raw transaction with the connected wallet. */
  const sendTransaction = useCallback(async (tx: { to: string; data: string }): Promise<string> => {
    const eth = window.ethereum;
    if (!eth || !address) throw new Error("Wallet not connected.");
    return (await eth.request({
      method: "eth_sendTransaction",
      params: [{ from: address, to: tx.to, data: tx.data }],
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
