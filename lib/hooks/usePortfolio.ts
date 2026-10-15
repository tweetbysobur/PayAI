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
 * Forces a fresh portfolio-discovery scan for one wallet, bypassing
 * /api/portfolio/discover's own 5-minute cache — call this right after a
 * trade completes, so a token that may have just arrived doesn't stay
 * invisible for the rest of that window. This alone does not update any
 * mounted usePortfolio's own state (it has no reference to this specific
 * hook instance); pair it with the shared dashboard sync() (see
 * lib/hooks/useSync.tsx) immediately after, whose resulting refresh() call
 * will now hit this wallet's just-updated cache entry instead of the stale
 * one. Fire-and-forget: a failure here just means the NEXT automatic sync
 * (still cache-respecting) eventually catches up, same as before this
 * existed — never a user-facing error.
 */
export async function warmPortfolioDiscovery(address: string): Promise<void> {
  try {
    await fetch(`/api/portfolio/discover?address=${address}&fresh=1`);
  } catch {
    /* best-effort — the routine cache-respecting sync heartbeat still runs */
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
/**
 * Whether a token reads like a phishing airdrop rather than a coin: a name or
 * symbol carrying a link, a domain, or "claim / visit / reward" bait. Such a
 * token is never listed, whatever it claims to be worth.
 */
export function looksLikeSpam(meta: { symbol: string; name: string }): boolean {
  const text = `${meta.symbol} ${meta.name}`;
  return /https?:|www\.|t\.me\/|\.(?:com|io|xyz|net|org|app|fi|gg|site|online|top|live|link)\b|\b(?:claim|visit|reward|airdrop|voucher|redeem|gift)\b/i.test(text)
    || meta.symbol.length > 16;
}

/**
 * Which discovered tokens the portfolio lists. MON and USDC always. Any other
 * token only while it is actually held — so a coin sold to zero leaves the
 * list. A verified token with an unreadable balance stays (unknown is not
 * zero). An unverified one — a memecoin — is listed when it's held AND either
 * has a real market price or was bought through PayAI, and never when it
 * reads like a phishing airdrop. Pure, for testing.
 */
export function isListed(h: Holding, opts: { base: boolean; bought: boolean }): boolean {
  if (opts.base || h.native) return true;
  if (h.verified) return h.balance == null || h.balance > 0;
  if (!(h.balance != null && h.balance > 0)) return false;
  if (looksLikeSpam(h)) return false;
  return h.valueUsd != null || opts.bought;
}

export function usePortfolio(address: string | null, locked?: boolean) {
  const [rows, setRows] = useState<Holding[]>([]);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [discovered, setDiscovered] = useState<{ address: string; decimals: number; bought?: boolean }[]>([]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  useSyncRefresher(refresh);

  // Tokens this wallet may hold: bought through PayAI, recorded as they
  // arrived, or seen in the last few minutes (see /api/portfolio/discover).
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
      if (!seen.has(t.address.toLowerCase())) seen.set(t.address.toLowerCase(), { address: t.address, decimals: t.decimals });
    }
    return [...seen.values()];
  }, [discovered]);
  const baseSet = useMemo(() => new Set(baseTokens().map((t) => t.address.toLowerCase())), []);
  const boughtSet = useMemo(() => new Set(discovered.filter((t) => t.bought).map((t) => t.address.toLowerCase())), [discovered]);

  const { prices, usdValue } = useTokenPrices(tracked.map((t) => ({ address: t.address, decimals: t.decimals })));

  // Balances — read live from the chain for every tracked token.
  useEffect(() => {
    if (!address) { setRows([]); return; }
    let cancelled = false;
    setLoading(true);
    (async () => {
      const { formatUnits } = await import("viem");
      const { getBrowserPublicClient } = await import("@/lib/monad/browserClient");
      const client = await getBrowserPublicClient();

      const read = await Promise.all(
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
          // Nothing held of a non-base token: no metadata read needed.
          if (raw === 0n && !native && !baseSet.has(t.address.toLowerCase())) {
            return { address: t.address, symbol: "?", name: "", decimals: t.decimals, logoURI: null, verified: false, balance: 0, valueUsd: null, native };
          }

          const meta = await resolveTokenMeta(t.address, {
            symbol: native ? "MON" : "?",
            name: native ? "Monad" : "Unknown token",
            decimals: t.decimals,
            logoURI: null,
            verified: native,
          });

          return {
            address: t.address,
            symbol: meta.symbol,
            name: meta.name,
            decimals: meta.decimals ?? t.decimals,
            logoURI: meta.logoURI ?? null,
            verified: !!meta.verified,
            balance: raw == null ? null : Number(formatUnits(raw, meta.decimals ?? t.decimals)),
            valueUsd: null,
            native,
          };
        }),
      );

      if (cancelled) return;
      setRows(read.filter((r): r is Holding => r !== null));
      setLoading(false);
    })().catch(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [address, tracked, nonce, baseSet]);

  // Values — recomputed whenever prices arrive, so a price that lands after
  // the balances (the usual order) shows at once instead of on the next sync.
  // The total is the sum of exactly the rows listed, so the two always agree.
  const priceSig = JSON.stringify(prices);
  const holdings = useMemo(
    () => rows
      .map((r) => ({ ...r, valueUsd: r.balance == null ? null : usdValue(r.address, r.balance) ?? null }))
      .filter((h) => isListed(h, { base: baseSet.has(h.address.toLowerCase()), bought: boughtSet.has(h.address.toLowerCase()) })),
    // usdValue reads the same cache prices does; priceSig is its change signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, priceSig, baseSet, boughtSet],
  );

  const totalUsd = useMemo(
    () => holdings.reduce((sum, h) => sum + (h.valueUsd ?? 0), 0),
    [holdings],
  );

  return { holdings, loading, refresh, totalUsd };
}

/** A held amount as people read it: "12.45M", "1,234.56", "0.000123".
 *  Memecoin balances run to millions or billions; written out in full they
 *  crowd a phone screen and stop being readable. */
export function formatBalance(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n === 0) return "0";
  if (n >= 1e6) return n.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 });
  if (n >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: n >= 1000 ? 2 : 4 });
  if (n < 0.000001) return n.toExponential(2);
  return n.toLocaleString("en-US", { maximumSignificantDigits: 4 });
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
