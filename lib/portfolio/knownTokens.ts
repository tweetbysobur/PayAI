/**
 * Tokens a wallet is known to have touched — the candidate list the portfolio
 * reads balances for.
 *
 * Monad's public RPC answers `eth_getLogs` for at most 100 blocks (about 40
 * seconds of history), so a wallet's holdings cannot be found by scanning its
 * transfer history on demand. Instead every place PayAI sees a token reach a
 * wallet records it here as it happens:
 *
 *   - the deposit reconciler, for any token transferred in while it watches;
 *   - a trade built through Ask, for the token being bought;
 *   - a token lookup, when the wallet already holds some.
 *
 * Only an address is stored — never a balance. The portfolio reads every
 * balance live from the chain, and shows an unverified token only when it is
 * actually held and has a real market price (see usePortfolio), so an entry
 * here can't make anything appear that isn't really there.
 *
 * Server-only.
 */
import "server-only";
import { getRedis } from "@/lib/platform/kv";

/** Most recent first; older entries beyond this are dropped. */
export const MAX_KNOWN_TOKENS = 150;

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const key = (wallet: string) => `payai:wallet-tokens:${wallet.toLowerCase()}`;

const g = globalThis as unknown as { __payaiKnownTokens?: Map<string, Map<string, number>> };
const mem = (g.__payaiKnownTokens ??= new Map());

/** Records tokens for a wallet. Never throws — this is bookkeeping alongside
 *  the real work, and must not fail it. */
export async function addKnownTokens(wallet: string, tokens: (string | null | undefined)[]): Promise<void> {
  if (!ADDR_RE.test(wallet)) return;
  const valid = [...new Set(tokens.filter((t): t is string => !!t && ADDR_RE.test(t) && !/^0x0{40}$/i.test(t)).map((t) => t.toLowerCase()))];
  if (valid.length === 0) return;
  const now = Date.now();
  try {
    const r = await getRedis();
    if (r) {
      for (const t of valid) await r.zadd(key(wallet), { score: now, member: t });
      // Bounded: a flood of spam airdrops can't grow one wallet's list forever.
      const all = await r.zrange(key(wallet), 0, Number.MAX_SAFE_INTEGER, { byScore: true });
      for (const old of all.slice(0, Math.max(0, all.length - MAX_KNOWN_TOKENS))) await r.zrem(key(wallet), old);
      return;
    }
  } catch {
    /* fall through to memory */
  }
  const m = mem.get(key(wallet)) ?? new Map<string, number>();
  for (const t of valid) m.set(t, now);
  if (m.size > MAX_KNOWN_TOKENS) {
    for (const [t] of [...m.entries()].sort((a, b) => a[1] - b[1]).slice(0, m.size - MAX_KNOWN_TOKENS)) m.delete(t);
  }
  mem.set(key(wallet), m);
}

/** The wallet's known tokens, most recently seen first, capped. */
export async function getKnownTokens(wallet: string): Promise<string[]> {
  if (!ADDR_RE.test(wallet)) return [];
  try {
    const r = await getRedis();
    if (r) {
      const all = await r.zrange(key(wallet), 0, Number.MAX_SAFE_INTEGER, { byScore: true });
      return [...all].reverse().slice(0, MAX_KNOWN_TOKENS).filter((t) => ADDR_RE.test(t));
    }
  } catch {
    return [];
  }
  const m = mem.get(key(wallet));
  if (!m) return [];
  return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_KNOWN_TOKENS).map(([t]) => t);
}
