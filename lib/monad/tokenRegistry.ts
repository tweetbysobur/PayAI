/**
 * Token Registry — makes the automation engine token-agnostic.
 *
 * Any fungible token deployed on Monad is supported automatically: this
 * module never hardcodes a token's decimals — those are always read live
 * from the contract's own `decimals()`/`symbol()`/`name()`, so a wrong
 * guess can never mis-scale a transfer. The only thing curated here is
 * which addresses get a "Verified" badge in the picker; an unrecognized
 * address still resolves and works, it just displays as unverified.
 *
 * Verified mainnet addresses below are the well-known bridged/native assets
 * from the Monad ecosystem reference (never hand-guessed — wrong addresses
 * mean lost funds). Testnet has no equivalent curated reference available,
 * so only the network's own configured stablecoin is pre-verified there;
 * any other testnet address still resolves fine, just unverified.
 *
 * Server-only.
 */
import "server-only";
import { getPublicClient } from "./wallet";
import { getNetwork, getChain, getStablecoin } from "./config";

/** Sentinel used throughout the app (and by PaymentExecutor on-chain) to mean "the chain's native asset," never a real ERC-20. */
// Defined in the browser-safe config so client code can use it without
// pulling this server-side module in; re-exported so existing imports keep
// working and the two can never drift.
import { NATIVE_TOKEN_ADDRESS } from "./public";
export { NATIVE_TOKEN_ADDRESS };

export interface TokenInfo {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string | null;
  verified: boolean;
}

const ERC20_METADATA_ABI = [
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

/** Curated, verified Monad MAINNET token addresses — sourced from the
 *  project's Monad address reference. Decimals are intentionally absent
 *  here; resolveToken() always confirms them on-chain. */
const CURATED_MAINNET: { address: string; symbol: string; name: string }[] = [
  { address: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", symbol: "USDC", name: "USD Coin" },
  { address: "0xe7cd86e13AC4309349F30B3435a9d337750fC82D", symbol: "USDT0", name: "Tether USD" },
  { address: "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a", symbol: "AUSD", name: "Agora USD" },
  { address: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A", symbol: "WMON", name: "Wrapped MON" },
  { address: "0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242", symbol: "WETH", name: "Wrapped Ether" },
  { address: "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c", symbol: "WBTC", name: "Wrapped Bitcoin" },
];

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/** In-memory cache — a token's on-chain metadata is immutable for the life
 *  of the process, so a resolved entry never needs to be re-read. */
const cache = new Map<string, TokenInfo>();

function nativeTokenInfo(): TokenInfo {
  const chain = getChain();
  return {
    address: NATIVE_TOKEN_ADDRESS,
    symbol: chain.nativeCurrency.symbol,
    name: chain.nativeCurrency.name,
    decimals: chain.nativeCurrency.decimals,
    logoURI: null,
    verified: true,
  };
}

function isNativeAddress(address: string): boolean {
  return !address || address.toLowerCase() === NATIVE_TOKEN_ADDRESS || /^0x0+$/.test(address);
}

function curatedList(): { address: string; symbol: string; name: string }[] {
  if (getNetwork() !== "mainnet") {
    // No verified testnet reference — fall back to just the configured
    // testnet stablecoin so the picker still has at least one real entry.
    try {
      const s = getStablecoin();
      return [{ address: s.address, symbol: s.symbol, name: s.symbol }];
    } catch {
      return [];
    }
  }
  return CURATED_MAINNET;
}

/** The ERC-20s whose balance PayAI follows for deposits that land while
 *  nobody is watching: the curated list for this network. */
export function trackedTokenAddresses(): `0x${string}`[] {
  return curatedList()
    .map((c) => c.address)
    .filter((a) => ADDR_RE.test(a)) as `0x${string}`[];
}

/**
 * Resolve ANY address (native sentinel or ERC-20) to real, on-chain-verified
 * metadata. This is what makes new Monad tokens "automatically supported":
 * there is no allowlist gate on whether a token *works*, only on whether it
 * shows a Verified badge.
 */
export async function resolveToken(addressInput: string): Promise<TokenInfo> {
  if (isNativeAddress(addressInput)) return nativeTokenInfo();

  const address = addressInput.trim();
  if (!ADDR_RE.test(address)) throw new Error(`"${addressInput}" is not a valid token address.`);
  const key = address.toLowerCase();
  const cached = cache.get(key);
  if (cached) return cached;

  const pub = getPublicClient();
  let symbol: string, name: string, decimals: number;
  try {
    [symbol, name, decimals] = await Promise.all([
      pub.readContract({ address: address as `0x${string}`, abi: ERC20_METADATA_ABI, functionName: "symbol" }) as Promise<string>,
      pub.readContract({ address: address as `0x${string}`, abi: ERC20_METADATA_ABI, functionName: "name" }) as Promise<string>,
      pub.readContract({ address: address as `0x${string}`, abi: ERC20_METADATA_ABI, functionName: "decimals" }) as Promise<number>,
    ]);
  } catch {
    throw new Error(`Could not read "${address}" as an ERC-20 token on Monad. Check the address and try again.`);
  }

  // decimals() is declared uint8 on-chain, so a malformed/malicious token can
  // legally return anything 0-255. An absurd value (e.g. >30) makes every
  // downstream `10 ** decimals` scaling computation overflow to Infinity,
  // which throws deep inside allowance/amount math — that throw was
  // previously getting mistaken for a transient RPC hiccup by a blanket
  // catch further up the call chain, silently skipping the approval check
  // instead of rejecting the token outright. Reject here so bad data never
  // reaches any scaling math at all.
  const decimalsNum = Number(decimals);
  if (!Number.isInteger(decimalsNum) || decimalsNum < 0 || decimalsNum > 30) {
    throw new Error(`"${address}" reports an implausible decimals value (${decimalsNum}) and can't be used.`);
  }

  const curated = curatedList().find((c) => c.address.toLowerCase() === key);
  const info: TokenInfo = {
    address,
    symbol: curated?.symbol ?? symbol,
    name: curated?.name ?? name,
    decimals: decimalsNum,
    logoURI: null,
    verified: !!curated,
  };
  cache.set(key, info);
  return info;
}

/** The full verified list for the active network, each entry confirmed
 *  on-chain (not just hand-typed). Native asset always comes first.
 *
 *  In-flight calls share one promise: on a cold cache, Uniswap and Kuru
 *  quote a pair concurrently and each independently needs this list, which
 *  would otherwise fire the same RPC burst twice at once. Once it resolves
 *  the memo is cleared -- every entry is already permanent in `cache` by
 *  then, so later calls are cheap reads, not another live RPC round-trip. */
let verifiedTokensInFlight: Promise<TokenInfo[]> | null = null;
export async function getVerifiedTokens(): Promise<TokenInfo[]> {
  if (verifiedTokensInFlight) return verifiedTokensInFlight;
  const curated = curatedList();
  verifiedTokensInFlight = Promise.all(
    curated.map((c) => resolveToken(c.address).catch(() => null)),
  )
    .then((resolved) => [nativeTokenInfo(), ...resolved.filter((t): t is TokenInfo => t !== null)])
    .finally(() => {
      verifiedTokensInFlight = null;
    });
  return verifiedTokensInFlight;
}

/** Case-insensitive substring match against name or symbol. */
export function searchTokens(tokens: TokenInfo[], query: string): TokenInfo[] {
  const q = query.trim().toLowerCase();
  if (!q) return tokens;
  return tokens.filter((t) => t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q));
}
