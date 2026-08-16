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

/**
 * Identifies whether `token` is Nad.Fun-managed and which phase it's in, by
 * CONTRACT ADDRESS only — never by symbol, per this module's brief. A read
 * that reverts (the Lens doesn't know this token) is treated as "not
 * recognized", never guessed as any particular phase.
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
  try {
    const [isGraduated, isLocked] = await Promise.all([
      pub.readContract({ address: NADFUN_MAINNET.lens, abi: LENS_ABI, functionName: "isGraduated", args: [token] }) as Promise<boolean>,
      pub.readContract({ address: NADFUN_MAINNET.lens, abi: LENS_ABI, functionName: "isLocked", args: [token] }) as Promise<boolean>,
    ]);
    const status: NadFunStatusLabel = isGraduated ? "graduated" : isLocked ? "locked" : "bonding_curve";
    return { recognized: true, isGraduated, isLocked, status };
  } catch {
    return unrecognized;
  }
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

/** Bonding-curve buy capacity for `token` — how much is left before it hits
 *  its graduation target, per the official `availableBuyTokens` Lens read.
 *  Returns null when unreadable (already graduated, or not a Nad.Fun token
 *  at all) rather than a fabricated 0. */
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
    amountInWei = parseUnits(amountIn, decimalsIn);
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
 * working, tested implementations against the verified ABI.
 *
 * Deliberately NOT wired into lib/monad/tradeQuote.ts's main preview/execute
 * flow yet: that flow rejects `exact_output` once, up front, for every
 * provider (see resolveAmountInInputUnits's own doc) before routing is even
 * known, and every other provider genuinely can't do it — special-casing
 * Nad.Fun there means restructuring shared logic all providers depend on.
 * Per the brief's own "do not enable automatically", this is held at the
 * module level, verified and tested, ready for that follow-up.
 */
export async function nadFunQuoteExactOut(token: Address, tokenDecimals: number, amountOut: string, isBuy: boolean): Promise<NadFunExactOutQuote | null> {
  if (getNetwork() !== "mainnet") return null;
  const pub = getPublicClient();
  const decimalsOut = isBuy ? tokenDecimals : 18;
  let amountOutWei: bigint;
  try {
    amountOutWei = parseUnits(amountOut, decimalsOut);
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
  const amountInWei = parseUnits(amountInMon, 18);
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
  const amountInWei = parseUnits(amountInToken, tokenDecimals);
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
  const amountOutWei = parseUnits(amountOutToken, tokenDecimals);
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
  const amountOutWei = parseUnits(amountOutMon, 18);
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
