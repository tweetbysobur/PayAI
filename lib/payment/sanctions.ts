/**
 * Address sanctions screening.
 *
 * Two layers, both applied to the resolved 0x recipient before any payment is
 * approved:
 *   1. A static env denylist (PAYAI_ADDRESS_DENYLIST) — always applied, sync,
 *      available immediately at cold start.
 *   2. The OFAC SDN sanctioned digital-currency address list, fetched from a
 *      public source and cached in memory. This is the "real screening" upgrade
 *      over a name-substring match, and it's free — no third-party provider.
 *
 * Design goals: the check itself is synchronous (`isSanctionedAddress`) so the
 * validation engine stays pure and fast; the list is refreshed out-of-band and
 * cached. Fail-safe: if the remote list can't be fetched, the last-known-good
 * set (and the env denylist) still apply — a fetch outage never silently
 * disables screening, and never blocks every payment either.
 *
 * Server-only.
 */
import "server-only";

// Community-maintained mirror of the OFAC SDN crypto addresses (Ethereum),
// one address per line. Override with PAYAI_SANCTIONS_LIST_URL; set that to an
// empty string to disable the remote list (env denylist still applies).
const DEFAULT_OFAC_LIST_URL =
  "https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_ETH.txt";

const LIST_URL = process.env.PAYAI_SANCTIONS_LIST_URL ?? DEFAULT_OFAC_LIST_URL;
const REFRESH_MS = 6 * 60 * 60 * 1000; // re-fetch at most every 6h
const FETCH_TIMEOUT_MS = 4000;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

const g = globalThis as unknown as {
  __payaiSanctions?: { set: Set<string>; loadedAt: number; inflight: Promise<void> | null };
};

function envDenylist(): string[] {
  return (process.env.PAYAI_ADDRESS_DENYLIST || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => ADDR_RE.test(s));
}

// Seed synchronously from the env denylist so screening works at cold start,
// before the remote list has been fetched.
function state() {
  if (!g.__payaiSanctions) {
    g.__payaiSanctions = { set: new Set(envDenylist()), loadedAt: 0, inflight: null };
  }
  return g.__payaiSanctions;
}

/** Sync check against the currently-loaded set (env denylist + fetched list). */
export function isSanctionedAddress(address: string): boolean {
  const a = address.trim().toLowerCase();
  if (!ADDR_RE.test(a)) return false;
  return state().set.has(a);
}

/** True once the remote OFAC list has been merged in — used only for honest UI copy. */
export function sanctionsListLoaded(): boolean {
  return state().loadedAt > 0;
}

/**
 * Ensure the remote sanctions list is loaded and reasonably fresh. Safe to call
 * on every request: it no-ops when the list is fresh, dedups concurrent
 * fetches, and never throws.
 */
export async function ensureSanctionsLoaded(): Promise<void> {
  if (!LIST_URL) return; // remote list disabled — env denylist still applies
  const s = state();
  if (s.loadedAt && Date.now() - s.loadedAt < REFRESH_MS) return;
  if (s.inflight) return s.inflight;

  s.inflight = (async () => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(LIST_URL, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error(`sanctions list HTTP ${res.status}`);
      const text = await res.text();
      const next = new Set(envDenylist());
      for (const line of text.split(/\r?\n/)) {
        const a = line.trim().toLowerCase();
        if (ADDR_RE.test(a)) next.add(a);
      }
      // Only replace on a plausibly-successful parse; keep last-known-good otherwise.
      if (next.size > 0) {
        s.set = next;
        s.loadedAt = Date.now();
      }
    } catch (e) {
      // Fail-safe: keep the existing set (env denylist + any prior fetch). Log so
      // a persistently-unreachable list is visible, but never block payments.
      console.error(JSON.stringify({ level: "warn", kind: "sanctions_fetch_failed", message: e instanceof Error ? e.message : String(e) }));
    } finally {
      s.inflight = null;
    }
  })();
  return s.inflight;
}
