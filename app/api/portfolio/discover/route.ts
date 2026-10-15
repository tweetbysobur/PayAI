/**
 * GET /api/portfolio/discover?address=0x… — the tokens this wallet may hold,
 * for the portfolio to read balances for.
 *
 * Monad's public RPC answers `eth_getLogs` for at most 100 blocks (about 40
 * seconds of history) and refuses anything wider with "413 Request Entity Too
 * Large" — filtered to one recipient or not. So a wallet's holdings cannot be
 * found by scanning its transfer history on demand: the old multi-day scan
 * here sent hundreds of requests the RPC refused, took ~20 seconds, and came
 * back empty, so a memecoin bought anywhere but through PayAI never appeared.
 *
 * Instead the list is assembled from what PayAI already knows, plus a cheap
 * look at the last few minutes:
 *
 *   1. tokens this wallet bought through PayAI (its settled trade history);
 *   2. tokens recorded as they reached the wallet — by the deposit reconciler
 *      (any token transferred in while it watches), trade builds and token
 *      lookups (see lib/portfolio/knownTokens);
 *   3. incoming transfers in the most recent RECENT_BLOCKS, read in pieces the
 *      RPC accepts — what catches a token that arrived moments ago;
 *   4. PayAI's verified token list.
 *
 * Only addresses come from here. Every balance is read live from the chain by
 * the portfolio, and an unverified token is shown only when it is actually
 * held and has a real market price — so nothing in this list can make a token
 * appear that isn't really there.
 */
import { NextRequest, NextResponse } from "next/server";
import { withTimeout } from "@/lib/monad/rpcTimeout";

export const maxDuration = 30;

/** The widest range Monad's public RPC serves for eth_getLogs. */
const LOG_RANGE = 100n;
/** The recent stretch read on every refresh — about 2.5 minutes of blocks. */
const RECENT_BLOCKS = 400n;
/** Bounds one getLogs piece or one token's metadata read. */
const TIMEOUT_MS = 4_000;
const TIMED_OUT = Symbol("timed_out");
/** Short: the reads are cheap now, and a just-arrived token should not wait. */
const CACHE_MS = 60_000;
/** Most tokens resolved for one wallet per request. */
const MAX_TOKENS = 80;

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface DiscoveredToken { address: string; decimals: number; bought?: true }
interface Cached { at: number; tokens: DiscoveredToken[] }
const g = globalThis as unknown as { __payaiDiscover?: Map<string, Cached> };
const cache = (g.__payaiDiscover ??= new Map());

/**
 * Incoming Transfer logs over the last RECENT_BLOCKS, in pieces of at most
 * LOG_RANGE blocks read in parallel. A piece the RPC refuses or never answers
 * contributes nothing rather than failing the rest.
 *
 * `request` takes a block range and returns raw logs, so the piecing and
 * timeouts are testable without a live RPC.
 */
export async function fetchRecentIncomingLogs<T>(
  latest: bigint,
  request: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>,
  timeoutMs: number = TIMEOUT_MS,
): Promise<T[]> {
  const floor = latest >= RECENT_BLOCKS ? latest - RECENT_BLOCKS + 1n : 0n;
  const pieces: [bigint, bigint][] = [];
  for (let from = floor; from <= latest; from += LOG_RANGE) {
    const to = from + LOG_RANGE - 1n < latest ? from + LOG_RANGE - 1n : latest;
    pieces.push([from, to]);
  }
  const results = await Promise.all(
    pieces.map(async ([from, to]) => {
      try {
        const r = await withTimeout<T[] | typeof TIMED_OUT>(request(from, to), timeoutMs, TIMED_OUT);
        return r === TIMED_OUT ? [] : r;
      } catch {
        return [];
      }
    }),
  );
  return results.flat();
}

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get("address") ?? "";
  if (!ADDR_RE.test(address)) {
    return NextResponse.json({ error: "A valid wallet address is required." }, { status: 400 });
  }
  const key = address.toLowerCase();

  // Unauthenticated (balances and incoming transfers are public chain data),
  // so bounded per caller.
  const { rateLimited } = await import("@/lib/platform/ratelimit");
  const limited = await rateLimited(req, "discover", { max: 12, windowSec: 60 });
  if (limited) return limited;

  // ?fresh=1 skips the cache — used right after a trade completes (see
  // usePortfolio's warmPortfolioDiscovery), bounded per wallet so it can't be
  // replayed to force a scan on every call.
  const fresh = req.nextUrl.searchParams.get("fresh") === "1";
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) {
    return NextResponse.json({ tokens: hit.tokens, cached: true });
  }
  if (fresh) {
    const freshLimited = await rateLimited(req, "discover-fresh", { max: 4, windowSec: 60, subject: key });
    if (freshLimited) {
      if (hit) return NextResponse.json({ tokens: hit.tokens, cached: true, throttled: true });
      return freshLimited;
    }
  }

  // Each source fails on its own: one being unavailable never hides the others.
  const [bought, known, recent, curated] = await Promise.all([
    boughtThroughPayAI(req, address),
    import("@/lib/portfolio/knownTokens").then((m) => m.getKnownTokens(address)).catch(() => [] as string[]),
    recentArrivals(key),
    import("@/lib/monad/tokenRegistry").then((m) => m.trackedTokenAddresses().map((a) => a.toLowerCase())).catch(() => [] as string[]),
  ]);

  // A token just seen arriving is remembered, so it stays listed after it
  // falls out of the recent window.
  if (recent.length > 0) {
    await import("@/lib/portfolio/knownTokens").then((m) => m.addKnownTokens(address, recent)).catch(() => {});
  }

  const boughtSet = new Set(bought);
  const contracts = [...new Set([...bought, ...recent, ...known, ...curated])].slice(0, MAX_TOKENS);

  // Real decimals for every token — a balance read with the wrong decimals is
  // a wrong number. One contract that never answers is skipped, not waited on.
  const { resolveToken } = await import("@/lib/monad/tokenRegistry");
  const tokens = (
    await Promise.all(
      contracts.map(async (c): Promise<DiscoveredToken | null> => {
        try {
          const t = await withTimeout<{ address: string; decimals: number } | typeof TIMED_OUT>(
            resolveToken(c).then((r) => ({ address: r.address, decimals: r.decimals })),
            TIMEOUT_MS,
            TIMED_OUT,
          );
          if (t === TIMED_OUT) return null;
          return boughtSet.has(c) ? { ...t, bought: true } : t;
        } catch {
          return null; // not a readable ERC-20
        }
      }),
    )
  ).filter((t): t is DiscoveredToken => t !== null);

  cache.set(key, { at: Date.now(), tokens });
  return NextResponse.json({ tokens });
}

/** Tokens this wallet acquired through PayAI, from its settled trade history.
 *  Private app records, so read only with the wallet's grant (or outside the
 *  demo tenant). */
async function boughtThroughPayAI(req: NextRequest, address: string): Promise<string[]> {
  try {
    const { resolveTenantId } = await import("@/lib/platform/tenant");
    const { listTx } = await import("@/lib/platform/store");
    const { requestHasWalletGrant } = await import("@/lib/auth/walletGrant");
    const { DEMO_TENANT } = await import("@/lib/platform/merchants");
    const merchantId = await resolveTenantId(req);
    if (merchantId === DEMO_TENANT && !requestHasWalletGrant(req, address)) return [];
    const rows = await listTx(merchantId, { sender: address });
    return rows
      .map((row) => row.outputTokenAddress)
      .filter((a): a is string => typeof a === "string" && ADDR_RE.test(a))
      .map((a) => a.toLowerCase());
  } catch {
    return [];
  }
}

/** Token contracts that transferred into this wallet in the last few minutes. */
async function recentArrivals(wallet: string): Promise<string[]> {
  try {
    const { getPublicClient } = await import("@/lib/monad/wallet");
    const client = getPublicClient();
    const latest = await client.getBlockNumber();
    const logs = await fetchRecentIncomingLogs<{ address: string }>(latest, (fromBlock, toBlock) =>
      client.request({
        method: "eth_getLogs",
        params: [{
          fromBlock: `0x${fromBlock.toString(16)}`,
          toBlock: `0x${toBlock.toString(16)}`,
          topics: [TRANSFER_TOPIC, null, `0x${"0".repeat(24)}${wallet.slice(2)}`],
        }],
      } as never) as Promise<{ address: string }[]>,
    );
    return [...new Set(logs.map((l) => l.address.toLowerCase()))];
  } catch {
    return [];
  }
}
