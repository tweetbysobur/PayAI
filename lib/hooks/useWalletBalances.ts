"use client";

import { useCallback, useEffect, useState } from "react";
import { MONAD_CHAIN_ID, MONAD_CHAIN_NAME, MONAD_RPC_URLS, MONAD_USDC, MONAD_USDC_DECIMALS } from "@/lib/monad/public";

export interface WalletBalances {
  mon: string | null;
  usdc: string | null;
  loading: boolean;
  refresh: () => void;
}

const ERC20_BALANCE_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

/**
 * Reads the CONNECTED browser wallet's real on-chain MON + USDC balances —
 * read-only, no signer needed, runs entirely client-side against the public
 * RPC. Distinct from the platform's own agent wallet (shown separately via
 * /api/health) — this is the user's own funds, not the app's hot wallet.
 */
export function useWalletBalances(address: string | null): WalletBalances {
  const [mon, setMon] = useState<string | null>(null);
  const [usdc, setUsdc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!address) { setMon(null); setUsdc(null); return; }
    let cancelled = false;
    setLoading(true);
    (async () => {
      const { createPublicClient, http, formatEther, fallback } = await import("viem");
      const client = createPublicClient({
        chain: { id: MONAD_CHAIN_ID, name: MONAD_CHAIN_NAME, nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: MONAD_RPC_URLS } } },
        transport: MONAD_RPC_URLS.length > 1 ? fallback(MONAD_RPC_URLS.map((u) => http(u))) : http(MONAD_RPC_URLS[0]),
      });
      try {
        const [bal, usdcBal] = await Promise.all([
          client.getBalance({ address: address as `0x${string}` }),
          MONAD_USDC
            ? client.readContract({ address: MONAD_USDC, abi: ERC20_BALANCE_ABI, functionName: "balanceOf", args: [address as `0x${string}`] }).catch(() => 0n)
            : Promise.resolve(null),
        ]);
        if (cancelled) return;
        setMon(formatEther(bal));
        setUsdc(usdcBal != null ? (Number(usdcBal) / 10 ** MONAD_USDC_DECIMALS).toString() : null);
      } catch {
        if (!cancelled) { setMon(null); setUsdc(null); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [address, nonce]);

  return { mon, usdc, loading, refresh };
}
