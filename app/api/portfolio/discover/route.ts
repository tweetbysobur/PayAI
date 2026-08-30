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
 */
import { NextRequest, NextResponse } from "next/server";
import { withTimeout } from "@/lib/monad/rpcTimeout";

/** Worst case is now 4 windowed attempts at up to TIMEOUT_MS each (~20s) — see
 *  fetchIncomingTransferLogs below — rather than the platform's default
 *  function duration, matching how run-schedules/route.ts declares its own
 *  ceiling for the same reason. */
export const maxDuration = 30;

/** How far back to look for first-ever receipts. Wide enough to cover a
 *  wallet's real history on a young chain, bounded so the RPC never sees an
 *  unbounded getLogs. Tried first; see FALLBACK_WINDOWS below for what
 *  happens when a provider won't serve a range this wide. */
const LOOKBACK_BLOCKS = 200_000n;
/** Narrower windows tried, in order, when the wide scan above is rejected or
 *  doesn't answer within TIMEOUT_MS. Recent activity — the case a user
 *  actually notices ("I just swapped into this and don't see it") — is still
 *  found even against a provider that only serves a small address-less
 *  range. */
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

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return NextResponse.json({ tokens: hit.tokens, cached: true });
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
    const logs = await fetchIncomingTransferLogs<{ address: string }>(latest, (fromBlock, toBlock) =>
      client.request({
        method: "eth_getLogs",
        params: [{
          fromBlock: `0x${fromBlock.toString(16)}`,
          toBlock: `0x${toBlock.toString(16)}`,
          topics: [TRANSFER_TOPIC, null, `0x${"0".repeat(24)}${key.slice(2)}`],
        }],
      } as never) as Promise<{ address: string }[]>,
    );

    const contracts = [...new Set((logs ?? []).map((l) => l.address.toLowerCase()))];
    // Resolve metadata so the caller gets real decimals — a balance read with
    // the wrong decimals is a wrong number, which is worse than no number.
    const tokens = (
      await Promise.all(
        contracts.slice(0, 50).map(async (c) => {
          try {
            const t = await resolveToken(c);
            return { address: t.address, decimals: t.decimals };
          } catch {
            return null; // not a readable ERC-20; skip rather than guess
          }
        }),
      )
    ).filter((t): t is { address: string; decimals: number } => t !== null);

    cache.set(key, { at: Date.now(), tokens });
    return NextResponse.json({ tokens });
  } catch {
    // Discovery is additive: the portfolio still renders its base tokens, so
    // a failure here degrades to "no extra tokens found", never to an error
    // the user has to act on.
    return NextResponse.json({ tokens: [] });
  }
}
