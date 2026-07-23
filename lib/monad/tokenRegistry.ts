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
export const NATIVE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

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

  const curated = curatedList().find((c) => c.address.toLowerCase() === key);
  const info: TokenInfo = {
    address,
    symbol: curated?.symbol ?? symbol,
    name: curated?.name ?? name,
    decimals: Number(decimals),
    logoURI: null,
    verified: !!curated,
  };
  cache.set(key, info);
  return info;
}

/** The full verified list for the active network, each entry confirmed
 *  on-chain (not just hand-typed). Native asset always comes first. */
export async function getVerifiedTokens(): Promise<TokenInfo[]> {
  const curated = curatedList();
  const resolved = await Promise.all(
    curated.map((c) => resolveToken(c.address).catch(() => null)),
  );
  return [nativeTokenInfo(), ...resolved.filter((t): t is TokenInfo => t !== null)];
}

/** Case-insensitive substring match against name or symbol. */
export function searchTokens(tokens: TokenInfo[], query: string): TokenInfo[] {
  const q = query.trim().toLowerCase();
  if (!q) return tokens;
  return tokens.filter((t) => t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q));
}
