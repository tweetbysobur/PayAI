"use client";

import { useEffect, useState } from "react";

/**
 * Approximate USD prices for a set of tokens.
 *
 * The anti-lag design matters more than the fetching: this hook returns a UNIT
 * PRICE per token, and callers multiply locally. So typing "100" into an amount
 * field recomputes the dollar value synchronously with zero network work — no
 * request per keystroke, no debounce, no spinner mid-typing.
 *
 * A module-level cache is shared across every component instance and survives
 * navigation, so the token selector, the amount field, and the balance tiles
 * all reuse one fetch instead of each triggering their own.
 */

const TTL_MS = 60_000;
const cache = new Map<string, { usd: number | null; at: number }>();
/** In-flight requests, so N components mounting at once make ONE call. */
const inflight = new Map<string, Promise<void>>();

export interface PriceTarget { address: string; decimals: number }

const key = (address: string) => address.toLowerCase();

function fresh(address: string): { usd: number | null } | undefined {
  const hit = cache.get(key(address));
  return hit && Date.now() - hit.at < TTL_MS ? hit : undefined;
}

/** /api/prices answers at most this many tokens per request. */
const BATCH = 25;

async function load(targets: PriceTarget[]): Promise<void> {
  const missing = targets.filter((t) => !fresh(t.address));
  if (missing.length === 0) return;
  // Batched to the server's own cap. One request for everything used to get
  // only the first 25 priced — the rest were cached as "no price" and a wallet
  // holding many tokens showed most of them without a value.
  if (missing.length > BATCH) {
    const batches: PriceTarget[][] = [];
    for (let i = 0; i < missing.length; i += BATCH) batches.push(missing.slice(i, i + BATCH));
    await Promise.all(batches.map(loadBatch));
    return;
  }
  return loadBatch(missing);
}

async function loadBatch(missing: PriceTarget[]): Promise<void> {

  const qs = missing.map((t) => `${t.address}:${t.decimals}`).join(",");
  if (inflight.has(qs)) return inflight.get(qs);

  const p = (async () => {
    try {
      const r = await fetch(`/api/prices?tokens=${encodeURIComponent(qs)}`);
      const j = await r.json();
      const prices: Record<string, number | null> = j.prices ?? {};
      const at = Date.now();
      // Record every requested token, including ones that came back absent —
      // caching the null is what stops a pool-less token being re-requested
      // on every render.
      for (const t of missing) {
        const k = key(t.address);
        cache.set(k, { usd: k in prices ? prices[k] : null, at });
      }
    } catch {
      const at = Date.now();
      for (const t of missing) cache.set(key(t.address), { usd: null, at });
    } finally {
      inflight.delete(qs);
    }
  })();

  inflight.set(qs, p);
  return p;
}

/**
 * Unit USD prices keyed by lowercased address. `null` means genuinely not
 * priceable (no pool) — render it as nothing, never as $0.
 */
export function useTokenPrices(targets: PriceTarget[]): {
  prices: Record<string, number | null>;
  loading: boolean;
  usdValue: (address: string, amount: number) => number | null;
} {
  // Stable dependency: the hook is usually called with a fresh array literal,
  // so depending on the array identity would refetch on every render.
  const sig = targets.map((t) => `${key(t.address)}:${t.decimals}`).sort().join(",");
  const [, bump] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const list = sig
      ? sig.split(",").map((s) => {
          const [address, decimals] = s.split(":");
          return { address, decimals: Number(decimals) };
        })
      : [];
    if (list.length === 0) return;
    if (list.every((t) => fresh(t.address))) return;

    let cancelled = false;
    setLoading(true);
    load(list).finally(() => {
      if (!cancelled) { setLoading(false); bump((n) => n + 1); }
    });
    return () => { cancelled = true; };
  }, [sig]);

  const prices: Record<string, number | null> = {};
  for (const t of targets) prices[key(t.address)] = cache.get(key(t.address))?.usd ?? null;

  return {
    prices,
    loading,
    // Local multiply — instant while typing.
    usdValue: (address, amount) => {
      const p = cache.get(key(address))?.usd ?? null;
      if (p == null || !Number.isFinite(amount)) return null;
      return p * amount;
    },
  };
}

/** Consistent formatting for an approximate dollar value. Sub-cent amounts
 *  show more precision instead of collapsing to "$0.00", which would read as
 *  worthless rather than small. */
export function formatUsd(value: number | null): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1000) return `$${value.toFixed(2)}`;
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}
