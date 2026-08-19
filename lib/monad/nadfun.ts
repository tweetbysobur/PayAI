/**
 * Nad.Fun provider — Step 6 of the PayAI Trading Engine.
 *
 * Nad.Fun is a token-launch platform on Monad: a new token starts on a
 * "bonding curve" (priced algorithmically against MON, no external LP) and,
 * once enough MON has been raised, "graduates" onto a real DEX pool. PayAI's
 * existing Uniswap/Kuru providers only ever see the post-graduation pool —
 * before that, `quoteUniswapDirect()` finds nothing and a perfectly tradable
 * token reads as "no route found". This module adds Nad.Fun as a THIRD
 * provider behind the same seam (see swap.ts's SwapProvider/UnsignedStep),
 * so a bonding-curve token is discovered, quoted and traded like any other —
 * Uniswap and Kuru are untouched.
 *
 * ── Verification, not guessing ──────────────────────────────────────────────
 * Every address and every ABI below was independently re-fetched from
 * Nad.Fun's official ABI repository — github.com/Naddotfun/contract-v3-abi —
 * via raw.githubusercontent.com (the project's GitBook docs site is
 * unreachable from this build environment's network policy, same as
 * DexScreener was in Step 5; GitHub's raw content was not, and the fetched
 * addresses matched exactly what the task's own brief specified). Nothing
 * here was typed from memory or inferred from the Nad.Fun frontend.
 *
 * ── The Lens is the source of truth ─────────────────────────────────────────
 * `getAmountOut`/`getAmountIn` return BOTH a quote AND the router that quote
 * is only valid against — PayAI never decides bonding-curve-vs-DEX itself
 * (isGraduated() alone is not reliable for that per the official docs, which
 * describe cases needing the Lens's own routing decision). The router Lens
 * returns is still validated against ALLOWED_ROUTERS below before it is ever
 * used in a transaction target — belt-and-suspenders against ever building a
 * transaction aimed at an address that didn't come from this hardcoded,
 * verified configuration, regardless of what any read call returns.
 *
 * Server-only.
 */
import "server-only";
import { encodeFunctionData, formatUnits, parseUnits, type Address } from "viem";
import { getNetwork } from "./config";
import { getPublicClient } from "./wallet";
import { ERC20_ABI, MAX_SLIPPAGE, minOutWei, type UnsignedStep } from "./swap";
import { normalizeDecimalString } from "./verify";
import { withTimeout } from "./rpcTimeout";

/** Official Monad-mainnet Nad.Fun contracts, from the official ABI repo's
 *  README (github.com/Naddotfun/contract-v3-abi) — re-verified directly
 *  against raw.githubusercontent.com, not copied from the task brief without
 *  checking. Env-overridable, matching this codebase's existing convention
 *  for every other verified deployment (see swap.ts's UNISWAP_MAINNET). */
const NADFUN_MAINNET = {
  dexFactory: (process.env.MONAD_MAINNET_NADFUN_DEX_FACTORY || "0x6B5F564339DbAD6b780249827f2198a841FEB7F3") as Address,
  wmon: (process.env.MONAD_MAINNET_WMON || "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A") as Address,
  bondingCurveRouter: (process.env.MONAD_MAINNET_NADFUN_BONDING_CURVE_ROUTER || "0x6F6B8F1a20703309951a5127c45B49b1CD981A22") as Address,
  bondingCurve: (process.env.MONAD_MAINNET_NADFUN_BONDING_CURVE || "0xA7283d07812a02AFB7C09B60f8896bCEA3F90aCE") as Address,
  dexRouter: (process.env.MONAD_MAINNET_NADFUN_DEX_ROUTER || "0x0B79d71AE99528D1dB24A4148b5f4F865cc2b137") as Address,
  lens: (process.env.MONAD_MAINNET_NADFUN_LENS || "0x7e78A8DE94f21804F7a17F4E8BF9EC2c872187ea") as Address,
} as const;

/** The ONLY two contracts a Nad.Fun trade can ever be sent to. A router
 *  address coming back from a Lens read is checked against this set before
 *  it is used for anything — see this module's own doc. Never derived from
 *  a token address or any other user-controlled input. */
const ALLOWED_ROUTERS = new Set<string>([
  NADFUN_MAINNET.bondingCurveRouter.toLowerCase(),
  NADFUN_MAINNET.dexRouter.toLowerCase(),
]);

/** Lens ABI — trimmed to the read functions this module actually calls.
 *  Field names/order verified against ILens.json in the official ABI repo. */
const LENS_ABI = [
  {
    type: "function", name: "getAmountOut", stateMutability: "view",
    inputs: [{ name: "_token", type: "address" }, { name: "_amountIn", type: "uint256" }, { name: "_isBuy", type: "bool" }],
    outputs: [{ name: "router", type: "address" }, { name: "amountOut", type: "uint256" }],
  },
  {
    type: "function", name: "getAmountIn", stateMutability: "view",
    inputs: [{ name: "_token", type: "address" }, { name: "_amountOut", type: "uint256" }, { name: "_isBuy", type: "bool" }],
    outputs: [{ name: "router", type: "address" }, { name: "amountIn", type: "uint256" }],
  },
  { type: "function", name: "isGraduated", stateMutability: "view", inputs: [{ name: "_token", type: "address" }], outputs: [{ name: "isGraduated", type: "bool" }] },
  { type: "function", name: "isLocked", stateMutability: "view", inputs: [{ name: "_token", type: "address" }], outputs: [{ name: "isLocked", type: "bool" }] },
  {
    type: "function", name: "availableBuyTokens", stateMutability: "view",
    inputs: [{ name: "_token", type: "address" }],
    outputs: [{ name: "availableBuyToken", type: "uint256" }, { name: "requiredMonAmount", type: "uint256" }],
  },
  {
    type: "function", name: "getProgress", stateMutability: "view",
    inputs: [{ name: "_token", type: "address" }],
    outputs: [{ name: "progress", type: "uint256" }],
  },
] as const;

/** BondingCurve's `curves` mapping getter — the token's REAL reserves, not
 *  just its buy capacity (see `availableBuyTokens`, a different concept:
 *  Step 7's brief is explicit that the two must never be conflated). Field
 *  names/order verified against IBondingCurve.json in the official repo. */
const BONDING_CURVE_ABI = [
  {
    type: "function", name: "curves", stateMutability: "view",
    inputs: [{ name: "token", type: "address" }],
    outputs: [
      { name: "realMonReserve", type: "uint256" }, { name: "realTokenReserve", type: "uint256" },
      { name: "virtualMonReserve", type: "uint256" }, { name: "virtualTokenReserve", type: "uint256" },
      { name: "k", type: "uint256" }, { name: "targetTokenAmount", type: "uint256" },
      { name: "initVirtualMonReserve", type: "uint256" }, { name: "initVirtualTokenReserve", type: "uint256" },
    ],
  },
] as const;

/** CurveCreate — fired exactly once per token, ever, at creation. `creator`,
 *  `token` and `pool` are all indexed, so a single token's event is a
 *  targeted topic-filtered lookup, not a full-history scan. Verified
 *  verbatim against IBondingCurve.json's event list in the official repo. */
const CURVE_CREATE_EVENT = {
  type: "event", name: "CurveCreate", anonymous: false,
  inputs: [
    { name: "creator", type: "address", indexed: true },
    { name: "token", type: "address", indexed: true },
    { name: "pool", type: "address", indexed: true },
    { name: "name", type: "string", indexed: false },
    { name: "symbol", type: "string", indexed: false },
    { name: "tokenURI", type: "string", indexed: false },
    { name: "virtualMon", type: "uint256", indexed: false },
    { name: "virtualToken", type: "uint256", indexed: false },
    { name: "targetTokenAmount", type: "uint256", indexed: false },
  ],
} as const;

/**
 * Nad.Fun's DEX side is a straight fork of Uniswap V2 (verified against
 * Naddotfun/contracts/src/uniswap/{UniswapV2Factory,UniswapV2Pair}.sol —
 * `UniswapV2Factory.getPair` is a public `mapping(address => mapping(address
 * => address))`, `UniswapV2Pair.getReserves()`/`token0()`/`token1()` are the
 * standard, unmodified interface), so the universal Uniswap V2 ABI is used
 * here rather than a bespoke Nad.Fun one — the same standing this codebase
 * already gives plain ERC-20 `balanceOf`/`allowance` elsewhere.
 */
const DEX_FACTORY_ABI = [
  { type: "function", name: "getPair", stateMutability: "view", inputs: [{ name: "", type: "address" }, { name: "", type: "address" }], outputs: [{ name: "", type: "address" }] },
] as const;
const UNISWAP_V2_PAIR_ABI = [
  { type: "function", name: "getReserves", stateMutability: "view", inputs: [], outputs: [{ name: "_reserve0", type: "uint112" }, { name: "_reserve1", type: "uint112" }, { name: "_blockTimestampLast", type: "uint32" }] },
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "token1", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
] as const;

/**
 * BondingCurveRouter and DexRouter expose IDENTICAL `buy`/`sell`/
 * `exactOutBuy`/`exactOutSell` struct shapes (verified independently against
 * both IBondingCurveRouter.json and IDexRouter.json in the official repo —
 * same field names, same field order, same types; they differ only in
 * unrelated details like DexRouter's `buy` also returning `amountOut`, which
 * has no effect on calldata encoding). One shared ABI is used for calls to
 * EITHER contract — never guessed, both independently confirmed.
 */
const NADFUN_ROUTER_ABI = [
  {
    type: "function", name: "buy", stateMutability: "payable",
    inputs: [{
      name: "params", type: "tuple", components: [
        { name: "amountOutMin", type: "uint256" }, { name: "token", type: "address" }, { name: "to", type: "address" }, { name: "deadline", type: "uint256" },
      ],
    }],
    outputs: [],
  },
  {
    type: "function", name: "sell", stateMutability: "nonpayable",
    inputs: [{
      name: "params", type: "tuple", components: [
        { name: "amountIn", type: "uint256" }, { name: "amountOutMin", type: "uint256" }, { name: "token", type: "address" }, { name: "to", type: "address" }, { name: "deadline", type: "uint256" },
      ],
    }],
    outputs: [],
  },
  {
    type: "function", name: "exactOutBuy", stateMutability: "payable",
    inputs: [{
      name: "params", type: "tuple", components: [
        { name: "amountInMax", type: "uint256" }, { name: "amountOut", type: "uint256" }, { name: "token", type: "address" }, { name: "to", type: "address" }, { name: "deadline", type: "uint256" },
      ],
    }],
    outputs: [],
  },
  {
    type: "function", name: "exactOutSell", stateMutability: "nonpayable",
    inputs: [{
      name: "params", type: "tuple", components: [
        { name: "amountInMax", type: "uint256" }, { name: "amountOut", type: "uint256" }, { name: "token", type: "address" }, { name: "to", type: "address" }, { name: "deadline", type: "uint256" },
      ],
    }],
    outputs: [],
  },
] as const;

const DEADLINE_SECONDS = 10 * 60;
function deadline(): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS);
}

export type NadFunStatusLabel = "bonding_curve" | "graduated" | "locked" | "unsupported";

export interface NadFunStatus {
  /** False when the Lens doesn't recognize this address as a Nad.Fun token
   *  at all (read reverted) — the only case that means "not a Nad.Fun
   *  token"; every other case is a real, distinguishable phase. */
  recognized: boolean;
  isGraduated: boolean;
  isLocked: boolean;
  status: NadFunStatusLabel;
}

/** Probe size for getNadFunStatus's sell-side recognition quote: 1 token in
 *  its smallest 18-dp unit. Never shown to anyone — it only has to be large
 *  enough that a real pool doesn't round the output to a reverting zero, and
 *  small enough that no pool is too thin to answer it. */
const RECOGNITION_SELL_PROBE_WEI = 10n ** 18n;

/** One read, reduced to "did it answer" — a revert here is information
 *  (this contract has nothing for that token), not a failure to propagate. */
async function tryRead<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch {
    return null;
  }
}

/**
 * Identifies whether `token` is Nad.Fun-managed and which phase it's in, by
 * CONTRACT ADDRESS only — never by symbol, per this module's brief.
 *
 * ── Why the flags alone can't decide this ────────────────────────────────────
 * `isGraduated`/`isLocked` do NOT revert for an address the Lens has never
 * seen — they return a harmless `(false, false)`. Confirmed live against WMON
 * (wrapped native MON, never a Nad.Fun token): both read false with no error,
 * while `getAmountOut`/`getProgress` reverted and `BondingCurve.curves()` came
 * back all-zero. Trusting the non-revert made WMON present as a bonding-curve
 * token with $0 liquidity.
 *
 * ── Recognition is about EXISTENCE, not tradability ──────────────────────────
 * The tempting fix — probe `getAmountOut` and treat a revert as "not Nad.Fun"
 * — is wrong in the other direction. That read is a *buy* quote, and a curve
 * that is locked (paused at its target, pending graduation) or simply sold out
 * has no buy to quote, so it can revert for a perfectly real Nad.Fun token —
 * precisely the `locked` phase this module explicitly models. That trades a
 * false positive for a false negative.
 *
 * So recognition asks whether Nad.Fun holds STATE for this token, via two
 * independent existence signals, either of which is proof on its own:
 *   - `BondingCurve.curves(token)` has any non-zero field — it has, or had, a
 *     real bonding curve.
 *   - Nad.Fun's OWN dex factory has a `getPair(WMON, token)` — it has a
 *     Nad.Fun DEX pool. (This is Nad.Fun's factory, not a generic Uniswap one,
 *     so a pair here is Nad.Fun's own liquidity.)
 *
 * Neither signal can fire for WMON: its curve storage is all-zero (verified),
 * and `getPair(WMON, WMON)` is a self-pair, which a Uniswap-V2-style factory
 * never creates.
 *
 * ── Why a third signal was needed ────────────────────────────────────────────
 * Those two were chosen partly to sidestep a question this sandbox could not
 * then verify: whether a curve's storage is cleared at graduation. It is.
 * Measured live against BOB (0x21E3…7777), a real graduated Nad.Fun token:
 *
 *   curves(BOB)          -> all zero          (storage cleared at graduation)
 *   getPair(WMON, BOB)   -> execution reverted (this factory read is broken)
 *   isGraduated/isLocked -> true / true
 *   getProgress          -> 0x2710 = 100%
 *   getAmountOut(sell)   -> router 0x0B79…b137, a real amount
 *
 * So BOTH existence signals missed at once, and every graduated token came
 * back unrecognized — no liquidity, no phase, no curve data — while its Lens
 * quote worked perfectly. That is the worst possible failure for someone
 * pasting a contract address to decide whether to buy.
 *
 * The Lens quote is therefore the third signal, and the strongest of the
 * three: it is the same read this module already trusts to ROUTE REAL MONEY
 * (see lensGetAmountOut and the module's own top doc). It is taken on the
 * SELL side deliberately — a curve that is locked, sold out, or graduated has
 * no buy to quote but always has a sell — and it counts only when the router
 * it names is one of Nad.Fun's own two allowlisted routers. A quote naming an
 * allowlisted Nad.Fun router IS proof the token is Nad.Fun-managed; nothing
 * else can produce one. WMON stays excluded because that read reverts for it
 * outright (verified).
 *
 * Priority when both flags are set: graduated wins. `isLocked` (the
 * `CurveTokenLocked` event in the official ABI) reads as a bonding-curve-
 * phase state — the curve reaching its target and pausing pending
 * graduation — so it stops being the operative fact once graduation has
 * actually happened. Both raw flags are still returned so a caller can
 * decide differently if that inference turns out wrong once the (currently
 * network-blocked) prose docs can be checked directly.
 */
export async function getNadFunStatus(token: Address): Promise<NadFunStatus> {
  const unrecognized: NadFunStatus = { recognized: false, isGraduated: false, isLocked: false, status: "unsupported" };
  if (getNetwork() !== "mainnet") return unrecognized;
  const pub = getPublicClient();

  // One round trip: the phase flags and all three existence signals are
  // independent reads, so they go out together rather than gating each other.
  const [isGraduated, isLocked, curve, pool, quote] = await Promise.all([
    tryRead(pub.readContract({ address: NADFUN_MAINNET.lens, abi: LENS_ABI, functionName: "isGraduated", args: [token] }) as Promise<boolean>),
    tryRead(pub.readContract({ address: NADFUN_MAINNET.lens, abi: LENS_ABI, functionName: "isLocked", args: [token] }) as Promise<boolean>),
    tryRead(pub.readContract({ address: NADFUN_MAINNET.bondingCurve, abi: BONDING_CURVE_ABI, functionName: "curves", args: [token] }) as Promise<readonly bigint[]>),
    tryRead(pub.readContract({ address: NADFUN_MAINNET.dexFactory, abi: DEX_FACTORY_ABI, functionName: "getPair", args: [NADFUN_MAINNET.wmon, token] }) as Promise<Address>),
    tryRead(pub.readContract({
      address: NADFUN_MAINNET.lens, abi: LENS_ABI, functionName: "getAmountOut",
      args: [token, RECOGNITION_SELL_PROBE_WEI, false],
    }) as Promise<readonly [Address, bigint]>),
  ]);

  const hasCurve = Array.isArray(curve) && curve.some((v) => typeof v === "bigint" && v > 0n);
  const hasPool = typeof pool === "string" && !/^0x0+$/.test(pool);
  // Only an allowlisted Nad.Fun router counts — see this function's own doc.
  const hasQuote =
    Array.isArray(quote) &&
    typeof quote[0] === "string" &&
    ALLOWED_ROUTERS.has(quote[0].toLowerCase()) &&
    typeof quote[1] === "bigint" &&
    quote[1] > 0n;

  if (!hasCurve && !hasPool && !hasQuote) return unrecognized;

  const graduated = isGraduated === true;
  const locked = isLocked === true;
  // Graduation wins over `locked` (see above), and either beats inferring the
  // phase from storage. With no curve storage left, the curve phase is behind
  // it whatever else is true — that is what graduation looks like on-chain.
  const status: NadFunStatusLabel = graduated ? "graduated" : locked ? "locked" : hasCurve ? "bonding_curve" : "graduated";
  return { recognized: true, isGraduated: graduated, isLocked: locked, status };
}

interface LensAmountOut { router: Address; amountOutWei: bigint }
interface LensAmountIn { router: Address; amountInWei: bigint }

/** Raw Lens read for a quote, with the router-allowlist check applied right
 *  here so every caller in this module gets it for free rather than having
 *  to remember to apply it themselves. */
async function lensGetAmountOut(pub: ReturnType<typeof getPublicClient>, token: Address, amountInWei: bigint, isBuy: boolean): Promise<LensAmountOut | null> {
  if (amountInWei <= 0n) return null;
  try {
    const result = (await pub.readContract({
      address: NADFUN_MAINNET.lens, abi: LENS_ABI, functionName: "getAmountOut", args: [token, amountInWei, isBuy],
    })) as readonly [Address, bigint];
    const [router, amountOutWei] = result;
    if (!ALLOWED_ROUTERS.has(router.toLowerCase())) return null;
    if (amountOutWei <= 0n) return null;
    return { router, amountOutWei };
  } catch {
    return null;
  }
}

async function lensGetAmountIn(pub: ReturnType<typeof getPublicClient>, token: Address, amountOutWei: bigint, isBuy: boolean): Promise<LensAmountIn | null> {
  if (amountOutWei <= 0n) return null;
  try {
    const result = (await pub.readContract({
      address: NADFUN_MAINNET.lens, abi: LENS_ABI, functionName: "getAmountIn", args: [token, amountOutWei, isBuy],
    })) as readonly [Address, bigint];
    const [router, amountInWei] = result;
    if (!ALLOWED_ROUTERS.has(router.toLowerCase())) return null;
    if (amountInWei <= 0n) return null;
    return { router, amountInWei };
  } catch {
    return null;
  }
}

export interface NadFunAvailability {
  /** How much of the token can still be bought on the bonding curve, human
   *  units. Only meaningful pre-graduation; null once graduated (the curve's
   *  own supply cap no longer applies). */
  availableToBuy: string;
  /** How much MON that would cost, human units. */
  requiredMon: string;
}

/**
 * Bonding-curve buy capacity for `token` — how much is left before it hits
 * its graduation target, per the official `availableBuyTokens` Lens read.
 * Returns null when the read reverts, rather than a fabricated 0.
 *
 * Caveat the caller MUST respect: a revert is not the only way this read says
 * "nothing here". The Lens answers `(0, 0)` without reverting for an address
 * it has never seen — verified live against WMON — and that is indistinguish-
 * able from the legitimate `(0, 0)` of a real curve that has sold out. Both
 * are returned as "0" on purpose, because collapsing them to null would throw
 * away the real sold-out signal, which is genuine information about a real
 * token.
 *
 * Disambiguating the two is therefore not this function's job and cannot be
 * done from its return value: gate on getNadFunStatus().recognized first, as
 * tokenIntelligence.ts does, and only then is a "0" here meaningful.
 */
export async function nadFunAvailableBuyTokens(token: Address, tokenDecimals: number): Promise<NadFunAvailability | null> {
  if (getNetwork() !== "mainnet") return null;
  const pub = getPublicClient();
  try {
    const result = (await pub.readContract({
      address: NADFUN_MAINNET.lens, abi: LENS_ABI, functionName: "availableBuyTokens", args: [token],
    })) as readonly [bigint, bigint];
    const [availableToken, requiredMon] = result;
    return { availableToBuy: formatUnits(availableToken, tokenDecimals), requiredMon: formatUnits(requiredMon, 18) };
  } catch {
    return null;
  }
}

/**
 * Bonding-curve completion, 0-100. The official ABI repo's README states
 * `getProgress()` returns basis points (10000 = 100%) — that unit
 * convention itself comes from the task brief / referenced docs, not
 * independently re-derived here (GitBook, where it's presumably spelled
 * out in prose, is unreachable from this environment — see this module's
 * top-of-file doc). The ABI only confirms the function exists and returns
 * a single uint256; the /100 scaling is trusted from that stated
 * convention. Null once graduated or unrecognized, never a fabricated 0
 * or 100.
 */
export async function getNadFunProgress(token: Address): Promise<number | null> {
  if (getNetwork() !== "mainnet") return null;
  const pub = getPublicClient();
  try {
    const bps = (await pub.readContract({
      address: NADFUN_MAINNET.lens, abi: LENS_ABI, functionName: "getProgress", args: [token],
    })) as bigint;
    return Number(bps) / 100;
  } catch {
    return null;
  }
}

export interface NadFunCurveReserves {
  /** Real (actually deposited) reserves — what the curve is genuinely
   *  holding right now, human units. */
  realMon: string;
  realToken: string;
  /** Virtual reserves — the curve's pricing-formula baseline, human units.
   *  Included because they're part of the same verified read, but real
   *  reserves are what "bonding-curve liquidity" below is computed from. */
  virtualMon: string;
  virtualToken: string;
}

/**
 * The bonding curve's actual reserves for `token`, via `BondingCurve.curves`
 * — a single, direct view read, not derived from `CurveSync` event history
 * (the brief raised `CurveSync` as one option; the curve's own current-state
 * getter is the more direct, equally-official source for CURRENT reserves,
 * and avoids scanning event logs for a value the contract already exposes
 * live). Returns null for a token the curve holds nothing for, never a
 * fabricated zero.
 *
 * "Holds nothing" is NOT signalled by a revert, which is what this function
 * originally assumed. `curves` is a plain mapping getter, so an address the
 * curve has never seen reads back as an all-zero struct rather than throwing —
 * verified live against WMON. Taken at face value that produced a confident
 * "Bonding Curve Liquidity: 0 MON / $0.00" for a token that has no bonding
 * curve at all, which is precisely the fabricated zero the line above promises
 * not to emit. An all-zero struct is therefore treated as absence: a curve
 * that genuinely exists always carries non-zero virtual reserves and a
 * non-zero target, since those are set at creation and never drain to zero.
 */
export async function getNadFunCurveReserves(token: Address, tokenDecimals: number): Promise<NadFunCurveReserves | null> {
  if (getNetwork() !== "mainnet") return null;
  const pub = getPublicClient();
  try {
    const result = (await pub.readContract({
      address: NADFUN_MAINNET.bondingCurve, abi: BONDING_CURVE_ABI, functionName: "curves", args: [token],
    })) as readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
    if (result.every((v) => v === 0n)) return null; // no curve here — see above
    const [realMonReserve, realTokenReserve, virtualMonReserve, virtualTokenReserve] = result;
    return {
      realMon: formatUnits(realMonReserve, 18),
      realToken: formatUnits(realTokenReserve, tokenDecimals),
      virtualMon: formatUnits(virtualMonReserve, 18),
      virtualToken: formatUnits(virtualTokenReserve, tokenDecimals),
    };
  } catch {
    return null;
  }
}

export interface NadFunPoolLiquidity {
  pool: Address;
  /** Real MON sitting in the graduated DEX pool right now, human units —
   *  "DEX Liquidity", deliberately labeled distinctly from bonding-curve
   *  liquidity (see this module's own doc — the brief is explicit these
   *  must never be combined into one number). */
  monReserve: string;
  tokenReserve: string;
}

/**
 * The GRADUATED DEX pool's real reserves for `token`, found via the
 * official Uniswap-V2-fork factory (`getPair(WMON, token)`) rather than
 * trusting `CurveCreate`'s `pool` field — that field is the BONDING-CURVE
 * pool, which the brief explicitly warns against showing as the active DEX
 * pool post-graduation. Returns null when no pool exists yet (pre-
 * graduation) or the pair can't be read, never a fabricated value.
 */
export async function getNadFunGraduatedPoolLiquidity(token: Address, tokenDecimals: number): Promise<NadFunPoolLiquidity | null> {
  if (getNetwork() !== "mainnet") return null;
  const pub = getPublicClient();
  try {
    const pool = (await pub.readContract({
      address: NADFUN_MAINNET.dexFactory, abi: DEX_FACTORY_ABI, functionName: "getPair", args: [NADFUN_MAINNET.wmon, token],
    })) as Address;
    if (!pool || /^0x0+$/.test(pool)) return null; // no pool exists yet
    const [reserves, token0] = await Promise.all([
      pub.readContract({ address: pool, abi: UNISWAP_V2_PAIR_ABI, functionName: "getReserves" }) as Promise<readonly [bigint, bigint, number]>,
      pub.readContract({ address: pool, abi: UNISWAP_V2_PAIR_ABI, functionName: "token0" }) as Promise<Address>,
    ]);
    const [reserve0, reserve1] = reserves;
    const wmonIsToken0 = token0.toLowerCase() === NADFUN_MAINNET.wmon.toLowerCase();
    const monReserveWei = wmonIsToken0 ? reserve0 : reserve1;
    const tokenReserveWei = wmonIsToken0 ? reserve1 : reserve0;
    return { pool, monReserve: formatUnits(monReserveWei, 18), tokenReserve: formatUnits(tokenReserveWei, tokenDecimals) };
  } catch {
    return null;
  }
}

export interface NadFunCreatorInfo {
  creator: Address;
  /** The BONDING-CURVE pool from `CurveCreate` — distinct from, and often
   *  stale after, the graduated DEX pool (see getNadFunGraduatedPoolLiquidity). */
  curvePool: Address;
  /** Unix ms the token was created, from the CurveCreate log's own block —
   *  a real on-chain timestamp, not an estimate. Null only if the block
   *  itself couldn't be read (the creator/pool are still valid in that
   *  case; this one extra field just stays honestly unavailable). */
  createdAt: number | null;
}

/** Permanent — a token's `CurveCreate` event never changes once it exists
 *  (a token is created exactly once), matching tokenRegistry.ts's own
 *  "immutable on-chain fact -> cache forever" precedent. */
const creatorCache = new Map<string, NadFunCreatorInfo | null>();

/** Test-only escape hatch, matching tokenIntelligence.ts's own
 *  clearMarketDataCache() precedent — a module-level cache otherwise
 *  leaks one test's mocked value into the next test run against the same
 *  address. Not called anywhere in application code. */
export function clearNadFunCreatorCache(): void {
  creatorCache.clear();
}

/**
 * The token's creator and original bonding-curve pool, from its ONE
 * `CurveCreate` log ever emitted — found via a topic-filtered `getLogs`
 * call (all three addresses in the event are indexed, so this is a
 * targeted lookup for this exact token, not a scan of unrelated activity).
 *
 * Best-effort and fails open, and now genuinely bounded, not just in
 * theory: this sandbox never had live RPC access to confirm whether the
 * configured provider accepts an unbounded (`fromBlock: "earliest"`) range
 * for a single indexed-topic query or requires a bounded/chunked range
 * instead — and on production RPC, it turned out to accept the range and
 * take minutes to answer rather than reject it, which is a failure mode a
 * try/catch alone does nothing for (nothing ever throws). withTimeout below
 * caps that at 5s and falls open to "no creator/pool data" past it — see
 * rpcTimeout.ts's own doc. Any failure still returns null rather than
 * fabricating creator/pool data or breaking the rest of a token lookup.
 * Cached permanently on success — the cost of a wide historical scan, if
 * the provider allows one at all, is paid at most once per token, ever.
 */
export async function getNadFunCreatorInfo(token: Address): Promise<NadFunCreatorInfo | null> {
  if (getNetwork() !== "mainnet") return null;
  const key = token.toLowerCase();
  if (creatorCache.has(key)) return creatorCache.get(key) ?? null;
  const pub = getPublicClient();
  try {
    // withTimeout, not just this function's own try/catch: an unbounded
    // (fromBlock: "earliest") getLogs range doesn't necessarily error on a
    // real provider — some accept it and just take a very long time to
    // actually scan the chain's full history, which a catch block does
    // nothing for since nothing ever throws. That was live: a token lookup
    // could take minutes instead of seconds. 5s is generous for a targeted,
    // indexed-topic query; past that, fail open exactly like every other
    // failure mode here already does, and let the cache absorb the cost of
    // a slow-but-eventually-successful scan the next time this token is
    // looked up (see withTimeout's own doc — the abandoned call can still
    // finish and this module's own cache would just never see it).
    const logs = await withTimeout(
      pub.getLogs({
        address: NADFUN_MAINNET.bondingCurve,
        event: CURVE_CREATE_EVENT,
        args: { token },
        fromBlock: "earliest",
        toBlock: "latest",
      }),
      5000,
      [],
    );
    const log = logs[0];
    if (!log || !("args" in log) || !log.args) {
      creatorCache.set(key, null);
      return null;
    }
    const args = log.args as { creator?: Address; pool?: Address };
    if (!args.creator || !args.pool) {
      creatorCache.set(key, null);
      return null;
    }
    let createdAt: number | null = null;
    if (log.blockNumber != null) {
      try {
        const block = await pub.getBlock({ blockNumber: log.blockNumber });
        createdAt = Number(block.timestamp) * 1000;
      } catch {
        /* block read failed -- creator/pool are still good, just no timestamp */
      }
    }
    const info: NadFunCreatorInfo = { creator: args.creator, curvePool: args.pool, createdAt };
    creatorCache.set(key, info);
    return info;
  } catch {
    // Provider rejected the range, RPC hiccup, or genuinely no such event —
    // all indistinguishable from here, and all handled the same honest way.
    creatorCache.set(key, null);
    return null;
  }
}

export interface NadFunRouteQuote {
  provider: "Nad.Fun";
  router: Address;
  /** Human-readable amount of the OUT side for this exact request. */
  amountOut: string;
  isBuy: boolean;
}

/**
 * Quotes buying `token` by spending `amountIn` MON (isBuy=true), or selling
 * `amountIn` of `token` for MON (isBuy=false). The router is whatever the
 * Lens's OWN read names for this exact call — never inferred from
 * `isGraduated()` alone, per this module's doc.
 */
export async function nadFunQuote(token: Address, tokenDecimals: number, amountIn: string, isBuy: boolean): Promise<NadFunRouteQuote | null> {
  if (getNetwork() !== "mainnet") return null;
  const pub = getPublicClient();
  const decimalsIn = isBuy ? 18 : tokenDecimals; // spending MON to buy, or spending the token to sell
  let amountInWei: bigint;
  try {
    amountInWei = parseUnits(normalizeDecimalString(amountIn, decimalsIn), decimalsIn);
  } catch {
    return null;
  }
  const q = await lensGetAmountOut(pub, token, amountInWei, isBuy);
  if (!q) return null;
  const decimalsOut = isBuy ? tokenDecimals : 18;
  return { provider: "Nad.Fun", router: q.router, amountOut: formatUnits(q.amountOutWei, decimalsOut), isBuy };
}

export interface NadFunExactOutQuote {
  provider: "Nad.Fun";
  router: Address;
  /** Human-readable amount of the IN side required for this exact request. */
  amountIn: string;
  isBuy: boolean;
}

/**
 * Exact-output investigation (Step 6 brief): the official Lens exposes
 * `getAmountIn(token, amountOut, isBuy)`, and both routers expose
 * `exactOutBuy`/`exactOutSell` with a verified `amountInMax` cap — unlike
 * Uniswap/Kuru's quoting primitives in this codebase (input-only), Nad.Fun's
 * ARE genuinely exact-output-capable, and this function and
 * buildNadFunExactOutBuyPlan/buildNadFunExactOutSellPlan below are real,
 * working, tested implementations against the verified ABI (calldata shape
 * and selector are 100% confirmed — see NADFUN_ROUTER_ABI's own doc).
 *
 * ONE runtime behavior could not be independently confirmed for the
 * deployed v3 router specifically: whether `exactOutBuy`'s `amountInMax`
 * (sent as `msg.value`, since the exact `amountIn` needed isn't knowable
 * until execution) gets refunded back to the caller when the actual cost
 * comes in under the cap. What was checked:
 *   - GitBook prose docs: unreachable from this sandbox (network policy).
 *   - The Monad block explorer and Sourcify, either of which would show the
 *     deployed contract's verified source directly: both also blocked by
 *     this sandbox's network policy.
 *   - Naddotfun/contracts (their actual Solidity source, `main` branch,
 *     untagged/unversioned): real code, but for a DIFFERENT, older router —
 *     its `buy`/`sell`/`exactOutBuy` all take flat parameters, not the
 *     struct-tuple shape the v3 ABI (and this module) use, so it's a
 *     different contract, not directly authoritative for v3. It DOES show
 *     the team's own established pattern for this exact situation, though:
 *     `require(msg.value >= amountInMax)`, compute the real `amountIn`,
 *     then `if (amountInMax - amountIn > 0) safeTransferNative(msg.sender,
 *     rest)` — the same WNative/fee-vault/`_swap` architecture as the v3
 *     interface, consistent with continuous evolution of one codebase by
 *     one team rather than an unrelated project.
 *   - Naddotfun/nadfun-v2-intergration (their own current V2 integration
 *     docs, ROUTER_INTEGRATION.md + abi/NadFunRouter.json — a different
 *     repo from the one above, found on a later pass): this is prose, not
 *     inferred from code. It states outright: "Exact-output native flows
 *     use `amountInMax` as `msg.value` and refund unused input," and
 *     separately, for `createWithNative`: "Excess native is refunded."
 *     The ABI confirms `exactOutBuy`/`exactOutBuyWithNative`/`exactOutSell`/
 *     `exactOutSellToNative` are real functions on that router. Checked
 *     twice independently — once asking directly about refunds, once with
 *     a neutral "quote the raw text" prompt that never mentioned refunds —
 *     because a fetch of an adjacent repo earlier in this same pass had
 *     returned content that belonged to a different repository entirely,
 *     so this was re-verified harder than the first finding above. Both
 *     passes, plus the raw ABI, agreed.
 *
 *     This is real and official, but it is still NOT the deployed v3
 *     router: V2's `NadFunRouter` is one unified contract (mainnet
 *     0x8986C8fD44eb85294A725a7e61AF35E76bA26F91) that internally routes
 *     curve-vs-DEX itself, at a different address with a different shape
 *     than v3's split BondingCurveRouter/DexRouter that the Lens contract
 *     selects between and this module actually calls. It raises the refund
 *     from "inferred from an unversioned older repo's code pattern" to
 *     "the team's own current prose documentation for the adjacent
 *     version" — a materially stronger signal of design intent — but it is
 *     still the adjacent version's documented behavior, not a confirmation
 *     of the specific v3 bytecode deployed at the addresses above.
 *
 * This is why exact-output stays out of the main flow below rather than
 * being flipped on based on that inference: the module-level functions
 * are correct and ready, but enabling them for real money is a call for a
 * session (or a person) with unblocked access to the block explorer to
 * confirm in under a minute, not something to assume from here.
 */
export async function nadFunQuoteExactOut(token: Address, tokenDecimals: number, amountOut: string, isBuy: boolean): Promise<NadFunExactOutQuote | null> {
  if (getNetwork() !== "mainnet") return null;
  const pub = getPublicClient();
  const decimalsOut = isBuy ? tokenDecimals : 18;
  let amountOutWei: bigint;
  try {
    amountOutWei = parseUnits(normalizeDecimalString(amountOut, decimalsOut), decimalsOut);
  } catch {
    return null;
  }
  const q = await lensGetAmountIn(pub, token, amountOutWei, isBuy);
  if (!q) return null;
  const decimalsIn = isBuy ? 18 : tokenDecimals;
  return { provider: "Nad.Fun", router: q.router, amountIn: formatUnits(q.amountInWei, decimalsIn), isBuy };
}

export interface NadFunPlanResult {
  steps: UnsignedStep[];
  amountOut: string;
  router: Address;
}

function assertTradable(slippage: number): void {
  if (getNetwork() !== "mainnet") throw new Error("Trading is only available on Monad mainnet right now.");
  if (!Number.isFinite(slippage) || slippage < 0 || slippage > MAX_SLIPPAGE) {
    throw new Error(`Slippage tolerance must be between 0% and ${(MAX_SLIPPAGE * 100).toFixed(0)}%.`);
  }
}

/**
 * Builds an unsigned BUY: spend `amountInMon` native MON for `token`.
 * Re-quotes fresh via the Lens (never trusts a caller-supplied quote,
 * matching this codebase's existing "always re-quote right before signing"
 * principle — see tradeQuote.ts's prepareTradeExecution) and only ever
 * targets whichever of the two hardcoded, verified router addresses the
 * Lens's OWN result names for THIS call.
 */
export async function buildNadFunBuyPlan(
  token: Address, tokenSymbol: string, tokenDecimals: number,
  amountInMon: string, slippage: number, wallet: Address,
): Promise<NadFunPlanResult> {
  assertTradable(slippage);
  const pub = getPublicClient();
  const amountInWei = parseUnits(normalizeDecimalString(amountInMon, 18), 18);
  const q = await lensGetAmountOut(pub, token, amountInWei, true);
  if (!q) throw new Error(`No active Nad.Fun trading route found for ${tokenSymbol} right now.`);

  const amountOutMin = minOutWei(q.amountOutWei, slippage);
  const data = encodeFunctionData({
    abi: NADFUN_ROUTER_ABI, functionName: "buy",
    args: [{ amountOutMin, token, to: wallet, deadline: deadline() }],
  });
  return {
    steps: [{ kind: "swap", label: `Buy ${tokenSymbol} on Nad.Fun`, tx: { to: q.router, data, value: `0x${amountInWei.toString(16)}` } }],
    amountOut: formatUnits(q.amountOutWei, tokenDecimals),
    router: q.router,
  };
}

/**
 * Builds an unsigned SELL: sell `amountInToken` of `token` for native MON.
 * The ERC-20 must be approved to whichever router the Lens names — an
 * allowance check first, an approve step only when the current on-chain
 * allowance doesn't already cover it, mirroring swap.ts's own established
 * approve-step pattern exactly (see buildUniswapPlanDirect).
 */
export async function buildNadFunSellPlan(
  token: Address, tokenSymbol: string, tokenDecimals: number,
  amountInToken: string, slippage: number, wallet: Address,
): Promise<NadFunPlanResult> {
  assertTradable(slippage);
  const pub = getPublicClient();
  const amountInWei = parseUnits(normalizeDecimalString(amountInToken, tokenDecimals), tokenDecimals);
  const q = await lensGetAmountOut(pub, token, amountInWei, false);
  if (!q) throw new Error(`No active Nad.Fun trading route found for ${tokenSymbol} right now.`);

  const amountOutMin = minOutWei(q.amountOutWei, slippage);
  const steps: UnsignedStep[] = [];

  const allowance = (await pub.readContract({
    address: token, abi: ERC20_ABI, functionName: "allowance", args: [wallet, q.router],
  })) as bigint;
  if (allowance < amountInWei) {
    steps.push({
      kind: "approve",
      label: `Approve ${amountInToken} ${tokenSymbol} for Nad.Fun`,
      tx: { to: token, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [q.router, amountInWei] }), value: "0x0" },
    });
  }

  steps.push({
    kind: "swap",
    label: `Sell ${amountInToken} ${tokenSymbol} on Nad.Fun`,
    tx: {
      to: q.router,
      data: encodeFunctionData({
        abi: NADFUN_ROUTER_ABI, functionName: "sell",
        args: [{ amountIn: amountInWei, amountOutMin, token, to: wallet, deadline: deadline() }],
      }),
      value: "0x0",
    },
  });

  return { steps, amountOut: formatUnits(q.amountOutWei, 18), router: q.router };
}

export interface NadFunExactOutPlanResult {
  steps: UnsignedStep[];
  amountIn: string;
  router: Address;
}

/** Exact-output BUY: spend up to a slippage-bounded MON cap for an EXACT
 *  amount of `token`. See nadFunQuoteExactOut's doc — verified, tested,
 *  intentionally not yet wired into the main trade flow. */
export async function buildNadFunExactOutBuyPlan(
  token: Address, tokenSymbol: string, tokenDecimals: number,
  amountOutToken: string, slippage: number, wallet: Address,
): Promise<NadFunExactOutPlanResult> {
  assertTradable(slippage);
  const pub = getPublicClient();
  const amountOutWei = parseUnits(normalizeDecimalString(amountOutToken, tokenDecimals), tokenDecimals);
  const q = await lensGetAmountIn(pub, token, amountOutWei, true);
  if (!q) throw new Error(`No active Nad.Fun trading route found for ${tokenSymbol} right now.`);

  // The cap moves the OPPOSITE direction from a minimum-out floor: slippage
  // protection here means never paying MORE than amountInMax, so the max is
  // pushed UP from the quote, not down.
  const amountInMax = (q.amountInWei * BigInt(Math.round((1 + slippage) * 1_000_000))) / 1_000_000n;
  const data = encodeFunctionData({
    abi: NADFUN_ROUTER_ABI, functionName: "exactOutBuy",
    args: [{ amountInMax, amountOut: amountOutWei, token, to: wallet, deadline: deadline() }],
  });
  return {
    steps: [{ kind: "swap", label: `Buy exactly ${amountOutToken} ${tokenSymbol} on Nad.Fun`, tx: { to: q.router, data, value: `0x${amountInMax.toString(16)}` } }],
    amountIn: formatUnits(q.amountInWei, 18),
    router: q.router,
  };
}

/** Exact-output SELL: deliver an EXACT amount of MON, selling up to a
 *  slippage-bounded cap of `token`. Same status as the buy side above. */
export async function buildNadFunExactOutSellPlan(
  token: Address, tokenSymbol: string, tokenDecimals: number,
  amountOutMon: string, slippage: number, wallet: Address,
): Promise<NadFunExactOutPlanResult> {
  assertTradable(slippage);
  const pub = getPublicClient();
  const amountOutWei = parseUnits(normalizeDecimalString(amountOutMon, 18), 18);
  const q = await lensGetAmountIn(pub, token, amountOutWei, false);
  if (!q) throw new Error(`No active Nad.Fun trading route found for ${tokenSymbol} right now.`);

  const amountInMax = (q.amountInWei * BigInt(Math.round((1 + slippage) * 1_000_000))) / 1_000_000n;
  const steps: UnsignedStep[] = [];

  const allowance = (await pub.readContract({
    address: token, abi: ERC20_ABI, functionName: "allowance", args: [wallet, q.router],
  })) as bigint;
  if (allowance < amountInMax) {
    steps.push({
      kind: "approve",
      label: `Approve ${tokenSymbol} for Nad.Fun`,
      tx: { to: token, data: encodeFunctionData({ abi: ERC20_ABI, functionName: "approve", args: [q.router, amountInMax] }), value: "0x0" },
    });
  }
  steps.push({
    kind: "swap",
    label: `Sell ${tokenSymbol} on Nad.Fun for exactly ${amountOutMon} MON`,
    tx: {
      to: q.router,
      data: encodeFunctionData({
        abi: NADFUN_ROUTER_ABI, functionName: "exactOutSell",
        args: [{ amountInMax, amountOut: amountOutWei, token, to: wallet, deadline: deadline() }],
      }),
      value: "0x0",
    },
  });
  return { steps, amountIn: formatUnits(q.amountInWei, tokenDecimals), router: q.router };
}

/** Exported for tests only — lets a test assert the exact configured
 *  addresses without duplicating them, and construct a malicious/unknown
 *  router to prove ALLOWED_ROUTERS actually rejects it. */
export const __testing = { NADFUN_MAINNET, ALLOWED_ROUTERS };
