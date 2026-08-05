"use client";

import { useCallback, useEffect, useState } from "react";
import { MONAD_USDC, MONAD_USDC_DECIMALS } from "@/lib/monad/public";
import { useSyncRefresher } from "@/lib/hooks/useSync";

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

  // Part of the dashboard's one refresh, so a balance is never the stale thing
  // on an otherwise fresh screen — and so a completed swap updates it without
  // the swap flow needing to know balances exist.
  useSyncRefresher(refresh);

  useEffect(() => {
    if (!address) { setMon(null); setUsdc(null); return; }
    let cancelled = false;
    setLoading(true);
    (async () => {
      const { formatEther } = await import("viem");
      const { getBrowserPublicClient } = await import("@/lib/monad/browserClient");
      const client = await getBrowserPublicClient();
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
