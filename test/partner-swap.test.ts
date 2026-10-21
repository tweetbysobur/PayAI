import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeFunctionData, parseAbi } from "viem";

/**
 * Partner swap API (Dubu first): a partner's key only unlocks its own token
 * list and limits, both venues are compared, and what comes back is exactly
 * one direct call paying the partner's user, never anyone else.
 */

const CHOG = "0x350035555E10d9AfAF1566AaebfCeD5BA6C27777";
const OTHER = "0x1111111111111111111111111111111111111111";
const WMON = "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A";
const USER = "0x2222222222222222222222222222222222222222";
const CURVE_ROUTER = "0x6F6B8F1a20703309951a5127c45B49b1CD981A22";
const UNI_ROUTER = "0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900";
const KEY = "dubu_test_key_0123456789abcdef0123456789";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

const NAD_ABI = parseAbi([
  "struct BuyParams { uint256 amountOutMin; address token; address to; uint256 deadline; }",
  "function buy(BuyParams params) payable",
]);

let nadOut: string | null = "1000";
let uniOut: string | null = null;
let uniImpact: string | null = "0.10%";
let network = "mainnet";

vi.mock("@/lib/monad/config", () => ({ getNetwork: () => network, getWrappedNative: () => WMON }));
vi.mock("@/lib/monad/wallet", () => ({
  getPublicClient: () => ({
    readContract: async ({ functionName }: { functionName: string }) => (functionName === "decimals" ? 18 : "CHOG"),
  }),
}));
vi.mock("@/lib/monad/nadfun", () => ({
  nadFunQuote: async () => (nadOut ? { provider: "Nad.Fun", router: CURVE_ROUTER, amountOut: nadOut, isBuy: true } : null),
  buildNadFunBuyPlan: async (token: string, _s: string, _d: number, amountInMon: string, slippage: number, wallet: string) => ({
    steps: [{
      kind: "swap", label: "Buy", tx: {
        to: CURVE_ROUTER,
        data: encodeFunctionData({
          abi: NAD_ABI, functionName: "buy",
          args: [{ amountOutMin: BigInt(Math.floor(Number(nadOut) * (1 - slippage))) * 10n ** 18n, token: token as `0x${string}`, to: wallet as `0x${string}`, deadline: 1n }],
        }),
        value: `0x${(BigInt(Math.round(Number(amountInMon) * 1e6)) * 10n ** 12n).toString(16)}`,
      },
    }],
    amountOut: nadOut, router: CURVE_ROUTER,
  }),
}));
vi.mock("@/lib/monad/swap", () => ({
  MAX_PRICE_IMPACT: 0.15,
  quoteUniswapDirect: async () => (uniOut ? { amountOut: uniOut, priceImpact: uniImpact } : null),
  buildUniswapPlanDirect: async () => ({ steps: [{ kind: "swap", label: "Trade", tx: { to: UNI_ROUTER, data: "0x414bf389", value: "0x1" } }], amountOut: uniOut, priceImpact: uniImpact }),
}));

const { loadPartners, partnerForKey } = await import("@/lib/partner/auth");
const { partnerBuild, partnerQuote, validateRequest, PartnerSwapError } = await import("@/lib/partner/swap");

const CONFIG = JSON.stringify([{ id: "dubu", keySha256: sha(KEY), tokens: [CHOG], maxMon: 100 }]);
const dubu = partnerForKey(`Bearer ${KEY}`, loadPartners(CONFIG))!;

beforeEach(() => {
  nadOut = "1000";
  uniOut = null;
  uniImpact = "0.10%";
  network = "mainnet";
});

describe("partner keys", () => {
  it("the right key finds its partner, with its own token list and cap", () => {
    expect(dubu).toEqual({ id: "dubu", tokens: [CHOG.toLowerCase()], maxMon: 100 });
  });
  it("a wrong, short, missing or non-Bearer key finds nothing", () => {
    const partners = loadPartners(CONFIG);
    expect(partnerForKey(`Bearer ${KEY}x`, partners)).toBeNull();
    expect(partnerForKey("Bearer short", partners)).toBeNull();
    expect(partnerForKey(null, partners)).toBeNull();
    expect(partnerForKey(KEY, partners)).toBeNull();
  });
  it("malformed config entries are dropped, never half-trusted", () => {
    expect(loadPartners("not json")).toEqual([]);
    expect(loadPartners(JSON.stringify([{ id: "x", keySha256: "abc", tokens: [CHOG], maxMon: 1 }]))).toEqual([]);
    expect(loadPartners(JSON.stringify([{ id: "dubu", keySha256: sha(KEY), tokens: [], maxMon: 1 }]))).toEqual([]);
    expect(loadPartners(JSON.stringify([{ id: "dubu", keySha256: sha(KEY), tokens: [CHOG], maxMon: 0 }]))).toEqual([]);
  });
});

describe("request limits", () => {
  const ok = { token: CHOG, amountMon: "1.5", slippageBps: 100 };
  it("accepts a normal request and defaults slippage to 1%", () => {
    expect(validateRequest(dubu, { token: CHOG, amountMon: "1.5" })).toEqual(ok);
  });
  it("refuses a token the partner is not allowed to buy", () => {
    expect(() => validateRequest(dubu, { ...ok, token: OTHER })).toThrow(/cannot buy that token/);
  });
  it("refuses amounts over the cap, zero, or not decimal strings", () => {
    expect(() => validateRequest(dubu, { ...ok, amountMon: "101" })).toThrow(/largest swap/);
    expect(() => validateRequest(dubu, { ...ok, amountMon: "0" })).toThrow(PartnerSwapError);
    expect(() => validateRequest(dubu, { ...ok, amountMon: 1 })).toThrow(PartnerSwapError);
    expect(() => validateRequest(dubu, { ...ok, amountMon: "1e3" })).toThrow(PartnerSwapError);
  });
  it("refuses slippage outside 0.1% to 5%", () => {
    expect(() => validateRequest(dubu, { ...ok, slippageBps: 5 })).toThrow(/slippageBps/);
    expect(() => validateRequest(dubu, { ...ok, slippageBps: 501 })).toThrow(/slippageBps/);
  });
});

describe("quote", () => {
  const req = { token: CHOG, amountMon: "1", slippageBps: 100 };
  it("uses Nad.Fun when Uniswap has no pool", async () => {
    const q = await partnerQuote(req);
    expect(q.venue).toBe("nadfun");
    expect(q.amountOut).toBe("1000");
    expect(q.venues).toEqual({ nadfun: "1000", uniswap: null });
  });
  it("picks the venue that gives more", async () => {
    uniOut = "1200";
    expect((await partnerQuote(req)).venue).toBe("uniswap");
  });
  it("ignores a Uniswap quote whose price impact is over the limit", async () => {
    uniOut = "5000";
    uniImpact = "40.00%";
    expect((await partnerQuote(req)).venue).toBe("nadfun");
  });
  it("says so when there is no route at all", async () => {
    nadOut = null;
    await expect(partnerQuote(req)).rejects.toThrow(/No route/);
  });
  it("runs on mainnet only", async () => {
    network = "testnet";
    await expect(partnerQuote(req)).rejects.toThrow(/mainnet/);
  });
});

describe("build", () => {
  const req = { token: CHOG, amountMon: "1", slippageBps: 100 };
  it("returns one Nad.Fun buy that pays the user, for the token asked, with a real minimum", async () => {
    const b = await partnerBuild(req, USER);
    expect(b.tx.to).toBe(CURVE_ROUTER);
    const call = decodeFunctionData({ abi: NAD_ABI, data: b.tx.data as `0x${string}` });
    expect(call.args[0].to.toLowerCase()).toBe(USER.toLowerCase());
    expect(call.args[0].token.toLowerCase()).toBe(CHOG.toLowerCase());
    expect(call.args[0].amountOutMin).toBe(990n * 10n ** 18n);
    expect(BigInt(b.tx.value)).toBe(10n ** 18n);
  });
  it("needs a real wallet address", async () => {
    await expect(partnerBuild(req, "not-an-address")).rejects.toThrow(/wallet/);
  });
});
