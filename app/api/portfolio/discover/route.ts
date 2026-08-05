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
 */
import { NextRequest, NextResponse } from "next/server";

/** How far back to look for first-ever receipts. Wide enough to cover a
 *  wallet's real history on a young chain, bounded so the RPC never sees an
 *  unbounded getLogs. */
const LOOKBACK_BLOCKS = 200_000n;
/** Discovery changes rarely — a token you hold stays held. Caching keeps the
 *  20-second dashboard sync from turning into a log scan every 20 seconds. */
const CACHE_MS = 5 * 60_000;

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

interface Cached { at: number; tokens: { address: string; decimals: number }[] }
const g = globalThis as unknown as { __payaiDiscover?: Map<string, Cached> };
const cache = (g.__payaiDiscover ??= new Map());

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
    const fromBlock = latest > LOOKBACK_BLOCKS ? latest - LOOKBACK_BLOCKS : 0n;

    // Incoming transfers only. A token this wallet has merely sent (without
    // ever receiving) is one it cannot hold a balance of.
    // The raw request, not viem's typed `event` helper: this must match a
    // Transfer to this wallet from ANY contract, and the typed form insists on
    // narrowing to specific addresses.
    const logs = (await client.request({
      method: "eth_getLogs",
      params: [{
        fromBlock: `0x${fromBlock.toString(16)}`,
        toBlock: `0x${latest.toString(16)}`,
        topics: [TRANSFER_TOPIC, null, `0x${"0".repeat(24)}${key.slice(2)}`],
      }],
    } as never)) as { address: string }[];

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
