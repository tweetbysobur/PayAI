import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * lib/monad/tokenIntelligence.ts's only external inputs are the chain
 * (getCode / readContract), the token registry (resolveToken), the swap
 * aggregator (candidateProviders / quoteUniswapDirect / resolveSwapSide),
 * and lib/monad/prices's getUsdPrice — stub all of them so these tests
 * exercise the real classification/routing/formatting logic without
 * touching a real RPC, DEX, or external price source. quoteUniswapDirect
 * is mocked at this (higher) level rather than the raw simulateContract
 * calls beneath it, since that fee-tier-loop math now lives in swap.ts —
 * see test/swap.test.ts for coverage of quoteUniswapDirect itself.
 */

let codeAt: Record<string, string | undefined> = {};
let readContractImpl: (args: { address: string; functionName: string; args?: unknown[] }) => unknown = () => {
  throw new Error("unexpected readContract call");
};
let getCodeShouldThrow = false;

vi.mock("@/lib/monad/wallet", () => ({
  getPublicClient: () => ({
    getCode: async ({ address }: { address: string }) => {
      if (getCodeShouldThrow) throw new Error("RPC unreachable");
      return codeAt[address.toLowerCase()];
    },
    readContract: async (args: { address: string; functionName: string; args?: unknown[] }) => readContractImpl(args),
  }),
}));

let network: "mainnet" | "testnet" = "mainnet";
const STABLECOIN = { address: "0x1234567890123456789012345678901234567890", decimals: 6, symbol: "USDC" };
vi.mock("@/lib/monad/config", () => ({
  getNetwork: () => network,
  getStablecoin: () => STABLECOIN,
  explorerAddress: (address: string) => `https://monadexplorer.com/address/${address}`,
}));

let resolveTokenImpl: (address: string) => Promise<{ address: string; symbol: string; name: string; decimals: number; verified: boolean }> = async () => {
  throw new Error("not an ERC-20");
};
const NATIVE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000";
vi.mock("@/lib/monad/tokenRegistry", () => ({
  resolveToken: (address: string) => resolveTokenImpl(address),
  NATIVE_TOKEN_ADDRESS: "0x0000000000000000000000000000000000000000",
}));

type MockProvider = { name: string; quote: (from: string, to: string, amountIn: number) => Promise<{ amountOut: number; priceImpact: number | null }> };
let candidateProvidersImpl: () => Promise<MockProvider[]> = async () => [];
let quoteUniswapDirectImpl: (tokenIn: string, tokenInDecimals: number, tokenOut: string, tokenOutDecimals: number, amount: string) => Promise<{ amountOut: string; priceImpact: string | null } | null> = async () => null;
let resolveSwapSideImpl: (symbol: string) => Promise<{ symbol: string; routeAddress: string; decimals: number; isNative: boolean }> = async (symbol) => ({
  symbol, routeAddress: symbol === "USDC" ? STABLECOIN.address : "0xwmon00000000000000000000000000000000000", decimals: symbol === "USDC" ? 6 : 18, isNative: symbol !== "USDC",
});
vi.mock("@/lib/monad/swap", () => ({
  candidateProviders: () => candidateProvidersImpl(),
  quoteUniswapDirect: (tokenIn: string, tokenInDecimals: number, tokenOut: string, tokenOutDecimals: number, amount: string) =>
    quoteUniswapDirectImpl(tokenIn, tokenInDecimals, tokenOut, tokenOutDecimals, amount),
  MAX_PRICE_IMPACT: 0.15,
  resolveSwapSide: (symbol: string) => resolveSwapSideImpl(symbol),
}));

let getUsdPriceImpl: (address: string) => Promise<number | null> = async () => null;
vi.mock("@/lib/monad/prices", () => ({
  getUsdPrice: (address: string) => getUsdPriceImpl(address),
}));

interface StubDexScreenerSnapshot {
  volume24h: number;
  transactions24h: number | null;
  buys24h: number | null;
  sells24h: number | null;
  priceChange24h: number | null;
}
let getDexScreenerSnapshotImpl: (address: string) => Promise<StubDexScreenerSnapshot | null> = async () => null;
vi.mock("@/lib/monad/dexscreener", () => ({
  getDexScreenerSnapshot: (address: string) => getDexScreenerSnapshotImpl(address),
}));

interface StubNadFunStatus { recognized: boolean; isGraduated: boolean; isLocked: boolean; status: "bonding_curve" | "graduated" | "locked" | "unsupported" }
let getNadFunStatusImpl: (token: string) => Promise<StubNadFunStatus> = async () => ({ recognized: false, isGraduated: false, isLocked: false, status: "unsupported" });
let nadFunAvailableBuyTokensImpl: (token: string, decimals: number) => Promise<{ availableToBuy: string; requiredMon: string } | null> = async () => null;
let nadFunQuoteImpl: (token: string, decimals: number, amount: string, isBuy: boolean) => Promise<{ provider: "Nad.Fun"; router: string; amountOut: string; isBuy: boolean } | null> = async () => null;
let getNadFunProgressImpl: (token: string) => Promise<number | null> = async () => null;
let getNadFunCurveReservesImpl: (token: string, decimals: number) => Promise<{ realMon: string; realToken: string; virtualMon: string; virtualToken: string } | null> = async () => null;
let getNadFunGraduatedPoolLiquidityImpl: (token: string, decimals: number) => Promise<{ pool: string; monReserve: string; tokenReserve: string } | null> = async () => null;
let getNadFunCreatorInfoImpl: (token: string) => Promise<{ creator: string; curvePool: string; createdAt: number | null } | null> = async () => null;
vi.mock("@/lib/monad/nadfun", () => ({
  getNadFunStatus: (token: string) => getNadFunStatusImpl(token),
  nadFunAvailableBuyTokens: (token: string, decimals: number) => nadFunAvailableBuyTokensImpl(token, decimals),
  nadFunQuote: (token: string, decimals: number, amount: string, isBuy: boolean) => nadFunQuoteImpl(token, decimals, amount, isBuy),
  getNadFunProgress: (token: string) => getNadFunProgressImpl(token),
  getNadFunCurveReserves: (token: string, decimals: number) => getNadFunCurveReservesImpl(token, decimals),
  getNadFunGraduatedPoolLiquidity: (token: string, decimals: number) => getNadFunGraduatedPoolLiquidityImpl(token, decimals),
  getNadFunCreatorInfo: (token: string) => getNadFunCreatorInfoImpl(token),
}));

afterEach(async () => {
  vi.restoreAllMocks();
  const { clearMarketDataCache } = await import("@/lib/monad/tokenIntelligence");
  clearMarketDataCache();
  network = "mainnet";
  codeAt = {};
  getCodeShouldThrow = false;
  readContractImpl = () => { throw new Error("unexpected readContract call"); };
  resolveTokenImpl = async () => { throw new Error("not an ERC-20"); };
  candidateProvidersImpl = async () => [];
  quoteUniswapDirectImpl = async () => null;
  resolveSwapSideImpl = async (symbol: string) => ({ symbol, routeAddress: symbol === "USDC" ? STABLECOIN.address : "0xwmon00000000000000000000000000000000000", decimals: symbol === "USDC" ? 6 : 18, isNative: symbol !== "USDC" });
  getUsdPriceImpl = async () => null;
  getNadFunStatusImpl = async () => ({ recognized: false, isGraduated: false, isLocked: false, status: "unsupported" });
  nadFunAvailableBuyTokensImpl = async () => null;
  nadFunQuoteImpl = async () => null;
  getNadFunProgressImpl = async () => null;
  getNadFunCurveReservesImpl = async () => null;
  getNadFunGraduatedPoolLiquidityImpl = async () => null;
  getNadFunCreatorInfoImpl = async () => null;
  getDexScreenerSnapshotImpl = async () => null;
});

const TOKEN = "0xaaaabbbbccccddddeeeeffff0000111122223333";
const OTHER_TOKEN = "0xffffeeeeddddccccbbbbaaaa0000111122223333";
const WALLET_EOA = "0x9999888877776666555544443333222211110000";
const HOLDER = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";

describe("inspectAddress — address validation and network gate", () => {
  it("rejects a malformed address without ever touching the chain", async () => {
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const r = await inspectAddress("not-an-address");
    expect(r.kind).toBe("invalid");
  });

  it("rejects a too-short address", async () => {
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const r = await inspectAddress("0x1234");
    expect(r.kind).toBe("invalid");
  });

  it("reports unavailable on testnet rather than guessing at unverified data", async () => {
    network = "testnet";
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const r = await inspectAddress(TOKEN);
    expect(r.kind).toBe("invalid");
  });
});

describe("inspectAddress — EOA vs contract vs ERC-20 classification", () => {
  it("an address with no bytecode is reported as a wallet, never guessed as a token", async () => {
    codeAt[WALLET_EOA.toLowerCase()] = "0x";
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const r = await inspectAddress(WALLET_EOA);
    expect(r.kind).toBe("wallet");
  });

  it("undefined bytecode (RPC returns nothing) is also treated as a wallet", async () => {
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const r = await inspectAddress(WALLET_EOA);
    expect(r.kind).toBe("wallet");
  });

  it("a contract that doesn't behave like an ERC-20 (resolveToken throws) is reported honestly, not as a token", async () => {
    codeAt[TOKEN.toLowerCase()] = "0x6080604052";
    resolveTokenImpl = async () => { throw new Error("Could not read as an ERC-20 token"); };
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const r = await inspectAddress(TOKEN);
    expect(r.kind).toBe("unknown_contract");
  });

  it("an RPC failure during the code check propagates rather than being silently swallowed as a wallet", async () => {
    getCodeShouldThrow = true;
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    await expect(inspectAddress(TOKEN)).rejects.toThrow();
  });
});

describe("inspectAddress — real ERC-20 metadata, never fabricated", () => {
  function setUpErc20(overrides: Partial<{ symbol: string; name: string; decimals: number; verified: boolean }> = {}) {
    codeAt[TOKEN.toLowerCase()] = "0x6080604052";
    resolveTokenImpl = async () => ({
      address: TOKEN, symbol: overrides.symbol ?? "PEPE", name: overrides.name ?? "Pepe Coin",
      decimals: overrides.decimals ?? 18, verified: overrides.verified ?? false,
    });
  }

  it("returns name/symbol/decimals exactly as resolveToken reports them", async () => {
    setUpErc20();
    readContractImpl = ({ functionName }) => {
      if (functionName === "totalSupply") return 1_000_000_000000000000000000n;
      throw new Error("unexpected");
    };
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const r = await inspectAddress(TOKEN);
    expect(r.kind).toBe("token");
    if (r.kind !== "token") throw new Error("expected token");
    expect(r.data.symbol).toBe("PEPE");
    expect(r.data.name).toBe("Pepe Coin");
    expect(r.data.decimals).toBe(18);
    expect(r.data.totalSupply).toBe("1000000"); // 1_000_000_000000000000000000n / 10^18
    expect(r.data.chain).toBe("Monad");
    expect(r.data.address).toBe(TOKEN);
    expect(r.data.explorerUrl).toContain(TOKEN);
  });

  it("totalSupply() failing doesn't fail the whole lookup -- it's reported as null, never 0", async () => {
    setUpErc20();
    readContractImpl = ({ functionName }) => { throw new Error(`${functionName} reverted`); };
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const r = await inspectAddress(TOKEN);
    expect(r.kind).toBe("token");
    if (r.kind !== "token") throw new Error("expected token");
    expect(r.data.totalSupply).toBeNull();
  });

  it("includes the caller's own balance only when a wallet address was given", async () => {
    setUpErc20();
    readContractImpl = ({ functionName, args }) => {
      if (functionName === "totalSupply") return 0n;
      if (functionName === "balanceOf") {
        expect(args?.[0]).toBe(HOLDER);
        return 42_500000000000000000n;
      }
      throw new Error("unexpected");
    };
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const withWallet = await inspectAddress(TOKEN, HOLDER);
    if (withWallet.kind !== "token") throw new Error("expected token");
    expect(withWallet.data.userBalance).toBe("42.5");

    const withoutWallet = await inspectAddress(TOKEN);
    if (withoutWallet.kind !== "token") throw new Error("expected token");
    expect(withoutWallet.data.userBalance).toBeNull();
  });
});

describe("inspectAddress — real trading-pair and route discovery", () => {
  it("a verified token shows every configured provider's own route across BOTH USDC and MON, not just the winner", async () => {
    codeAt[TOKEN.toLowerCase()] = "0x6080604052";
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "USDT0", name: "Tether USD", decimals: 6, verified: true });
    readContractImpl = () => 0n;
    getUsdPriceImpl = async () => 0.998;
    candidateProvidersImpl = async () => [
      { name: "Uniswap v3", quote: async (from, to) => (to === "USDC" ? { amountOut: 0.997, priceImpact: 0.001 } : { amountOut: 1.99, priceImpact: 0.002 }) },
      { name: "Kuru", quote: async (from, to) => { if (to !== "USDC") throw new Error("Kuru doesn't support this pair"); return { amountOut: 0.998, priceImpact: null }; } },
    ];
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const r = await inspectAddress(TOKEN);
    if (r.kind !== "token") throw new Error("expected token");
    expect(r.data.isTradable).toBe(true);
    expect(r.data.market.price).toBe("0.99800000"); // from getUsdPrice (8dp under $1), not derived from routes
    expect(r.data.market.priceQuoteAsset).toBe("USD");
    // Uniswap serves both pairs, Kuru serves only USDC -- 3 routes total.
    expect(r.data.market.routes).toHaveLength(3);
    expect(r.data.market.routes).toEqual(
      expect.arrayContaining([
        { provider: "Uniswap v3", inputToken: "USDT0", outputToken: "USDC", estimatedOutput: "0.997", priceImpact: "0.10%", available: true },
        { provider: "Uniswap v3", inputToken: "USDT0", outputToken: "MON", estimatedOutput: "1.99", priceImpact: "0.20%", available: true },
        { provider: "Kuru", inputToken: "USDT0", outputToken: "USDC", estimatedOutput: "0.998", priceImpact: null, available: true },
      ]),
    );
    expect(r.data.market.quoteAssetsChecked).toEqual(["USDC", "MON"]);
  });

  it("an unverified/arbitrary token with a real Uniswap pool is still correctly reported as tradable via the direct address probe", async () => {
    codeAt[TOKEN.toLowerCase()] = "0x6080604052";
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "RANDO", name: "Random Token", decimals: 18, verified: false });
    readContractImpl = () => 0n;
    quoteUniswapDirectImpl = async () => ({ amountOut: "5.0", priceImpact: "1.00%" });
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const r = await inspectAddress(TOKEN);
    if (r.kind !== "token") throw new Error("expected token");
    expect(r.data.isTradable).toBe(true);
    // resolveSwapSide is called per quote asset, so BOTH USDC and MON get
    // probed against the same mocked pool -- two routes, both via Uniswap.
    expect(r.data.market.routes.length).toBeGreaterThan(0);
    expect(r.data.market.routes.every((route) => route.provider === "Uniswap v3")).toBe(true);
  });

  it("a token with genuinely no liquidity anywhere is reported non-tradable, with a 'no_liquidity' signal, never fabricated as tradable", async () => {
    codeAt[TOKEN.toLowerCase()] = "0x6080604052";
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "DEAD", name: "Dead Token", decimals: 18, verified: false });
    readContractImpl = () => 0n;
    // quoteUniswapDirectImpl already defaults to null (no pool found).
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const r = await inspectAddress(TOKEN);
    if (r.kind !== "token") throw new Error("expected token");
    expect(r.data.isTradable).toBe(false);
    expect(r.data.market.routes).toEqual([]);
    expect(r.data.market.price).toBeNull();
    expect(r.data.market.signals).toContain("no_liquidity");
  });

  it("liquidity/volume24h/priceChange24h are null, never a fabricated zero, when no external data is available", async () => {
    codeAt[TOKEN.toLowerCase()] = "0x6080604052";
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "DEAD", name: "Dead Token", decimals: 18, verified: false });
    readContractImpl = () => 0n;
    // getDexScreenerSnapshotImpl already defaults to null (no pairs indexed for this token).
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const r = await inspectAddress(TOKEN);
    if (r.kind !== "token") throw new Error("expected token");
    expect(r.data.market.liquidity).toBeNull();
    expect(r.data.market.volume24h).toBeNull();
    expect(r.data.market.priceChange24h).toBeNull();
  });

  it("volume24h/transactions24h/buys24h/sells24h/priceChange24h are filled from DexScreener when it has data for this token", async () => {
    codeAt[TOKEN.toLowerCase()] = "0x6080604052";
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "PEPE", name: "Pepe Coin", decimals: 18, verified: false });
    readContractImpl = () => 0n;
    getDexScreenerSnapshotImpl = async () => ({
      volume24h: 123_456.789, transactions24h: 42, buys24h: 30, sells24h: 12, priceChange24h: 0.0512,
    });
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const r = await inspectAddress(TOKEN);
    if (r.kind !== "token") throw new Error("expected token");
    expect(r.data.market.volume24h).toBe("123,456.79");
    expect(r.data.market.transactions24h).toBe(42);
    expect(r.data.market.buys24h).toBe(30);
    expect(r.data.market.sells24h).toBe(12);
    expect(r.data.market.priceChange24h).toBe("+5.12%");
    // Never fabricated, even with DexScreener data available: no source for
    // a buy/sell volume split or holder counts.
    expect(r.data.market.buyVolume24h).toBeNull();
    expect(r.data.market.sellVolume24h).toBeNull();
    expect(r.data.market.holders).toBeNull();
  });

  it("a negative 24h price move formats with a minus sign, not a double sign or a bare magnitude", async () => {
    codeAt[TOKEN.toLowerCase()] = "0x6080604052";
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "PEPE", name: "Pepe Coin", decimals: 18, verified: false });
    readContractImpl = () => 0n;
    getDexScreenerSnapshotImpl = async () => ({ volume24h: 1, transactions24h: 1, buys24h: 1, sells24h: 0, priceChange24h: -0.031 });
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const r = await inspectAddress(TOKEN);
    if (r.kind !== "token") throw new Error("expected token");
    expect(r.data.market.priceChange24h).toBe("-3.10%");
  });

  it("DexScreener is queried by the token's own contract address, never a curated symbol", async () => {
    codeAt[TOKEN.toLowerCase()] = "0x6080604052";
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "PEPE", name: "Pepe Coin", decimals: 18, verified: false });
    readContractImpl = () => 0n;
    let queried: string | null = null;
    getDexScreenerSnapshotImpl = async (address) => { queried = address; return null; };
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    await inspectAddress(TOKEN);
    expect((queried as string | null)?.toLowerCase()).toBe(TOKEN.toLowerCase());
  });

  it("a route existing but genuinely too shallow to price honestly is NOT reported as untradable -- 'liquidity data unavailable, but a trading route was found'", async () => {
    codeAt[TOKEN.toLowerCase()] = "0x6080604052";
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "SHALLOW", name: "Shallow Pool Token", decimals: 18, verified: false });
    readContractImpl = () => 0n;
    quoteUniswapDirectImpl = async () => ({ amountOut: "0.000001", priceImpact: "50.00%" }); // a real (if tiny) route exists
    getUsdPriceImpl = async () => null; // prices.ts's own shallow-pool rejection kicked in
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const r = await inspectAddress(TOKEN);
    if (r.kind !== "token") throw new Error("expected token");
    expect(r.data.isTradable).toBe(true); // a route WAS found
    expect(r.data.market.routes.length).toBeGreaterThan(0);
    expect(r.data.market.price).toBeNull(); // but not reliably priceable
    expect(r.data.market.signals).toContain("quote_unavailable");
  });

  it("high price impact on the best route is surfaced as a signal, never silently hidden", async () => {
    codeAt[TOKEN.toLowerCase()] = "0x6080604052";
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "USDT0", name: "Tether USD", decimals: 6, verified: true });
    readContractImpl = () => 0n;
    getUsdPriceImpl = async () => 0.9;
    candidateProvidersImpl = async () => [
      { name: "Uniswap v3", quote: async () => ({ amountOut: 0.8, priceImpact: 0.2 }) }, // 20% > MAX_PRICE_IMPACT (15%)
    ];
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const r = await inspectAddress(TOKEN);
    if (r.kind !== "token") throw new Error("expected token");
    expect(r.data.market.signals).toContain("high_price_impact");
  });
});

describe("inspectAddress — contract-address identity (never symbol)", () => {
  it("two different contracts sharing the SAME symbol are priced from their OWN address, never confused with each other", async () => {
    // TOKEN is genuinely verified/curated; OTHER_TOKEN just happens to
    // report the same on-chain symbol but is NOT in the curated registry.
    codeAt[TOKEN.toLowerCase()] = "0x6080604052";
    codeAt[OTHER_TOKEN.toLowerCase()] = "0x6080604052";
    resolveTokenImpl = async (address: string) =>
      address.toLowerCase() === TOKEN.toLowerCase()
        ? { address: TOKEN, symbol: "USDT0", name: "Tether USD (real)", decimals: 6, verified: true }
        : { address: OTHER_TOKEN, symbol: "USDT0", name: "Tether USD (impostor)", decimals: 18, verified: false };
    readContractImpl = () => 0n;
    getUsdPriceImpl = async (address: string) => (address.toLowerCase() === TOKEN.toLowerCase() ? 1.0 : 0.0001);
    candidateProvidersImpl = async () => [
      { name: "Kuru", quote: async () => ({ amountOut: 0.999, priceImpact: null }) },
    ];
    quoteUniswapDirectImpl = async () => ({ amountOut: "0.0001", priceImpact: "5.00%" });

    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const real = await inspectAddress(TOKEN);
    const impostor = await inspectAddress(OTHER_TOKEN);
    if (real.kind !== "token" || impostor.kind !== "token") throw new Error("expected token for both");

    // The real, curated token goes through the symbol-safe aggregator (Kuru
    // shows up as a route) -- the impostor, despite sharing the SAME
    // symbol, never does (verified=false forces the address-only path).
    expect(real.data.verified).toBe(true);
    expect(real.data.market.routes.some((r) => r.provider === "Kuru")).toBe(true);
    expect(impostor.data.verified).toBe(false);
    expect(impostor.data.market.routes.every((r) => r.provider === "Uniswap v3")).toBe(true);
    // And their prices are genuinely independent -- never the curated
    // token's price leaking onto the impostor just because the symbol matches.
    expect(real.data.market.price).toBe("1.0000");
    expect(impostor.data.market.price).not.toBe(real.data.market.price);
  });
});

describe("inspectAddress — a specific requested amount is a real quote, not a scaled-up estimate", () => {
  it("quotes exactly the requested amount through a real route", async () => {
    codeAt[TOKEN.toLowerCase()] = "0x6080604052";
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "USDT0", name: "Tether USD", decimals: 6, verified: true });
    readContractImpl = () => 0n;
    getUsdPriceImpl = async () => 1;
    candidateProvidersImpl = async () => [
      { name: "Uniswap v3", quote: async (from, to, amountIn) => ({ amountOut: amountIn * 0.997, priceImpact: 0.001 }) },
    ];
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const r = await inspectAddress(TOKEN, null, { amount: "50", quoteAsset: "USDC" });
    if (r.kind !== "token") throw new Error("expected token");
    expect(r.data.quote).toEqual({ amount: "50", quoteAsset: "USDC", route: expect.objectContaining({ estimatedOutput: "49.85" }) });
  });

  it("no requested amount means no `quote` field at all -- not null, absent", async () => {
    codeAt[TOKEN.toLowerCase()] = "0x6080604052";
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "USDT0", name: "Tether USD", decimals: 6, verified: true });
    readContractImpl = () => 0n;
    candidateProvidersImpl = async () => [];
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const r = await inspectAddress(TOKEN);
    if (r.kind !== "token") throw new Error("expected token");
    expect("quote" in r.data).toBe(false);
  });

  it("a requested amount with no usable route reports route: null, never a fabricated number", async () => {
    codeAt[TOKEN.toLowerCase()] = "0x6080604052";
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "DEAD", name: "Dead Token", decimals: 18, verified: false });
    readContractImpl = () => 0n;
    // quoteUniswapDirectImpl already defaults to null (no pool found).
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const r = await inspectAddress(TOKEN, null, { amount: "50", quoteAsset: "USDC" });
    if (r.kind !== "token") throw new Error("expected token");
    expect(r.data.quote).toEqual({ amount: "50", quoteAsset: "USDC", route: null });
  });
});

/**
 * Step 5's market-data cache (separate from tokenRegistry's permanent
 * metadata cache and prices.ts's own 60s price cache — see probeMarket's
 * own doc). Before this existed, every inspectAddress() call re-ran the
 * full route-discovery fan-out (candidateProviders x quote assets) with no
 * caching at all, so "what's the price?" right after pasting a contract
 * address cost the full RPC fan-out twice for identical data.
 */
describe("inspectAddress — market-data caching (routes + price snapshot)", () => {
  function setUpVerifiedToken() {
    codeAt[TOKEN.toLowerCase()] = "0x6080604052";
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "PEPE", name: "Pepe Coin", decimals: 18, verified: true });
    readContractImpl = () => 0n;
  }

  it("a second lookup within the TTL is served from cache -- no repeat route-discovery RPC fan-out", async () => {
    setUpVerifiedToken();
    let calls = 0;
    candidateProvidersImpl = async () => [
      { name: "Uniswap v3", quote: async () => { calls += 1; return { amountOut: 100, priceImpact: 0.001 }; } },
    ];
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    await inspectAddress(TOKEN);
    const callsAfterFirst = calls;
    expect(callsAfterFirst).toBeGreaterThan(0);

    await inspectAddress(TOKEN);
    expect(calls).toBe(callsAfterFirst); // no new RPC round-trips -- served from cache
  });

  it("the cached snapshot's lastUpdated timestamp does not change on a cache hit -- an honest 'still the same snapshot', not a fabricated fresh one", async () => {
    setUpVerifiedToken();
    candidateProvidersImpl = async () => [{ name: "Uniswap v3", quote: async () => ({ amountOut: 100, priceImpact: 0.001 }) }];
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const first = await inspectAddress(TOKEN);
    const second = await inspectAddress(TOKEN);
    if (first.kind !== "token" || second.kind !== "token") throw new Error("expected token");
    expect(second.data.market.lastUpdated).toBe(first.data.market.lastUpdated);
  });

  it("a lookup after the TTL expires refreshes rather than serving stale routes forever", async () => {
    setUpVerifiedToken();
    let calls = 0;
    candidateProvidersImpl = async () => [
      { name: "Uniswap v3", quote: async () => { calls += 1; return { amountOut: 100, priceImpact: 0.001 }; } },
    ];
    vi.useFakeTimers();
    try {
      const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
      const first = await inspectAddress(TOKEN);
      const callsAfterFirst = calls;

      vi.advanceTimersByTime(21_000); // past the 20s market-data TTL
      const second = await inspectAddress(TOKEN);
      expect(calls).toBeGreaterThan(callsAfterFirst); // genuinely re-fetched
      if (first.kind !== "token" || second.kind !== "token") throw new Error("expected token");
      expect(second.data.market.lastUpdated).toBeGreaterThan(first.data.market.lastUpdated);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a specific-amount quote request is never served from the market cache -- always a fresh route lookup for that exact amount", async () => {
    setUpVerifiedToken();
    let calls = 0;
    candidateProvidersImpl = async () => [
      { name: "Uniswap v3", quote: async (_from, _to, amountIn) => { calls += 1; return { amountOut: amountIn * 2, priceImpact: 0.001 }; } },
    ];
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    await inspectAddress(TOKEN); // primes the market cache (amount "1")
    const callsAfterBaseline = calls;
    await inspectAddress(TOKEN, null, { amount: "50", quoteAsset: "USDC" });
    expect(calls).toBeGreaterThan(callsAfterBaseline); // a different amount always re-quotes, cache or not
  });

  it("two DIFFERENT tokens never share a cache entry -- each address gets its own snapshot", async () => {
    codeAt[TOKEN.toLowerCase()] = "0x6080604052";
    codeAt[OTHER_TOKEN.toLowerCase()] = "0x6080604052";
    resolveTokenImpl = async (address: string) =>
      address.toLowerCase() === TOKEN.toLowerCase()
        ? { address: TOKEN, symbol: "PEPE", name: "Pepe Coin", decimals: 18, verified: false }
        : { address: OTHER_TOKEN, symbol: "WOJAK", name: "Wojak Coin", decimals: 18, verified: false };
    readContractImpl = () => 0n;
    quoteUniswapDirectImpl = async (tokenIn) =>
      tokenIn.toLowerCase() === TOKEN.toLowerCase() ? { amountOut: "111", priceImpact: null } : { amountOut: "222", priceImpact: null };
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const a = await inspectAddress(TOKEN);
    const b = await inspectAddress(OTHER_TOKEN);
    if (a.kind !== "token" || b.kind !== "token") throw new Error("expected token");
    expect(a.data.market.routes[0]?.estimatedOutput).toBe("111");
    expect(b.data.market.routes[0]?.estimatedOutput).toBe("222");
  });
});

describe("inspectAddress — Nad.Fun (Step 6): status, availability, and route discovery", () => {
  it("a bonding-curve token with NO Uniswap pool yet is still correctly reported as tradable, via a Nad.Fun route", async () => {
    codeAt[TOKEN.toLowerCase()] = "0x6080604052";
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "MEOW", name: "Meow Coin", decimals: 18, verified: false });
    readContractImpl = () => 0n;
    // quoteUniswapDirectImpl defaults to null -- no pool exists pre-graduation.
    getNadFunStatusImpl = async () => ({ recognized: true, isGraduated: false, isLocked: false, status: "bonding_curve" });
    nadFunQuoteImpl = async (_token, _decimals, _amount, isBuy) => (isBuy ? null : { provider: "Nad.Fun", router: "0xrouter", amountOut: "0.42", isBuy: false });
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const r = await inspectAddress(TOKEN);
    if (r.kind !== "token") throw new Error("expected token");
    expect(r.data.isTradable).toBe(true);
    expect(r.data.market.routes).toContainEqual({ provider: "Nad.Fun", inputToken: "MEOW", outputToken: "MON", estimatedOutput: "0.42", priceImpact: null, available: true });
  });

  it("Nad.Fun and Uniswap can BOTH serve the MON pair at once (a newly-graduated token) -- both routes show up, neither replaces the other", async () => {
    codeAt[TOKEN.toLowerCase()] = "0x6080604052";
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "MEOW", name: "Meow Coin", decimals: 18, verified: false });
    readContractImpl = () => 0n;
    quoteUniswapDirectImpl = async (_tokenIn, _d1, tokenOut) =>
      tokenOut.toLowerCase() === "0xwmon00000000000000000000000000000000000" ? { amountOut: "0.40", priceImpact: "0.50%" } : null;
    getNadFunStatusImpl = async () => ({ recognized: true, isGraduated: true, isLocked: false, status: "graduated" });
    nadFunQuoteImpl = async (_token, _decimals, _amount, isBuy) => (isBuy ? null : { provider: "Nad.Fun", router: "0xrouter", amountOut: "0.42", isBuy: false });
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const r = await inspectAddress(TOKEN);
    if (r.kind !== "token") throw new Error("expected token");
    const monRoutes = r.data.market.routes.filter((route) => route.outputToken === "MON");
    expect(monRoutes.map((route) => route.provider).sort()).toEqual(["Nad.Fun", "Uniswap v3"]);
  });

  it("nadFun status is populated with bonding-curve capacity for a pre-graduation token", async () => {
    codeAt[TOKEN.toLowerCase()] = "0x6080604052";
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "MEOW", name: "Meow Coin", decimals: 18, verified: false });
    readContractImpl = () => 0n;
    getNadFunStatusImpl = async () => ({ recognized: true, isGraduated: false, isLocked: false, status: "bonding_curve" });
    nadFunAvailableBuyTokensImpl = async () => ({ availableToBuy: "500000", requiredMon: "12.5" });
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const r = await inspectAddress(TOKEN);
    if (r.kind !== "token") throw new Error("expected token");
    expect(r.data.nadFun).toEqual({ status: "bonding_curve", isLocked: false, availableToBuy: "500000", progressPct: null });
  });

  it("a graduated token's bonding-curve capacity/progress are never SURFACED, even though (Latency Task 3) the reads now fire unconditionally", async () => {
    codeAt[TOKEN.toLowerCase()] = "0x6080604052";
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "MEOW", name: "Meow Coin", decimals: 18, verified: false });
    readContractImpl = () => 0n;
    getNadFunStatusImpl = async () => ({ recognized: true, isGraduated: true, isLocked: false, status: "graduated" });
    // These now DO get called concurrently with getNadFunStatus (see the
    // Latency report) -- a real Lens response is stubbed here to prove the
    // call succeeding doesn't leak into the output; a prior version of this
    // test asserted the calls never happened at all, which was true only
    // because of the sequential wait this task deliberately removed.
    nadFunAvailableBuyTokensImpl = async () => ({ availableToBuy: "999999", requiredMon: "1" });
    getNadFunProgressImpl = async () => 100;
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const r = await inspectAddress(TOKEN);
    if (r.kind !== "token") throw new Error("expected token");
    expect(r.data.nadFun).toEqual({ status: "graduated", isLocked: false, availableToBuy: null, progressPct: null });
  });

  it("a locked (curve paused at target, pre-graduation) token reports isLocked: true", async () => {
    codeAt[TOKEN.toLowerCase()] = "0x6080604052";
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "MEOW", name: "Meow Coin", decimals: 18, verified: false });
    readContractImpl = () => 0n;
    getNadFunStatusImpl = async () => ({ recognized: true, isGraduated: false, isLocked: true, status: "locked" });
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const r = await inspectAddress(TOKEN);
    if (r.kind !== "token") throw new Error("expected token");
    expect(r.data.nadFun?.status).toBe("locked");
    expect(r.data.nadFun?.isLocked).toBe(true);
  });

  it("a token never recognized by Nad.Fun reports nadFun: null, not a fabricated 'unsupported' object", async () => {
    codeAt[TOKEN.toLowerCase()] = "0x6080604052";
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "USDT0", name: "Tether USD", decimals: 6, verified: true });
    readContractImpl = () => 0n;
    // getNadFunStatusImpl defaults to { recognized: false, ... }.
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const r = await inspectAddress(TOKEN);
    if (r.kind !== "token") throw new Error("expected token");
    expect(r.data.nadFun).toBeNull();
  });

  it("a token with no liquidity anywhere (Uniswap AND Nad.Fun) is still honestly reported non-tradable", async () => {
    codeAt[TOKEN.toLowerCase()] = "0x6080604052";
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "DEAD", name: "Dead Token", decimals: 18, verified: false });
    readContractImpl = () => 0n;
    // quoteUniswapDirectImpl and nadFunQuoteImpl both default to null/no route.
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const r = await inspectAddress(TOKEN);
    if (r.kind !== "token") throw new Error("expected token");
    expect(r.data.isTradable).toBe(false);
    expect(r.data.market.routes).toEqual([]);
  });
});

describe("inspectAddress — Step 7: market cap, FDV, liquidity, progress, creator, pool", () => {
  function totalSupplyReader(supplyWei: bigint) {
    return ({ functionName }: { functionName: string }) => (functionName === "totalSupply" ? supplyWei : 0n);
  }

  it("market cap and FDV are both price x totalSupply -- deliberately equal (no verified circulating-supply source)", async () => {
    codeAt[TOKEN.toLowerCase()] = "0x6080604052";
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "MEOW", name: "Meow Coin", decimals: 18, verified: false });
    readContractImpl = totalSupplyReader(1_000_000_000n * 10n ** 18n); // 1B tokens
    getUsdPriceImpl = async (addr) => (addr.toLowerCase() === TOKEN.toLowerCase() ? 0.002 : null); // token price only
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const r = await inspectAddress(TOKEN);
    if (r.kind !== "token") throw new Error("expected token");
    expect(r.data.market.marketCapUsd).toBe("2,000,000");
    expect(r.data.market.fdvUsd).toBe(r.data.market.marketCapUsd);
  });

  it("no usable price -> market cap and FDV are honestly null, never a fabricated figure", async () => {
    codeAt[TOKEN.toLowerCase()] = "0x6080604052";
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "MEOW", name: "Meow Coin", decimals: 18, verified: false });
    readContractImpl = totalSupplyReader(1_000_000_000n * 10n ** 18n);
    // getUsdPriceImpl defaults to null.
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const r = await inspectAddress(TOKEN);
    if (r.kind !== "token") throw new Error("expected token");
    expect(r.data.market.marketCapUsd).toBeNull();
    expect(r.data.market.fdvUsd).toBeNull();
  });

  it("no readable totalSupply -> market cap and FDV are null even with a real price", async () => {
    codeAt[TOKEN.toLowerCase()] = "0x6080604052";
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "MEOW", name: "Meow Coin", decimals: 18, verified: false });
    readContractImpl = ({ functionName }) => { if (functionName === "totalSupply") throw new Error("revert"); return 0n; };
    getUsdPriceImpl = async () => 1;
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const r = await inspectAddress(TOKEN);
    if (r.kind !== "token") throw new Error("expected token");
    expect(r.data.totalSupply).toBeNull();
    expect(r.data.market.marketCapUsd).toBeNull();
  });

  it("bonding-curve liquidity: real (not virtual) curve reserves, labeled distinctly, never combined with a DEX figure", async () => {
    codeAt[TOKEN.toLowerCase()] = "0x6080604052";
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "MEOW", name: "Meow Coin", decimals: 18, verified: false });
    readContractImpl = () => 0n;
    getNadFunStatusImpl = async () => ({ recognized: true, isGraduated: false, isLocked: false, status: "bonding_curve" });
    getNadFunCurveReservesImpl = async () => ({ realMon: "10", realToken: "500000", virtualMon: "180000", virtualToken: "1073000191" });
    getUsdPriceImpl = async (addr) => (addr === NATIVE_TOKEN_ADDRESS ? 2 : null); // MON = $2
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const r = await inspectAddress(TOKEN);
    if (r.kind !== "token") throw new Error("expected token");
    expect(r.data.market.liquidity).toEqual({ label: "Bonding Curve Liquidity", mon: "20", usd: "40", pool: null });
  });

  it("graduated DEX liquidity: real pool reserves, distinct label, includes the pool address", async () => {
    codeAt[TOKEN.toLowerCase()] = "0x6080604052";
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "MEOW", name: "Meow Coin", decimals: 18, verified: false });
    readContractImpl = () => 0n;
    getNadFunStatusImpl = async () => ({ recognized: true, isGraduated: true, isLocked: false, status: "graduated" });
    getNadFunGraduatedPoolLiquidityImpl = async () => ({ pool: "0x9999888877776666555544443333222211110000", monReserve: "50", tokenReserve: "2500" });
    getUsdPriceImpl = async (addr) => (addr === NATIVE_TOKEN_ADDRESS ? 2 : null);
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const r = await inspectAddress(TOKEN);
    if (r.kind !== "token") throw new Error("expected token");
    expect(r.data.market.liquidity).toEqual({
      label: "DEX Liquidity", mon: "100", usd: "200", pool: "0x9999888877776666555544443333222211110000",
    });
  });

  it("a non-Nad.Fun token has no liquidity figure -- honestly null, never a v3-pool guess", async () => {
    codeAt[TOKEN.toLowerCase()] = "0x6080604052";
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "USDT0", name: "Tether USD", decimals: 6, verified: true });
    readContractImpl = () => 0n;
    // getNadFunStatusImpl defaults to unrecognized.
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const r = await inspectAddress(TOKEN);
    if (r.kind !== "token") throw new Error("expected token");
    expect(r.data.market.liquidity).toBeNull();
  });

  it("bonding-curve progress is surfaced 0-100, and reused from the Lens, never re-derived from a guessed formula", async () => {
    codeAt[TOKEN.toLowerCase()] = "0x6080604052";
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "MEOW", name: "Meow Coin", decimals: 18, verified: false });
    readContractImpl = () => 0n;
    getNadFunStatusImpl = async () => ({ recognized: true, isGraduated: false, isLocked: false, status: "bonding_curve" });
    getNadFunProgressImpl = async () => 78.42;
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const r = await inspectAddress(TOKEN);
    if (r.kind !== "token") throw new Error("expected token");
    expect(r.data.nadFun?.progressPct).toBe(78.42);
  });

  it("creator, pool (bonding-curve pool pre-graduation) and creation time come from the one CurveCreate log", async () => {
    codeAt[TOKEN.toLowerCase()] = "0x6080604052";
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "MEOW", name: "Meow Coin", decimals: 18, verified: false });
    readContractImpl = () => 0n;
    getNadFunStatusImpl = async () => ({ recognized: true, isGraduated: false, isLocked: false, status: "bonding_curve" });
    getNadFunCreatorInfoImpl = async () => ({ creator: "0xcccc111122223333444455556666777788889999", curvePool: "0xdddd111122223333444455556666777788889999", createdAt: 1_700_000_000_000 });
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const r = await inspectAddress(TOKEN);
    if (r.kind !== "token") throw new Error("expected token");
    expect(r.data.creator).toBe("0xcccc111122223333444455556666777788889999");
    expect(r.data.pool).toBe("0xdddd111122223333444455556666777788889999"); // the bonding-curve pool -- no DEX pool exists yet
    expect(r.data.createdAt).toBe(1_700_000_000_000);
  });

  it("once graduated, the ACTIVE pool shown is the DEX pool, never the obsolete bonding-curve pool", async () => {
    codeAt[TOKEN.toLowerCase()] = "0x6080604052";
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "MEOW", name: "Meow Coin", decimals: 18, verified: false });
    readContractImpl = () => 0n;
    getNadFunStatusImpl = async () => ({ recognized: true, isGraduated: true, isLocked: false, status: "graduated" });
    getNadFunCreatorInfoImpl = async () => ({ creator: "0xcccc111122223333444455556666777788889999", curvePool: "0xOLD_BONDING_CURVE_POOL_00000000000000000", createdAt: 1 });
    getNadFunGraduatedPoolLiquidityImpl = async () => ({ pool: "0xNEW_DEX_POOL_0000000000000000000000000000", monReserve: "50", tokenReserve: "2500" });
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const r = await inspectAddress(TOKEN);
    if (r.kind !== "token") throw new Error("expected token");
    expect(r.data.pool).toBe("0xNEW_DEX_POOL_0000000000000000000000000000");
    expect(r.data.pool).not.toBe("0xOLD_BONDING_CURVE_POOL_00000000000000000");
  });

  it("a non-Nad.Fun token has creator/pool/createdAt all null -- absent, not a failed lookup", async () => {
    codeAt[TOKEN.toLowerCase()] = "0x6080604052";
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "USDT0", name: "Tether USD", decimals: 6, verified: true });
    readContractImpl = () => 0n;
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const r = await inspectAddress(TOKEN);
    if (r.kind !== "token") throw new Error("expected token");
    expect(r.data.creator).toBeNull();
    expect(r.data.pool).toBeNull();
    expect(r.data.createdAt).toBeNull();
  });

  it("buy-volume/sell-volume/holders are honestly unavailable regardless -- never approximated or split from a partial source; volume/transactions/buys/sells are null too when DexScreener has no data for this token yet (e.g. a fresh bonding-curve launch)", async () => {
    codeAt[TOKEN.toLowerCase()] = "0x6080604052";
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "MEOW", name: "Meow Coin", decimals: 18, verified: false });
    readContractImpl = () => 0n;
    getNadFunStatusImpl = async () => ({ recognized: true, isGraduated: false, isLocked: false, status: "bonding_curve" });
    // getDexScreenerSnapshotImpl already defaults to null (no pairs indexed yet).
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const r = await inspectAddress(TOKEN);
    if (r.kind !== "token") throw new Error("expected token");
    expect(r.data.market.volume24h).toBeNull();
    expect(r.data.market.buyVolume24h).toBeNull();
    expect(r.data.market.sellVolume24h).toBeNull();
    expect(r.data.market.transactions24h).toBeNull();
    expect(r.data.market.buys24h).toBeNull();
    expect(r.data.market.sells24h).toBeNull();
    expect(r.data.market.holders).toBeNull();
  });

  it("Part 9 #27: two different contracts with the SAME symbol never share market data -- identity is the address, not the symbol", async () => {
    const TOKEN_B = "0xbbbbccccddddeeeeffff000011112222333344a4";
    resolveTokenImpl = async (address: string) =>
      address.toLowerCase() === TOKEN.toLowerCase()
        ? { address: TOKEN, symbol: "MEOW", name: "Real Meow", decimals: 18, verified: false }
        : { address: TOKEN_B, symbol: "MEOW", name: "Fake Meow (different contract, same symbol)", decimals: 18, verified: false };
    codeAt[TOKEN.toLowerCase()] = "0x6080604052";
    codeAt[TOKEN_B.toLowerCase()] = "0x6080604052";
    readContractImpl = () => 0n;
    getNadFunStatusImpl = async (token: string) =>
      token.toLowerCase() === TOKEN.toLowerCase()
        ? { recognized: true, isGraduated: false, isLocked: false, status: "bonding_curve" }
        : { recognized: false, isGraduated: false, isLocked: false, status: "unsupported" };
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const a = await inspectAddress(TOKEN);
    const b = await inspectAddress(TOKEN_B);
    if (a.kind !== "token" || b.kind !== "token") throw new Error("expected token");
    expect(a.data.name).toBe("Real Meow");
    expect(a.data.nadFun).not.toBeNull();
    expect(b.data.name).toBe("Fake Meow (different contract, same symbol)");
    expect(b.data.nadFun).toBeNull(); // NOT treated as the same token just because the symbol matches
  });

  it("an RPC failure on the Nad.Fun-specific reads degrades honestly (null fields) rather than breaking the whole lookup", async () => {
    codeAt[TOKEN.toLowerCase()] = "0x6080604052";
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "MEOW", name: "Meow Coin", decimals: 18, verified: false });
    readContractImpl = totalSupplyReader(1_000_000_000n * 10n ** 18n);
    getUsdPriceImpl = async (addr) => (addr.toLowerCase() === TOKEN.toLowerCase() ? 0.002 : null);
    getNadFunStatusImpl = async () => ({ recognized: true, isGraduated: false, isLocked: false, status: "bonding_curve" });
    getNadFunCurveReservesImpl = async () => null; // simulates the underlying RPC/read failure
    getNadFunProgressImpl = async () => null;
    getNadFunCreatorInfoImpl = async () => null;
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const r = await inspectAddress(TOKEN);
    if (r.kind !== "token") throw new Error("expected token");
    // The token is still identified and priced -- only the Nad.Fun-specific
    // extras that genuinely failed are missing, nothing fabricated in their place.
    expect(r.data.market.marketCapUsd).toBe("2,000,000");
    expect(r.data.market.liquidity).toBeNull();
    expect(r.data.nadFun).toEqual({ status: "bonding_curve", isLocked: false, availableToBuy: null, progressPct: null });
    expect(r.data.creator).toBeNull();
  });
});

describe("inspectAddress — Latency Task 3: availableBuyTokens/getProgress no longer wait for status", () => {
  it("nadFunAvailableBuyTokens and getNadFunProgress are called BEFORE getNadFunStatus resolves, not after", async () => {
    codeAt[TOKEN.toLowerCase()] = "0x6080604052";
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "MEOW", name: "Meow Coin", decimals: 18, verified: false });
    readContractImpl = () => 0n;

    const order: string[] = [];
    let releaseStatus: () => void = () => {};
    const statusGate = new Promise<void>((resolve) => { releaseStatus = resolve; });

    getNadFunStatusImpl = async () => {
      order.push("status:start");
      await statusGate; // deliberately held open, so anything that waited for THIS to resolve first would deadlock/never record its own start before status finishes
      order.push("status:end");
      return { recognized: true, isGraduated: false, isLocked: false, status: "bonding_curve" };
    };
    nadFunAvailableBuyTokensImpl = async () => {
      order.push("availability:start"); // must be recorded before status:end if these are truly concurrent
      return { availableToBuy: "500", requiredMon: "1" };
    };
    getNadFunProgressImpl = async () => {
      order.push("progress:start");
      return 42;
    };

    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const pending = inspectAddress(TOKEN);
    // Give the concurrent reads a microtask turn to start before status
    // resolves -- if availableBuyTokens/getProgress were still gated behind
    // status (the old sequential behavior), neither would have recorded
    // "start" yet at this point.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toContain("availability:start");
    expect(order).toContain("progress:start");
    expect(order).not.toContain("status:end");

    releaseStatus();
    const r = await pending;
    if (r.kind !== "token") throw new Error("expected token");
    expect(r.data.nadFun).toEqual({ status: "bonding_curve", isLocked: false, availableToBuy: "500", progressPct: 42 });
  });

  it("getNadFunCreatorInfo stays gated on a CONFIRMED recognized status -- it is a getLogs call, not a cheap Lens view read, so it is not fired speculatively", async () => {
    codeAt[TOKEN.toLowerCase()] = "0x6080604052";
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "USDT0", name: "Tether USD", decimals: 6, verified: true });
    readContractImpl = () => 0n;
    // getNadFunStatusImpl defaults to unrecognized.
    getNadFunCreatorInfoImpl = async () => { throw new Error("must not be probed for a token the Lens doesn't recognize"); };
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const r = await inspectAddress(TOKEN);
    if (r.kind !== "token") throw new Error("expected token");
    expect(r.data.creator).toBeNull();
  });
});
