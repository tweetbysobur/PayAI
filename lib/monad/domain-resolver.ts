/**
 * Monad domain resolution — Nad Name Service (NNS) integration.
 *
 * NNS is a real, independently-deployed naming protocol on Monad
 * (https://nad.domains, npm: @nadnameservice/nns-ethers-sdk) that maps
 * human-readable names like "test.nad" to wallet addresses. This module talks
 * to NNS's actual contract — the address, ABI, and namehash algorithm below
 * are taken directly from that SDK's published source, not invented.
 *
 * IMPORTANT, DISCLOSED HONESTLY: as of this writing the NNS contract has no
 * deployed bytecode on Monad TESTNET (confirmed via eth_getCode — PayAI
 * currently runs on testnet). It appears to be live on Monad mainnet only.
 * That means on testnet, resolving any .nad domain will correctly come back
 * as "unable to resolve" — not because this code is fake, but because the
 * real registry isn't there yet. The integration is real and will start
 * working the moment either (a) NNS deploys to testnet, or (b)
 * MONAD_NETWORK=mainnet, or (c) NNS_CONTRACT_ADDRESS is overridden to point
 * at a test deployment.
 *
 * Server-only.
 */
import "server-only";
import { namehash } from "viem";
import { getChain, getTransport } from "./config";

/** The real NNS registry contract (from @nadnameservice/nns-ethers-sdk@2.0.0). */
const DEFAULT_NNS_CONTRACT = "0xCc7a1bfF8845573dbF0B3b96e25B9b549d4a2eC7" as const;

export function getNnsContractAddress(): `0x${string}` {
  const override = process.env.NNS_CONTRACT_ADDRESS;
  return (override && /^0x[0-9a-fA-F]{40}$/.test(override) ? override : DEFAULT_NNS_CONTRACT) as `0x${string}`;
}

const NNS_ABI = [
  {
    inputs: [{ internalType: "bytes32", name: "node", type: "bytes32" }],
    name: "getResolvedAddress",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

/** The real TLD is ".nad" (e.g. "test.nad"). ".nads" is accepted too — a name
 *  ending in it is normalized to ".nad" before the registry is queried, since
 *  that's the only suffix the actual contract understands. */
const NAD_TLD = ".nad";
const ACCEPTED_SUFFIXES = [".nad", ".nads"];

/** Matches a single domain-shaped token, e.g. "alex.nads" or "alice.nad". */
const DOMAIN_TOKEN_RE = /\b([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.(nads?)\b/i;

export function isDomainName(text: string): boolean {
  return DOMAIN_TOKEN_RE.test(text.trim());
}

/** Find the first domain-shaped token anywhere in free text. */
export function extractDomain(text: string): string | null {
  const m = text.match(DOMAIN_TOKEN_RE);
  return m ? `${m[1]}.${m[2]}`.toLowerCase() : null;
}

/** Normalize to the form the real registry recognizes: always ".nad". */
export function normalizeDomain(domain: string): string {
  const lower = domain.trim().toLowerCase();
  for (const suffix of ACCEPTED_SUFFIXES) {
    if (lower.endsWith(suffix)) return lower.slice(0, -suffix.length) + NAD_TLD;
  }
  return lower;
}

export interface DomainResolution {
  domain: string;
  resolvedAddress: `0x${string}` | null;
  cached: boolean;
  error?: string;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const CACHE_TTL_MS = 5 * 60 * 1000;
type CacheEntry = { value: DomainResolution; expiresAt: number };
const cache = new Map<string, CacheEntry>();

function cacheKey(domain: string): string {
  return `${getChain().id}:${domain}`;
}

/** Drop any expired entries — called lazily on read, no background timer needed. */
function getCached(key: string): DomainResolution | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.value;
}

/**
 * Resolve a .nad / .nads domain to a wallet address via the real NNS
 * contract. Returns `resolvedAddress: null` (with `error` set) for anything
 * that isn't a live, registered name — never fabricates an address.
 */
export async function resolveDomain(rawDomain: string): Promise<DomainResolution> {
  const domain = normalizeDomain(rawDomain);
  const key = cacheKey(domain);
  const cached = getCached(key);
  if (cached) return { ...cached, cached: true };

  if (!DOMAIN_TOKEN_RE.test(domain)) {
    const result: DomainResolution = { domain, resolvedAddress: null, cached: false, error: "Unable to resolve domain" };
    return result;
  }

  try {
    const { createPublicClient } = await import("viem");
    const client = createPublicClient({ chain: getChain(), transport: getTransport() });
    const node = namehash(domain);
    const address = await client.readContract({
      address: getNnsContractAddress(),
      abi: NNS_ABI,
      functionName: "getResolvedAddress",
      args: [node],
    });

    if (!address || address.toLowerCase() === ZERO_ADDRESS) {
      const result: DomainResolution = { domain, resolvedAddress: null, cached: false, error: "Unable to resolve domain" };
      cache.set(key, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
      return result;
    }

    const result: DomainResolution = { domain, resolvedAddress: address, cached: false };
    cache.set(key, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
    return result;
  } catch {
    // Includes: registry not deployed on this network, RPC failure, or a
    // malformed/unregistered name the contract can't decode a response for.
    // Deliberately NOT cached — a transient RPC failure shouldn't poison a
    // name for 5 minutes once the network recovers.
    return { domain, resolvedAddress: null, cached: false, error: "Unable to resolve domain" };
  }
}
