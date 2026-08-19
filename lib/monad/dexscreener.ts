/**
 * DexScreener — the one external market-data provider this app integrates,
 * for exactly the metrics on-chain reads genuinely can't give us honestly:
 * 24h volume, 24h buy/sell transaction counts, and 24h price change. This
 * is the integration point Step 5's investigation (see tokenIntelligence.ts's
 * own doc) explicitly left open for "if egress to a real provider is ever
 * opened up" — verified against DexScreener's own public API before writing
 * this, not guessed:
 *   - Monad is a listed chain (dexscreener.com/monad is a real, live page).
 *   - Endpoint (no API key required): `GET /tokens/v1/{chainId}/{tokenAddress}`
 *     — confirmed against a working open-source TypeScript client's actual
 *     request code, not just documentation prose.
 *   - Response: a plain JSON array of pair objects (not wrapped in an
 *     envelope) with `liquidity.usd`, `volume` (keyed by window: m5/h1/h6/h24),
 *     `txns` (keyed by window, each `{ buys, sells }`), `priceChange`, `fdv`,
 *     `marketCap`, `pairCreatedAt` — confirmed against that same client's
 *     real, working TypeScript model types.
 *   - Rate limit: 300 req/min for this endpoint family — far more than this
 *     app's one-lookup-per-question usage pattern needs.
 *
 * What was NOT verified, and can't be from this build environment (the
 * domain is blocked by this sandbox's own egress policy — the same
 * situation the live RPC endpoint turned out to be reachable from
 * production despite being blocked here): the exact "monad" chainId slug
 * against a real response, and whether api.dexscreener.com is reachable
 * from production at all. Neither matters for safety — every failure mode
 * (unreachable, wrong slug, malformed response, no pairs indexed yet) fails
 * open to null below, exactly like every other best-effort probe in this
 * app. If the slug turns out to be wrong, this silently contributes nothing
 * rather than fabricating data or breaking a token lookup.
 *
 * Deliberately does NOT touch price, market cap, or liquidity — those stay
 * sourced from this app's own on-chain reads (prices.ts, nadfun.ts), which
 * are real-time and already verified. Two different sources reporting two
 * different "liquidity" numbers for the same pool would be confusing, not
 * additive, so DexScreener is scoped to fields this app has no other source
 * for at all.
 *
 * Server-only.
 */
import "server-only";
import type { Address } from "viem";
import { getNetwork } from "./config";

const DEXSCREENER_CHAIN_ID = "monad";
const REQUEST_TIMEOUT_MS = 4000;

interface DexScreenerTxnWindow {
  buys?: number;
  sells?: number;
}

interface DexScreenerPair {
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  priceChange?: { h24?: number };
  txns?: { h24?: DexScreenerTxnWindow };
}

export interface DexScreenerSnapshot {
  volume24h: number;
  transactions24h: number | null;
  buys24h: number | null;
  sells24h: number | null;
  /** Signed fraction, e.g. 0.0512 for +5.12% — matches the convention this
   *  app already uses for priceImpact (see swap.ts), not a pre-formatted
   *  string, so the caller controls presentation. */
  priceChange24h: number | null;
  /**
   * Pool liquidity in USD for the pair this snapshot came from — the most
   * liquid pool for the token, already selected below.
   *
   * This module originally, deliberately, reported nothing for liquidity: the
   * app had its own on-chain read and two sources disagreeing on one number is
   * worse than one source. That reasoning holds only while the on-chain read
   * actually works, and for a GRADUATED Nad.Fun token it does not — verified
   * live against BOB, where `dexFactory.getPair(WMON, token)` reverts outright,
   * so the on-chain path yields nothing to disagree with. Exposed here as a
   * clearly-labelled FALLBACK for exactly that case (see tokenIntelligence's
   * probeMarket): the on-chain figure still wins whenever it is available.
   */
  liquidityUsd: number | null;
}

/**
 * The best-effort 24h snapshot for one token, or null for absolutely any
 * reason (unreachable, no pairs indexed for this token yet, malformed
 * response, wrong network) — every failure mode is indistinguishable from
 * here and all handled the same honest way: report nothing rather than
 * guess.
 */
export async function getDexScreenerSnapshot(address: Address): Promise<DexScreenerSnapshot | null> {
  if (getNetwork() !== "mainnet") return null;
  try {
    const r = await fetch(`https://api.dexscreener.com/tokens/v1/${DEXSCREENER_CHAIN_ID}/${address}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!r.ok) return null;
    const pairs = (await r.json()) as unknown;
    if (!Array.isArray(pairs) || pairs.length === 0) return null;

    // Multiple pools can exist for the same token (different DEX, different
    // quote asset) — the most liquid one is the one whose 24h activity
    // actually reflects where this token trades, matching DexScreener's own
    // default sort.
    let best: DexScreenerPair | null = null;
    let bestLiquidity = -1;
    for (const raw of pairs) {
      const pair = raw as DexScreenerPair;
      const liquidity = pair.liquidity?.usd ?? 0;
      if (liquidity > bestLiquidity) { best = pair; bestLiquidity = liquidity; }
    }
    if (!best || typeof best.volume?.h24 !== "number") return null;

    const buys = best.txns?.h24?.buys;
    const sells = best.txns?.h24?.sells;
    const hasCounts = typeof buys === "number" && typeof sells === "number";
    return {
      volume24h: best.volume.h24,
      transactions24h: hasCounts ? buys + sells : null,
      buys24h: typeof buys === "number" ? buys : null,
      sells24h: typeof sells === "number" ? sells : null,
      priceChange24h: typeof best.priceChange?.h24 === "number" ? best.priceChange.h24 / 100 : null,
      // bestLiquidity is this pair's own liquidity.usd (the value it was
      // selected by). Guarded rather than passed through: the selector seeds
      // with -1 and treats a missing figure as 0, neither of which is a real
      // liquidity reading.
      liquidityUsd: bestLiquidity > 0 ? bestLiquidity : null,
    };
  } catch {
    return null;
  }
}
