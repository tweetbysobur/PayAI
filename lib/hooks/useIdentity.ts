"use client";

import { useEffect, useState } from "react";

/**
 * The connected wallet's display identity, resolved with a strict priority:
 *   1. Connected .nad/.nads domain (reverse-resolved on-chain — real, never fabricated)
 *   2. User-defined display name — not implemented yet, so this step is skipped
 *      rather than faked; add it here the day that feature exists.
 *   3. Shortened wallet address (e.g. "0x84F2…91AC")
 *
 * Centralized so every surface (Topbar, Connect, Wallets, Overview, …) shows
 * the same identity for the same wallet instead of each re-implementing its
 * own fallback order.
 */
export function shortAddress(address?: string | null): string {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "—";
}

export interface Identity {
  /** The .nad domain, when the connected wallet has one set as primary. */
  domain: string | null;
  /** domain ?? shortened address — what most UI should render. */
  display: string;
  /** True while the reverse-domain lookup is in flight. */
  loading: boolean;
}

export function useIdentity(address?: string | null): Identity {
  const [domain, setDomain] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!address) { setDomain(null); return; }
    let cancelled = false;
    setLoading(true);
    fetch(`/api/nns/primary-name?address=${address}`)
      .then((r) => r.json())
      .then((j) => { if (!cancelled) setDomain(j.name ?? null); })
      .catch(() => { if (!cancelled) setDomain(null); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [address]);

  return { domain, display: domain ?? shortAddress(address), loading };
}
