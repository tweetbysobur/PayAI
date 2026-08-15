import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * lib/monad/tokenIntelligence.ts's only external inputs are the chain
 * (getCode / readContract / simulateContract), the token registry
 * (resolveToken), the swap aggregator (candidateProviders /
 * estimatePriceImpact / resolveSwapSide), and lib/monad/prices's
 * getUsdPrice — stub all of them so these tests exercise the real
 * classification/routing/formatting logic without touching a real RPC,
 * DEX, or external price source.
 */

let codeAt: Record<string, string | undefined> = {};
let readContractImpl: (args: { address: string; functionName: string; args?: unknown[] }) => unknown = () => {
  throw new Error("unexpected readContract call");
};
let simulateContractImpl: (args: { functionName: string; args: unknown[] }) => unknown = () => {
  throw new Error("unexpected simulateContract call");
};
let getCodeShouldThrow = false;

vi.mock("@/lib/monad/wallet", () => ({
  getPublicClient: () => ({
    getCode: async ({ address }: { address: string }) => {
      if (getCodeShouldThrow) throw new Error("RPC unreachable");
      return codeAt[address.toLowerCase()];
    },
    readContract: async (args: { address: string; functionName: string; args?: unknown[] }) => readContractImpl(args),
    simulateContract: async (args: { functionName: string; args: unknown[] }) => simulateContractImpl(args),
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
vi.mock("@/lib/monad/tokenRegistry", () => ({
  resolveToken: (address: string) => resolveTokenImpl(address),
}));

type MockProvider = { name: string; quote: (from: string, to: string, amountIn: number) => Promise<{ amountOut: number; priceImpact: number | null }> };
let candidateProvidersImpl: () => Promise<MockProvider[]> = async () => [];
let estimatePriceImpactImpl: () => Promise<number | null> = async () => null;
let resolveSwapSideImpl: (symbol: string) => Promise<{ symbol: string; routeAddress: string; decimals: number; isNative: boolean }> = async (symbol) => ({
  symbol, routeAddress: symbol === "USDC" ? STABLECOIN.address : "0xwmon00000000000000000000000000000000000", decimals: symbol === "USDC" ? 6 : 18, isNative: symbol !== "USDC",
});
vi.mock("@/lib/monad/swap", () => ({
  candidateProviders: () => candidateProvidersImpl(),
  estimatePriceImpact: () => estimatePriceImpactImpl(),
  MAX_PRICE_IMPACT: 0.15,
  resolveSwapSide: (symbol: string) => resolveSwapSideImpl(symbol),
}));

let getUsdPriceImpl: (address: string) => Promise<number | null> = async () => null;
vi.mock("@/lib/monad/prices", () => ({
  getUsdPrice: (address: string) => getUsdPriceImpl(address),
}));

afterEach(() => {
  vi.restoreAllMocks();
  network = "mainnet";
  codeAt = {};
  getCodeShouldThrow = false;
  readContractImpl = () => { throw new Error("unexpected readContract call"); };
  simulateContractImpl = () => { throw new Error("unexpected simulateContract call"); };
  resolveTokenImpl = async () => { throw new Error("not an ERC-20"); };
  candidateProvidersImpl = async () => [];
  estimatePriceImpactImpl = async () => null;
  resolveSwapSideImpl = async (symbol: string) => ({ symbol, routeAddress: symbol === "USDC" ? STABLECOIN.address : "0xwmon00000000000000000000000000000000000", decimals: symbol === "USDC" ? 6 : 18, isNative: symbol !== "USDC" });
  getUsdPriceImpl = async () => null;
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
    simulateContractImpl = ({ args }) => {
      const fee = (args[0] as { fee: number }).fee;
      return { result: [fee === 3000 ? 5_000000n : 0n, 0n, 0, 0n] }; // only the 0.3% tier has a real pool
    };
    estimatePriceImpactImpl = async () => 0.01;
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
    simulateContractImpl = () => { throw new Error("execution reverted"); }; // every fee tier reverts, no pool
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const r = await inspectAddress(TOKEN);
    if (r.kind !== "token") throw new Error("expected token");
    expect(r.data.isTradable).toBe(false);
    expect(r.data.market.routes).toEqual([]);
    expect(r.data.market.price).toBeNull();
    expect(r.data.market.signals).toContain("no_liquidity");
  });

  it("liquidity/volume24h/priceChange24h are always reported as null, never a fabricated zero -- no indexer is wired in", async () => {
    codeAt[TOKEN.toLowerCase()] = "0x6080604052";
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "DEAD", name: "Dead Token", decimals: 18, verified: false });
    readContractImpl = () => 0n;
    simulateContractImpl = () => { throw new Error("execution reverted"); };
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const r = await inspectAddress(TOKEN);
    if (r.kind !== "token") throw new Error("expected token");
    expect(r.data.market.liquidity).toBeNull();
    expect(r.data.market.volume24h).toBeNull();
    expect(r.data.market.priceChange24h).toBeNull();
  });

  it("a route existing but genuinely too shallow to price honestly is NOT reported as untradable -- 'liquidity data unavailable, but a trading route was found'", async () => {
    codeAt[TOKEN.toLowerCase()] = "0x6080604052";
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "SHALLOW", name: "Shallow Pool Token", decimals: 18, verified: false });
    readContractImpl = () => 0n;
    simulateContractImpl = ({ args }) => {
      const fee = (args[0] as { fee: number }).fee;
      return { result: [fee === 3000 ? 100n : 0n, 0n, 0, 0n] }; // a real (if tiny) route exists
    };
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
    simulateContractImpl = ({ args }) => {
      const fee = (args[0] as { fee: number }).fee;
      return { result: [fee === 3000 ? 1n : 0n, 0n, 0, 0n] };
    };

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
    simulateContractImpl = () => { throw new Error("execution reverted"); };
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const r = await inspectAddress(TOKEN, null, { amount: "50", quoteAsset: "USDC" });
    if (r.kind !== "token") throw new Error("expected token");
    expect(r.data.quote).toEqual({ amount: "50", quoteAsset: "USDC", route: null });
  });
});
