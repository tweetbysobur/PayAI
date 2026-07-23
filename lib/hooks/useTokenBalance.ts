"use client";

import { useEffect, useState } from "react";

const ERC20_BALANCE_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

const NATIVE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Reads the connected wallet's on-chain balance for ANY token (native MON or
 * an arbitrary ERC-20 address) — client-side, read-only, no signer needed.
 * This is what lets the token selector show a live balance for a token the
 * user just pasted in, not only the two previously hardcoded assets.
 */
export function useTokenBalance(tokenAddress: string | null, decimals: number | null, walletAddress: string | null): { balance: string | null; loading: boolean } {
  const [balance, setBalance] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!walletAddress || !tokenAddress || decimals == null) { setBalance(null); return; }
    let cancelled = false;
    setLoading(true);
    (async () => {
      const { getBrowserPublicClient } = await import("@/lib/monad/browserClient");
      const client = await getBrowserPublicClient();
      try {
        const isNative = tokenAddress.toLowerCase() === NATIVE_TOKEN_ADDRESS;
        const raw = isNative
          ? await client.getBalance({ address: walletAddress as `0x${string}` })
          : await client.readContract({
              address: tokenAddress as `0x${string}`, abi: ERC20_BALANCE_ABI,
              functionName: "balanceOf", args: [walletAddress as `0x${string}`],
            });
        if (cancelled) return;
        setBalance((Number(raw) / 10 ** decimals).toString());
      } catch {
        if (!cancelled) setBalance(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [tokenAddress, decimals, walletAddress]);

  return { balance, loading };
}
