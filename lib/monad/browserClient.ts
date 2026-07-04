"use client";

/**
 * Shared, memoized viem public client for browser-side reads (balance checks,
 * receipt polling). Previously every call site (useWalletBalances, useWallet,
 * PayWithWallet) rebuilt an identical client object on every call — same chain
 * config, same RPC fallback list. One instance, created lazily on first use.
 */
import type { PublicClient } from "viem";
import { MONAD_CHAIN_ID, MONAD_CHAIN_NAME, MONAD_RPC_URLS } from "@/lib/monad/public";

let cached: PublicClient | null = null;

export async function getBrowserPublicClient(): Promise<PublicClient> {
  if (cached) return cached;
  const { createPublicClient, fallback, http } = await import("viem");
  cached = createPublicClient({
    chain: {
      id: MONAD_CHAIN_ID,
      name: MONAD_CHAIN_NAME,
      nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
      rpcUrls: { default: { http: MONAD_RPC_URLS } },
    },
    transport: MONAD_RPC_URLS.length > 1
      ? fallback(MONAD_RPC_URLS.map((u) => http(u, { retryCount: 3, retryDelay: 500, timeout: 12_000 })), { rank: false })
      : http(MONAD_RPC_URLS[0], { retryCount: 4, retryDelay: 500, timeout: 12_000 }),
  }) as PublicClient;
  return cached;
}
