/**
 * Partner swap: native MON in, one of the partner's allowed tokens out.
 *
 * Built from the same primitives PayAI's own trades use, nothing new:
 *  - nadFunQuote / buildNadFunBuyPlan (Lens-routed, allowlisted routers,
 *    DEX-reserve fallback when the Lens is wrong about a token's phase)
 *  - quoteUniswapDirect / buildUniswapPlanDirect (QuoterV2 across fee tiers,
 *    SwapRouter02, minOutWei so a minimum never floors to zero)
 *
 * Direct venue calls only, no PayAITradeExecutor, so a partner can decode and
 * verify exactly what its user is about to sign (router, function, token,
 * recipient, minimum). Both venues are quoted; the larger output wins.
 *
 * Server-only.
 */
import "server-only";
import { isAddress, parseAbi, type Address } from "viem";
import { getNetwork, getWrappedNative } from "@/lib/monad/config";
import { getPublicClient } from "@/lib/monad/wallet";
import { buildNadFunBuyPlan, nadFunQuote } from "@/lib/monad/nadfun";
import { buildUniswapPlanDirect, MAX_PRICE_IMPACT, quoteUniswapDirect } from "@/lib/monad/swap";
import type { Partner } from "./auth";

export class PartnerSwapError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export type PartnerVenue = "nadfun" | "uniswap";

export interface PartnerSwapRequest {
  token: string;
  /** Whole MON as a decimal string, e.g. "1.5". */
  amountMon: string;
  slippageBps: number;
}

export interface PartnerQuote {
  ok: true;
  venue: PartnerVenue;
  /** Expected output, in whole tokens. */
  amountOut: string;
  /** Formatted percentage, or null when it couldn't be measured. */
  priceImpact: string | null;
  /** True when the Nad.Fun quote came from pool reserves before the DEX fee. */
  estimate: boolean;
  venues: Record<PartnerVenue, string | null>;
  quotedAt: number;
}

export interface PartnerBuild extends Omit<PartnerQuote, "venues"> {
  /** The one unsigned call to sign. value is hex wei. */
  tx: { to: string; data: string; value: string };
}

const AMOUNT_RE = /^\d{1,9}(\.\d{1,18})?$/;
const ERC20 = parseAbi(["function decimals() view returns (uint8)", "function symbol() view returns (string)"]);

const tokenInfo = new Map<string, { decimals: number; symbol: string }>();
async function readToken(token: Address) {
  const key = token.toLowerCase();
  const hit = tokenInfo.get(key);
  if (hit) return hit;
  const pub = getPublicClient();
  const [decimals, symbol] = await Promise.all([
    pub.readContract({ address: token, abi: ERC20, functionName: "decimals" }),
    pub.readContract({ address: token, abi: ERC20, functionName: "symbol" }).catch(() => "token"),
  ]);
  const info = { decimals: Number(decimals), symbol: String(symbol) };
  tokenInfo.set(key, info);
  return info;
}

/** Checks the request against the partner's own limits. Throws a 4xx on anything off. */
export function validateRequest(partner: Partner, body: unknown): PartnerSwapRequest {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const token = typeof b.token === "string" ? b.token.trim() : "";
  if (!isAddress(token)) throw new PartnerSwapError("token must be a contract address.");
  if (!partner.tokens.includes(token.toLowerCase())) throw new PartnerSwapError("This partner cannot buy that token.", 403);

  const amountMon = typeof b.amountMon === "string" ? b.amountMon.trim() : "";
  if (!AMOUNT_RE.test(amountMon) || Number(amountMon) <= 0) throw new PartnerSwapError("amountMon must be a positive decimal string.");
  if (Number(amountMon) > partner.maxMon) throw new PartnerSwapError(`The largest swap is ${partner.maxMon} MON.`);

  const slippageBps = b.slippageBps === undefined ? 100 : Number(b.slippageBps);
  if (!Number.isInteger(slippageBps) || slippageBps < 10 || slippageBps > 500) {
    throw new PartnerSwapError("slippageBps must be a whole number from 10 to 500.");
  }
  return { token, amountMon, slippageBps };
}

function impactTooHigh(impact: string | null) {
  return impact !== null && parseFloat(impact) / 100 > MAX_PRICE_IMPACT;
}

async function quotes(token: Address, decimals: number, amountMon: string) {
  const wmon = getWrappedNative();
  const [nad, uni] = await Promise.all([
    nadFunQuote(token, decimals, amountMon, true).catch(() => null),
    wmon ? quoteUniswapDirect(wmon, 18, token, decimals, amountMon).catch(() => null) : Promise.resolve(null),
  ]);
  const uniUsable = uni && !impactTooHigh(uni.priceImpact) ? uni : null;
  const nadOut = nad ? Number(nad.amountOut) : 0;
  const uniOut = uniUsable ? Number(uniUsable.amountOut) : 0;
  const best: PartnerVenue | null = nadOut === 0 && uniOut === 0 ? null : nadOut >= uniOut ? "nadfun" : "uniswap";
  return { nad, uni, uniUsable, best };
}

export async function partnerQuote(req: PartnerSwapRequest): Promise<PartnerQuote> {
  if (getNetwork() !== "mainnet") throw new PartnerSwapError("Partner swaps run on Monad mainnet only.", 503);
  const token = req.token as Address;
  const { decimals } = await readToken(token);
  const q = await quotes(token, decimals, req.amountMon);
  if (!q.best) {
    if (q.uni && !q.uniUsable) throw new PartnerSwapError("That amount would move the price too much. Try a smaller amount.");
    throw new PartnerSwapError("No route for that amount right now. Try a smaller amount or try again soon.", 404);
  }
  return {
    ok: true,
    venue: q.best,
    amountOut: q.best === "nadfun" ? q.nad!.amountOut : q.uniUsable!.amountOut,
    priceImpact: q.best === "uniswap" ? q.uniUsable!.priceImpact : null,
    estimate: q.best === "nadfun" && !!q.nad?.estimatedBeforeFees,
    venues: { nadfun: q.nad?.amountOut ?? null, uniswap: q.uni?.amountOut ?? null },
    quotedAt: Date.now(),
  };
}

/** Re-quotes, then builds the winning venue's call with `wallet` as the only recipient. */
export async function partnerBuild(req: PartnerSwapRequest, wallet: string): Promise<PartnerBuild> {
  if (!isAddress(wallet)) throw new PartnerSwapError("wallet must be an address.");
  const quote = await partnerQuote(req);
  const token = req.token as Address;
  const { decimals, symbol } = await readToken(token);
  const slippage = req.slippageBps / 10_000;

  const plan =
    quote.venue === "nadfun"
      ? await buildNadFunBuyPlan(token, symbol, decimals, req.amountMon, slippage, wallet as Address)
      : await buildUniswapPlanDirect(
          getWrappedNative()!, "MON", 18, true,
          token, symbol, decimals, false,
          req.amountMon, slippage, wallet as Address,
        );

  // MON in means no approval: exactly one swap call, or something is wrong.
  if (plan.steps.length !== 1 || plan.steps[0].kind !== "swap") {
    throw new PartnerSwapError("Could not prepare a single-step swap for that token.", 502);
  }
  return {
    ok: true,
    venue: quote.venue,
    amountOut: plan.amountOut,
    priceImpact: quote.priceImpact,
    estimate: quote.estimate,
    quotedAt: quote.quotedAt,
    tx: plan.steps[0].tx,
  };
}
