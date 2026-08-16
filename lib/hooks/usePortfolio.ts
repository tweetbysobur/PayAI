"use client";

/**
 * Everything this wallet actually holds.
 *
 * The dashboard only ever knew about two assets, MON and USDC, because those
 * are the two it was written around. So a user who swapped into anything else
 * — the exact thing the swap feature exists to let them do — ended up holding
 * a token the product could not see, with no balance, no value and no way to
 * tell it had worked.
 *
 * Holdings are discovered, not configured. The verified token list is a
 * starting set, not a gate: any token this wallet has ever received shows up
 * too, resolved from the chain. That is what makes "swap into a new token and
 * it appears" true without anyone maintaining an allowlist.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { MONAD_USDC, MONAD_USDC_DECIMALS, NATIVE_TOKEN_ADDRESS } from "@/lib/monad/public";
import { useTokenPrices } from "@/lib/hooks/useTokenPrices";
import { useSyncRefresher } from "@/lib/hooks/useSync";

export interface Holding {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoURI: string | null;
  verified: boolean;
  /**
   * Human-readable balance, or null when it could not be read.
   *
   * Unknown is not zero. A flaky RPC used to make an asset disappear from the
   * portfolio outright, which reads as "you no longer hold this" — the single
   * most alarming thing a wallet can wrongly say. Showing the row with an
   * unknown balance is honest; both dropping it and printing 0 are not.
   */
  balance: number | null;
  /** USD value, or null when this token has no price we trust. Never guessed. */
  valueUsd: number | null;
  /** True for the chain's own asset, which has no contract to link to. */
  native: boolean;
}

/**
 * How long to wait for a token's metadata before showing the row without it.
 *
 * Metadata comes from a chain read, and one unresponsive token contract used
 * to hold up the ENTIRE portfolio: the list waited on every row, so a single
 * slow lookup left the user staring at "Reading your balances…" with nothing
 * on screen. A row is far more useful late-and-partial than never.
 */
const META_TIMEOUT_MS = 4_000;

const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "o", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

/** Tokens every wallet on this network should see, held or not, so an empty
 *  portfolio still shows what it is empty of. */
function baseTokens(): { address: string; decimals: number }[] {
  const out: { address: string; decimals: number }[] = [{ address: NATIVE_TOKEN_ADDRESS, decimals: 18 }];
  if (MONAD_USDC) out.push({ address: MONAD_USDC, decimals: MONAD_USDC_DECIMALS });
  return out;
}

export type SortKey = "value" | "balance" | "symbol";

export interface TokenMeta {
  symbol: string;
  name: string;
  decimals: number;
  logoURI: string | null;
  verified: boolean;
}

/**
 * A token's metadata, or what we already knew, whichever arrives first.
 *
 * Metadata comes from a chain read, and the portfolio waits on every row
 * before rendering any of them. So one unresponsive token contract used to
 * hold up the ENTIRE list — a user with a single bad token in their history
 * saw "Reading your balances…" and nothing else, indefinitely.
 *
 * Bounded, and never fatal: past the deadline, or on any error, the row
 * renders with the fallback descriptor. A real balance beside a placeholder
 * symbol is far more useful than a screen that never resolves.
 *
 * Extracted from the hook so the deadline is testable without a browser.
 */
export async function resolveTokenMeta(
  address: string,
  fallback: TokenMeta,
  opts: { timeoutMs?: number; fetcher?: (address: string) => Promise<unknown> } = {},
): Promise<TokenMeta> {
  const timeoutMs = opts.timeoutMs ?? META_TIMEOUT_MS;
  const fetcher =
    opts.fetcher ?? ((a: string) => fetch(`/api/tokens?address=${a}`).then((r) => r.json()));

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fetcher(address)
        .then((j) => (j as { token?: TokenMeta } | null)?.token ?? fallback)
        .catch(() => fallback),
      new Promise<TokenMeta>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    // The loser of the race must not keep a timer alive — a portfolio with
    // twenty tokens would otherwise hold twenty pending timeouts per refresh.
    if (timer) clearTimeout(timer);
  }
}

/**
 * `locked` is optional and only matters for callers passing an embedded
 * wallet's `readAddress`: that string stays identical through a lock/unlock
 * cycle (it's the remembered address, not the live one), so unlocking is
 * otherwise invisible to the effects below and holdings sit stale until the
 * next background sync. Passing `isLocked` makes the true→false transition
 * trigger an immediate re-read.
 */
export function usePortfolio(address: string | null, locked?: boolean) {
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [discovered, setDiscovered] = useState<{ address: string; decimals: number }[]>([]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  useSyncRefresher(refresh);

  // Which tokens this wallet has ever been sent. Discovering them from
  // transfer history is what makes an unknown asset appear on its own — a
  // swap output, an airdrop, a payment in something new.
  useEffect(() => {
    if (!address) { setDiscovered([]); return; }
    let cancelled = false;
    fetch(`/api/portfolio/discover?address=${address}`)
      .then((r) => r.json())
      .then((j) => { if (!cancelled) setDiscovered(Array.isArray(j?.tokens) ? j.tokens : []); })
      .catch(() => { /* discovery is additive — the base tokens still render */ });
    return () => { cancelled = true; };
  }, [address, nonce, locked]);

  const tracked = useMemo(() => {
    const seen = new Map<string, { address: string; decimals: number }>();
    for (const t of [...baseTokens(), ...discovered]) {
      seen.set(t.address.toLowerCase(), t);
    }
    return [...seen.values()];
  }, [discovered]);

  const { usdValue } = useTokenPrices(tracked.map((t) => ({ address: t.address, decimals: t.decimals })));

  useEffect(() => {
    if (!address) { setHoldings([]); return; }
    let cancelled = false;
    setLoading(true);
    (async () => {
      const { formatUnits } = await import("viem");
      const { getBrowserPublicClient } = await import("@/lib/monad/browserClient");
      const client = await getBrowserPublicClient();

      const rows = await Promise.all(
        tracked.map(async (t): Promise<Holding | null> => {
          const native = t.address.toLowerCase() === NATIVE_TOKEN_ADDRESS.toLowerCase();
          let raw: bigint | null = null;
          try {
            raw = native
              ? await client.getBalance({ address: address as `0x${string}` })
              : ((await client.readContract({
                  address: t.address as `0x${string}`,
                  abi: ERC20_ABI,
                  functionName: "balanceOf",
                  args: [address as `0x${string}`],
                })) as bigint);
          } catch {
            // Unreadable. The native asset still gets a row — it always exists
            // and hiding it would read as "your MON is gone" — with its balance
            // reported as unknown. A speculative ERC-20 we cannot read is
            // dropped instead, since we have no evidence it is held at all.
            if (!native) return null;
          }

          const meta = await resolveTokenMeta(t.address, {
            symbol: native ? "MON" : "?",
            name: native ? "Monad" : "Unknown token",
            decimals: t.decimals,
            logoURI: null,
            verified: native,
          });

          const balance = raw == null ? null : Number(formatUnits(raw, meta.decimals ?? t.decimals));
          return {
            address: t.address,
            symbol: meta.symbol,
            name: meta.name,
            decimals: meta.decimals ?? t.decimals,
            logoURI: meta.logoURI ?? null,
            verified: !!meta.verified,
            balance,
            valueUsd: balance == null ? null : usdValue(t.address, balance) ?? null,
            native,
          };
        }),
      );

      if (cancelled) return;
      setHoldings(rows.filter((r): r is Holding => r !== null));
      setLoading(false);
    })().catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // usdValue is intentionally excluded: prices refresh on their own cadence
    // and re-running every balance read on a price tick would hammer the RPC.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, tracked, nonce]);

  const totalUsd = useMemo(
    () => holdings.reduce((sum, h) => sum + (h.valueUsd ?? 0), 0),
    [holdings],
  );

  return { holdings, loading, refresh, totalUsd };
}

/** Filter and order a holdings list for display. Pure, so it is testable
 *  without a wallet, a chain, or a browser. */
export function viewHoldings(
  holdings: Holding[],
  opts: { hideZero?: boolean; query?: string; sort?: SortKey } = {},
): Holding[] {
  const query = opts.query?.trim().toLowerCase() ?? "";
  let rows = holdings;

  if (opts.hideZero) {
    // Hide only what is KNOWN to be empty. The native asset always stays —
    // "you have 0 MON" is the most actionable thing an empty wallet can say,
    // since nothing on this chain works without it — and an unknown balance
    // stays too, because hiding it would assert a zero nobody measured.
    rows = rows.filter((h) => h.balance == null || h.balance > 0 || h.native);
  }
  if (query) {
    rows = rows.filter(
      (h) =>
        h.symbol.toLowerCase().includes(query) ||
        h.name.toLowerCase().includes(query) ||
        h.address.toLowerCase().includes(query),
    );
  }

  const sort = opts.sort ?? "value";
  const byBalance = (x: Holding, y: Holding) => (y.balance ?? -1) - (x.balance ?? -1);
  return [...rows].sort((a, b) => {
    if (sort === "symbol") return a.symbol.localeCompare(b.symbol);
    if (sort === "balance") return byBalance(a, b);
    // By value, with priced tokens ahead of unpriced ones — an unknown value
    // is not the same as a zero one and must not outrank a real holding.
    const av = a.valueUsd;
    const bv = b.valueUsd;
    if (av == null && bv == null) return byBalance(a, b);
    if (av == null) return 1;
    if (bv == null) return -1;
    return bv - av;
  });
}
