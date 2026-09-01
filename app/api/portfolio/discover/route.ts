/**
 * GET /api/portfolio/discover?address=0x… — every token this wallet has ever
 * been sent.
 *
 * This is what lets an asset appear in the portfolio on its own. A swap
 * output, an airdrop, a payment in something the product has never heard of:
 * all of them arrive as an ERC-20 `Transfer` into the wallet, so reading those
 * logs finds the token without anyone maintaining an allowlist.
 *
 * Deliberately not filtered to a set of known contracts — filtering would
 * defeat the point. It IS bounded: a capped block window and a short cache,
 * because this runs behind a portfolio that refreshes on every sync.
 *
 * This is also the widest, most expensive `getLogs` shape in the codebase —
 * every other caller (getNadFunCreatorInfo, fetchPaymentEvents) scopes its
 * query to ONE contract address; this one can't, since the whole point is
 * finding contracts the app has never heard of, so it matches Transfer logs
 * from ANY address. On production RPC, an address-less wide-range query is
 * exactly the shape providers reject outright or silently stall on — the
 * same class of failure documented in nadfun.ts's getNadFunCreatorInfo
 * ("it turned out to accept the range and take minutes to answer rather than
 * reject it, which a try/catch alone does nothing for since nothing ever
 * throws"). A single fixed-width attempt with a bare try/catch used to mean
 * that failure mode was indistinguishable from "this wallet holds nothing
 * new": the newly-bought token just never appeared, with no error anywhere.
 * withTimeout + a series of narrowing fallback windows (mirrors
 * fetchPaymentEvents' single-step fallback, generalized to several steps
 * since this sandbox has no live RPC access to pin the provider's real cap)
 * means a rejected or stalled wide scan still finds recent activity instead
 * of surfacing nothing.
 *
 * That fixed provider rejection/stalling, but not a second, distinct gap:
 * Monad mainnet produces a block roughly every 0.4s, so the original
 * 200,000-block-wide scan covered barely 22 hours of real history — a token
 * bought yesterday, not just now, was already outside the window, with
 * nothing to indicate why. GET below now scans several such windows,
 * covering a full week by default, in parallel.
 */
import { NextRequest, NextResponse } from "next/server";
import { withTimeout } from "@/lib/monad/rpcTimeout";

/** Worst case is now (history chunks) windowed attempts running in
 *  PARALLEL, each up to 4 tries at up to TIMEOUT_MS (~20s worst case per
 *  chunk, not per chunk multiplied) — see fetchIncomingTransferLogs below —
 *  rather than the platform's default function duration, matching how
 *  run-schedules/route.ts declares its own ceiling for the same reason. */
export const maxDuration = 30;

/** Monad mainnet's real block interval — ~0.4s/block, per documented
 *  post-launch network performance figures (not hand-guessed) — used only to
 *  size how much WALL-CLOCK history a bounded discovery scan should cover,
 *  never for balance/amount math. This is the reason the original
 *  200,000-block LOOKBACK_BLOCKS below was a real bug, not just a
 *  provider-limit workaround: at this block rate, 200,000 blocks is only
 *  ~22 HOURS of chain history. A token bought more than a day before the
 *  user checked their portfolio was silently invisible — no timeout, no
 *  error, just outside the window entirely. The chunked scan below is what
 *  actually fixes that; the narrowing-fallback logic (still exactly the
 *  provider-limit workaround it always was) only helps within whatever
 *  window it's given. */
const BLOCK_INTERVAL_MS = 400;
const BLOCKS_PER_DAY = BigInt(Math.round(86_400_000 / BLOCK_INTERVAL_MS));

/** Total history discovery covers. A holding from "earlier this week" is the
 *  realistic case a user actually checks for; the result is cached
 *  (CACHE_MS) so this cost is paid at most once per wallet per five-minute
 *  window no matter how many chunks it takes. Wider would find older
 *  holdings too, but also means more parallel requests against the same RPC
 *  endpoint — this is a deliberately moderate default, not a hard ceiling on
 *  what COULD be discovered. */
const HISTORY_DAYS = 7n;
const TOTAL_LOOKBACK_BLOCKS = BLOCKS_PER_DAY * HISTORY_DAYS;

/** Width of a single getLogs attempt (and of each history chunk below).
 *  Wide enough to cover a meaningful slice per request, bounded so the RPC
 *  never sees an unbounded getLogs. Tried first per chunk; see
 *  FALLBACK_WINDOWS for what happens when a provider won't serve a range
 *  this wide. */
const LOOKBACK_BLOCKS = 200_000n;
/** Narrower windows tried, in order, when the wide scan above is rejected or
 *  doesn't answer within TIMEOUT_MS. Recent activity within that chunk is
 *  still found even against a provider that only serves a small
 *  address-less range. */
const FALLBACK_WINDOWS = [50_000n, 10_000n, 2_000n];
/** Bounds a single getLogs attempt. A provider that accepts the range instead
 *  of rejecting it can just take minutes to answer rather than erroring, so a
 *  try/catch alone never sees that failure — see this file's own doc. */
const TIMEOUT_MS = 5_000;
/** Sentinel distinguishing "timed out, try a narrower window" from a real
 *  empty result. */
const TIMED_OUT = Symbol("timed_out");
/** Discovery changes rarely — a token you hold stays held. Caching keeps the
 *  20-second dashboard sync from turning into a log scan every 20 seconds. */
const CACHE_MS = 5 * 60_000;

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

interface Cached { at: number; tokens: { address: string; decimals: number }[] }
const g = globalThis as unknown as { __payaiDiscover?: Map<string, Cached> };
const cache = (g.__payaiDiscover ??= new Map());

/**
 * Tries the widest transfer-log window first, falling back to progressively
 * narrower ones when the provider rejects the range outright (throws) or
 * simply never answers within TIMEOUT_MS (a hang, not an error — see this
 * file's own doc). Returns whatever the first successful attempt found, or
 * an empty list if every window failed.
 *
 * `request` takes the block range and returns the raw logs — kept separate
 * from the actual RPC client so the retry/timeout behavior is testable with
 * a fake, deterministic responder instead of a live network call. `timeoutMs`
 * defaults to the real production budget; tests override it so a simulated
 * hang doesn't mean actually waiting out TIMEOUT_MS per window.
 */
export async function fetchIncomingTransferLogs<T>(
  latest: bigint,
  request: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>,
  timeoutMs: number = TIMEOUT_MS,
): Promise<T[]> {
  for (const window of [LOOKBACK_BLOCKS, ...FALLBACK_WINDOWS]) {
    const fromBlock = latest > window ? latest - window : 0n;
    try {
      const result = await withTimeout<T[] | typeof TIMED_OUT>(
        request(fromBlock, latest),
        timeoutMs,
        TIMED_OUT,
      );
      if (result !== TIMED_OUT) return result;
      // Timed out on this window — try the next, narrower one.
    } catch {
      // Provider rejected this range outright — try the next, narrower one.
    }
  }
  return [];
}

export async function GET(req: NextRequest) {
  const address = req.nextUrl.searchParams.get("address") ?? "";
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return NextResponse.json({ error: "A valid wallet address is required." }, { status: 400 });
  }
  const key = address.toLowerCase();

  // This route is unauthenticated (a wallet's incoming transfers are public
  // chain data, so there is nothing here to authenticate against), and it is
  // by far the most expensive endpoint in the app: maxDuration 30, up to
  // (history chunks x 4) address-less getLogs queries — the query shape
  // providers charge the most for and rate-limit hardest. Unlimited, that is
  // a straightforward way to burn the project's RPC quota from anywhere.
  const { rateLimited } = await import("@/lib/platform/ratelimit");
  const limited = await rateLimited(req, "discover", { max: 12, windowSec: 60 });
  if (limited) return limited;

  // ?fresh=1 skips the cache-hit check below — used ONLY right after a trade
  // completes (see usePortfolio's warmPortfolioDiscovery), to update this
  // wallet's cache entry with the token it may have just received. Without
  // this, a wallet whose portfolio was viewed (or auto-synced) any time in
  // the preceding CACHE_MS kept serving that now-stale token list for the
  // rest of the window — a freshly bought token stayed invisible for up to 5
  // minutes with no way to force it, not even the manual Sync button, since
  // every refresh still hit the same unconditional cache check. The routine
  // 20-second auto-sync heartbeat still respects the cache as before (this
  // is deliberately NOT a blanket bypass — see CACHE_MS's own doc on why a
  // log scan every 20 seconds must stay the exception, not the norm); this
  // one explicit, targeted case is the only thing allowed to skip it, and it
  // still repopulates the same cache afterward so every OTHER reader
  // benefits from the fresh result too, not just this one call.
  const fresh = req.nextUrl.searchParams.get("fresh") === "1";
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) {
    return NextResponse.json({ tokens: hit.tokens, cached: true });
  }

  // ?fresh=1 removes the CACHE_MS ceiling that was the only thing bounding how
  // OFTEN the scan below could actually run, so it needs a ceiling of its own —
  // otherwise the bypass added for one legitimate post-trade refresh doubles as
  // an open invitation to replay the most expensive query in the codebase.
  // Keyed on the WALLET, not the caller's IP: the IP bucket above already
  // covers one host, and this is what stops a distributed caller (or anyone
  // rotating IPs) from concentrating the same forced rescan on one address.
  // The real caller needs exactly one of these per trade — see
  // warmPortfolioDiscovery — so a handful a minute is generous for it and
  // still far below anything that hurts.
  if (fresh) {
    const freshLimited = await rateLimited(req, "discover-fresh", { max: 4, windowSec: 60, subject: key });
    // Not an error for the user: the cached list is a real answer, just
    // possibly a few minutes old. Serving it beats both a 429 and a rescan.
    if (freshLimited) {
      if (hit) return NextResponse.json({ tokens: hit.tokens, cached: true, throttled: true });
      return freshLimited;
    }
  }

  // Tokens this wallet is KNOWN to have acquired through PayAI itself, read
  // from its own settled trade history — no chain scan involved.
  //
  // The log scan below is the only way to find a token that arrived from
  // somewhere else (an airdrop, an external transfer), so it stays. But it is
  // also the single most rate-limit-prone query in the product — an
  // address-less, 200k-block-wide eth_getLogs, fanned out across several
  // windows at once — and when a provider throttles or refuses it, the catch
  // below cannot tell that apart from "this wallet holds nothing new" and
  // returns an empty list. A token the user bought minutes ago through PayAI
  // then vanished from their portfolio entirely, which is exactly the
  // reported failure.
  //
  // PayAI already knows those tokens without asking the chain anything: it
  // executed the trade and recorded the received token's real contract
  // address at settlement (see TxLogEntry.outputTokenAddress). Seeding from
  // that makes a bought token appear even when the scan returns nothing at
  // all. Deliberately kept in its OWN try/catch, ahead of the scan, so the
  // two sources fail independently — a thrown scan can no longer take the
  // reliable half down with it.
  const seeded: string[] = [];
  try {
    const { resolveTenantId } = await import("@/lib/platform/tenant");
    const { listTx } = await import("@/lib/platform/store");
    const rows = await listTx(await resolveTenantId(req), { sender: address });
    for (const row of rows) {
      const a = row.outputTokenAddress;
      if (typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a)) seeded.push(a.toLowerCase());
    }
  } catch {
    // History unavailable — the scan below is still a complete source on its
    // own, exactly as it was before this seed existed.
  }

  try {
    const { getPublicClient } = await import("@/lib/monad/wallet");
    const { resolveToken } = await import("@/lib/monad/tokenRegistry");
    const client = getPublicClient();

    const latest = await client.getBlockNumber();

    // Incoming transfers only. A token this wallet has merely sent (without
    // ever receiving) is one it cannot hold a balance of.
    // The raw request, not viem's typed `event` helper: this must match a
    // Transfer to this wallet from ANY contract, and the typed form insists on
    // narrowing to specific addresses.
    const fetchWindow = (windowLatest: bigint) =>
      fetchIncomingTransferLogs<{ address: string }>(windowLatest, (fromBlock, toBlock) =>
        client.request({
          method: "eth_getLogs",
          params: [{
            fromBlock: `0x${fromBlock.toString(16)}`,
            toBlock: `0x${toBlock.toString(16)}`,
            topics: [TRANSFER_TOPIC, null, `0x${"0".repeat(24)}${key.slice(2)}`],
          }],
        } as never) as Promise<{ address: string }[]>,
      );

    // A single LOOKBACK_BLOCKS-wide window only ever covers the most recent
    // slice of chain history (~22 hours at Monad's real block rate) — a
    // token bought earlier this week would be outside it entirely, with no
    // error to explain why. Scan several such windows, each anchored at a
    // progressively older block, covering HISTORY_DAYS in total — run in
    // PARALLEL so the wall-clock cost is bounded by the slowest single
    // window, not the sum of all of them.
    const windowAnchors: bigint[] = [];
    const floor = latest > TOTAL_LOOKBACK_BLOCKS ? latest - TOTAL_LOOKBACK_BLOCKS : 0n;
    for (let anchor = latest; anchor > floor; anchor -= LOOKBACK_BLOCKS) {
      windowAnchors.push(anchor);
    }
    const logs = (await Promise.all(windowAnchors.map(fetchWindow))).flat();

    // Seeded-first so a known, just-bought token keeps its slot even if the
    // scan returned more than the 50-contract resolution cap below.
    const contracts = [...new Set([...seeded, ...logs.map((l) => l.address.toLowerCase())])];
    // Resolve metadata so the caller gets real decimals — a balance read with
    // the wrong decimals is a wrong number, which is worse than no number.
    //
    // Bounded per-contract, same reasoning as fetchIncomingTransferLogs above:
    // resolveToken()'s symbol()/name()/decimals() reads are plain readContract
    // calls with no timeout of their own, and a provider can stall on one of
    // those exactly the way it can stall on a wide getLogs range — accepting
    // the call instead of rejecting it, just never answering. Before this,
    // ONE such contract among a wallet's discovered tokens hung the entire
    // Promise.all below, which meant the whole route ran past its 30s
    // maxDuration, the client's fetch failed, and usePortfolio's discovery
    // silently degrades to "no extra tokens found" (see its own doc) — a
    // wallet holding several tokens then showed only the two base assets
    // (MON, USDC) with no error anywhere. withTimeout here means one bad
    // contract is skipped instead of blocking every other token's resolution.
    const tokens = (
      await Promise.all(
        contracts.slice(0, 50).map(async (c) => {
          try {
            const t = await withTimeout<{ address: string; decimals: number } | typeof TIMED_OUT>(
              resolveToken(c).then((r) => ({ address: r.address, decimals: r.decimals })),
              TIMEOUT_MS,
              TIMED_OUT,
            );
            return t === TIMED_OUT ? null : t;
          } catch {
            return null; // not a readable ERC-20; skip rather than guess
          }
        }),
      )
    ).filter((t): t is { address: string; decimals: number } => t !== null);

    cache.set(key, { at: Date.now(), tokens });
    return NextResponse.json({ tokens });
  } catch {
    // The chain scan failed outright (a refused or throttled getLogs, an
    // unreachable RPC). Discovery is additive, so this still degrades rather
    // than erroring — but it degrades to what PayAI independently KNOWS this
    // wallet acquired, not to nothing. Returning [] here regardless of the
    // seed is what made a just-bought token disappear from the portfolio
    // whenever the provider throttled that one query.
    //
    // Resolved through the same metadata path as the scan's own results,
    // because a balance read with wrong decimals is a wrong number; a token
    // whose metadata can't be read is dropped rather than guessed at. Not
    // cached: this is the degraded answer, and caching it would keep the
    // full result out for the rest of the window once the scan recovers.
    if (seeded.length === 0) return NextResponse.json({ tokens: [] });
    try {
      const { resolveToken } = await import("@/lib/monad/tokenRegistry");
      const tokens = (
        await Promise.all(
          [...new Set(seeded)].slice(0, 50).map(async (c) => {
            try {
              const t = await withTimeout<{ address: string; decimals: number } | typeof TIMED_OUT>(
                resolveToken(c).then((r) => ({ address: r.address, decimals: r.decimals })),
                TIMEOUT_MS,
                TIMED_OUT,
              );
              return t === TIMED_OUT ? null : t;
            } catch {
              return null;
            }
          }),
        )
      ).filter((t): t is { address: string; decimals: number } => t !== null);
      return NextResponse.json({ tokens, degraded: true });
    } catch {
      return NextResponse.json({ tokens: [] });
    }
  }
}
