/**
 * USD pricing for any Monad token, derived from the DEX PayAI already routes
 * through (Uniswap v3 on Monad mainnet) by quoting TOKEN -> USDC.
 *
 * Why the DEX and not an external price API: this is a payments product, so the
 * number a user cares about is what their tokens are actually worth *here*, on
 * the venue they'd transact on. A CoinGecko mid-price would disagree with what
 * a swap would really produce, and most Monad tokens aren't listed there at all.
 * The trade-off is stated honestly in the UI — values are shown as approximate
 * ("≈ $"), never as an authoritative mark.
 *
 * USDC is treated as the dollar numeraire (1 USDC = 1 USD). That is an
 * assumption, but a standard one, and it's the same unit the rest of the
 * product already denominates volume in.
 *
 * Caching: prices are cached in-process for PRICE_TTL_MS. Every caller shares
 * one entry per token, so a page rendering ten token rows costs one quote per
 * token per minute rather than one per render — the difference between a
 * responsive UI and a laggy one.
 *
 * Server-only.
 */
import "server-only";
import { parseUnits, type Address } from "viem";
import { getNetwork } from "./config";
import { getPublicClient } from "./wallet";
import { withTimeout } from "./rpcTimeout";

const PRICE_TTL_MS = 60_000;

/** Max tolerated divergence between a 1-unit and a 10-unit quote before the
 *  pool is judged too shallow to price honestly. 5% is loose enough for normal
 *  pool fees and tick spacing, tight enough to reject a pool whose price moves
 *  materially on a trade that small. */
const MAX_PRICE_IMPACT = 0.05;

/** Same deployment the swap engine uses, verified to have bytecode on mainnet. */
const QUOTER = (process.env.MONAD_MAINNET_UNISWAP_QUOTER || "0x661e93cca42afacb172121ef892830ca3b70f08d") as Address;
const WMON = (process.env.MONAD_MAINNET_WMON || "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A") as Address;
const USDC = (process.env.MONAD_MAINNET_USDC || "0x754704Bc059F8C67012fEd69BC8A327a5aafb603") as Address;
const USDC_DECIMALS = Number(process.env.MONAD_USDC_DECIMALS ?? 6);

const FEE_TIERS = [500, 3000, 10000] as const;

/** Bounds ONE token's price probe. A quoter read that stalls (the provider
 *  accepts the call and simply never answers, same failure class as the
 *  portfolio-discovery gap this mirrors) doesn't reject — Promise.allSettled
 *  inside quoteUnitPrice tolerates a REJECTED fee tier, but does nothing for
 *  one that never settles at all, and neither does any caller's Promise.all
 *  across tokens. Without a bound, ONE wallet holding stuck on a stalled
 *  quoter call meant every OTHER token in the same portfolio silently never
 *  got a USD value either — not just the flaky one.
 *
 *  This lives INSIDE getUsdPrice rather than only around getUsdPrices' batch,
 *  because the singular export has callers of its own on user-facing paths —
 *  tokenIntelligence's probeMarket awaits it twice in a Promise.all with no
 *  bound of its own, so a stall there hung the whole "what is this token?"
 *  lookup with nothing above it able to release the request. */
const PRICE_TIMEOUT_MS = 4_000;

/** Distinguishes "the quoter answered, and there is no pool deep enough to
 *  price this honestly" — a real, stable fact worth caching for the TTL —
 *  from "the quoter never answered in time", which is transient and must not
 *  be pinned. Both hand the caller the same null, so only the cache write
 *  needs to tell them apart.
 *
 *  This matters well beyond one price field: tokenIntelligence computes market
 *  cap and FDV as price x totalSupply, so caching a stalled read as null took
 *  the whole valuation block down with it, and kept it down for a full minute
 *  — pasting the same contract address again a second later was served the
 *  same empty answer from cache instead of re-reading the chain. */
const TIMED_OUT = Symbol("price-probe-timed-out");

const QUOTER_ABI = [
  {
    type: "function", name: "quoteExactInputSingle", stateMutability: "nonpayable",
    inputs: [{
      name: "params", type: "tuple", components: [
        { name: "tokenIn", type: "address" }, { name: "tokenOut", type: "address" },
        { name: "amountIn", type: "uint256" }, { name: "fee", type: "uint24" },
        { name: "sqrtPriceLimitX96", type: "uint160" },
      ],
    }],
    outputs: [
      { name: "amountOut", type: "uint256" }, { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" }, { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

interface CacheEntry { usd: number | null; at: number }
const cache = new Map<string, CacheEntry>();

const NATIVE = "0x0000000000000000000000000000000000000000";
function isNative(address: string): boolean {
  return !address || /^0x0+$/.test(address);
}

/**
 * USD price for ONE unit of `address`, or null when it can't be priced (no
 * pool, wrong network, RPC failure). Null is meaningful and must be surfaced
 * as "unavailable" rather than 0 — a zero would read as "worthless".
 */
export async function getUsdPrice(address: string, decimals: number): Promise<number | null> {
  if (getNetwork() !== "mainnet") return null; // Uniswap is mainnet-only here

  // Route native MON through WMON, the form the pools actually hold.
  const routeAddress = isNative(address) ? WMON : (address as Address);

  // USDC is the numeraire — pricing it against itself would always be 1 and
  // wastes an RPC round-trip.
  if (routeAddress.toLowerCase() === USDC.toLowerCase()) return 1;

  const key = routeAddress.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < PRICE_TTL_MS) return hit.usd;

  const pub = getPublicClient();

  const quoteUnitPrice = async (units: string): Promise<number | null> => {
    const amountIn = parseUnits(units, decimals);
    // The 3 fee tiers are independent probes -- query them concurrently
    // (matches swap.ts's quoteUniswapDirect/buildUniswapPlanDirect) rather
    // than one RPC round-trip at a time. A sequential loop here was the
    // dominant cost in a cold token lookup: 3 round-trips back-to-back per
    // probe, twice (this "1 unit" probe and the "10 unit" one below), before
    // Promise.all even gets a chance to overlap them with each other.
    const settled = await Promise.allSettled(
      FEE_TIERS.map(async (fee) => {
        const { result } = await pub.simulateContract({
          address: QUOTER, abi: QUOTER_ABI, functionName: "quoteExactInputSingle",
          args: [{ tokenIn: routeAddress, tokenOut: USDC, amountIn, fee, sqrtPriceLimitX96: 0n }],
        });
        return (result as readonly [bigint, bigint, number, bigint])[0];
      }),
    );
    let best: bigint | null = null;
    for (const r of settled) {
      if (r.status === "fulfilled" && r.value > 0n && (best === null || r.value > best)) best = r.value;
    }
    if (best === null) return null;
    // Normalise back to a per-1-unit price so the two probes are comparable.
    return Number(best) / 10 ** USDC_DECIMALS / Number(units);
  };

  // Two probes at different sizes. In a deep pool the implied unit price is
  // near-identical; in a shallow one the larger trade walks the curve and the
  // implied price collapses. That divergence IS the liquidity signal.
  //
  // This guard exists because a real pool on this chain quotes WBTC at ~$652
  // against a true price orders of magnitude higher. Rendering that as
  // "≈ $652" next to someone's balance would be actively misleading, and on a
  // payments product a confidently wrong dollar figure is worse than none. So
  // when the two probes disagree materially we return null and the UI shows
  // nothing rather than a number nobody should rely on.
  const probed = await withTimeout<[number | null, number | null] | typeof TIMED_OUT>(
    Promise.all([quoteUnitPrice("1"), quoteUnitPrice("10")]),
    PRICE_TIMEOUT_MS,
    TIMED_OUT,
  );
  // Deliberately not cached: the chain never told us anything, so there is
  // nothing here to remember. Returning null still reads as "unavailable" to
  // the caller, but the very next attempt re-reads instead of replaying this
  // non-answer for the rest of the TTL.
  if (probed === TIMED_OUT) return null;
  const [small, large] = probed;

  let usd: number | null = null;
  if (small !== null) {
    if (large === null) {
      // Can't quote 10 units at all — too shallow to trust.
      usd = null;
    } else {
      const drift = Math.abs(small - large) / small;
      usd = drift <= MAX_PRICE_IMPACT ? small : null;
    }
  }

  cache.set(key, { usd, at: Date.now() });
  return usd;
}

/** Price several tokens at once, sharing the cache. Quotes run in parallel. */
export async function getUsdPrices(
  tokens: { address: string; decimals: number }[],
): Promise<Record<string, number | null>> {
  const unique = new Map<string, { address: string; decimals: number }>();
  for (const t of tokens) {
    const k = (isNative(t.address) ? NATIVE : t.address).toLowerCase();
    if (!unique.has(k)) unique.set(k, t);
  }
  const entries = await Promise.all(
    [...unique.entries()].map(async ([k, t]) => {
      // The stall bound now lives inside getUsdPrice itself (see
      // PRICE_TIMEOUT_MS), so all that's left to do here is keep one token's
      // outright rejection from failing the whole batch.
      const usd = await getUsdPrice(t.address, t.decimals).catch(() => null);
      return [k, usd] as const;
    }),
  );
  return Object.fromEntries(entries);
}
