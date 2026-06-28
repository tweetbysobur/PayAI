/**
 * Reverse .nads resolution — wallet address → primary NNS name (e.g.
 * 0x25b8… → "gentle.nad"). Uses the official @nadnameservice/nns-viem-sdk
 * against the active Monad network's public client. NNS is live on Monad
 * mainnet; on a network where it isn't deployed this returns null rather than
 * a fabricated name.
 *
 * Server-only.
 */
import "server-only";
import { getPublicClient } from "./wallet";

const ZERO = "0x0000000000000000000000000000000000000000";
const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { name: string | null; expiresAt: number }>();

/** The primary .nad name for an address, or null if none is set / unavailable. Never fabricated. */
export async function reverseResolve(address: `0x${string}`): Promise<string | null> {
  if (!address || address.toLowerCase() === ZERO) return null;
  const key = address.toLowerCase();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.name;

  try {
    const { NNS } = await import("@nadnameservice/nns-viem-sdk");
    // The SDK's PublicClient typing is structurally compatible with ours.
    const nns = new NNS(getPublicClient() as unknown as ConstructorParameters<typeof NNS>[0]);
    const name = await nns.getPrimaryNameForAddress(address);
    const value = name && name.trim().length > 0 ? name : null;
    cache.set(key, { name: value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  } catch {
    // Registry not deployed on this network, RPC failure, or no primary name —
    // never cache a transient failure as a permanent "no name".
    return null;
  }
}
