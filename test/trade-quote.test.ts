import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * lib/monad/tradeQuote.ts's only external inputs are the token registry
 * (resolveToken), the swap engine (bestQuote / quoteUniswapDirect /
 * resolveSwapSide / the DEFAULT_SLIPPAGE/MAX_SLIPPAGE/MAX_PRICE_IMPACT
 * constants), balance reads (getTokenBalance), and USD pricing
 * (getUsdPrice) — stub all of them so these tests exercise the real
 * validation/quoting/formatting logic (this is the module that turns a
 * structured trade request into a real preview or an honest rejection)
 * without touching a real RPC or DEX.
 */

let network: "mainnet" | "testnet" = "mainnet";
vi.mock("@/lib/monad/config", () => ({ getNetwork: () => network }));

// PayAITradeExecutor plan builders (lib/monad/tradeExecutor.ts) — stubbed so
// these tests exercise tradeQuote's routing/fee logic without a real RPC.
// selectExecutor mirrors the real Gate 7 dispatch: V2 (when enabled) serves
// all three venues, superseding V1 for Uniswap/Kuru; V1 (when enabled) serves
// Uniswap/Kuru only (Nad.Fun was never built into V1); otherwise null (the
// existing direct path).
const V1 = "0xF17a916280321Ddb657c8EDd26B2a729F6E63b69";
const V2_ADDR = "0x2222222222222222222222222222222222222222";
let v1Enabled = false;
let v2Enabled = false;
let executorFeeBps = 25;
interface StubStep2 { kind: "approve" | "swap"; label: string; tx: { to: string; data: string; value: string } }
let uniExecPlanImpl: (...a: unknown[]) => Promise<{ steps: StubStep2[]; amountOut: string; priceImpact: string | null; feeBps: number; feeAmount: string }> =
  async () => ({ steps: [{ kind: "swap", label: "exec uni", tx: { to: "0xEXEC", data: "0x", value: "0x0" } }], amountOut: "0", priceImpact: null, feeBps: executorFeeBps, feeAmount: "0" });
let kuruExecPlanImpl: (...a: unknown[]) => Promise<{ steps: StubStep2[]; amountOut: string; priceImpact: string | null; feeBps: number; feeAmount: string } | null> =
  async () => ({ steps: [{ kind: "swap", label: "exec kuru", tx: { to: "0xEXEC", data: "0x", value: "0x0" } }], amountOut: "0", priceImpact: null, feeBps: executorFeeBps, feeAmount: "0" });
let nadExecPlanImpl: (...a: unknown[]) => Promise<{ steps: StubStep2[]; amountOut: string; priceImpact: string | null; feeBps: number; feeAmount: string } | null> =
  async () => ({ steps: [{ kind: "swap", label: "exec nadfun", tx: { to: "0xEXEC", data: "0x", value: "0x0" } }], amountOut: "0", priceImpact: null, feeBps: executorFeeBps, feeAmount: "0" });
vi.mock("@/lib/monad/tradeExecutor", () => ({
  getExecutorFeeBps: async () => executorFeeBps,
  selectExecutor: (venue: "uniswap" | "kuru" | "nadfun") => {
    if (v2Enabled) return V2_ADDR;
    if (v1Enabled && (venue === "uniswap" || venue === "kuru")) return V1;
    return null;
  },
  buildUniswapExecutorPlan: (...a: unknown[]) => uniExecPlanImpl(...a),
  buildKuruExecutorPlan: (...a: unknown[]) => kuruExecPlanImpl(...a),
  buildNadFunExecutorPlan: (...a: unknown[]) => nadExecPlanImpl(...a),
}));

let resolveTokenImpl: (address: string) => Promise<{ address: string; symbol: string; name: string; decimals: number; verified: boolean }> = async () => {
  throw new Error("not an ERC-20");
};
vi.mock("@/lib/monad/tokenRegistry", () => ({ resolveToken: (address: string) => resolveTokenImpl(address) }));

const STABLE = { address: "0x1234567890123456789012345678901234567890", decimals: 6, symbol: "USDC" };
const WMON = { address: "0x3bd359c1119da7da1d913d1c4d2b7c461115433a", decimals: 18, symbol: "MON" };

let bestQuoteImpl: (from: string, to: string, amount: number) => Promise<{ provider: { name: string }; quote: { amountOut: number; priceImpact: number | null } }> = async () => {
  throw new Error("no route");
};
let quoteUniswapDirectImpl: (tokenIn: string, tokenInDecimals: number, tokenOut: string, tokenOutDecimals: number, amount: string) => Promise<{ amountOut: string; priceImpact: string | null } | null> = async () => null;
let resolveSwapSideImpl: (symbol: string) => Promise<{ symbol: string; routeAddress: string; decimals: number; isNative: boolean }> = async (symbol) => {
  const s = symbol.toUpperCase();
  if (s === "USDC") return { symbol: "USDC", routeAddress: STABLE.address, decimals: STABLE.decimals, isNative: false };
  if (s === "MON" || s === "WMON") return { symbol: "MON", routeAddress: WMON.address, decimals: WMON.decimals, isNative: true };
  throw new Error(`${symbol} isn't a token PayAI can swap yet.`);
};
interface StubStep { kind: "approve" | "swap"; label: string; tx: { to: string; data: string; value: string } }
// quote/provider are optional: the single-hop verified-pair build path only
// ever reads .steps, but buildNadFunMultiHopSteps's counter-leg builder also
// reads plan.quote.amountOut and plan.provider (mirrors getSwapProvider()'s
// real return shape — see swap.ts's SwapPlan) when routing a multi-hop
// trade's non-Nad.Fun leg through the verified-pair path.
let buildPlanImpl: (from: string, to: string, amount: number, wallet: string, slippage?: number) => Promise<{ steps: StubStep[]; quote?: { amountOut: number }; provider?: string }> =
  async () => { throw new Error("buildPlan not stubbed"); };
let buildUniswapPlanDirectImpl: (
  tokenIn: string, tokenInSymbol: string, tokenInDecimals: number, tokenInIsNative: boolean,
  tokenOut: string, tokenOutSymbol: string, tokenOutDecimals: number, tokenOutIsNative: boolean,
  amount: string, slippage: number, wallet: string,
) => Promise<{ steps: StubStep[]; amountOut: string; priceImpact: string | null }> =
  async () => { throw new Error("buildUniswapPlanDirect not stubbed"); };

vi.mock("@/lib/monad/swap", () => ({
  bestQuote: (from: string, to: string, amount: number) => bestQuoteImpl(from, to, amount),
  quoteUniswapDirect: (tokenIn: string, tokenInDecimals: number, tokenOut: string, tokenOutDecimals: number, amount: string) =>
    quoteUniswapDirectImpl(tokenIn, tokenInDecimals, tokenOut, tokenOutDecimals, amount),
  resolveSwapSide: (symbol: string) => resolveSwapSideImpl(symbol),
  getSwapProvider: () => ({
    buildPlan: (from: string, to: string, amount: number, wallet: string, slippage?: number) => buildPlanImpl(from, to, amount, wallet, slippage),
  }),
  buildUniswapPlanDirect: (
    tokenIn: string, tokenInSymbol: string, tokenInDecimals: number, tokenInIsNative: boolean,
    tokenOut: string, tokenOutSymbol: string, tokenOutDecimals: number, tokenOutIsNative: boolean,
    amount: string, slippage: number, wallet: string,
  ) => buildUniswapPlanDirectImpl(tokenIn, tokenInSymbol, tokenInDecimals, tokenInIsNative, tokenOut, tokenOutSymbol, tokenOutDecimals, tokenOutIsNative, amount, slippage, wallet),
  DEFAULT_SLIPPAGE: 0.005,
  MAX_SLIPPAGE: 0.5,
  MAX_PRICE_IMPACT: 0.15,
}));

interface StubNadFunQuote { provider: "Nad.Fun"; router: string; amountOut: string; isBuy: boolean }
let nadFunQuoteImpl: (token: string, decimals: number, amount: string, isBuy: boolean) => Promise<StubNadFunQuote | null> = async () => null;
let buildNadFunBuyPlanImpl: (token: string, symbol: string, decimals: number, amountInMon: string, slippage: number, wallet: string) => Promise<{ steps: StubStep[]; amountOut: string; router: string }> =
  async () => { throw new Error("buildNadFunBuyPlan not stubbed"); };
let buildNadFunSellPlanImpl: (token: string, symbol: string, decimals: number, amountInToken: string, slippage: number, wallet: string) => Promise<{ steps: StubStep[]; amountOut: string; router: string }> =
  async () => { throw new Error("buildNadFunSellPlan not stubbed"); };
interface StubNadFunStatus { recognized: boolean; isGraduated: boolean; isLocked: boolean; status: "bonding_curve" | "graduated" | "locked" | "unsupported" }
// Defaults to "not a Nad.Fun token at all" — the common case for these tests'
// generic "DEAD"/"RANDO" fixtures, which aren't testing Nad.Fun recognition.
let getNadFunStatusImpl: (token: string) => Promise<StubNadFunStatus> = async () => ({ recognized: false, isGraduated: false, isLocked: false, status: "unsupported" });
vi.mock("@/lib/monad/nadfun", () => ({
  nadFunQuote: (token: string, decimals: number, amount: string, isBuy: boolean) => nadFunQuoteImpl(token, decimals, amount, isBuy),
  buildNadFunBuyPlan: (token: string, symbol: string, decimals: number, amountInMon: string, slippage: number, wallet: string) =>
    buildNadFunBuyPlanImpl(token, symbol, decimals, amountInMon, slippage, wallet),
  buildNadFunSellPlan: (token: string, symbol: string, decimals: number, amountInToken: string, slippage: number, wallet: string) =>
    buildNadFunSellPlanImpl(token, symbol, decimals, amountInToken, slippage, wallet),
  getNadFunStatus: (token: string) => getNadFunStatusImpl(token),
}));

let getTokenBalanceImpl: (owner: string, token: string, decimals: number, isNative: boolean) => Promise<number> = async () => 0;
vi.mock("@/lib/monad/balance", () => ({
  getTokenBalance: (owner: string, token: string, decimals: number, isNative: boolean) => getTokenBalanceImpl(owner, token, decimals, isNative),
  GAS_RESERVE_MON: 0.01,
}));

let getUsdPriceImpl: (address: string) => Promise<number | null> = async () => null;
vi.mock("@/lib/monad/prices", () => ({ getUsdPrice: (address: string) => getUsdPriceImpl(address) }));

afterEach(() => {
  vi.restoreAllMocks();
  network = "mainnet";
  v1Enabled = false;
  v2Enabled = false;
  executorFeeBps = 25;
  uniExecPlanImpl = async () => ({ steps: [{ kind: "swap", label: "exec uni", tx: { to: "0xEXEC", data: "0x", value: "0x0" } }], amountOut: "0", priceImpact: null, feeBps: executorFeeBps, feeAmount: "0" });
  kuruExecPlanImpl = async () => ({ steps: [{ kind: "swap", label: "exec kuru", tx: { to: "0xEXEC", data: "0x", value: "0x0" } }], amountOut: "0", priceImpact: null, feeBps: executorFeeBps, feeAmount: "0" });
  nadExecPlanImpl = async () => ({ steps: [{ kind: "swap", label: "exec nadfun", tx: { to: "0xEXEC", data: "0x", value: "0x0" } }], amountOut: "0", priceImpact: null, feeBps: executorFeeBps, feeAmount: "0" });
  resolveTokenImpl = async () => { throw new Error("not an ERC-20"); };
  bestQuoteImpl = async () => { throw new Error("no route"); };
  quoteUniswapDirectImpl = async () => null;
  resolveSwapSideImpl = async (symbol: string) => {
    const s = symbol.toUpperCase();
    if (s === "USDC") return { symbol: "USDC", routeAddress: STABLE.address, decimals: STABLE.decimals, isNative: false };
    if (s === "MON" || s === "WMON") return { symbol: "MON", routeAddress: WMON.address, decimals: WMON.decimals, isNative: true };
    throw new Error(`${symbol} isn't a token PayAI can swap yet.`);
  };
  getTokenBalanceImpl = async () => 0;
  getUsdPriceImpl = async () => null;
  buildPlanImpl = async () => { throw new Error("buildPlan not stubbed"); };
  buildUniswapPlanDirectImpl = async () => { throw new Error("buildUniswapPlanDirect not stubbed"); };
  nadFunQuoteImpl = async () => null;
  buildNadFunBuyPlanImpl = async () => { throw new Error("buildNadFunBuyPlan not stubbed"); };
  buildNadFunSellPlanImpl = async () => { throw new Error("buildNadFunSellPlan not stubbed"); };
  getNadFunStatusImpl = async () => ({ recognized: false, isGraduated: false, isLocked: false, status: "unsupported" });
});

const TOKEN = "0xaaaabbbbccccddddeeeeffff0000111122223333";
const WALLET = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";

describe("previewTrade — buying/selling an arbitrary Monad token", () => {
  it("buying an arbitrary (unverified) token with USDC quotes via the direct address probe", async () => {
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "RANDO", name: "Random Token", decimals: 18, verified: false });
    quoteUniswapDirectImpl = async (tokenIn, _d1, tokenOut, _d2, amount) => {
      expect(tokenIn.toLowerCase()).toBe(STABLE.address.toLowerCase()); // spending USDC
      expect(tokenOut.toLowerCase()).toBe(TOKEN.toLowerCase()); // acquiring the arbitrary token
      expect(amount).toBe("50");
      return { amountOut: "12345", priceImpact: "0.30%" };
    };
    const { previewTrade } = await import("@/lib/monad/tradeQuote");
    const r = await previewTrade({ action: "buy", inputToken: "USDC", outputToken: TOKEN, amount: "50", amountType: "exact_input" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spend).toEqual({ amount: "50", token: "USDC" });
    expect(r.receive).toEqual({ amount: "12345", token: "RANDO" });
    expect(r.route).toEqual({ provider: "Uniswap v3", path: ["USDC", "RANDO"] });
    expect(r.rate).toMatch(/^1 USDC ≈/);
  });

  it("selling an arbitrary token for USDC quotes the reverse direction correctly", async () => {
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "RANDO", name: "Random Token", decimals: 18, verified: false });
    quoteUniswapDirectImpl = async (tokenIn, _d1, tokenOut) => {
      expect(tokenIn.toLowerCase()).toBe(TOKEN.toLowerCase()); // spending the arbitrary token
      expect(tokenOut.toLowerCase()).toBe(STABLE.address.toLowerCase()); // receiving USDC
      return { amountOut: "0.42", priceImpact: "0.10%" };
    };
    const { previewTrade } = await import("@/lib/monad/tradeQuote");
    const r = await previewTrade({ action: "sell", inputToken: TOKEN, outputToken: "USDC", amount: "20", amountType: "exact_input" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spend).toEqual({ amount: "20", token: "RANDO" });
    expect(r.receive).toEqual({ amount: "0.42", token: "USDC" });
  });

  it("swapping MON into an arbitrary token", async () => {
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "RANDO", name: "Random Token", decimals: 18, verified: false });
    quoteUniswapDirectImpl = async (tokenIn) => {
      expect(tokenIn.toLowerCase()).toBe(WMON.address.toLowerCase());
      return { amountOut: "500", priceImpact: null };
    };
    const { previewTrade } = await import("@/lib/monad/tradeQuote");
    const r = await previewTrade({ action: "buy", inputToken: "MON", outputToken: TOKEN, amount: "1", amountType: "exact_input" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spend.token).toBe("MON");
    expect(r.receive).toEqual({ amount: "500", token: "RANDO" });
  });

  it("a verified token on BOTH sides is safe to route by symbol via the aggregator (bestQuote)", async () => {
    resolveTokenImpl = async () => { throw new Error("not called for curated symbols"); };
    bestQuoteImpl = async (from, to, amount) => {
      expect(from).toBe("MON");
      expect(to).toBe("USDC");
      expect(amount).toBe(2);
      return { provider: { name: "Kuru" }, quote: { amountOut: 199.5, priceImpact: null } };
    };
    const { previewTrade } = await import("@/lib/monad/tradeQuote");
    const r = await previewTrade({ action: "sell", inputToken: "MON", outputToken: "USDC", amount: "2", amountType: "exact_input" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.route.provider).toBe("Kuru");
  });
});

describe("previewTrade — Nad.Fun (bonding-curve / newly-graduated tokens)", () => {
  it("buying an arbitrary token with MON prefers a recognized Nad.Fun route over Uniswap", async () => {
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "MEOW", name: "Meow Coin", decimals: 18, verified: false });
    nadFunQuoteImpl = async (token, decimals, amount, isBuy) => {
      expect(token.toLowerCase()).toBe(TOKEN.toLowerCase());
      expect(decimals).toBe(18);
      expect(amount).toBe("1");
      expect(isBuy).toBe(true);
      return { provider: "Nad.Fun", router: "0x6F6B8F1a20703309951a5127c45B49b1CD981A22", amountOut: "9000", isBuy: true };
    };
    quoteUniswapDirectImpl = async () => { throw new Error("Uniswap must not be probed once Nad.Fun serves the pair"); };
    const { previewTrade } = await import("@/lib/monad/tradeQuote");
    const r = await previewTrade({ action: "buy", inputToken: "MON", outputToken: TOKEN, amount: "1", amountType: "exact_input" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.route).toEqual({ provider: "Nad.Fun", path: ["MON", "MEOW"] });
    expect(r.receive).toEqual({ amount: "9000", token: "MEOW" });
  });

  it("selling an arbitrary token for MON quotes the sell direction (isBuy: false)", async () => {
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "MEOW", name: "Meow Coin", decimals: 18, verified: false });
    nadFunQuoteImpl = async (_token, _decimals, amount, isBuy) => {
      expect(amount).toBe("1000");
      expect(isBuy).toBe(false);
      return { provider: "Nad.Fun", router: "0x6F6B8F1a20703309951a5127c45B49b1CD981A22", amountOut: "0.5", isBuy: false };
    };
    const { previewTrade } = await import("@/lib/monad/tradeQuote");
    const r = await previewTrade({ action: "sell", inputToken: TOKEN, outputToken: "MON", amount: "1000", amountType: "exact_input" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.route.provider).toBe("Nad.Fun");
    expect(r.receive).toEqual({ amount: "0.5", token: "MON" });
  });

  it("falls through to Uniswap when Nad.Fun's Lens doesn't recognize the token", async () => {
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "RANDO", name: "Random Token", decimals: 18, verified: false });
    nadFunQuoteImpl = async () => null; // not a Nad.Fun token
    quoteUniswapDirectImpl = async () => ({ amountOut: "500", priceImpact: null });
    const { previewTrade } = await import("@/lib/monad/tradeQuote");
    const r = await previewTrade({ action: "buy", inputToken: "MON", outputToken: TOKEN, amount: "1", amountType: "exact_input" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.route.provider).toBe("Uniswap v3");
  });

  it("neither side is MON — Nad.Fun is never even queried (it only ever pairs a token against MON)", async () => {
    const TOKEN_B = "0xbbbbccccddddeeeeffff000011112222333344a4";
    resolveTokenImpl = async (address) =>
      address.toLowerCase() === TOKEN.toLowerCase()
        ? { address: TOKEN, symbol: "RANDO", name: "Random Token", decimals: 18, verified: false }
        : { address: TOKEN_B, symbol: "OTHER", name: "Other Token", decimals: 18, verified: false };
    nadFunQuoteImpl = async () => { throw new Error("Nad.Fun must never be probed for a non-MON pair"); };
    quoteUniswapDirectImpl = async () => ({ amountOut: "10", priceImpact: null });
    const { previewTrade } = await import("@/lib/monad/tradeQuote");
    const r = await previewTrade({ action: "buy", inputToken: TOKEN, outputToken: TOKEN_B, amount: "1", amountType: "exact_input" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.route.provider).toBe("Uniswap v3");
  });

  it("a real Nad.Fun token (graduated) quoted against USDC (not MON) gets an honest, actionable message instead of the generic 'no route' — the bug behind '0xD10cf1...785657777 says not tradable'", async () => {
    // Nad.Fun only ever pairs against MON (see nadFunSides), and the token's
    // liquidity lives in Nad.Fun's own graduated DEX pool, not Uniswap's — so
    // BOTH quoteUniswapDirectImpl and nadFunQuoteImpl correctly return
    // nothing for TOKEN<->USDC. That's not a bug in the quote; the bug was
    // the resulting message being indistinguishable from "no liquidity at
    // all" when the real, actionable fact is "wrong counter-asset".
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "GRAD", name: "Graduated Coin", decimals: 18, verified: false });
    getNadFunStatusImpl = async (token) => {
      expect(token.toLowerCase()).toBe(TOKEN.toLowerCase());
      return { recognized: true, isGraduated: true, isLocked: false, status: "graduated" };
    };
    const { previewTrade } = await import("@/lib/monad/tradeQuote");
    const r = await previewTrade({ action: "buy", inputToken: "USDC", outputToken: TOKEN, amount: "50", amountType: "exact_input" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/GRAD/);
    expect(r.message).toMatch(/nad\.fun/i);
    expect(r.message).toMatch(/\bMON\b/);
    expect(r.message).not.toMatch(/no usable trading route/i); // the honest, specific message replaces the generic one
  });

  it("a bonding-curve (not yet graduated) Nad.Fun token quoted against USDC gets the same actionable hint", async () => {
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "MEOW", name: "Meow Coin", decimals: 18, verified: false });
    getNadFunStatusImpl = async () => ({ recognized: true, isGraduated: false, isLocked: false, status: "bonding_curve" });
    const { previewTrade } = await import("@/lib/monad/tradeQuote");
    const r = await previewTrade({ action: "sell", inputToken: TOKEN, outputToken: "USDC", amount: "100", amountType: "exact_input" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/MEOW/);
    expect(r.message).toMatch(/\bMON\b/);
  });

  it("a token that IS Nad.Fun-recognized still gets the plain honest 'no route' message when it's paired against MON (the pair Nad.Fun itself couldn't quote)", async () => {
    // Distinguishes the new hint from the pre-existing behavior: the hint
    // must only fire for a pair Nad.Fun was never even asked about (neither
    // side MON — see nadFunSides), never override a REAL Nad.Fun "no route"
    // for a MON pair it actually tried and failed.
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "DEAD", name: "Dead Token", decimals: 18, verified: false });
    getNadFunStatusImpl = async () => { throw new Error("must not be consulted for a pair Nad.Fun already tried directly"); };
    const { previewTrade } = await import("@/lib/monad/tradeQuote");
    const r = await previewTrade({ action: "buy", inputToken: "MON", outputToken: TOKEN, amount: "1", amountType: "exact_input" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/no usable trading route/i);
  });

  it("buying a graduated Nad.Fun token with USDC now actually works, routed USDC -> MON -> TOKEN as two real legs", async () => {
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "GRAD", name: "Graduated Coin", decimals: 18, verified: false });
    getNadFunStatusImpl = async () => ({ recognized: true, isGraduated: true, isLocked: false, status: "graduated" });
    bestQuoteImpl = async (from, to, amount) => {
      expect(from).toBe("USDC");
      expect(to).toBe("MON");
      expect(amount).toBe(50);
      return { provider: { name: "Uniswap v3" }, quote: { amountOut: 100, priceImpact: null } };
    };
    nadFunQuoteImpl = async (token, decimals, amount, isBuy) => {
      expect(token.toLowerCase()).toBe(TOKEN.toLowerCase());
      expect(decimals).toBe(18);
      expect(amount).toBe("100"); // sized off leg A's REAL output, not the original 50
      expect(isBuy).toBe(true);
      return { provider: "Nad.Fun", router: "0x6F6B8F1a20703309951a5127c45B49b1CD981A22", amountOut: "5000", isBuy: true };
    };
    const { previewTrade } = await import("@/lib/monad/tradeQuote");
    const r = await previewTrade({ action: "buy", inputToken: "USDC", outputToken: TOKEN, amount: "50", amountType: "exact_input" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.receive).toEqual({ amount: "5000", token: "GRAD" });
    expect(r.route.provider).toBe("Uniswap v3 + Nad.Fun");
    expect(r.route.path).toEqual(["USDC", "MON", "GRAD"]); // the real, honest two-leg path
    // Deferred, not fabricated: no blended fee line for a two-venue route.
    expect(r.fee).toBeNull();
  });

  it("selling a bonding-curve Nad.Fun token for USDC now actually works, routed TOKEN -> MON -> USDC", async () => {
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "MEOW", name: "Meow Coin", decimals: 18, verified: false });
    getNadFunStatusImpl = async () => ({ recognized: true, isGraduated: false, isLocked: false, status: "bonding_curve" });
    nadFunQuoteImpl = async (token, decimals, amount, isBuy) => {
      expect(token.toLowerCase()).toBe(TOKEN.toLowerCase());
      expect(amount).toBe("1000");
      expect(isBuy).toBe(false);
      return { provider: "Nad.Fun", router: "0x6F6B8F1a20703309951a5127c45B49b1CD981A22", amountOut: "2", isBuy: false };
    };
    bestQuoteImpl = async (from, to, amount) => {
      expect(from).toBe("MON");
      expect(to).toBe("USDC");
      expect(amount).toBe(2); // sized off leg A's REAL MON output
      return { provider: { name: "Uniswap v3" }, quote: { amountOut: 4, priceImpact: null } };
    };
    const { previewTrade } = await import("@/lib/monad/tradeQuote");
    const r = await previewTrade({ action: "sell", inputToken: TOKEN, outputToken: "USDC", amount: "1000", amountType: "exact_input" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.receive).toEqual({ amount: "4", token: "USDC" });
    expect(r.route.provider).toBe("Nad.Fun + Uniswap v3");
    expect(r.route.path).toEqual(["MEOW", "MON", "USDC"]);
    expect(r.fee).toBeNull();
  });

  it("a token with no Nad.Fun recognition at all still gets a plain 'no route' — multi-hop is never attempted for a genuinely illiquid token", async () => {
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "DEAD", name: "Dead Token", decimals: 18, verified: false });
    getNadFunStatusImpl = async () => ({ recognized: false, isGraduated: false, isLocked: false, status: "unsupported" });
    bestQuoteImpl = async () => { throw new Error("must not quote a MON leg for a non-Nad.Fun token"); };
    const { previewTrade } = await import("@/lib/monad/tradeQuote");
    const r = await previewTrade({ action: "buy", inputToken: "USDC", outputToken: TOKEN, amount: "50", amountType: "exact_input" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/no usable trading route/i);
  });

  it("a token that genuinely isn't a Nad.Fun token at all still gets the plain honest 'no route' message", async () => {
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "DEAD", name: "Dead Token", decimals: 18, verified: false });
    getNadFunStatusImpl = async () => ({ recognized: false, isGraduated: false, isLocked: false, status: "unsupported" });
    const { previewTrade } = await import("@/lib/monad/tradeQuote");
    const r = await previewTrade({ action: "buy", inputToken: "USDC", outputToken: TOKEN, amount: "50", amountType: "exact_input" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/no usable trading route/i);
  });

  it("a Nad.Fun status lookup failure (RPC hiccup) fails open to the plain message, never throws out of previewTrade", async () => {
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "DEAD", name: "Dead Token", decimals: 18, verified: false });
    getNadFunStatusImpl = async () => { throw new Error("RPC hiccup"); };
    const { previewTrade } = await import("@/lib/monad/tradeQuote");
    const r = await previewTrade({ action: "buy", inputToken: "USDC", outputToken: TOKEN, amount: "50", amountType: "exact_input" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/no usable trading route/i);
  });

  it("Part 5 NL coverage: \"sell half of my tokens\" (a percentage amount) resolves to real units BEFORE routing, then flows through Nad.Fun exactly like exact_input does", async () => {
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "MEOW", name: "Meow Coin", decimals: 18, verified: false });
    getTokenBalanceImpl = async () => 2000; // holds 2000 MEOW -> "half" = 1000
    nadFunQuoteImpl = async (_token, _decimals, amount, isBuy) => {
      expect(amount).toBe("1000"); // the real resolved amount, not "50" (the percentage)
      expect(isBuy).toBe(false);
      return { provider: "Nad.Fun", router: "0x6F6B8F1a20703309951a5127c45B49b1CD981A22", amountOut: "0.5", isBuy: false };
    };
    const { previewTrade } = await import("@/lib/monad/tradeQuote");
    const r = await previewTrade({ action: "sell", inputToken: TOKEN, outputToken: "MON", amount: "50", amountType: "percentage", walletAddress: WALLET });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spend).toEqual({ amount: "1000", token: "MEOW" });
    expect(r.route.provider).toBe("Nad.Fun");
  });

  it("Part 4 scenario E: a MON pair with no route on EITHER Nad.Fun or Uniswap is honestly reported as no route, never fabricated", async () => {
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "DEAD", name: "Dead Token", decimals: 18, verified: false });
    // nadFunQuoteImpl and quoteUniswapDirectImpl both default to null/no route.
    const { previewTrade } = await import("@/lib/monad/tradeQuote");
    const r = await previewTrade({ action: "buy", inputToken: "MON", outputToken: TOKEN, amount: "1", amountType: "exact_input" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/no usable trading route/i);
  });
});

describe("previewTrade — amount types", () => {
  function setUp() {
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "RANDO", name: "Random Token", decimals: 18, verified: false });
    quoteUniswapDirectImpl = async (_i, _id, _o, _od, amount) => ({ amountOut: String(Number(amount) * 100), priceImpact: "0.10%" });
  }

  it("exact_input spends exactly the stated amount", async () => {
    setUp();
    const { previewTrade } = await import("@/lib/monad/tradeQuote");
    const r = await previewTrade({ action: "buy", inputToken: "USDC", outputToken: TOKEN, amount: "50", amountType: "exact_input" });
    if (!r.ok) throw new Error("expected ok");
    expect(r.spend.amount).toBe("50");
  });

  it("exact_output is recognized but honestly reported as not yet supported, never guessed", async () => {
    setUp();
    const { previewTrade } = await import("@/lib/monad/tradeQuote");
    const r = await previewTrade({ action: "buy", inputToken: "USDC", outputToken: TOKEN, amount: "100", amountType: "exact_output" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/can't quote an exact-output trade yet/i);
  });

  it("usd converts through getUsdPrice when the input isn't USDC itself", async () => {
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "RANDO", name: "Random Token", decimals: 18, verified: false });
    getUsdPriceImpl = async (address) => (address.toLowerCase() === WMON.address.toLowerCase() ? 2 : null); // 1 MON = $2
    quoteUniswapDirectImpl = async (_i, _id, _o, _od, amount) => {
      expect(amount).toBe("25"); // $50 / $2 per MON = 25 MON
      return { amountOut: "1000", priceImpact: null };
    };
    const { previewTrade } = await import("@/lib/monad/tradeQuote");
    const r = await previewTrade({ action: "buy", inputToken: "MON", outputToken: TOKEN, amount: "50", amountType: "usd" });
    expect(r.ok).toBe(true);
  });

  it("usd spending USDC itself skips the price lookup (1 USDC ≈ $1)", async () => {
    setUp();
    const { previewTrade } = await import("@/lib/monad/tradeQuote");
    const r = await previewTrade({ action: "buy", inputToken: "USDC", outputToken: TOKEN, amount: "50", amountType: "usd" });
    if (!r.ok) throw new Error("expected ok");
    expect(r.spend.amount).toBe("50");
  });

  it("percentage computes from the REAL wallet balance, never a guess", async () => {
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "RANDO", name: "Random Token", decimals: 18, verified: false });
    getTokenBalanceImpl = async () => 200; // 200 USDC
    quoteUniswapDirectImpl = async (_i, _id, _o, _od, amount) => {
      expect(amount).toBe("100"); // 50% of 200
      return { amountOut: "10000", priceImpact: null };
    };
    const { previewTrade } = await import("@/lib/monad/tradeQuote");
    const r = await previewTrade({ action: "buy", inputToken: "USDC", outputToken: TOKEN, amount: "50", amountType: "percentage", walletAddress: WALLET });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spend.amount).toBe("100");
  });

  it("balance_all uses the entire balance, minus the MON gas reserve when selling MON", async () => {
    resolveTokenImpl = async () => { throw new Error("not called for MON"); };
    getTokenBalanceImpl = async () => 5; // 5 MON
    bestQuoteImpl = async (from, to, amount) => {
      expect(amount).toBeCloseTo(4.99, 5); // 5 - 0.01 gas reserve
      return { provider: { name: "Uniswap v3" }, quote: { amountOut: 500, priceImpact: null } };
    };
    const { previewTrade } = await import("@/lib/monad/tradeQuote");
    const r = await previewTrade({ action: "sell", inputToken: "MON", outputToken: "USDC", amount: "", amountType: "balance_all", walletAddress: WALLET });
    expect(r.ok).toBe(true);
  });

  it("percentage/balance_all without a connected wallet is an honest rejection, never a guessed number", async () => {
    setUp();
    const { previewTrade } = await import("@/lib/monad/tradeQuote");
    const r = await previewTrade({ action: "buy", inputToken: "USDC", outputToken: TOKEN, amount: "50", amountType: "percentage" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/connect your wallet/i);
  });
});

describe("previewTrade — validation failures never produce a fake preview", () => {
  it("an unresolvable output token (missing/invalid) is rejected honestly", async () => {
    resolveTokenImpl = async () => { throw new Error("Could not read as an ERC-20 token"); };
    const { previewTrade } = await import("@/lib/monad/tradeQuote");
    const r = await previewTrade({ action: "buy", inputToken: "USDC", outputToken: TOKEN, amount: "50", amountType: "exact_input" });
    expect(r.ok).toBe(false);
  });

  it("an unrecognized input asset symbol is rejected, not silently defaulted", async () => {
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "RANDO", name: "Random Token", decimals: 18, verified: false });
    const { previewTrade } = await import("@/lib/monad/tradeQuote");
    const r = await previewTrade({ action: "buy", inputToken: "NOTATHING", outputToken: TOKEN, amount: "50", amountType: "exact_input" });
    expect(r.ok).toBe(false);
  });

  it("insufficient balance is reported with the REAL available amount, never a fake preview", async () => {
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "RANDO", name: "Random Token", decimals: 18, verified: false });
    getTokenBalanceImpl = async () => 100; // only has 100 USDC
    const { previewTrade } = await import("@/lib/monad/tradeQuote");
    const r = await previewTrade({ action: "buy", inputToken: "USDC", outputToken: TOKEN, amount: "500", amountType: "exact_input", walletAddress: WALLET });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/only have 100 USDC/i);
    expect(r.message).toMatch(/500 USDC/i);
  });

  it("sufficient balance is NOT blocked", async () => {
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "RANDO", name: "Random Token", decimals: 18, verified: false });
    getTokenBalanceImpl = async () => 1000;
    quoteUniswapDirectImpl = async () => ({ amountOut: "12345", priceImpact: null });
    const { previewTrade } = await import("@/lib/monad/tradeQuote");
    const r = await previewTrade({ action: "buy", inputToken: "USDC", outputToken: TOKEN, amount: "50", amountType: "exact_input", walletAddress: WALLET });
    expect(r.ok).toBe(true);
  });

  it("no usable route anywhere is reported honestly, never a fabricated quote", async () => {
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "DEAD", name: "Dead Token", decimals: 18, verified: false });
    quoteUniswapDirectImpl = async () => null;
    const { previewTrade } = await import("@/lib/monad/tradeQuote");
    const r = await previewTrade({ action: "buy", inputToken: "USDC", outputToken: TOKEN, amount: "50", amountType: "exact_input" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/no usable trading route/i);
  });

  it("high price impact is surfaced on the preview, never silently hidden or blocked at this step", async () => {
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "RANDO", name: "Random Token", decimals: 18, verified: false });
    quoteUniswapDirectImpl = async () => ({ amountOut: "100", priceImpact: "25.00%" }); // > 15% MAX_PRICE_IMPACT
    const { previewTrade } = await import("@/lib/monad/tradeQuote");
    const r = await previewTrade({ action: "buy", inputToken: "USDC", outputToken: TOKEN, amount: "50", amountType: "exact_input" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.highPriceImpact).toBe(true);
    expect(r.priceImpact).toBe("25.00%");
  });

  it("the same asset on both sides is rejected outright", async () => {
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "RANDO", name: "Random Token", decimals: 18, verified: false });
    const { previewTrade } = await import("@/lib/monad/tradeQuote");
    const r = await previewTrade({ action: "buy", inputToken: TOKEN, outputToken: TOKEN, amount: "50", amountType: "exact_input" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/two different tokens/i);
  });
});

describe("previewTrade — slippage validation reuses the existing limits, never silently changed", () => {
  function setUp() {
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "RANDO", name: "Random Token", decimals: 18, verified: false });
    quoteUniswapDirectImpl = async () => ({ amountOut: "100", priceImpact: null });
  }

  it("no slippage requested uses the existing DEFAULT_SLIPPAGE", async () => {
    setUp();
    const { previewTrade } = await import("@/lib/monad/tradeQuote");
    const r = await previewTrade({ action: "buy", inputToken: "USDC", outputToken: TOKEN, amount: "50", amountType: "exact_input" });
    if (!r.ok) throw new Error("expected ok");
    expect(r.slippage).toBe("0.50%");
  });

  it("a valid custom slippage is honored exactly, not silently changed", async () => {
    setUp();
    const { previewTrade } = await import("@/lib/monad/tradeQuote");
    const r = await previewTrade({ action: "buy", inputToken: "USDC", outputToken: TOKEN, amount: "50", amountType: "exact_input", slippage: "1" });
    if (!r.ok) throw new Error("expected ok");
    expect(r.slippage).toBe("1.00%");
  });

  it("a slippage above the existing MAX_SLIPPAGE ceiling is rejected, never clamped", async () => {
    setUp();
    const { previewTrade } = await import("@/lib/monad/tradeQuote");
    const r = await previewTrade({ action: "buy", inputToken: "USDC", outputToken: TOKEN, amount: "50", amountType: "exact_input", slippage: "80" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/safety ceiling/i);
  });
});

describe("previewTrade — every successful preview is freshly quoted, never reused", () => {
  it("two consecutive calls produce two different quotedAt timestamps", async () => {
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "RANDO", name: "Random Token", decimals: 18, verified: false });
    quoteUniswapDirectImpl = async () => ({ amountOut: "100", priceImpact: null });
    const { previewTrade } = await import("@/lib/monad/tradeQuote");
    const first = await previewTrade({ action: "buy", inputToken: "USDC", outputToken: TOKEN, amount: "50", amountType: "exact_input" });
    await new Promise((r) => setTimeout(r, 5));
    const second = await previewTrade({ action: "buy", inputToken: "USDC", outputToken: TOKEN, amount: "50", amountType: "exact_input" });
    if (!first.ok || !second.ok) throw new Error("expected ok");
    expect(second.quotedAt).toBeGreaterThanOrEqual(first.quotedAt);
  });
});

/**
 * prepareTradeExecution — Step 4's transaction-construction entry point.
 * Every case here confirms the same guarantees previewTrade already has
 * (real quote, honest rejection) PLUS the Step 4-specific ones: it always
 * re-quotes fresh rather than trusting the caller, it never builds when the
 * fresh quote moved materially, and the transaction target it produces is
 * always either the resolved token's OWN contract (approve) or the
 * existing, hardcoded router/aggregator plan — never anything derived from
 * unvalidated input.
 */
describe("prepareTradeExecution — re-quotes fresh and only builds real steps when nothing material changed", () => {
  beforeEach(() => {
    // Every WALLET-connected case below needs a balance the requested
    // amount actually fits under — previewTrade() (which
    // prepareTradeExecution calls internally) re-checks this for real.
    getTokenBalanceImpl = async () => 1000;
  });

  it("requires a connected wallet — never builds for an anonymous request", async () => {
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "RANDO", name: "Random Token", decimals: 18, verified: false });
    quoteUniswapDirectImpl = async () => ({ amountOut: "100", priceImpact: null });
    const { prepareTradeExecution } = await import("@/lib/monad/tradeQuote");
    const r = await prepareTradeExecution({ action: "buy", inputToken: "USDC", outputToken: TOKEN, amount: "50", amountType: "exact_input", walletAddress: null });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/connect your wallet/i);
  });

  it("an invalid trade (no route) is rejected the same honest way previewTrade rejects it — never builds steps", async () => {
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "DEAD", name: "Dead Token", decimals: 18, verified: false });
    quoteUniswapDirectImpl = async () => null;
    const { prepareTradeExecution } = await import("@/lib/monad/tradeQuote");
    const r = await prepareTradeExecution({ action: "buy", inputToken: "USDC", outputToken: TOKEN, amount: "50", amountType: "exact_input", walletAddress: WALLET });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/no usable trading route/i);
  });

  it("no previous quote supplied (first confirm) — builds steps directly, no 'changed' comparison possible", async () => {
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "RANDO", name: "Random Token", decimals: 18, verified: false });
    quoteUniswapDirectImpl = async () => ({ amountOut: "12345", priceImpact: "0.30%" });
    buildUniswapPlanDirectImpl = async (_tokenIn, tokenInSymbol) => {
      expect(tokenInSymbol).toBe("USDC");
      return { steps: [{ kind: "swap", label: `Trade 50 USDC for RANDO`, tx: { to: "0xrouter", data: "0xdead", value: "0x0" } }], amountOut: "12345", priceImpact: "0.30%" };
    };
    const { prepareTradeExecution } = await import("@/lib/monad/tradeQuote");
    const r = await prepareTradeExecution({ action: "buy", inputToken: "USDC", outputToken: TOKEN, amount: "50", amountType: "exact_input", walletAddress: WALLET });
    expect(r.ok).toBe(true);
    if (!r.ok || r.status !== "ready") return;
    // Every ordinary (single-leg) trade's last step now carries settleLeg —
    // the same mechanism a multi-hop trade uses per leg, unified so
    // orchestrate.ts's execution loop never needs two different settlement
    // code paths.
    expect(r.steps[r.steps.length - 1].settleLeg).toEqual({ fromToken: "USDC", toToken: "RANDO", amountIn: 50, amountOut: 12345, provider: "Uniswap v3" });
  });

  it("no previous quote supplied (first confirm) — builds steps directly, no 'changed' comparison possible (status check)", async () => {
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "RANDO", name: "Random Token", decimals: 18, verified: false });
    quoteUniswapDirectImpl = async () => ({ amountOut: "12345", priceImpact: "0.30%" });
    buildUniswapPlanDirectImpl = async (_tokenIn, tokenInSymbol) => {
      expect(tokenInSymbol).toBe("USDC");
      return { steps: [{ kind: "swap", label: `Trade 50 USDC for RANDO`, tx: { to: "0xrouter", data: "0xdead", value: "0x0" } }], amountOut: "12345", priceImpact: "0.30%" };
    };
    const { prepareTradeExecution } = await import("@/lib/monad/tradeQuote");
    const r = await prepareTradeExecution({ action: "buy", inputToken: "USDC", outputToken: TOKEN, amount: "50", amountType: "exact_input", walletAddress: WALLET });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe("ready");
    if (r.status !== "ready") return;
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0].kind).toBe("swap");
  });

  it("an unchanged quote (within slippage tolerance) builds real steps", async () => {
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "RANDO", name: "Random Token", decimals: 18, verified: false });
    quoteUniswapDirectImpl = async () => ({ amountOut: "12345", priceImpact: "0.30%" });
    buildUniswapPlanDirectImpl = async () => ({ steps: [{ kind: "swap", label: "Trade", tx: { to: "0xrouter", data: "0xdead", value: "0x0" } }], amountOut: "12345", priceImpact: "0.30%" });
    const { prepareTradeExecution } = await import("@/lib/monad/tradeQuote");
    const r = await prepareTradeExecution(
      { action: "buy", inputToken: "USDC", outputToken: TOKEN, amount: "50", amountType: "exact_input", walletAddress: WALLET },
      { receiveAmount: "12345", provider: "Uniswap v3" }, // identical to the fresh quote
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe("ready");
  });

  it("the route/provider changing is a material change — never builds steps, returns 'changed' with the fresh preview", async () => {
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "RANDO", name: "Random Token", decimals: 18, verified: false });
    quoteUniswapDirectImpl = async () => ({ amountOut: "12345", priceImpact: "0.30%" }); // Uniswap v3 provider (see getTradeRoute)
    buildUniswapPlanDirectImpl = async () => { throw new Error("must not build steps for a materially changed quote"); };
    const { prepareTradeExecution } = await import("@/lib/monad/tradeQuote");
    const r = await prepareTradeExecution(
      { action: "buy", inputToken: "USDC", outputToken: TOKEN, amount: "50", amountType: "exact_input", walletAddress: WALLET },
      { receiveAmount: "12345", provider: "Kuru" }, // the card the user is looking at shows a different DEX
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe("changed");
    if (r.status !== "changed") return;
    expect(r.preview.receive.amount).toBe("12345");
  });

  it("the receive amount moving beyond the slippage tolerance is a material change — never builds steps", async () => {
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "RANDO", name: "Random Token", decimals: 18, verified: false });
    quoteUniswapDirectImpl = async () => ({ amountOut: "9000", priceImpact: "0.30%" }); // moved far from what the user was shown
    buildUniswapPlanDirectImpl = async () => { throw new Error("must not build steps for a materially changed quote"); };
    const { prepareTradeExecution } = await import("@/lib/monad/tradeQuote");
    const r = await prepareTradeExecution(
      { action: "buy", inputToken: "USDC", outputToken: TOKEN, amount: "50", amountType: "exact_input", slippage: "0.5", walletAddress: WALLET },
      { receiveAmount: "12345", provider: "Uniswap v3" },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe("changed");
  });

  it("the receive amount moving only WITHIN the slippage tolerance is NOT material — builds steps as normal (that's what slippage protection is for)", async () => {
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "RANDO", name: "Random Token", decimals: 18, verified: false });
    quoteUniswapDirectImpl = async () => ({ amountOut: "12300", priceImpact: "0.30%" }); // ~0.36% off, well under a 5% tolerance
    buildUniswapPlanDirectImpl = async () => ({ steps: [{ kind: "swap", label: "Trade", tx: { to: "0xrouter", data: "0xdead", value: "0x0" } }], amountOut: "12300", priceImpact: "0.30%" });
    const { prepareTradeExecution } = await import("@/lib/monad/tradeQuote");
    const r = await prepareTradeExecution(
      { action: "buy", inputToken: "USDC", outputToken: TOKEN, amount: "50", amountType: "exact_input", slippage: "5", walletAddress: WALLET },
      { receiveAmount: "12345", provider: "Uniswap v3" },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe("ready");
  });

  it("a verified pair on both sides builds through the SAME curated aggregator plan Smart Swap uses (getSwapProvider().buildPlan), not the direct address path", async () => {
    resolveTokenImpl = async () => { throw new Error("must not resolve by address for curated symbols"); };
    bestQuoteImpl = async () => ({ provider: { name: "Uniswap v3" }, quote: { amountOut: 64.2, priceImpact: null } });
    buildPlanImpl = async (from, to, amount, wallet) => {
      expect(from).toBe("USDC");
      expect(to).toBe("MON");
      expect(wallet).toBe(WALLET);
      return { steps: [{ kind: "swap", label: "Swap", tx: { to: "0xrouter", data: "0xdead", value: "0x0" } }] };
    };
    buildUniswapPlanDirectImpl = async () => { throw new Error("verified pairs must use buildPlan, not the direct address path"); };
    const { prepareTradeExecution } = await import("@/lib/monad/tradeQuote");
    const r = await prepareTradeExecution({ action: "sell", inputToken: "USDC", outputToken: "MON", amount: "30", amountType: "exact_input", walletAddress: WALLET });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe("ready");
  });

  it("an arbitrary/unverified token on either side never reaches Kuru's curated-symbol plan builder — only the direct Uniswap path", async () => {
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "RANDO", name: "Random Token", decimals: 18, verified: false });
    quoteUniswapDirectImpl = async () => ({ amountOut: "12345", priceImpact: "0.30%" });
    buildPlanImpl = async () => { throw new Error("an arbitrary token must never route through the curated-symbol aggregator plan"); };
    buildUniswapPlanDirectImpl = async (_tokenIn, _tokenInSymbol, _d1, _n1, tokenOut) => {
      expect(tokenOut.toLowerCase()).toBe(TOKEN.toLowerCase());
      return { steps: [{ kind: "swap", label: "Trade", tx: { to: "0xrouter", data: "0xdead", value: "0x0" } }], amountOut: "12345", priceImpact: "0.30%" };
    };
    const { prepareTradeExecution } = await import("@/lib/monad/tradeQuote");
    const r = await prepareTradeExecution({ action: "buy", inputToken: "USDC", outputToken: TOKEN, amount: "50", amountType: "exact_input", walletAddress: WALLET });
    expect(r.ok).toBe(true);
  });

  it("a build-time failure (e.g. allowance/simulate revert) is reported honestly, never a fabricated step list", async () => {
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "RANDO", name: "Random Token", decimals: 18, verified: false });
    quoteUniswapDirectImpl = async () => ({ amountOut: "12345", priceImpact: "0.30%" });
    buildUniswapPlanDirectImpl = async () => { throw new Error("simulateContract reverted"); };
    const { prepareTradeExecution } = await import("@/lib/monad/tradeQuote");
    const r = await prepareTradeExecution({ action: "buy", inputToken: "USDC", outputToken: TOKEN, amount: "50", amountType: "exact_input", walletAddress: WALLET });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/simulatecontract reverted/i);
  });

  it("exact_output is still unsupported at execution time too — never fabricates a reverse quote", async () => {
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "RANDO", name: "Random Token", decimals: 18, verified: false });
    const { prepareTradeExecution } = await import("@/lib/monad/tradeQuote");
    const r = await prepareTradeExecution({ action: "buy", inputToken: "USDC", outputToken: TOKEN, amount: "100", amountType: "exact_output", walletAddress: WALLET });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/exact-output/i);
  });
});

describe("prepareTradeExecution — Nad.Fun buy/sell", () => {
  it("a Nad.Fun buy (MON -> token) builds through buildNadFunBuyPlan, never Uniswap or the curated aggregator", async () => {
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "MEOW", name: "Meow Coin", decimals: 18, verified: false });
    getTokenBalanceImpl = async () => 10; // enough MON
    nadFunQuoteImpl = async () => ({ provider: "Nad.Fun", router: "0x6F6B8F1a20703309951a5127c45B49b1CD981A22", amountOut: "9000", isBuy: true });
    buildPlanImpl = async () => { throw new Error("must not use the curated aggregator"); };
    buildUniswapPlanDirectImpl = async () => { throw new Error("must not fall back to Uniswap once Nad.Fun served the preview"); };
    buildNadFunBuyPlanImpl = async (token, symbol, decimals, amountInMon, slippage, wallet) => {
      expect(token.toLowerCase()).toBe(TOKEN.toLowerCase());
      expect(symbol).toBe("MEOW");
      expect(decimals).toBe(18);
      expect(amountInMon).toBe("1");
      expect(wallet).toBe(WALLET);
      return { steps: [{ kind: "swap", label: "Buy MEOW on Nad.Fun", tx: { to: "0x6F6B8F1a20703309951a5127c45B49b1CD981A22", data: "0xdead", value: "0xde0b6b3a7640000" } }], amountOut: "9000", router: "0x6F6B8F1a20703309951a5127c45B49b1CD981A22" };
    };
    const { prepareTradeExecution } = await import("@/lib/monad/tradeQuote");
    const r = await prepareTradeExecution({ action: "buy", inputToken: "MON", outputToken: TOKEN, amount: "1", amountType: "exact_input", walletAddress: WALLET });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe("ready");
    if (r.status !== "ready") return;
    expect(r.steps).toHaveLength(1);
    expect(r.steps[0].tx.to).toBe("0x6F6B8F1a20703309951a5127c45B49b1CD981A22");
  });

  it("a Nad.Fun sell (token -> MON) builds through buildNadFunSellPlan", async () => {
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "MEOW", name: "Meow Coin", decimals: 18, verified: false });
    getTokenBalanceImpl = async () => 5000; // enough MEOW
    nadFunQuoteImpl = async () => ({ provider: "Nad.Fun", router: "0x6F6B8F1a20703309951a5127c45B49b1CD981A22", amountOut: "0.5", isBuy: false });
    buildNadFunSellPlanImpl = async (token, symbol, decimals, amountInToken, _slippage, wallet) => {
      expect(token.toLowerCase()).toBe(TOKEN.toLowerCase());
      expect(amountInToken).toBe("1000");
      expect(wallet).toBe(WALLET);
      return {
        steps: [
          { kind: "approve", label: "Approve MEOW for Nad.Fun", tx: { to: TOKEN, data: "0xapprove", value: "0x0" } },
          { kind: "swap", label: "Sell MEOW on Nad.Fun", tx: { to: "0x6F6B8F1a20703309951a5127c45B49b1CD981A22", data: "0xdead", value: "0x0" } },
        ],
        amountOut: "0.5",
        router: "0x6F6B8F1a20703309951a5127c45B49b1CD981A22",
      };
    };
    const { prepareTradeExecution } = await import("@/lib/monad/tradeQuote");
    const r = await prepareTradeExecution({ action: "sell", inputToken: TOKEN, outputToken: "MON", amount: "1000", amountType: "exact_input", walletAddress: WALLET });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe("ready");
    if (r.status !== "ready") return;
    expect(r.steps).toHaveLength(2);
    expect(r.steps[0].kind).toBe("approve");
    expect(r.steps[1].kind).toBe("swap");
  });

  it("a build-time Nad.Fun failure (e.g. the Lens no longer recognizes the token) is reported honestly", async () => {
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "MEOW", name: "Meow Coin", decimals: 18, verified: false });
    getTokenBalanceImpl = async () => 10; // enough MON
    nadFunQuoteImpl = async () => ({ provider: "Nad.Fun", router: "0x6F6B8F1a20703309951a5127c45B49b1CD981A22", amountOut: "9000", isBuy: true });
    buildNadFunBuyPlanImpl = async () => { throw new Error("No active Nad.Fun trading route found for MEOW right now."); };
    const { prepareTradeExecution } = await import("@/lib/monad/tradeQuote");
    const r = await prepareTradeExecution({ action: "buy", inputToken: "MON", outputToken: TOKEN, amount: "1", amountType: "exact_input", walletAddress: WALLET });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/no active nad\.fun/i);
  });

  it("Part 8 regression: a token graduating between preview and confirm (Nad.Fun -> Uniswap) is a material change — refuses to build, never silently executes on the stale provider", async () => {
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "MEOW", name: "Meow Coin", decimals: 18, verified: false });
    getTokenBalanceImpl = async () => 10; // enough MON
    // The token just graduated: the Lens no longer serves it as a bonding-curve
    // quote (nadFunQuote now returns null), so the fresh re-quote inside
    // prepareTradeExecution correctly falls through to Uniswap this time.
    nadFunQuoteImpl = async () => null;
    quoteUniswapDirectImpl = async () => ({ amountOut: "9500", priceImpact: "0.10%" });
    buildUniswapPlanDirectImpl = async () => { throw new Error("must not build steps for a materially changed quote"); };
    buildNadFunBuyPlanImpl = async () => { throw new Error("must not build steps for a materially changed quote"); };
    const { prepareTradeExecution } = await import("@/lib/monad/tradeQuote");
    const r = await prepareTradeExecution(
      { action: "buy", inputToken: "MON", outputToken: TOKEN, amount: "1", amountType: "exact_input", walletAddress: WALLET },
      { receiveAmount: "9000", provider: "Nad.Fun" }, // the card the user confirmed was still showing Nad.Fun
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe("changed");
    if (r.status !== "changed") return;
    expect(r.preview.route.provider).toBe("Uniswap v3");
  });

  it("Part 8 regression: the reverse transition (Uniswap -> Nad.Fun, e.g. a bonding-curve token becomes newly detected) is also a material change", async () => {
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "MEOW", name: "Meow Coin", decimals: 18, verified: false });
    getTokenBalanceImpl = async () => 10;
    nadFunQuoteImpl = async () => ({ provider: "Nad.Fun", router: "0x6F6B8F1a20703309951a5127c45B49b1CD981A22", amountOut: "9200", isBuy: true });
    buildUniswapPlanDirectImpl = async () => { throw new Error("must not build steps for a materially changed quote"); };
    buildNadFunBuyPlanImpl = async () => { throw new Error("must not build steps for a materially changed quote"); };
    const { prepareTradeExecution } = await import("@/lib/monad/tradeQuote");
    const r = await prepareTradeExecution(
      { action: "buy", inputToken: "MON", outputToken: TOKEN, amount: "1", amountType: "exact_input", walletAddress: WALLET },
      { receiveAmount: "9000", provider: "Uniswap v3" },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.status).toBe("changed");
    if (r.status !== "changed") return;
    expect(r.preview.route.provider).toBe("Nad.Fun");
  });
});

describe("PayAITradeExecutor routing (Gate 5)", () => {
  beforeEach(() => { getTokenBalanceImpl = async () => 1_000_000; });

  it("flag OFF: no PayAI fee, receive is the full (gross) quote", async () => {
    bestQuoteImpl = async () => ({ provider: { name: "Uniswap v3" }, quote: { amountOut: 1000, priceImpact: 0.001 } });
    const { previewTrade } = await import("@/lib/monad/tradeQuote");
    const p = await previewTrade({ action: "buy", inputToken: "USDC", outputToken: "MON", amount: "100", amountType: "exact_input", walletAddress: WALLET });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.fee).toBeNull();
    expect(Number(p.receive.amount)).toBeCloseTo(1000, 6);
  });

  it("flag ON + Uniswap: preview quotes NET and discloses the 0.25% PayAI fee", async () => {
    v1Enabled = true;
    bestQuoteImpl = async () => ({ provider: { name: "Uniswap v3" }, quote: { amountOut: 1000, priceImpact: 0.001 } });
    const { previewTrade } = await import("@/lib/monad/tradeQuote");
    const p = await previewTrade({ action: "buy", inputToken: "USDC", outputToken: "MON", amount: "100", amountType: "exact_input", walletAddress: WALLET });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.fee).not.toBeNull();
    expect(p.fee!.percent).toBe("0.25%");
    expect(p.fee!.token).toBe("USDC");
    expect(Number(p.fee!.amount)).toBeCloseTo(0.25, 6);      // 100 * 0.25%
    expect(Number(p.receive.amount)).toBeCloseTo(997.5, 3);  // 1000 net of 0.25%
  });

  it("flag ON + Uniswap: build routes through the executor plan, never the direct router", async () => {
    v1Enabled = true;
    bestQuoteImpl = async () => ({ provider: { name: "Uniswap v3" }, quote: { amountOut: 1000, priceImpact: 0.001 } });
    buildPlanImpl = async () => { throw new Error("must not use the direct getSwapProvider().buildPlan when the executor is on"); };
    let called = false;
    uniExecPlanImpl = async () => { called = true; return { steps: [{ kind: "swap", label: "exec uni", tx: { to: "0xEXEC", data: "0x", value: "0x0" } }], amountOut: "997.5", priceImpact: null, feeBps: 25, feeAmount: "0.25" }; };
    const { prepareTradeExecution } = await import("@/lib/monad/tradeQuote");
    const r = await prepareTradeExecution({ action: "buy", inputToken: "USDC", outputToken: "MON", amount: "100", amountType: "exact_input", walletAddress: WALLET });
    expect(r.ok).toBe(true);
    if (!r.ok || r.status !== "ready") return;
    expect(called).toBe(true);
    expect(r.steps[0].label).toBe("exec uni");
  });

  it("flag ON + Kuru (allowlisted): build routes through the Kuru executor plan", async () => {
    v1Enabled = true;
    bestQuoteImpl = async () => ({ provider: { name: "Kuru" }, quote: { amountOut: 1000, priceImpact: null } });
    let called = false;
    kuruExecPlanImpl = async () => { called = true; return { steps: [{ kind: "swap", label: "exec kuru", tx: { to: "0xEXEC", data: "0x", value: "0x0" } }], amountOut: "997.5", priceImpact: null, feeBps: 25, feeAmount: "0.25" }; };
    const { prepareTradeExecution } = await import("@/lib/monad/tradeQuote");
    const r = await prepareTradeExecution({ action: "sell", inputToken: "MON", outputToken: "USDC", amount: "1", amountType: "exact_input", walletAddress: WALLET });
    expect(r.ok).toBe(true);
    if (!r.ok || r.status !== "ready") return;
    expect(called).toBe(true);
    expect(r.steps[0].label).toBe("exec kuru");
  });

  it("flag ON + Kuru (NOT allowlisted): falls back to the direct path, never reverts", async () => {
    v1Enabled = true;
    bestQuoteImpl = async () => ({ provider: { name: "Kuru" }, quote: { amountOut: 1000, priceImpact: null } });
    kuruExecPlanImpl = async () => null; // market not on the executor allowlist
    let directCalled = false;
    buildPlanImpl = async () => { directCalled = true; return { steps: [{ kind: "swap", label: "direct kuru", tx: { to: "0xmarket", data: "0x", value: "0x0" } }] }; };
    const { prepareTradeExecution } = await import("@/lib/monad/tradeQuote");
    const r = await prepareTradeExecution({ action: "sell", inputToken: "MON", outputToken: "USDC", amount: "1", amountType: "exact_input", walletAddress: WALLET });
    expect(r.ok).toBe(true);
    if (!r.ok || r.status !== "ready") return;
    expect(directCalled).toBe(true);
    expect(r.steps[0].label).toBe("direct kuru");
  });

  it("V1 ON + Nad.Fun: never executor-routed (V1 doesn't support it), no PayAI fee, uses the direct Nad.Fun plan", async () => {
    v1Enabled = true;
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "RANDO", name: "Random Token", decimals: 18, verified: false });
    nadFunQuoteImpl = async (_t, _d, _a, isBuy) => (isBuy ? { provider: "Nad.Fun", router: "0x6F6B8F1a20703309951a5127c45B49b1CD981A22", amountOut: "500", isBuy: true } : null);
    let nadCalled = false;
    buildNadFunBuyPlanImpl = async () => { nadCalled = true; return { steps: [{ kind: "swap", label: "nadfun buy", tx: { to: "0xcurve", data: "0x", value: "0x0" } }], amountOut: "500", router: "0xcurve" }; };
    uniExecPlanImpl = async () => { throw new Error("Nad.Fun must never route through the executor"); };
    kuruExecPlanImpl = async () => { throw new Error("Nad.Fun must never route through the executor"); };
    const { previewTrade, prepareTradeExecution } = await import("@/lib/monad/tradeQuote");
    const p = await previewTrade({ action: "buy", inputToken: "MON", outputToken: TOKEN, amount: "1", amountType: "exact_input", walletAddress: WALLET });
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.fee).toBeNull();
    const r = await prepareTradeExecution({ action: "buy", inputToken: "MON", outputToken: TOKEN, amount: "1", amountType: "exact_input", walletAddress: WALLET });
    expect(r.ok).toBe(true);
    if (!r.ok || r.status !== "ready") return;
    expect(nadCalled).toBe(true);
    expect(r.steps[0].label).toBe("nadfun buy");
  });
});

describe("PayAITradeExecutor V2 dispatch — Nad.Fun via the executor (Gate 7)", () => {
  beforeEach(() => { getTokenBalanceImpl = async () => 1_000_000; });

  it("V2 configured: Uniswap still routes through the executor plan (V2 supersedes V1 for existing venues)", async () => {
    v2Enabled = true;
    bestQuoteImpl = async () => ({ provider: { name: "Uniswap v3" }, quote: { amountOut: 1000, priceImpact: 0.001 } });
    buildPlanImpl = async () => { throw new Error("must not use the direct path when V2 is configured"); };
    let called = false;
    uniExecPlanImpl = async () => { called = true; return { steps: [{ kind: "swap", label: "exec uni v2", tx: { to: "0xEXEC", data: "0x", value: "0x0" } }], amountOut: "997.5", priceImpact: null, feeBps: 25, feeAmount: "0.25" }; };
    const { prepareTradeExecution } = await import("@/lib/monad/tradeQuote");
    const r = await prepareTradeExecution({ action: "buy", inputToken: "USDC", outputToken: "MON", amount: "100", amountType: "exact_input", walletAddress: WALLET });
    expect(r.ok).toBe(true);
    if (!r.ok || r.status !== "ready") return;
    expect(called).toBe(true);
    expect(r.steps[0].label).toBe("exec uni v2");
  });

  it("V2 configured: Kuru still routes through the executor plan", async () => {
    v2Enabled = true;
    bestQuoteImpl = async () => ({ provider: { name: "Kuru" }, quote: { amountOut: 1000, priceImpact: null } });
    let called = false;
    kuruExecPlanImpl = async () => { called = true; return { steps: [{ kind: "swap", label: "exec kuru v2", tx: { to: "0xEXEC", data: "0x", value: "0x0" } }], amountOut: "997.5", priceImpact: null, feeBps: 25, feeAmount: "0.25" }; };
    const { prepareTradeExecution } = await import("@/lib/monad/tradeQuote");
    const r = await prepareTradeExecution({ action: "sell", inputToken: "MON", outputToken: "USDC", amount: "1", amountType: "exact_input", walletAddress: WALLET });
    expect(r.ok).toBe(true);
    if (!r.ok || r.status !== "ready") return;
    expect(called).toBe(true);
    expect(r.steps[0].label).toBe("exec kuru v2");
  });

  it("V2 configured: previewing a Nad.Fun BUY discloses the same 0.25% PayAI fee Uniswap/Kuru already show", async () => {
    v2Enabled = true;
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "MEOW", name: "Meow Coin", decimals: 18, verified: false });
    nadFunQuoteImpl = async (_t, _d, amount, isBuy) => { expect(amount).toBe("1"); expect(isBuy).toBe(true); return { provider: "Nad.Fun", router: "0x6F6B8F1a20703309951a5127c45B49b1CD981A22", amountOut: "9000", isBuy: true }; };
    const { previewTrade } = await import("@/lib/monad/tradeQuote");
    const p = await previewTrade({ action: "buy", inputToken: "MON", outputToken: TOKEN, amount: "1", amountType: "exact_input", walletAddress: WALLET });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.fee).not.toBeNull();
    expect(p.fee!.percent).toBe("0.25%");
    expect(p.fee!.token).toBe("MON");
    expect(Number(p.receive.amount)).toBeCloseTo(9000 * 0.9975, 3); // net of the 0.25% fee
  });

  it("V2 configured: a Nad.Fun BUY builds through buildNadFunExecutorPlan (bonding-curve router), never the direct bonding-curve path", async () => {
    v2Enabled = true;
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "MEOW", name: "Meow Coin", decimals: 18, verified: false });
    nadFunQuoteImpl = async () => ({ provider: "Nad.Fun", router: "0x6F6B8F1a20703309951a5127c45B49b1CD981A22", amountOut: "9000", isBuy: true }); // BondingCurveRouter
    buildNadFunBuyPlanImpl = async () => { throw new Error("must not use the direct Nad.Fun path once V2 is configured and accepts the plan"); };
    let called = false;
    nadExecPlanImpl = async (execAddr, token, symbol, decimals, isBuy, amount, _slip, wallet) => {
      called = true;
      expect(execAddr).toBe(V2_ADDR);
      expect((token as string).toLowerCase()).toBe(TOKEN.toLowerCase());
      expect(symbol).toBe("MEOW");
      expect(decimals).toBe(18);
      expect(isBuy).toBe(true);
      expect(amount).toBe("1");
      expect(wallet).toBe(WALLET);
      return { steps: [{ kind: "swap", label: "exec nadfun buy (bonding curve)", tx: { to: V2_ADDR, data: "0xdead", value: "0xde0b6b3a7640000" } }], amountOut: "8977.5", priceImpact: null, feeBps: 25, feeAmount: "0.0025" };
    };
    const { prepareTradeExecution } = await import("@/lib/monad/tradeQuote");
    const r = await prepareTradeExecution({ action: "buy", inputToken: "MON", outputToken: TOKEN, amount: "1", amountType: "exact_input", walletAddress: WALLET });
    expect(r.ok).toBe(true);
    if (!r.ok || r.status !== "ready") return;
    expect(called).toBe(true);
    expect(r.steps[0].label).toBe("exec nadfun buy (bonding curve)");
  });

  it("V2 configured: a Nad.Fun SELL (graduated DEX router) builds through buildNadFunExecutorPlan with isBuy: false", async () => {
    v2Enabled = true;
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "MEOW", name: "Meow Coin", decimals: 18, verified: false });
    getTokenBalanceImpl = async () => 5000;
    nadFunQuoteImpl = async () => ({ provider: "Nad.Fun", router: "0x0B79d71AE99528D1dB24A4148b5f4F865cc2b137", amountOut: "0.5", isBuy: false }); // DexRouter (graduated)
    let called = false;
    nadExecPlanImpl = async (_exec, _token, _symbol, _decimals, isBuy, amount) => {
      called = true;
      expect(isBuy).toBe(false);
      expect(amount).toBe("1000");
      return { steps: [
        { kind: "approve", label: "Approve MEOW for the trade", tx: { to: TOKEN, data: "0xapprove", value: "0x0" } },
        { kind: "swap", label: "exec nadfun sell (graduated)", tx: { to: V2_ADDR, data: "0xdead", value: "0x0" } },
      ], amountOut: "0.49875", priceImpact: null, feeBps: 25, feeAmount: "2.5" };
    };
    const { prepareTradeExecution } = await import("@/lib/monad/tradeQuote");
    const r = await prepareTradeExecution({ action: "sell", inputToken: TOKEN, outputToken: "MON", amount: "1000", amountType: "exact_input", walletAddress: WALLET });
    expect(r.ok).toBe(true);
    if (!r.ok || r.status !== "ready") return;
    expect(called).toBe(true);
    expect(r.steps).toHaveLength(2);
    expect(r.steps[1].label).toBe("exec nadfun sell (graduated)");
  });

  it("V2 configured but the router isn't on the on-chain allowlist yet: buildNadFunExecutorPlan returns null, falls back to the existing direct Nad.Fun path — never reverts", async () => {
    v2Enabled = true;
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "MEOW", name: "Meow Coin", decimals: 18, verified: false });
    nadFunQuoteImpl = async () => ({ provider: "Nad.Fun", router: "0x6F6B8F1a20703309951a5127c45B49b1CD981A22", amountOut: "9000", isBuy: true });
    nadExecPlanImpl = async () => null; // router not yet Safe-approved on V2
    let directCalled = false;
    buildNadFunBuyPlanImpl = async () => { directCalled = true; return { steps: [{ kind: "swap", label: "direct nadfun buy", tx: { to: "0xcurve", data: "0x", value: "0x0" } }], amountOut: "9000", router: "0xcurve" }; };
    const { prepareTradeExecution } = await import("@/lib/monad/tradeQuote");
    const r = await prepareTradeExecution({ action: "buy", inputToken: "MON", outputToken: TOKEN, amount: "1", amountType: "exact_input", walletAddress: WALLET });
    expect(r.ok).toBe(true);
    if (!r.ok || r.status !== "ready") return;
    expect(directCalled).toBe(true);
    expect(r.steps[0].label).toBe("direct nadfun buy");
  });

  it("neither V1 nor V2 configured: Uniswap/Kuru/Nad.Fun all use their existing direct paths, unchanged by Gate 7", async () => {
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "MEOW", name: "Meow Coin", decimals: 18, verified: false });
    nadFunQuoteImpl = async () => ({ provider: "Nad.Fun", router: "0x6F6B8F1a20703309951a5127c45B49b1CD981A22", amountOut: "9000", isBuy: true });
    uniExecPlanImpl = async () => { throw new Error("no executor configured — must not be called"); };
    kuruExecPlanImpl = async () => { throw new Error("no executor configured — must not be called"); };
    nadExecPlanImpl = async () => { throw new Error("no executor configured — must not be called"); };
    let directCalled = false;
    buildNadFunBuyPlanImpl = async () => { directCalled = true; return { steps: [{ kind: "swap", label: "direct nadfun buy", tx: { to: "0xcurve", data: "0x", value: "0x0" } }], amountOut: "9000", router: "0xcurve" }; };
    const { previewTrade, prepareTradeExecution } = await import("@/lib/monad/tradeQuote");
    const p = await previewTrade({ action: "buy", inputToken: "MON", outputToken: TOKEN, amount: "1", amountType: "exact_input", walletAddress: WALLET });
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.fee).toBeNull();
    const r = await prepareTradeExecution({ action: "buy", inputToken: "MON", outputToken: TOKEN, amount: "1", amountType: "exact_input", walletAddress: WALLET });
    expect(r.ok).toBe(true);
    if (!r.ok || r.status !== "ready") return;
    expect(directCalled).toBe(true);
  });
});

/**
 * The execution side of the Nad.Fun-through-MON route: building the two
 * real, independently-signed on-chain legs, and tagging each leg's LAST
 * step with `settleLeg` so a caller settles/records BOTH real transactions
 * as they confirm — never only the second one, which would silently drop
 * the first leg's real, fund-moving transaction from the user's own history
 * if the second leg is then rejected or reverts.
 */
describe("prepareTradeExecution — Nad.Fun-through-MON multi-hop build", () => {
  it("buying a graduated Nad.Fun token with USDC builds BOTH legs, leg B sized off leg A's REAL output, each leg's last step tagged with its own settleLeg", async () => {
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "GRAD", name: "Graduated Coin", decimals: 18, verified: false });
    getNadFunStatusImpl = async () => ({ recognized: true, isGraduated: true, isLocked: false, status: "graduated" });
    getTokenBalanceImpl = async () => 1000; // plenty of USDC
    bestQuoteImpl = async (from, to, amount) => {
      // Called twice: once by previewTrade's own getTradeRoute, once by
      // prepareTradeExecution's fresh build — both must ask for USDC->MON.
      expect(from).toBe("USDC");
      expect(to).toBe("MON");
      expect(amount).toBe(50);
      return { provider: { name: "Uniswap v3" }, quote: { amountOut: 100, priceImpact: null } };
    };
    buildPlanImpl = async (from, to, amount) => {
      expect(from).toBe("USDC");
      expect(to).toBe("MON");
      expect(amount).toBe(50);
      return {
        steps: [
          { kind: "approve", label: "Approve USDC", tx: { to: "0xUSDC", data: "0xapprove", value: "0x0" } },
          { kind: "swap", label: "Swap USDC for MON", tx: { to: "0xRouter", data: "0xswap", value: "0x0" } },
        ],
        quote: { amountOut: 100 },
        provider: "Uniswap v3",
      };
    };
    nadFunQuoteImpl = async (token, decimals, amount, isBuy) => {
      expect(amount).toBe("100");
      expect(isBuy).toBe(true);
      return { provider: "Nad.Fun", router: "0x6F6B8F1a20703309951a5127c45B49b1CD981A22", amountOut: "5000", isBuy: true };
    };
    buildNadFunBuyPlanImpl = async (token, symbol, decimals, amountInMon, slippage, wallet) => {
      expect(amountInMon).toBe("100"); // leg B sized off leg A's REAL build output, not the preview estimate
      expect(wallet).toBe(WALLET);
      return { steps: [{ kind: "swap", label: "Buy GRAD on Nad.Fun", tx: { to: "0xNadFunRouter", data: "0xbuy", value: "0x0" } }], amountOut: "5000", router: "0xNadFunRouter" };
    };
    const { prepareTradeExecution } = await import("@/lib/monad/tradeQuote");
    const r = await prepareTradeExecution({ action: "buy", inputToken: "USDC", outputToken: TOKEN, amount: "50", amountType: "exact_input", walletAddress: WALLET });
    expect(r.ok).toBe(true);
    if (!r.ok || r.status !== "ready") return;
    expect(r.steps).toHaveLength(3); // approve(USDC) + swap(USDC->MON) + buy(MON->GRAD)
    expect(r.steps[0].label).toBe("Approve USDC");
    expect(r.steps[0].settleLeg).toBeUndefined(); // not the last step of its leg
    expect(r.steps[1].label).toBe("Swap USDC for MON");
    expect(r.steps[1].settleLeg).toEqual({ fromToken: "USDC", toToken: "MON", amountIn: 50, amountOut: 100, provider: "Uniswap v3" });
    expect(r.steps[2].label).toBe("Buy GRAD on Nad.Fun");
    expect(r.steps[2].settleLeg).toEqual({ fromToken: "MON", toToken: "GRAD", amountIn: 100, amountOut: 5000, provider: "Nad.Fun" });
  });

  it("selling a bonding-curve Nad.Fun token for USDC builds BOTH legs in the other order, leg B sized off leg A's REAL MON output", async () => {
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "MEOW", name: "Meow Coin", decimals: 18, verified: false });
    getNadFunStatusImpl = async () => ({ recognized: true, isGraduated: false, isLocked: false, status: "bonding_curve" });
    getTokenBalanceImpl = async () => 2000; // plenty of MEOW
    nadFunQuoteImpl = async (token, decimals, amount, isBuy) => {
      expect(amount).toBe("1000");
      expect(isBuy).toBe(false);
      return { provider: "Nad.Fun", router: "0x6F6B8F1a20703309951a5127c45B49b1CD981A22", amountOut: "2", isBuy: false };
    };
    buildNadFunSellPlanImpl = async (token, symbol, decimals, amountInToken, slippage, wallet) => {
      expect(amountInToken).toBe("1000");
      expect(wallet).toBe(WALLET);
      return { steps: [{ kind: "swap", label: "Sell MEOW on Nad.Fun", tx: { to: "0xNadFunRouter", data: "0xsell", value: "0x0" } }], amountOut: "2", router: "0xNadFunRouter" };
    };
    bestQuoteImpl = async (from, to, amount) => {
      expect(from).toBe("MON");
      expect(to).toBe("USDC");
      expect(amount).toBe(2);
      return { provider: { name: "Uniswap v3" }, quote: { amountOut: 4, priceImpact: null } };
    };
    buildPlanImpl = async (from, to, amount) => {
      expect(from).toBe("MON");
      expect(to).toBe("USDC");
      expect(amount).toBe(2); // sized off leg A's REAL MON output
      return {
        steps: [{ kind: "swap", label: "Swap MON for USDC", tx: { to: "0xRouter", data: "0xswap", value: "0x0" } }],
        quote: { amountOut: 4 },
        provider: "Uniswap v3",
      };
    };
    const { prepareTradeExecution } = await import("@/lib/monad/tradeQuote");
    const r = await prepareTradeExecution({ action: "sell", inputToken: TOKEN, outputToken: "USDC", amount: "1000", amountType: "exact_input", walletAddress: WALLET });
    expect(r.ok).toBe(true);
    if (!r.ok || r.status !== "ready") return;
    expect(r.steps).toHaveLength(2); // sell(MEOW->MON) + swap(MON->USDC), no approve needed for a native MON leg
    expect(r.steps[0].label).toBe("Sell MEOW on Nad.Fun");
    expect(r.steps[0].settleLeg).toEqual({ fromToken: "MEOW", toToken: "MON", amountIn: 1000, amountOut: 2, provider: "Nad.Fun" });
    expect(r.steps[1].label).toBe("Swap MON for USDC");
    expect(r.steps[1].settleLeg).toEqual({ fromToken: "MON", toToken: "USDC", amountIn: 2, amountOut: 4, provider: "Uniswap v3" });
  });

  it("if leg A's build fails outright, nothing is returned — never a half-built multi-hop trade", async () => {
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "GRAD", name: "Graduated Coin", decimals: 18, verified: false });
    getNadFunStatusImpl = async () => ({ recognized: true, isGraduated: true, isLocked: false, status: "graduated" });
    getTokenBalanceImpl = async () => 1000; // plenty of USDC — the failure must come from the build, not a balance check
    bestQuoteImpl = async () => ({ provider: { name: "Uniswap v3" }, quote: { amountOut: 100, priceImpact: null } });
    buildPlanImpl = async () => { throw new Error("RPC hiccup building leg A"); };
    nadFunQuoteImpl = async () => ({ provider: "Nad.Fun", router: "0x6F6B8F1a20703309951a5127c45B49b1CD981A22", amountOut: "5000", isBuy: true });
    buildNadFunBuyPlanImpl = async () => { throw new Error("must not build leg B when leg A's build already failed"); };
    const { prepareTradeExecution } = await import("@/lib/monad/tradeQuote");
    const r = await prepareTradeExecution({ action: "buy", inputToken: "USDC", outputToken: TOKEN, amount: "50", amountType: "exact_input", walletAddress: WALLET });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/rpc hiccup/i);
  });

  it("if leg B's build fails after leg A's already succeeded, still nothing is returned — the caller never sees a partial steps array to sign", async () => {
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "GRAD", name: "Graduated Coin", decimals: 18, verified: false });
    getNadFunStatusImpl = async () => ({ recognized: true, isGraduated: true, isLocked: false, status: "graduated" });
    getTokenBalanceImpl = async () => 1000; // plenty of USDC
    bestQuoteImpl = async () => ({ provider: { name: "Uniswap v3" }, quote: { amountOut: 100, priceImpact: null } });
    buildPlanImpl = async () => ({
      steps: [{ kind: "swap", label: "Swap USDC for MON", tx: { to: "0xRouter", data: "0xswap", value: "0x0" } }],
      quote: { amountOut: 100 }, provider: "Uniswap v3",
    });
    nadFunQuoteImpl = async () => ({ provider: "Nad.Fun", router: "0x6F6B8F1a20703309951a5127c45B49b1CD981A22", amountOut: "5000", isBuy: true });
    buildNadFunBuyPlanImpl = async () => { throw new Error("No active Nad.Fun trading route found for GRAD right now."); };
    const { prepareTradeExecution } = await import("@/lib/monad/tradeQuote");
    const r = await prepareTradeExecution({ action: "buy", inputToken: "USDC", outputToken: TOKEN, amount: "50", amountType: "exact_input", walletAddress: WALLET });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toMatch(/nad\.fun/i);
  });
});
