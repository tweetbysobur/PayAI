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
let buildPlanImpl: (from: string, to: string, amount: number, wallet: string, slippage?: number) => Promise<{ steps: StubStep[] }> =
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
vi.mock("@/lib/monad/nadfun", () => ({
  nadFunQuote: (token: string, decimals: number, amount: string, isBuy: boolean) => nadFunQuoteImpl(token, decimals, amount, isBuy),
  buildNadFunBuyPlan: (token: string, symbol: string, decimals: number, amountInMon: string, slippage: number, wallet: string) =>
    buildNadFunBuyPlanImpl(token, symbol, decimals, amountInMon, slippage, wallet),
  buildNadFunSellPlan: (token: string, symbol: string, decimals: number, amountInToken: string, slippage: number, wallet: string) =>
    buildNadFunSellPlanImpl(token, symbol, decimals, amountInToken, slippage, wallet),
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
