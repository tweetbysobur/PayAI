/**
 * Shared, minimal constants/helpers between the Aave V3 Monad actions
 * (supply — Phase 7A; withdraw — Phase 7B). Extracted from Phase 7A's
 * supply/index.ts verbatim (no behavior change — supply's own 33-test suite
 * re-passes unchanged against this file) rather than left duplicated, per
 * Phase 7B's explicit "do not duplicate utilities unnecessarily" instruction.
 *
 * Everything here is either a fixed, independently-verified constant or a
 * pure verification/formatting helper — no quote(), no build(), no
 * parseResult(), no action-specific logic. Those stay local to each action's
 * own file so supply and withdraw remain independently reviewable and a
 * change to one can never silently alter the other's transaction-building
 * logic.
 *
 * Server-side (reads app config and the chain).
 */
import "server-only";
import { getAddress, parseUnits, type Address } from "viem";
import { isAddress } from "@/lib/payees/directory";
import { getPublicClient } from "@/lib/monad/wallet";
import { resolveToken } from "@/lib/monad/tokenRegistry";

/** The only chain either Aave action is ever registered on. Aave V3 is not
 *  deployed anywhere else PayAI runs. */
export const MONAD_MAINNET_CHAIN_ID = 143;

/** Canonical Aave V3 Pool proxy on Monad mainnet — independently verified
 *  from `aave-dao/aave-address-book`'s `src/AaveV3Monad.sol`, cross-linked
 *  there to https://monadscan.com/address/0x69a5F9AD4f96ebf0a0C792dD42a01cC5C0102fef.
 *  This is the ONLY address either action's real transaction step is ever
 *  permitted to target — Layer B (lib/sdk/validate.ts) enforces this against
 *  build()'s actual output, not against this file's good intentions. */
export const POOL: Address = "0x69a5F9AD4f96ebf0a0C792dD42a01cC5C0102fef";

/** AaveProtocolDataProvider — same source/verification as POOL above,
 *  cross-linked to https://monadscan.com/address/0xB65A68B98274ef7D9a60E0C0747dD1BEc3D32fad.
 *  Read-only: used ONLY to verify an asset is a real Aave-listed reserve
 *  (and, in supply's own quote(), to read an informational APY). Never a
 *  transaction target. */
export const DATA_PROVIDER: Address = "0xB65A68B98274ef7D9a60E0C0747dD1BEc3D32fad";

/** Standard AaveProtocolDataProvider read surface used by both actions —
 *  identical across every Aave V3 deployment. `getAllReservesTokens` is
 *  what makes asset verification a LIVE chain read rather than a
 *  hand-maintained list that could silently drift from what Aave lists. */
export const DATA_PROVIDER_ABI = [
  {
    type: "function", name: "getAllReservesTokens", stateMutability: "view", inputs: [],
    outputs: [{
      type: "tuple[]",
      components: [{ name: "symbol", type: "string" }, { name: "tokenAddress", type: "address" }],
    }],
  },
  {
    type: "function", name: "getReserveData", stateMutability: "view",
    inputs: [{ name: "asset", type: "address" }],
    outputs: [
      { name: "unbacked", type: "uint256" }, { name: "accruedToTreasuryScaled", type: "uint256" },
      { name: "totalAToken", type: "uint256" }, { name: "totalStableDebt", type: "uint256" },
      { name: "totalVariableDebt", type: "uint256" }, { name: "liquidityRate", type: "uint256" },
      { name: "variableBorrowRate", type: "uint256" }, { name: "stableBorrowRate", type: "uint256" },
      { name: "averageStableBorrowRate", type: "uint256" }, { name: "liquidityIndex", type: "uint256" },
      { name: "variableBorrowIndex", type: "uint256" }, { name: "lastUpdateTimestamp", type: "uint256" },
    ],
  },
] as const;

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Thrown for a user-input problem shared by both actions (bad asset,
 *  unlisted reserve, bad amount, bad address). quote()/build() throw it;
 *  callers surface it — same convention as split-settlement's
 *  SplitInputError. Each action's own file may throw this directly; it is
 *  not action-specific, so it lives here rather than being duplicated. */
export class AaveActionInputError extends Error {}

/** In-memory cache of the live reserves list, shared by both actions, so a
 *  burst of quote()/build() calls across either action doesn't re-fetch the
 *  whole reserve set per call. Short TTL (unlike tokenRegistry's permanent
 *  ERC-20-metadata cache) because Aave governance can list a new reserve at
 *  any time and this must reflect that within a bounded window, not only
 *  after a redeploy. Mirrors reverse-resolver.ts's 5-minute TTL pattern. */
const RESERVES_CACHE_TTL_MS = 5 * 60 * 1000;
let reservesCache: { addresses: Set<string>; expiresAt: number } | null = null;

/** Reads the REAL, current Aave-listed reserve set from the chain. Never
 *  cached beyond RESERVES_CACHE_TTL_MS, and never assumed on a read
 *  failure — callers must fail closed when this throws. */
async function fetchListedReserves(): Promise<Set<string>> {
  if (reservesCache && reservesCache.expiresAt > Date.now()) return reservesCache.addresses;
  const pub = getPublicClient();
  const tokens = await pub.readContract({
    address: DATA_PROVIDER, abi: DATA_PROVIDER_ABI, functionName: "getAllReservesTokens",
  }) as readonly { symbol: string; tokenAddress: Address }[];
  const addresses = new Set(tokens.map((t) => t.tokenAddress.toLowerCase()));
  reservesCache = { addresses, expiresAt: Date.now() + RESERVES_CACHE_TTL_MS };
  return addresses;
}

/** Fail-closed reserve check: an RPC failure, a malformed response, or an
 *  asset simply not being in the list are ALL treated as "not verified" —
 *  never "assume it's fine". */
export async function isAaveListedReserve(asset: Address): Promise<boolean> {
  try {
    const reserves = await fetchListedReserves();
    return reserves.has(asset.toLowerCase());
  } catch {
    return false;
  }
}

export interface AaveAssetCtx { address: Address; decimals: number; symbol: string }

/**
 * Resolves and verifies an Aave action's asset: must be a real,
 * on-chain-readable ERC-20 (lib/monad/tokenRegistry's own resolver — the
 * same trusted metadata source split-settlement uses) AND an Aave-listed
 * reserve (live chain read, above). Rejects the native-MON sentinel
 * outright: Aave's supply()/withdraw() both take an ERC-20 reserve, never
 * native value.
 */
export async function resolveAaveAsset(assetInput: string): Promise<AaveAssetCtx> {
  const t = assetInput?.trim();
  if (!t || !isAddress(t) || t.toLowerCase() === ZERO_ADDRESS) {
    throw new AaveActionInputError(`"${assetInput}" is not a valid ERC-20 asset address.`);
  }
  let info;
  try {
    info = await resolveToken(t);
  } catch {
    throw new AaveActionInputError(`Couldn't read "${t}" as an ERC-20 token on Monad.`);
  }
  const address = getAddress(t);
  const listed = await isAaveListedReserve(address);
  if (!listed) {
    throw new AaveActionInputError(`"${info.symbol}" (${address}) is not a reserve Aave V3 lists on Monad — refusing to use an unverified asset.`);
  }
  return { address, decimals: info.decimals, symbol: info.symbol };
}

/** Amount → base units at the asset's real decimals, rejecting a value that
 *  rounds to zero. Same discipline as split-settlement's own toUnits(). */
export function toAaveUnits(amount: string, decimals: number): bigint {
  let units: bigint;
  try {
    units = parseUnits(amount, decimals);
  } catch {
    throw new AaveActionInputError(`"${amount}" is not a valid amount.`);
  }
  if (units <= 0n) throw new AaveActionInputError(`"${amount}" is below the smallest unit of this asset.`);
  return units;
}

/** Validates a required address input (onBehalfOf / to) as a normal,
 *  non-zero address. A zero address would make Aave's own supply()/
 *  withdraw() revert (or, worse, behave undefined) — rejected here, before
 *  it ever reaches a signer. */
export function resolveRequiredAddress(raw: string, fieldName: string): Address {
  const v = raw?.trim();
  if (!v || !isAddress(v) || v.toLowerCase() === ZERO_ADDRESS) {
    throw new AaveActionInputError(`"${raw}" is not a valid ${fieldName} address.`);
  }
  return getAddress(v);
}

/** Test-only: forget the cached reserve list so a test that changed the
 *  mocked reserve set isn't served a stale, previously-cached answer. Not
 *  called anywhere in application code — mirrors registry.ts's own
 *  __resetRegistryForTests() convention. Shared by both actions' test
 *  suites since the cache itself is now shared. */
export function __resetReservesCacheForTests(): void {
  reservesCache = null;
}
