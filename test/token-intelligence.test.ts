import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * lib/monad/tokenIntelligence.ts's only external inputs are the chain
 * (getCode / readContract / simulateContract), the token registry
 * (resolveToken), and the swap aggregator (bestQuote / resolveSwapSide) —
 * stub all four so these tests exercise the real classification/formatting
 * logic without touching a real RPC or DEX.
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

let bestQuoteImpl: (from: string, to: string, amountIn: number) => Promise<{ provider: { name: string }; quote: { amountOut: number } }> = async () => {
  throw new Error("no route");
};
let resolveSwapSideImpl: (symbol: string) => Promise<{ symbol: string; routeAddress: string; decimals: number; isNative: boolean }> = async (symbol) => ({
  symbol, routeAddress: STABLECOIN.address, decimals: STABLECOIN.decimals, isNative: false,
});
vi.mock("@/lib/monad/swap", () => ({
  bestQuote: (from: string, to: string, amountIn: number) => bestQuoteImpl(from, to, amountIn),
  resolveSwapSide: (symbol: string) => resolveSwapSideImpl(symbol),
}));

afterEach(() => {
  vi.restoreAllMocks();
  network = "mainnet";
  codeAt = {};
  getCodeShouldThrow = false;
  readContractImpl = () => { throw new Error("unexpected readContract call"); };
  simulateContractImpl = () => { throw new Error("unexpected simulateContract call"); };
  resolveTokenImpl = async () => { throw new Error("not an ERC-20"); };
  bestQuoteImpl = async () => { throw new Error("no route"); };
  resolveSwapSideImpl = async (symbol: string) => ({ symbol, routeAddress: STABLECOIN.address, decimals: STABLECOIN.decimals, isNative: false });
});

const TOKEN = "0xaaaabbbbccccddddeeeeffff0000111122223333";
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
    // codeAt has no entry at all -> undefined, same as an EOA
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

describe("inspectAddress — tradability and market data", () => {
  it("a verified token reuses the real aggregator (Uniswap+Kuru) and reports which DEX served the quote", async () => {
    codeAt[TOKEN.toLowerCase()] = "0x6080604052";
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "USDT0", name: "Tether USD", decimals: 6, verified: true });
    readContractImpl = () => 0n;
    bestQuoteImpl = async (from, to) => {
      expect(from).toBe("USDT0");
      expect(to).toBe("USDC");
      return { provider: { name: "Kuru" }, quote: { amountOut: 0.998 } };
    };
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const r = await inspectAddress(TOKEN);
    if (r.kind !== "token") throw new Error("expected token");
    expect(r.data.isTradable).toBe(true);
    expect(r.data.market.price).toBe("0.998");
    expect(r.data.market.priceQuoteAsset).toBe("USDC");
    expect(r.data.market.pairs).toEqual([{ dex: "Kuru", base: "USDT0", quote: "USDC" }]);
  });

  it("an unverified/arbitrary token with a real Uniswap pool is still correctly reported as tradable via the direct address probe", async () => {
    codeAt[TOKEN.toLowerCase()] = "0x6080604052";
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "RANDO", name: "Random Token", decimals: 18, verified: false });
    readContractImpl = () => 0n;
    // bestQuoteImpl stays throwing (unverified tokens never go through the
    // curated-symbol aggregator) -- only the direct probe should be hit.
    simulateContractImpl = ({ args }) => {
      const fee = (args[0] as { fee: number }).fee;
      // Only the 3000 (0.3%) tier has a real pool.
      return { result: [fee === 3000 ? 5_000000n : 0n, 0n, 0, 0n] };
    };
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const r = await inspectAddress(TOKEN);
    if (r.kind !== "token") throw new Error("expected token");
    expect(r.data.isTradable).toBe(true);
    expect(r.data.market.pairs).toEqual([{ dex: "Uniswap v3", base: "RANDO", quote: "USDC" }]);
    expect(r.data.market.price).not.toBeNull();
  });

  it("a token with genuinely no liquidity anywhere is reported non-tradable -- existing is never confused with tradable", async () => {
    codeAt[TOKEN.toLowerCase()] = "0x6080604052";
    resolveTokenImpl = async () => ({ address: TOKEN, symbol: "DEAD", name: "Dead Token", decimals: 18, verified: false });
    readContractImpl = () => 0n;
    simulateContractImpl = () => { throw new Error("execution reverted"); }; // every fee tier reverts, no pool
    const { inspectAddress } = await import("@/lib/monad/tokenIntelligence");
    const r = await inspectAddress(TOKEN);
    if (r.kind !== "token") throw new Error("expected token");
    expect(r.data.isTradable).toBe(false);
    expect(r.data.market.pairs).toEqual([]);
    expect(r.data.market.price).toBeNull();
  });

  it("missing market data is reported as null, never as a fabricated zero", async () => {
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
});
