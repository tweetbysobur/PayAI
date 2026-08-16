import { afterEach, describe, it, expect, vi } from "vitest";
import { decodeFunctionData } from "viem";

/**
 * lib/monad/nadfun.ts's only external input is the chain (readContract
 * against the Lens and, for sells, the token's own ERC-20 allowance) — stub
 * it so these tests exercise the real detection/quoting/plan-building logic
 * without a real RPC. Dispatch is keyed on `address` (which contract) and
 * `functionName`, mirroring test/swap.test.ts's own established pattern.
 */

interface ReadCall { address: string; functionName: string; args: unknown[] }
let onRead: (call: ReadCall) => unknown = () => {
  throw new Error("readContract not stubbed for this call");
};
let onGetLogs: (args: { address: string; args?: Record<string, unknown> }) => unknown[] = () => {
  throw new Error("getLogs not stubbed for this call");
};
let onGetBlock: (args: { blockNumber: bigint }) => { timestamp: bigint } = () => {
  throw new Error("getBlock not stubbed for this call");
};

vi.mock("@/lib/monad/wallet", () => ({
  getPublicClient: () => ({
    readContract: async ({ address, functionName, args }: ReadCall) => onRead({ address, functionName, args: args ?? [] }),
    getLogs: async (args: { address: string; args?: Record<string, unknown> }) => onGetLogs(args),
    getBlock: async (args: { blockNumber: bigint }) => onGetBlock(args),
  }),
}));

let network: "mainnet" | "testnet" = "mainnet";
vi.mock("@/lib/monad/config", () => ({ getNetwork: () => network }));

const TOKEN = "0xaaaabbbbccccddddeeeeffff0000111122223333";
const WALLET = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
// A contract that is NOT one of Nad.Fun's two official routers.
const ATTACKER = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

async function loadNadFun() {
  return import("@/lib/monad/nadfun");
}

afterEach(() => {
  vi.restoreAllMocks();
  network = "mainnet";
  onRead = () => { throw new Error("readContract not stubbed for this call"); };
  onGetLogs = () => { throw new Error("getLogs not stubbed for this call"); };
  onGetBlock = () => { throw new Error("getBlock not stubbed for this call"); };
});

describe("getNadFunStatus — detection by contract address only", () => {
  it("bonding-curve token: not graduated, not locked", async () => {
    onRead = ({ functionName }) => {
      if (functionName === "isGraduated") return false;
      if (functionName === "isLocked") return false;
      throw new Error(`unexpected: ${functionName}`);
    };
    const { getNadFunStatus, __testing } = await loadNadFun();
    const r = await getNadFunStatus(TOKEN as `0x${string}`);
    expect(r).toEqual({ recognized: true, isGraduated: false, isLocked: false, status: "bonding_curve" });
    expect(__testing.NADFUN_MAINNET.lens).toMatch(/^0x/);
  });

  it("graduated token", async () => {
    onRead = ({ functionName }) => {
      if (functionName === "isGraduated") return true;
      if (functionName === "isLocked") return false;
      throw new Error(`unexpected: ${functionName}`);
    };
    const { getNadFunStatus } = await loadNadFun();
    const r = await getNadFunStatus(TOKEN as `0x${string}`);
    expect(r.status).toBe("graduated");
  });

  it("locked (pre-graduation curve paused at target) token", async () => {
    onRead = ({ functionName }) => {
      if (functionName === "isGraduated") return false;
      if (functionName === "isLocked") return true;
      throw new Error(`unexpected: ${functionName}`);
    };
    const { getNadFunStatus } = await loadNadFun();
    const r = await getNadFunStatus(TOKEN as `0x${string}`);
    expect(r.status).toBe("locked");
  });

  it("graduated wins over locked when somehow both are set", async () => {
    onRead = ({ functionName }) => {
      if (functionName === "isGraduated") return true;
      if (functionName === "isLocked") return true;
      throw new Error(`unexpected: ${functionName}`);
    };
    const { getNadFunStatus } = await loadNadFun();
    const r = await getNadFunStatus(TOKEN as `0x${string}`);
    expect(r.status).toBe("graduated");
  });

  it("an address the Lens doesn't recognize (reverts) is honestly unsupported, never guessed", async () => {
    onRead = () => { throw new Error("execution reverted"); };
    const { getNadFunStatus } = await loadNadFun();
    const r = await getNadFunStatus(TOKEN as `0x${string}`);
    expect(r).toEqual({ recognized: false, isGraduated: false, isLocked: false, status: "unsupported" });
  });

  it("unavailable outside mainnet — never probes the chain", async () => {
    network = "testnet";
    onRead = () => { throw new Error("must not be called on testnet"); };
    const { getNadFunStatus } = await loadNadFun();
    const r = await getNadFunStatus(TOKEN as `0x${string}`);
    expect(r.recognized).toBe(false);
  });
});

describe("nadFunQuote — buy/sell via the Lens, router named by the Lens itself", () => {
  it("buy: spends MON (18dp), quotes the token amount out (18dp), reports the router Lens returned", async () => {
    const { __testing } = await loadNadFun();
    onRead = ({ functionName, args }) => {
      expect(functionName).toBe("getAmountOut");
      const [token, amountIn, isBuy] = args as [string, bigint, boolean];
      expect(token.toLowerCase()).toBe(TOKEN.toLowerCase());
      expect(amountIn).toBe(1_000000000000000000n); // 1 MON
      expect(isBuy).toBe(true);
      return [__testing.NADFUN_MAINNET.bondingCurveRouter, 9000_000000000000000000n];
    };
    const { nadFunQuote } = await loadNadFun();
    const q = await nadFunQuote(TOKEN as `0x${string}`, 18, "1", true);
    expect(q).toEqual({ provider: "Nad.Fun", router: __testing.NADFUN_MAINNET.bondingCurveRouter, amountOut: "9000", isBuy: true });
  });

  it("sell: spends the token (its own decimals), quotes MON out (18dp)", async () => {
    const { __testing } = await loadNadFun();
    onRead = ({ args }) => {
      const [, amountIn, isBuy] = args as [string, bigint, boolean];
      expect(amountIn).toBe(1000_000000n); // 1000 tokens at 6dp
      expect(isBuy).toBe(false);
      return [__testing.NADFUN_MAINNET.dexRouter, 500000000000000000n]; // 0.5 MON
    };
    const { nadFunQuote } = await loadNadFun();
    const q = await nadFunQuote(TOKEN as `0x${string}`, 6, "1000", false);
    expect(q).toEqual({ provider: "Nad.Fun", router: __testing.NADFUN_MAINNET.dexRouter, amountOut: "0.5", isBuy: false });
  });

  it("a router the Lens names that ISN'T one of the two official contracts is refused — never trusted blindly", async () => {
    onRead = () => [ATTACKER, 9000n];
    const { nadFunQuote } = await loadNadFun();
    const q = await nadFunQuote(TOKEN as `0x${string}`, 18, "1", true);
    expect(q).toBeNull();
  });

  it("a zero/negative amountOut is not a usable route", async () => {
    const { __testing } = await loadNadFun();
    onRead = () => [__testing.NADFUN_MAINNET.bondingCurveRouter, 0n];
    const { nadFunQuote } = await loadNadFun();
    const q = await nadFunQuote(TOKEN as `0x${string}`, 18, "1", true);
    expect(q).toBeNull();
  });

  it("a revert (token not recognized) yields null, not a fabricated quote", async () => {
    onRead = () => { throw new Error("execution reverted"); };
    const { nadFunQuote } = await loadNadFun();
    const q = await nadFunQuote(TOKEN as `0x${string}`, 18, "1", true);
    expect(q).toBeNull();
  });
});

describe("nadFunAvailableBuyTokens — bonding-curve capacity", () => {
  it("reports available token + required MON in human units", async () => {
    onRead = ({ functionName }) => {
      expect(functionName).toBe("availableBuyTokens");
      return [500_000000000000000000n, 10_000000000000000000n];
    };
    const { nadFunAvailableBuyTokens } = await loadNadFun();
    const r = await nadFunAvailableBuyTokens(TOKEN as `0x${string}`, 18);
    expect(r).toEqual({ availableToBuy: "500", requiredMon: "10" });
  });

  it("null when unreadable (already graduated / not a Nad.Fun token)", async () => {
    onRead = () => { throw new Error("execution reverted"); };
    const { nadFunAvailableBuyTokens } = await loadNadFun();
    const r = await nadFunAvailableBuyTokens(TOKEN as `0x${string}`, 18);
    expect(r).toBeNull();
  });
});

const ROUTER_BUY_ABI = [
  { type: "function", name: "buy", stateMutability: "payable", inputs: [{ name: "params", type: "tuple", components: [
    { name: "amountOutMin", type: "uint256" }, { name: "token", type: "address" }, { name: "to", type: "address" }, { name: "deadline", type: "uint256" },
  ] }], outputs: [] },
] as const;
const ROUTER_SELL_ABI = [
  { type: "function", name: "sell", stateMutability: "nonpayable", inputs: [{ name: "params", type: "tuple", components: [
    { name: "amountIn", type: "uint256" }, { name: "amountOutMin", type: "uint256" }, { name: "token", type: "address" }, { name: "to", type: "address" }, { name: "deadline", type: "uint256" },
  ] }], outputs: [] },
] as const;

describe("buildNadFunBuyPlan — unsigned BUY calldata, targeting only a verified router", () => {
  it("builds a single payable step to the router the Lens named, value = the MON spent, params matching the quote", async () => {
    const { __testing } = await loadNadFun();
    onRead = ({ functionName }) => {
      if (functionName === "getAmountOut") return [__testing.NADFUN_MAINNET.bondingCurveRouter, 9000_000000000000000000n];
      throw new Error(`unexpected: ${functionName}`);
    };
    const { buildNadFunBuyPlan } = await loadNadFun();
    const plan = await buildNadFunBuyPlan(TOKEN as `0x${string}`, "MEOW", 18, "1", 0.01, WALLET as `0x${string}`);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].kind).toBe("swap");
    expect(plan.steps[0].tx.to).toBe(__testing.NADFUN_MAINNET.bondingCurveRouter);
    expect(plan.steps[0].tx.value).toBe(`0x${(1_000000000000000000n).toString(16)}`);
    expect(plan.amountOut).toBe("9000");

    const decoded = decodeFunctionData({ abi: ROUTER_BUY_ABI, data: plan.steps[0].tx.data });
    const params = decoded.args[0] as { amountOutMin: bigint; token: string; to: string; deadline: bigint };
    expect(params.token.toLowerCase()).toBe(TOKEN.toLowerCase());
    expect(params.to.toLowerCase()).toBe(WALLET.toLowerCase());
    // 1% slippage off 9000 -> 8910 minimum.
    expect(params.amountOutMin).toBe(8910_000000000000000000n);
    expect(params.deadline).toBeGreaterThan(BigInt(Math.floor(Date.now() / 1000)));
  });

  it("targets the DEX router instead when the Lens says the token has graduated", async () => {
    const { __testing } = await loadNadFun();
    onRead = () => [__testing.NADFUN_MAINNET.dexRouter, 100n];
    const { buildNadFunBuyPlan } = await loadNadFun();
    const plan = await buildNadFunBuyPlan(TOKEN as `0x${string}`, "MEOW", 18, "1", 0.01, WALLET as `0x${string}`);
    expect(plan.steps[0].tx.to).toBe(__testing.NADFUN_MAINNET.dexRouter);
  });

  it("a Lens result naming an unofficial router is refused outright — never builds a transaction to it", async () => {
    onRead = () => [ATTACKER, 9000n];
    const { buildNadFunBuyPlan } = await loadNadFun();
    await expect(buildNadFunBuyPlan(TOKEN as `0x${string}`, "MEOW", 18, "1", 0.01, WALLET as `0x${string}`)).rejects.toThrow(/no active nad\.fun/i);
  });

  it("no active route (revert) is a clean, honest error — never a fabricated plan", async () => {
    onRead = () => { throw new Error("execution reverted"); };
    const { buildNadFunBuyPlan } = await loadNadFun();
    await expect(buildNadFunBuyPlan(TOKEN as `0x${string}`, "MEOW", 18, "1", 0.01, WALLET as `0x${string}`)).rejects.toThrow(/no active nad\.fun/i);
  });

  it("slippage outside 0-MAX_SLIPPAGE is rejected before any chain read", async () => {
    onRead = () => { throw new Error("must not read the chain for an invalid slippage"); };
    const { buildNadFunBuyPlan } = await loadNadFun();
    await expect(buildNadFunBuyPlan(TOKEN as `0x${string}`, "MEOW", 18, "1", 1.5, WALLET as `0x${string}`)).rejects.toThrow(/slippage/i);
  });

  it("unavailable outside mainnet", async () => {
    network = "testnet";
    const { buildNadFunBuyPlan } = await loadNadFun();
    await expect(buildNadFunBuyPlan(TOKEN as `0x${string}`, "MEOW", 18, "1", 0.01, WALLET as `0x${string}`)).rejects.toThrow(/mainnet/i);
  });
});

describe("buildNadFunSellPlan — unsigned SELL calldata, with an approve step when needed", () => {
  it("no existing allowance -> approve + sell, both targeting the router the Lens named", async () => {
    const { __testing } = await loadNadFun();
    onRead = ({ functionName }) => {
      if (functionName === "getAmountOut") return [__testing.NADFUN_MAINNET.bondingCurveRouter, 500000000000000000n];
      if (functionName === "allowance") return 0n;
      throw new Error(`unexpected: ${functionName}`);
    };
    const { buildNadFunSellPlan } = await loadNadFun();
    const plan = await buildNadFunSellPlan(TOKEN as `0x${string}`, "MEOW", 18, "1000", 0.01, WALLET as `0x${string}`);
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps[0].kind).toBe("approve");
    expect(plan.steps[0].tx.to).toBe(TOKEN);
    expect(plan.steps[1].kind).toBe("swap");
    expect(plan.steps[1].tx.to).toBe(__testing.NADFUN_MAINNET.bondingCurveRouter);
    expect(plan.amountOut).toBe("0.5");

    const decoded = decodeFunctionData({ abi: ROUTER_SELL_ABI, data: plan.steps[1].tx.data });
    const params = decoded.args[0] as { amountIn: bigint; amountOutMin: bigint; token: string; to: string };
    expect(params.amountIn).toBe(1000_000000000000000000n);
    expect(params.to.toLowerCase()).toBe(WALLET.toLowerCase());
  });

  it("sufficient existing allowance -> sell only, no redundant approve", async () => {
    const { __testing } = await loadNadFun();
    onRead = ({ functionName }) => {
      if (functionName === "getAmountOut") return [__testing.NADFUN_MAINNET.dexRouter, 500000000000000000n];
      if (functionName === "allowance") return 10_000_000000000000000000n; // plenty
      throw new Error(`unexpected: ${functionName}`);
    };
    const { buildNadFunSellPlan } = await loadNadFun();
    const plan = await buildNadFunSellPlan(TOKEN as `0x${string}`, "MEOW", 18, "1000", 0.01, WALLET as `0x${string}`);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].kind).toBe("swap");
  });

  it("an unofficial router named by the Lens is refused before any approve step is even considered", async () => {
    onRead = ({ functionName }) => {
      if (functionName === "getAmountOut") return [ATTACKER, 500000000000000000n];
      throw new Error(`must not check allowance against an unverified router: ${functionName}`);
    };
    const { buildNadFunSellPlan } = await loadNadFun();
    await expect(buildNadFunSellPlan(TOKEN as `0x${string}`, "MEOW", 18, "1000", 0.01, WALLET as `0x${string}`)).rejects.toThrow(/no active nad\.fun/i);
  });
});

describe("exact-output (Step 6 investigation) — quote + plan verified against the real ABI, held out of the main flow", () => {
  it("nadFunQuoteExactOut buy: getAmountIn for an exact token amount out", async () => {
    const { __testing } = await loadNadFun();
    onRead = ({ functionName, args }) => {
      expect(functionName).toBe("getAmountIn");
      const [, amountOut, isBuy] = args as [string, bigint, boolean];
      expect(amountOut).toBe(9000_000000000000000000n);
      expect(isBuy).toBe(true);
      return [__testing.NADFUN_MAINNET.bondingCurveRouter, 1_000000000000000000n];
    };
    const { nadFunQuoteExactOut } = await loadNadFun();
    const q = await nadFunQuoteExactOut(TOKEN as `0x${string}`, 18, "9000", true);
    expect(q).toEqual({ provider: "Nad.Fun", router: __testing.NADFUN_MAINNET.bondingCurveRouter, amountIn: "1", isBuy: true });
  });

  it("buildNadFunExactOutBuyPlan: amountInMax is pushed UP from the quote (opposite direction from a minimum-out floor)", async () => {
    const { __testing } = await loadNadFun();
    onRead = ({ functionName }) => {
      if (functionName === "getAmountIn") return [__testing.NADFUN_MAINNET.bondingCurveRouter, 1_000000000000000000n];
      throw new Error(`unexpected: ${functionName}`);
    };
    const { buildNadFunExactOutBuyPlan } = await loadNadFun();
    const plan = await buildNadFunExactOutBuyPlan(TOKEN as `0x${string}`, "MEOW", 18, "9000", 0.01, WALLET as `0x${string}`);
    expect(plan.amountIn).toBe("1");
    // 1% slippage cap ABOVE the quoted 1 MON -> 1.01 MON max, carried as msg.value.
    expect(plan.steps[0].tx.value).toBe(`0x${(1_010000000000000000n).toString(16)}`);
  });

  it("an unofficial router is refused for exact-output too", async () => {
    onRead = () => [ATTACKER, 1_000000000000000000n];
    const { buildNadFunExactOutBuyPlan } = await loadNadFun();
    await expect(buildNadFunExactOutBuyPlan(TOKEN as `0x${string}`, "MEOW", 18, "9000", 0.01, WALLET as `0x${string}`)).rejects.toThrow(/no active nad\.fun/i);
  });
});

describe("getNadFunProgress — bonding-curve completion (Step 7)", () => {
  it("scales the Lens's raw basis points to a 0-100 percentage", async () => {
    onRead = ({ functionName }) => {
      expect(functionName).toBe("getProgress");
      return 7842n; // 78.42%
    };
    const { getNadFunProgress } = await loadNadFun();
    const p = await getNadFunProgress(TOKEN as `0x${string}`);
    expect(p).toBe(78.42);
  });

  it("100% and 0% are represented exactly, never rounded to something else", async () => {
    onRead = () => 10000n;
    const { getNadFunProgress } = await loadNadFun();
    expect(await getNadFunProgress(TOKEN as `0x${string}`)).toBe(100);
  });

  it("a revert (unrecognized token) is null, never a fabricated 0", async () => {
    onRead = () => { throw new Error("execution reverted"); };
    const { getNadFunProgress } = await loadNadFun();
    expect(await getNadFunProgress(TOKEN as `0x${string}`)).toBeNull();
  });

  it("unavailable outside mainnet", async () => {
    network = "testnet";
    onRead = () => { throw new Error("must not read the chain off mainnet"); };
    const { getNadFunProgress } = await loadNadFun();
    expect(await getNadFunProgress(TOKEN as `0x${string}`)).toBeNull();
  });
});

describe("getNadFunCurveReserves — real bonding-curve reserves, never availableBuyTokens (Step 7)", () => {
  it("reads BondingCurve.curves() and reports the REAL (not virtual) reserves in human units", async () => {
    const { __testing } = await loadNadFun();
    onRead = ({ address, functionName }) => {
      expect(address).toBe(__testing.NADFUN_MAINNET.bondingCurve);
      expect(functionName).toBe("curves");
      return [
        10_000000000000000000n, // realMonReserve: 10 MON
        500000_000000000000000000n, // realTokenReserve: 500000 tokens
        180000_000000000000000000n, // virtualMonReserve
        1073000191_000000000000000000n, // virtualTokenReserve
        0n, 0n, 0n, 0n, // k, targetTokenAmount, initVirtualMonReserve, initVirtualTokenReserve (unused here)
      ];
    };
    const { getNadFunCurveReserves } = await loadNadFun();
    const r = await getNadFunCurveReserves(TOKEN as `0x${string}`, 18);
    expect(r).toEqual({ realMon: "10", realToken: "500000", virtualMon: "180000", virtualToken: "1073000191" });
  });

  it("a revert (unrecognized token) is null", async () => {
    onRead = () => { throw new Error("execution reverted"); };
    const { getNadFunCurveReserves } = await loadNadFun();
    expect(await getNadFunCurveReserves(TOKEN as `0x${string}`, 18)).toBeNull();
  });
});

describe("getNadFunGraduatedPoolLiquidity — the ACTUAL DEX pool, found via the factory (Step 7)", () => {
  const POOL = "0x1111222233334444555566667777888899990000";

  it("finds the WMON/token pair via the factory and orders reserves correctly (WMON as token0)", async () => {
    const { __testing } = await loadNadFun();
    onRead = ({ address, functionName, args }) => {
      if (functionName === "getPair") {
        expect(address).toBe(__testing.NADFUN_MAINNET.dexFactory);
        expect((args[0] as string).toLowerCase()).toBe(__testing.NADFUN_MAINNET.wmon.toLowerCase());
        return POOL;
      }
      if (functionName === "getReserves") { expect(address).toBe(POOL); return [50_000000000000000000n, 2500_000000000000000000n, 0]; }
      if (functionName === "token0") return __testing.NADFUN_MAINNET.wmon;
      throw new Error(`unexpected: ${functionName}`);
    };
    const { getNadFunGraduatedPoolLiquidity } = await loadNadFun();
    const r = await getNadFunGraduatedPoolLiquidity(TOKEN as `0x${string}`, 18);
    expect(r).toEqual({ pool: POOL, monReserve: "50", tokenReserve: "2500" });
  });

  it("orders reserves correctly when the token is token0 instead (WMON is token1)", async () => {
    onRead = ({ functionName }) => {
      if (functionName === "getPair") return POOL;
      if (functionName === "getReserves") return [2500_000000000000000000n, 50_000000000000000000n, 0]; // [token, wmon]
      if (functionName === "token0") return TOKEN; // token0 is the arbitrary token, not WMON
      throw new Error(`unexpected: ${functionName}`);
    };
    const { getNadFunGraduatedPoolLiquidity } = await loadNadFun();
    const r = await getNadFunGraduatedPoolLiquidity(TOKEN as `0x${string}`, 18);
    expect(r).toEqual({ pool: POOL, monReserve: "50", tokenReserve: "2500" });
  });

  it("no pool yet (pre-graduation) -> null, never a fabricated liquidity figure", async () => {
    onRead = ({ functionName }) => {
      if (functionName === "getPair") return "0x0000000000000000000000000000000000000000";
      throw new Error("must not read reserves when no pool exists");
    };
    const { getNadFunGraduatedPoolLiquidity } = await loadNadFun();
    expect(await getNadFunGraduatedPoolLiquidity(TOKEN as `0x${string}`, 18)).toBeNull();
  });

  it("an RPC failure at any step is null, never thrown", async () => {
    onRead = () => { throw new Error("RPC unreachable"); };
    const { getNadFunGraduatedPoolLiquidity } = await loadNadFun();
    expect(await getNadFunGraduatedPoolLiquidity(TOKEN as `0x${string}`, 18)).toBeNull();
  });
});

describe("getNadFunCreatorInfo — creator + pool + creation time from CurveCreate, permanently cached (Step 7)", () => {
  const CREATOR = "0x2222333344445555666677778888999900001111";
  const CURVE_POOL = "0x3333444455556666777788889999000011112222";

  it("reads the token's one CurveCreate log and its block timestamp", async () => {
    const { __testing } = await loadNadFun();
    onGetLogs = ({ address, args }) => {
      expect(address).toBe(__testing.NADFUN_MAINNET.bondingCurve);
      expect((args?.token as string | undefined)?.toLowerCase()).toBe(TOKEN.toLowerCase());
      return [{ args: { creator: CREATOR, token: TOKEN, pool: CURVE_POOL }, blockNumber: 12345n }];
    };
    onGetBlock = ({ blockNumber }) => { expect(blockNumber).toBe(12345n); return { timestamp: 1_700_000_000n }; };
    const { getNadFunCreatorInfo } = await loadNadFun();
    const r = await getNadFunCreatorInfo(TOKEN as `0x${string}`);
    expect(r).toEqual({ creator: CREATOR, curvePool: CURVE_POOL, createdAt: 1_700_000_000_000 });
  });

  it("is cached permanently -- a second call for the same token never re-queries the chain", async () => {
    let calls = 0;
    onGetLogs = () => { calls += 1; return [{ args: { creator: CREATOR, token: TOKEN, pool: CURVE_POOL }, blockNumber: 1n }]; };
    onGetBlock = () => ({ timestamp: 1n });
    const { getNadFunCreatorInfo, clearNadFunCreatorCache } = await loadNadFun();
    clearNadFunCreatorCache();
    await getNadFunCreatorInfo(TOKEN as `0x${string}`);
    await getNadFunCreatorInfo(TOKEN as `0x${string}`);
    expect(calls).toBe(1);
  });

  it("no CurveCreate log found (not a Nad.Fun token) -> null, never fabricated", async () => {
    onGetLogs = () => [];
    const { getNadFunCreatorInfo, clearNadFunCreatorCache } = await loadNadFun();
    clearNadFunCreatorCache();
    expect(await getNadFunCreatorInfo(TOKEN as `0x${string}`)).toBeNull();
  });

  it("the provider rejecting the log range (or any other failure) fails open to null, never throws and breaks the rest of a lookup", async () => {
    onGetLogs = () => { throw new Error("block range too large"); };
    const { getNadFunCreatorInfo, clearNadFunCreatorCache } = await loadNadFun();
    clearNadFunCreatorCache();
    await expect(getNadFunCreatorInfo(TOKEN as `0x${string}`)).resolves.toBeNull();
  });

  it("a block-timestamp read failure still returns creator/pool, just with createdAt: null", async () => {
    onGetLogs = () => [{ args: { creator: CREATOR, token: TOKEN, pool: CURVE_POOL }, blockNumber: 5n }];
    onGetBlock = () => { throw new Error("block not found"); };
    const { getNadFunCreatorInfo, clearNadFunCreatorCache } = await loadNadFun();
    clearNadFunCreatorCache();
    const r = await getNadFunCreatorInfo(TOKEN as `0x${string}`);
    expect(r).toEqual({ creator: CREATOR, curvePool: CURVE_POOL, createdAt: null });
  });
});
