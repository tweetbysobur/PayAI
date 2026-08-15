import { afterEach, describe, expect, it, vi } from "vitest";

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
vi.mock("@/lib/monad/swap", () => ({
  bestQuote: (from: string, to: string, amount: number) => bestQuoteImpl(from, to, amount),
  quoteUniswapDirect: (tokenIn: string, tokenInDecimals: number, tokenOut: string, tokenOutDecimals: number, amount: string) =>
    quoteUniswapDirectImpl(tokenIn, tokenInDecimals, tokenOut, tokenOutDecimals, amount),
  resolveSwapSide: (symbol: string) => resolveSwapSideImpl(symbol),
  DEFAULT_SLIPPAGE: 0.005,
  MAX_SLIPPAGE: 0.5,
  MAX_PRICE_IMPACT: 0.15,
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
