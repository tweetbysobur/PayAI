import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { encodeAbiParameters, encodeFunctionData, maxUint256, parseUnits, toEventSelector } from "viem";
import type { Action, ActionInputs } from "@/lib/sdk/types";

/**
 * Phase 2D — payai/swap@1.0.0: PayAI's existing MON ⇄ USDC trade as an SDK
 * action (a controlled reimplementation; see lib/sdk/actions/swap/index.ts).
 *
 * The trading engine (lib/monad/tradeQuote.ts) is stubbed at its two entry
 * points — previewTrade / prepareTradeExecution — so tests control the quote,
 * the drift verdict and the exact plan the engine returns. The stub's drift
 * verdict mirrors isMaterialChange (provider change, or output drift beyond
 * the slippage); the action's job, tested here, is to hand the engine the
 * SIGNED preview snapshot and refuse "changed". Everything else is real: the
 * executor ABI and fee math, the quote token, Layer A/B, the preview / build
 * / confirm routes, idempotency and the history store. The RPC is stubbed.
 */

const EXECUTOR = "0xF17a916280321Ddb657c8EDd26B2a729F6E63b69";
const OTHER_EXECUTOR = "0x1111111111111111111111111111111111111111";
const ROUTER = "0x2222222222222222222222222222222222222222";
const USDC = "0x754704bc059f5a0ce29e278a6d0eba96b6aafb60";
const WMON = "0x3bd359c1119da7da1d913d1c4d2b7c461115433a";
const NATIVE = "0x0000000000000000000000000000000000000000";
const WALLET = "0x6b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c";
const OTHER = "0x3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e";
const FORWARDER = "0x8b2c7E8FA09fCd664dbA9764FD63Bf3A4c56464D";
const ID = { protocolId: "payai", actionId: "swap", version: "1.0.0" };

vi.mock("@/lib/platform/ratelimit", () => ({ rateLimited: async () => null }));
vi.mock("@/lib/payment/sanctions", () => ({
  ensureSanctionsLoaded: async () => {}, isSanctionedAddress: () => false, sanctionsListLoaded: () => true,
}));

/** Live executor fee + RPC, as the stub reports them. */
const onchain = { feeBps: 25n as bigint, allowance: 0n as bigint };
const chain: {
  tx?: { from: string; to: string | null; input: string; value: bigint };
  receipt?: { status: "success" | "reverted"; from: string; logs: { address: string; topics: string[]; data: string }[] };
} = {};
vi.mock("@/lib/monad/wallet", () => ({
  getPublicClient: () => ({
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "feeBps") return onchain.feeBps;
      if (functionName === "allowance") return onchain.allowance;
      throw new Error(`unexpected read ${functionName}`);
    },
    waitForTransactionReceipt: async () => chain.receipt,
    getTransaction: async () => chain.tx,
  }),
}));

/** The trading engine's two entry points, under test control. */
type Step = { kind: "approve" | "swap"; label: string; tx: { to: string; data: string; value: string } };
const engine = vi.hoisted(() => ({
  provider: "Uniswap v3" as string,
  receive: "4.2" as string,
  multiHop: false,
  withFee: true,
  spendOverride: null as string | null,
  previewError: null as string | null,
  steps: null as null | ((req: { inputToken: string; outputToken: string; amount: string }) => Step[]),
  previewCalls: [] as unknown[],
  buildCalls: [] as { req: Record<string, unknown>; previous: { receiveAmount: string; provider: string } | null }[],
}));
vi.mock("@/lib/monad/tradeQuote", async () => {
  const { encodeFunctionData: enc, parseUnits: pu } = await import("viem");
  const { TRADE_EXECUTOR_ABI } = await import("@/lib/monad/tradeExecutor");
  const ERC20 = [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }] as const;
  const ZERO = "0x0000000000000000000000000000000000000000";
  const preview = (req: { action: string; inputToken: string; outputToken: string; amount: string; slippage: string }) => {
    const inSym = req.inputToken === "MON" ? "MON" : "USDC";
    const outSym = req.outputToken === "MON" ? "MON" : "USDC";
    return {
      ok: true as const, action: req.action,
      spend: { amount: engine.spendOverride ?? req.amount, token: inSym },
      receive: { amount: engine.receive, token: outSym },
      rate: "x", minimumReceived: `${engine.receive} ${outSym}`, priceImpact: "0.10%", highPriceImpact: false,
      route: { provider: engine.provider, path: engine.multiHop ? [inSym, "MON", outSym] : [inSym, outSym] },
      slippage: `${Number(req.slippage).toFixed(2)}%`, network: "Monad" as const, quotedAt: Date.now(),
      fee: engine.withFee ? { percent: "0.25%", amount: "0.025", token: inSym } : null,
    };
  };
  /** The executor plan the real builders produce: [exact approve] + trade. */
  const executorSteps = (req: { inputToken: string; outputToken: string; amount: string }): Step[] => {
    const native = req.inputToken === "MON";
    const gross = pu(req.amount, native ? 18 : 6);
    const steps: Step[] = [];
    if (!native) {
      steps.push({ kind: "approve", label: "Approve", tx: { to: req.inputToken, data: enc({ abi: ERC20, functionName: "approve", args: ["0xF17a916280321Ddb657c8EDd26B2a729F6E63b69", gross] }), value: "0x0" } });
    }
    steps.push({
      kind: "swap", label: "Trade",
      tx: {
        to: "0xF17a916280321Ddb657c8EDd26B2a729F6E63b69",
        data: enc({ abi: TRADE_EXECUTOR_ABI, functionName: "tradeUniswapExactInput", args: [native ? ZERO : req.inputToken as `0x${string}`, req.outputToken === "MON" ? ZERO : req.outputToken as `0x${string}`, 3000, gross, 1n, 9999999999n] }),
        value: native ? `0x${gross.toString(16)}` : "0x0",
      },
    });
    return steps;
  };
  return {
    previewTrade: async (req: Parameters<typeof preview>[0]) => {
      engine.previewCalls.push(req);
      if (engine.previewError) return { ok: false, message: engine.previewError };
      return preview(req);
    },
    prepareTradeExecution: async (req: Parameters<typeof preview>[0] & { walletAddress: string }, previous: { receiveAmount: string; provider: string } | null) => {
      engine.buildCalls.push({ req, previous });
      if (engine.previewError) return { ok: false, message: engine.previewError };
      const fresh = preview(req);
      // Mirror of the engine's isMaterialChange(): provider change, or output
      // drift beyond the request's own slippage.
      const slip = Number(req.slippage) / 100;
      const prevOut = Number(previous?.receiveAmount);
      const changed = !!previous && (fresh.route.provider !== previous.provider || !(prevOut > 0) || Math.abs(Number(fresh.receive.amount) - prevOut) / prevOut > slip);
      if (changed) return { ok: true, status: "changed", preview: fresh };
      return { ok: true, status: "ready", preview: fresh, steps: engine.steps ? engine.steps(req) : executorSteps(req) };
    },
  };
});

const ENV = [
  "MONAD_NETWORK", "MONAD_MAINNET_USDC", "MONAD_MAINNET_PAYAI_TRADE_EXECUTOR", "PAYAI_TRADE_EXECUTOR_ENABLED",
  "MONAD_MAINNET_PAYAI_TRADE_EXECUTOR_V2", "PAYAI_TRADE_EXECUTOR_V2_ENABLED", "MONAD_MAINNET_PAYAI_FORWARDER", "PAYAI_FORWARDER_ENABLED",
] as const;
let saved: Record<string, string | undefined>;
/** A fresh clock per test, an hour apart: the executor's 60s feeBps cache
 *  (lib/monad/tradeExecutor.ts) never leaks one test's fee into another. */
let epoch = Date.UTC(2026, 9, 1);
beforeEach(async () => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  process.env.MONAD_NETWORK = "mainnet";
  process.env.MONAD_MAINNET_USDC = USDC;
  process.env.MONAD_MAINNET_PAYAI_TRADE_EXECUTOR = EXECUTOR;
  process.env.PAYAI_TRADE_EXECUTOR_ENABLED = "true";
  delete process.env.MONAD_MAINNET_PAYAI_TRADE_EXECUTOR_V2;
  delete process.env.PAYAI_TRADE_EXECUTOR_V2_ENABLED;
  delete process.env.MONAD_MAINNET_PAYAI_FORWARDER;
  delete process.env.PAYAI_FORWARDER_ENABLED;
  epoch += 3_600_000;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(epoch);
  onchain.feeBps = 25n; onchain.allowance = 0n;
  Object.assign(engine, { provider: "Uniswap v3", receive: "4.2", multiHop: false, withFee: true, spendOverride: null, previewError: null, steps: null, previewCalls: [], buildCalls: [] });
  delete chain.tx; delete chain.receipt;
  (globalThis as unknown as { __veripayIdem?: Map<string, unknown> }).__veripayIdem?.clear();
  const { __resetRegistryForTests } = await import("@/lib/sdk/registry");
  const { __resetBootstrapForTests } = await import("@/lib/sdk/bootstrap");
  __resetRegistryForTests();
  __resetBootstrapForTests();
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  vi.useRealTimers();
});

async function swap(): Promise<Action> {
  const { ensureBuiltinsRegistered } = await import("@/lib/sdk/bootstrap");
  const { getAction } = await import("@/lib/sdk/registry");
  ensureBuiltinsRegistered();
  const a = getAction("payai", "swap", "1.0.0");
  if (!a) throw new Error("swap not registered");
  return a;
}
const MON_IN: ActionInputs = { tokenOut: USDC, amountIn: parseUnits("10", 18).toString() };
const USDC_IN: ActionInputs = { tokenIn: USDC, tokenOut: NATIVE, amountIn: parseUnits("35", 6).toString() };
async function err(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  return "OK";
}
async function quoteAndBuild(i: ActionInputs, preview = { receiveAmount: "4.2", provider: "Uniswap v3" }) {
  const a = await swap();
  const q = await a.quote(i);
  return a.build(i, q, { wallet: WALLET, preview });
}

/* ── Registration ──────────────────────────────────────────────────────── */

describe("registration", () => {
  it("payai/swap@1.0.0 on Monad mainnet, pinned to the selected executor as its ONLY target", async () => {
    const a = await swap();
    expect(a.chainId).toBe(143);
    expect(a.name).toBe("Swap");
    expect(a.historyAction).toBe("trade");
    expect(a.allowedTargets.map((t) => t.toLowerCase())).toEqual([EXECUTOR.toLowerCase()]);
    const { getProtocol } = await import("@/lib/sdk/registry");
    expect(getProtocol("payai")!.allowedTargets.map((t) => t.toLowerCase())).toEqual([EXECUTOR.toLowerCase()]);
  });
  it("shares the payai protocol with transfer; the protocol allowlist is the union of both", async () => {
    process.env.MONAD_MAINNET_PAYAI_FORWARDER = FORWARDER;
    process.env.PAYAI_FORWARDER_ENABLED = "true";
    await swap();
    const { getProtocol, getAction } = await import("@/lib/sdk/registry");
    expect(getAction("payai", "transfer", "1.0.0")).not.toBeNull();
    expect(getProtocol("payai")!.allowedTargets.map((t) => t.toLowerCase()).sort()).toEqual([EXECUTOR.toLowerCase(), FORWARDER.toLowerCase()].sort());
  });
  it("uses V2 when V2 is configured and enabled (the existing selectExecutor rule)", async () => {
    process.env.MONAD_MAINNET_PAYAI_TRADE_EXECUTOR_V2 = OTHER_EXECUTOR;
    process.env.PAYAI_TRADE_EXECUTOR_V2_ENABLED = "true";
    const a = await swap();
    expect(a.allowedTargets.map((t) => t.toLowerCase())).toEqual([OTHER_EXECUTOR]);
  });
  it.each([
    ["executor disabled", () => { process.env.PAYAI_TRADE_EXECUTOR_ENABLED = "false"; }],
    ["no executor configured", () => { delete process.env.MONAD_MAINNET_PAYAI_TRADE_EXECUTOR; }],
    ["no stablecoin configured", () => { delete process.env.MONAD_MAINNET_USDC; }],
    ["testnet", () => { process.env.MONAD_NETWORK = "testnet"; }],
  ])("not registered when %s — there is no direct-router path", async (_l, setup) => {
    setup();
    const { ensureBuiltinsRegistered } = await import("@/lib/sdk/bootstrap");
    const { getAction } = await import("@/lib/sdk/registry");
    ensureBuiltinsRegistered();
    expect(getAction("payai", "swap", "1.0.0")).toBeNull();
  });
  it("schema: exactly tokenIn, tokenOut, amountIn (units), slippageBps — no amountOut, to, data, spender", async () => {
    const a = await swap();
    expect(Object.keys(a.inputSchema).sort()).toEqual(["amountIn", "slippageBps", "tokenIn", "tokenOut"]);
    expect(a.inputSchema.amountIn.type).toBe("units");
    expect(a.inputSchema.tokenOut).toMatchObject({ type: "token", required: true });
    expect(a.inputSchema.tokenIn).toMatchObject({ type: "token", required: false });
  });
  it("declares confirmed outputs amountOut / tokenOut (in tokenOut) and fee (in tokenIn)", async () => {
    const a = await swap();
    expect(a.outputs).toEqual({
      amountOut: expect.objectContaining({ type: "units", denominatedIn: { input: "tokenOut" } }),
      tokenOut: expect.objectContaining({ type: "token", denominatedIn: { input: "tokenOut" } }),
      fee: expect.objectContaining({ type: "units", denominatedIn: { input: "tokenIn" } }),
    });
    expect("execute" in a).toBe(false);
  });
});

/* ── Inputs ─────────────────────────────────────────────────────────────── */

describe("inputs", () => {
  it("MON → USDC: the engine is asked for an exact-input sell of the user's exact amount", async () => {
    const a = await swap();
    const q = await a.quote(MON_IN);
    expect(engine.previewCalls[0]).toEqual({ action: "sell", inputToken: "MON", outputToken: expect.stringMatching(new RegExp(`^${USDC}$`, "i")), amount: "10", amountType: "exact_input", slippage: "0.5", walletAddress: null });
    expect(q.terms).toEqual({ executor: EXECUTOR.toLowerCase(), feeBps: "25", tokenIn: NATIVE, tokenOut: USDC, amountIn: MON_IN.amountIn, slippageBps: "50" });
    expect(q.snapshot).toEqual({ receiveAmount: "4.2", provider: "Uniswap v3" });
    expect(q.details).toMatchObject({ "you pay": "10 MON", "you receive (est.)": "4.2 USDC", "platform fee": "0.025 MON (0.25%)", route: "Uniswap v3" });
  });
  it("USDC → MON: an exact-input buy", async () => {
    const a = await swap();
    const q = await a.quote({ ...USDC_IN, slippageBps: "100" });
    expect(engine.previewCalls[0]).toMatchObject({ action: "buy", inputToken: expect.stringMatching(new RegExp(`^${USDC}$`, "i")), outputToken: "MON", amount: "35", slippage: "1" });
    expect(q.terms).toMatchObject({ tokenIn: USDC, tokenOut: NATIVE, slippageBps: "100" });
  });
  it.each([
    ["an unsupported token out", { tokenOut: WMON, amountIn: "1" }],
    ["an unsupported token in", { tokenIn: WMON, tokenOut: USDC, amountIn: "1" }],
    ["MON → MON", { tokenOut: NATIVE, amountIn: "1" }],
    ["USDC → USDC", { tokenIn: USDC, tokenOut: USDC, amountIn: "1" }],
  ])("refuses %s before quoting", async (_l, i) => {
    const a = await swap();
    expect(await err(a.quote(i))).toMatch(/Only MON → USDC and USDC → MON/);
    expect(engine.previewCalls).toHaveLength(0);
  });
  it("exact output isn't expressible: amountOut (or any unknown key) fails Layer A", async () => {
    const a = await swap();
    const { validateInputs } = await import("@/lib/sdk/validate");
    for (const k of ["amountOut", "to", "data", "calldata", "spender", "approval", "allowance", "chain", "nonce", "gas", "privateKey", "signature"]) {
      expect(validateInputs(a.inputSchema, { ...MON_IN, [k]: "1" }), k).toMatchObject({ ok: false, code: "UNKNOWN_PARAMETER" });
    }
  });
  it.each([["0"], ["-1"], ["1.5"], ["abc"], [""]])("refuses amountIn %j", async (amountIn) => {
    const a = await swap();
    const { validateInputs } = await import("@/lib/sdk/validate");
    const v = validateInputs(a.inputSchema, { tokenOut: USDC, amountIn });
    if (v.ok) expect(await err(a.quote(v.value))).not.toBe("OK");
    else expect(v.ok).toBe(false);
  });
  it.each([["0"], ["5001"], ["1.5"], ["abc"], ["-5"]])("refuses slippageBps %j (the engine's MAX_SLIPPAGE is 5000 bps)", async (slippageBps) => {
    const a = await swap();
    const { validateInputs } = await import("@/lib/sdk/validate");
    const v = validateInputs(a.inputSchema, { ...MON_IN, slippageBps });
    if (v.ok) expect(await err(a.quote(v.value))).toMatch(/Slippage/);
    else expect(v.ok).toBe(false);
    expect(engine.previewCalls).toHaveLength(0);
  });
  it("an amount the engine would round is refused, never traded at a different amount", async () => {
    const a = await swap();
    engine.spendOverride = "10.000000000000002";
    expect(await err(a.quote({ tokenOut: USDC, amountIn: "10000000000000000001" }))).toMatch(/can't be traded exactly/);
  });
});

/* ── Executor-only ─────────────────────────────────────────────────────── */

describe("executor-only", () => {
  async function encTrade(fn: "tradeUniswapExactInput" | "tradeKuruExactInput", args: readonly unknown[]) {
    const { TRADE_EXECUTOR_ABI } = await import("@/lib/monad/tradeExecutor");
    return encodeFunctionData({ abi: TRADE_EXECUTOR_ABI, functionName: fn, args: args as never });
  }
  const approve = (spender: string, amount: bigint, token = USDC): Step => ({
    kind: "approve", label: "Approve",
    tx: { to: token, value: "0x0", data: encodeFunctionData({ abi: [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }], functionName: "approve", args: [spender as `0x${string}`, amount] }) },
  });
  const gross = BigInt(USDC_IN.amountIn as string);

  it("an executor plan is returned as validated SDK steps: exact approve(executor, gross) + the trade", async () => {
    const steps = await quoteAndBuild(USDC_IN);
    expect(steps.map((s) => s.kind)).toEqual(["approve", "action"]);
    expect(steps[0].approval).toEqual({ token: expect.stringMatching(/^0x754704/i), spender: EXECUTOR, amount: gross.toString() });
    expect(steps[1].tx.to).toBe(EXECUTOR);
    const a = await swap();
    const { validateSteps } = await import("@/lib/sdk/validate");
    const { getProtocol } = await import("@/lib/sdk/registry");
    expect(validateSteps(steps, a, getProtocol("payai")!).ok).toBe(true);
  });
  it("native MON in: one trade step carrying the exact value — no approval", async () => {
    const steps = await quoteAndBuild(MON_IN);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ kind: "action", tx: { to: EXECUTOR, value: MON_IN.amountIn } });
  });
  it("a Kuru executor trade is accepted", async () => {
    const data = await encTrade("tradeKuruExactInput", [ROUTER, true, USDC, NATIVE, 1n, gross, 1n]);
    engine.steps = () => [approve(EXECUTOR, gross), { kind: "swap", label: "Trade", tx: { to: EXECUTOR, value: "0x0", data } }];
    const steps = await quoteAndBuild(USDC_IN);
    expect(steps[1].tx.data).toBe(data);
  });
  it("a direct-router plan (the engine's fallback) is refused, not rerouted", async () => {
    engine.steps = () => [approve(ROUTER, gross), { kind: "swap", label: "Swap", tx: { to: ROUTER, value: "0x0", data: "0x1234" } }];
    expect(await err(quoteAndBuild(USDC_IN))).toMatch(/can't be routed through PayAI's trade executor/);
  });
  it("another executor is refused", async () => {
    const data = await encTrade("tradeUniswapExactInput", [USDC, NATIVE, 3000, gross, 1n, 1n]);
    engine.steps = () => [approve(OTHER_EXECUTOR, gross), { kind: "swap", label: "Trade", tx: { to: OTHER_EXECUTOR, value: "0x0", data } }];
    expect(await err(quoteAndBuild(USDC_IN))).toMatch(/trade executor/);
  });
  it("a correctly encoded trade sent to any target but the executor is refused (router or another executor)", async () => {
    const data = await encTrade("tradeUniswapExactInput", [USDC, NATIVE, 3000, gross, 1n, 1n]);
    for (const to of [OTHER_EXECUTOR, ROUTER]) {
      engine.steps = () => [approve(EXECUTOR, gross), { kind: "swap", label: "Trade", tx: { to, value: "0x0", data } }];
      expect(await err(quoteAndBuild(USDC_IN))).toMatch(/trade executor/);
    }
    const g = BigInt(MON_IN.amountIn as string);
    const monData = await encTrade("tradeUniswapExactInput", [NATIVE, USDC, 3000, g, 1n, 1n]);
    engine.steps = () => [{ kind: "swap", label: "Trade", tx: { to: ROUTER, value: `0x${g.toString(16)}`, data: monData } }];
    expect(await err(quoteAndBuild(MON_IN))).toMatch(/trade executor/);
  });
  it("an approval to any spender but the executor, or for any other amount (incl. unlimited), is refused", async () => {
    const data = await encTrade("tradeUniswapExactInput", [USDC, NATIVE, 3000, gross, 1n, 1n]);
    const tradeStep = { kind: "swap" as const, label: "Trade", tx: { to: EXECUTOR, value: "0x0", data } };
    for (const bad of [approve(OTHER, gross), approve(EXECUTOR, maxUint256), approve(EXECUTOR, gross - 1n), approve(EXECUTOR, gross, WMON)]) {
      engine.steps = () => [bad, tradeStep];
      expect(await err(quoteAndBuild(USDC_IN))).toMatch(/trade executor/);
    }
  });
  it("calldata that isn't exactly this trade is refused: other gross, other tokens, another function, extra steps", async () => {
    const cases: Step[][] = [
      [approve(EXECUTOR, gross), { kind: "swap", label: "T", tx: { to: EXECUTOR, value: "0x0", data: await encTrade("tradeUniswapExactInput", [USDC, NATIVE, 3000, gross + 1n, 1n, 1n]) } }],
      [approve(EXECUTOR, gross), { kind: "swap", label: "T", tx: { to: EXECUTOR, value: "0x0", data: await encTrade("tradeUniswapExactInput", [USDC, WMON, 3000, gross, 1n, 1n]) } }],
      [approve(EXECUTOR, gross), { kind: "swap", label: "T", tx: { to: EXECUTOR, value: "0x0", data: approve(EXECUTOR, gross).tx.data } }],
      [approve(EXECUTOR, gross), approve(EXECUTOR, gross), { kind: "swap", label: "T", tx: { to: EXECUTOR, value: "0x0", data: await encTrade("tradeUniswapExactInput", [USDC, NATIVE, 3000, gross, 1n, 1n]) } }],
      [approve(EXECUTOR, gross), { kind: "swap", label: "T", tx: { to: EXECUTOR, value: "0x1", data: await encTrade("tradeUniswapExactInput", [USDC, NATIVE, 3000, gross, 1n, 1n]) } }],
    ];
    for (const c of cases) {
      engine.steps = () => c;
      expect(await err(quoteAndBuild(USDC_IN))).not.toBe("OK");
    }
  });
  it("native MON in: an approval step, or a value other than the exact amount, is refused", async () => {
    const g = BigInt(MON_IN.amountIn as string);
    const data = await encTrade("tradeUniswapExactInput", [NATIVE, USDC, 3000, g, 1n, 1n]);
    engine.steps = () => [approve(EXECUTOR, g), { kind: "swap", label: "T", tx: { to: EXECUTOR, value: `0x${g.toString(16)}`, data } }];
    expect(await err(quoteAndBuild(MON_IN))).toMatch(/trade executor/);
    engine.steps = () => [{ kind: "swap", label: "T", tx: { to: EXECUTOR, value: "0x0", data } }];
    expect(await err(quoteAndBuild(MON_IN))).toMatch(/trade executor/);
  });
  it("a multi-hop or no-executor (no PayAI fee) route is refused at the quote", async () => {
    const a = await swap();
    engine.multiHop = true;
    expect(await err(a.quote(MON_IN))).toMatch(/trade executor/);
    engine.multiHop = false;
    engine.withFee = false;
    expect(await err(a.quote(MON_IN))).toMatch(/trade executor/);
  });
  it("Layer B still refuses a tampered build (target or approval outside the allowlist)", async () => {
    const steps = await quoteAndBuild(USDC_IN);
    const a = await swap();
    const { validateSteps } = await import("@/lib/sdk/validate");
    const { getProtocol } = await import("@/lib/sdk/registry");
    const p = getProtocol("payai")!;
    expect(validateSteps([steps[0], { ...steps[1], tx: { ...steps[1].tx, to: ROUTER } }], a, p).ok).toBe(false);
    expect(validateSteps([{ ...steps[0], approval: { ...steps[0].approval!, spender: OTHER } }, steps[1]], a, p).ok).toBe(false);
  });
});

/* ── Quote token, drift, replay — through the real routes ──────────────── */

const post = (url: string, body: unknown) => new NextRequest(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
async function preview(i: ActionInputs = MON_IN) {
  await swap();
  const { POST } = await import("@/app/api/ask/action/route");
  return (await POST(post("https://usepayai.xyz/api/ask/action", { ...ID, inputs: i }))).json();
}
async function build(quoteToken: string, i: ActionInputs = MON_IN, wallet = WALLET) {
  const { POST } = await import("@/app/api/ask/action/build/route");
  const res = await POST(post("https://usepayai.xyz/api/ask/action/build", { ...ID, inputs: i, walletAddress: wallet, quoteToken }));
  return { status: res.status, json: await res.json() };
}
async function confirm(quoteId: string, txHash: string, wallet = WALLET, extra: Record<string, unknown> = {}) {
  const { POST } = await import("@/app/api/ask/action/confirm/route");
  const res = await POST(post("https://usepayai.xyz/api/ask/action/confirm", { ...ID, txHash, walletAddress: wallet, quoteId, ...extra }));
  return { status: res.status, json: await res.json() };
}

describe("quote token", () => {
  it("the preview's token signs the snapshot; it verifies and comes back intact", async () => {
    const p = await preview();
    expect(p.ok).toBe(true);
    const { verifyQuoteToken } = await import("@/lib/sdk/quoteToken");
    const v = verifyQuoteToken(p.quoteToken, { ...ID, chainId: 143 }, MON_IN);
    expect(v).toMatchObject({ ok: true, snapshot: { receiveAmount: "4.2", provider: "Uniswap v3" } });
  });
  it("a tampered snapshot breaks the signature", async () => {
    const p = await preview();
    const [enc, sig] = (p.quoteToken as string).split(".");
    const payload = JSON.parse(Buffer.from(enc, "base64url").toString("utf8"));
    payload.s.receiveAmount = "9999";
    const forged = `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${sig}`;
    const { verifyQuoteToken } = await import("@/lib/sdk/quoteToken");
    expect(verifyQuoteToken(forged, { ...ID, chainId: 143 }, MON_IN).ok).toBe(false);
  });
  it("never issues a token the verifier would refuse (size or malformed snapshot)", async () => {
    const { issueQuoteToken, verifyQuoteToken, MAX_QUOTE_TOKEN_LENGTH } = await import("@/lib/sdk/quoteToken");
    expect(() => issueQuoteToken({ ...ID, protocolId: "p".repeat(1600), chainId: 143 }, MON_IN, 1)).toThrow(/size/);
    expect(() => issueQuoteToken({ ...ID, chainId: 143 }, MON_IN, 1, undefined, { receiveAmount: "x".repeat(200) })).toThrow();
    expect(() => issueQuoteToken({ ...ID, chainId: 143 }, MON_IN, 1, undefined, { "bad-key": "1" })).toThrow();
    // The largest well-formed snapshot either issues a VERIFIABLE token or isn't issued at all.
    const big = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`k${i}`, "v".repeat(128)]));
    let token: string | null = null;
    try {
      token = issueQuoteToken({ ...ID, chainId: 143 }, MON_IN, 1, undefined, big).quoteToken;
    } catch { /* refused at issue */ }
    if (token) {
      expect(token.length).toBeLessThanOrEqual(MAX_QUOTE_TOKEN_LENGTH);
      expect(verifyQuoteToken(token, { ...ID, chainId: 143 }, MON_IN).ok).toBe(true);
    }
  });
  it("build requires a token for exactly this action, chain and inputs", async () => {
    const p = await preview();
    const { issueQuoteToken } = await import("@/lib/sdk/quoteToken");
    const otherAction = issueQuoteToken({ protocolId: "payai", actionId: "transfer", version: "1.0.0", chainId: 143 }, MON_IN, Date.now(), undefined, { receiveAmount: "4.2", provider: "Uniswap v3" });
    const otherChain = issueQuoteToken({ ...ID, chainId: 10143 }, MON_IN, Date.now(), undefined, { receiveAmount: "4.2", provider: "Uniswap v3" });
    expect((await build(otherAction.quoteToken)).json.code).toBe("QUOTE_REQUIRED");
    expect((await build(otherChain.quoteToken)).json.code).toBe("QUOTE_REQUIRED");
    expect((await build(p.quoteToken, { ...MON_IN, amountIn: "1" })).json.code).toBe("QUOTE_REQUIRED");
    expect(engine.buildCalls).toHaveLength(0);
  });
  it("an expired quote is refused before anything is built", async () => {
    const p = await preview();
    vi.setSystemTime(epoch + 91_000);
    const r = await build(p.quoteToken);
    expect(r.json.ok).toBe(false);
    expect(engine.buildCalls).toHaveLength(0);
  });
  it("a fee change between preview and build is FEE_TERMS_CHANGED (the quote is consumed)", async () => {
    const p = await preview();
    onchain.feeBps = 30n;
    vi.setSystemTime(epoch + 61_000); // past the executor fee cache
    expect((await build(p.quoteToken)).json.code).toBe("FEE_TERMS_CHANGED");
    expect((await build(p.quoteToken)).json.code).toBe("ALREADY_BUILT");
  });
  it("one build per quote: a replay is ALREADY_BUILT", async () => {
    const p = await preview();
    expect((await build(p.quoteToken)).json.ok).toBe(true);
    expect((await build(p.quoteToken)).json.code).toBe("ALREADY_BUILT");
    expect(engine.buildCalls).toHaveLength(1);
  });
});

describe("drift: the engine's guard runs against the SIGNED snapshot", () => {
  it("the engine receives exactly the previewed snapshot as `previous` — never a client value", async () => {
    const p = await preview();
    await build(p.quoteToken);
    expect(engine.buildCalls[0].previous).toEqual({ receiveAmount: "4.2", provider: "Uniswap v3" });
    expect(engine.buildCalls[0].req).toMatchObject({ walletAddress: WALLET, amount: "10", amountType: "exact_input" });
  });
  it("the comparison uses the snapshot signed at THIS preview (e.g. 5.0), not any other value", async () => {
    engine.receive = "5.0";
    const p = await preview();
    const r = await build(p.quoteToken);
    expect(r.json.ok).toBe(true);
    expect(engine.buildCalls[0].previous).toEqual({ receiveAmount: "5.0", provider: "Uniswap v3" });
  });
  it("a provider change is QUOTE_CHANGED, and the quote is consumed", async () => {
    const p = await preview();
    engine.provider = "Kuru";
    const r = await build(p.quoteToken);
    expect(r.json.code).toBe("QUOTE_CHANGED");
    expect((await build(p.quoteToken)).json.code).toBe("ALREADY_BUILT");
  });
  it("output drift beyond the slippage is QUOTE_CHANGED; within it, the build proceeds", async () => {
    const p1 = await preview();
    engine.receive = "4.1"; // −2.4% > 0.5%
    expect((await build(p1.quoteToken)).json.code).toBe("QUOTE_CHANGED");
    engine.receive = "4.2";
    const p2 = await preview();
    engine.receive = "4.19"; // −0.24% < 0.5%
    expect((await build(p2.quoteToken)).json.ok).toBe(true);
  });
  it("build refuses without a previewed snapshot", async () => {
    const a = await swap();
    const q = await a.quote(MON_IN);
    expect(await err(a.build(MON_IN, q, { wallet: WALLET }))).toMatch(/fresh preview/);
  });
});

/* ── Confirmation ──────────────────────────────────────────────────────── */

const TE_SIG = toEventSelector("TradeExecuted(uint256,address,uint8,address,address,uint256,uint256,uint256)");
function tradeLog(o: { emitter?: string; user?: string; venue?: number; tokenIn?: string; tokenOut?: string; amountIn?: bigint; amountOut?: bigint; fee?: bigint } = {}) {
  const gross = o.amountIn ?? BigInt(MON_IN.amountIn as string);
  return {
    address: o.emitter ?? EXECUTOR,
    topics: [TE_SIG, encodeAbiParameters([{ type: "uint256" }], [7n]), encodeAbiParameters([{ type: "address" }], [(o.user ?? WALLET) as `0x${string}`])],
    data: encodeAbiParameters(
      [{ type: "uint8" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      [o.venue ?? 0, (o.tokenIn ?? NATIVE) as `0x${string}`, (o.tokenOut ?? USDC) as `0x${string}`, gross, o.amountOut ?? 4_190_000n, o.fee ?? (gross * 25n) / 10_000n],
    ),
  };
}
/** A fresh tx hash per test: the history store outlives a single test. */
let TX = "";
let txSeq = 0;
beforeEach(() => { TX = `0x${(++txSeq).toString(16).padStart(64, "a")}`; });
async function built() {
  const p = await preview();
  const b = await build(p.quoteToken);
  expect(b.json.ok).toBe(true);
  return { quoteId: b.json.quoteId as string, final: b.json.steps.at(-1) as { tx: { to: string; data: string; value: string } } };
}
function mine(final: { tx: { to: string; data: string; value: string } }, logs: ReturnType<typeof tradeLog>[], from = WALLET, status: "success" | "reverted" = "success") {
  chain.tx = { from, to: final.tx.to, input: final.tx.data, value: BigInt(final.tx.value) };
  chain.receipt = { status, from, logs };
}
async function history() {
  const { listTx } = await import("@/lib/platform/store");
  return (await listTx("demo", { sender: WALLET })).filter((t) => t.txHash === TX);
}

describe("confirmation: only the build's executor's TradeExecuted, checked against the build", () => {
  it("a valid trade settles and records exactly ONE trade row, every amount from the event", async () => {
    const { quoteId, final } = await built();
    mine(final, [tradeLog()]);
    const r = await confirm(quoteId, TX, WALLET, { amountOut: 999 }); // a client amount is simply ignored
    expect(r.json).toMatchObject({ ok: true, success: true, recorded: 1 });
    expect(r.json.details).toMatchObject({ "you paid": "10 MON", "you received": "4.19 USDC", "platform fee": "0.025 MON", route: "Uniswap v3" });
    const rows = await history();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "trade", feature: "trade", amount: 10, token: "MON", sender: WALLET, recipient: WALLET,
      outputAmount: 4.19, outputToken: "USDC", outputTokenAddress: expect.stringMatching(/^0x754704/i), provider: "Uniswap v3",
    });
    expect(rows[0].summary).toContain("out 4190000");
  });
  it("repeated confirmation is idempotent: replayed, still one row", async () => {
    const { quoteId, final } = await built();
    mine(final, [tradeLog()]);
    await confirm(quoteId, TX);
    const again = await confirm(quoteId, TX);
    expect(again.json).toMatchObject({ ok: true, replayed: true });
    expect(await history()).toHaveLength(1);
  });
  it.each([
    ["another executor's event", { emitter: OTHER_EXECUTOR }],
    ["another wallet's trade", { user: OTHER }],
    ["a different tokenIn", { tokenIn: USDC }],
    ["a different tokenOut", { tokenOut: WMON }],
    ["a different gross input", { amountIn: BigInt(MON_IN.amountIn as string) - 1n, fee: ((BigInt(MON_IN.amountIn as string) - 1n) * 25n) / 10_000n }],
    ["a different fee", { fee: 1n }],
    ["zero output", { amountOut: 0n }],
    ["an unknown venue", { venue: 2 }],
  ])("%s → unverified, no history", async (_l, o) => {
    const { quoteId, final } = await built();
    mine(final, [tradeLog(o)]);
    const r = await confirm(quoteId, TX);
    expect(r.json).toMatchObject({ ok: false, verified: false });
    expect(await history()).toHaveLength(0);
  });
  it("no TradeExecuted (e.g. only an ERC-20 Transfer log) → unverified; two events → unverified", async () => {
    const transfer = {
      address: USDC,
      topics: [toEventSelector("Transfer(address,address,uint256)"), encodeAbiParameters([{ type: "address" }], [EXECUTOR]), encodeAbiParameters([{ type: "address" }], [WALLET])],
      data: encodeAbiParameters([{ type: "uint256" }], [4_190_000n]),
    };
    const a = await built();
    mine(a.final, [transfer]);
    expect((await confirm(a.quoteId, TX)).json).toMatchObject({ ok: false, verified: false });
    (globalThis as unknown as { __veripayIdem?: Map<string, unknown> }).__veripayIdem?.clear();
    const b = await built();
    mine(b.final, [tradeLog(), tradeLog()]);
    expect((await confirm(b.quoteId, TX)).json).toMatchObject({ ok: false, verified: false });
    expect(await history()).toHaveLength(0);
  });
  it("confirmed outputs (Phase 2C): from the verified event, stored once, never the client's or the preview's", async () => {
    const { quoteId, final } = await built();
    mine(final, [tradeLog({ amountOut: 4_123_456n })]);
    const r = await confirm(quoteId, TX, WALLET, { amountOut: "999", outputs: { amountOut: { verified: true, type: "units", value: "999", token: USDC } } });
    expect(r.json).toMatchObject({ ok: true, outputsStatus: "recorded" });
    expect(r.json.outputs).toEqual({
      amountOut: { verified: true, type: "units", value: "4123456", token: USDC }, // not the 4.2 preview, not 999
      tokenOut: { verified: true, type: "token", value: USDC },
      fee: { verified: true, type: "units", value: "25000000000000000", token: NATIVE },
    });
    const { readOutputRecord } = await import("@/lib/sdk/settlement");
    expect(await readOutputRecord({ quoteId, txHash: TX, wallet: WALLET, ...ID })).toMatchObject({ status: "recorded", record: { outputs: r.json.outputs } });
    expect((await confirm(quoteId, TX)).json).toMatchObject({ replayed: true, outputs: r.json.outputs });
  });
  it("confirmed outputs: an unverifiable trade stores none", async () => {
    const { quoteId, final } = await built();
    mine(final, [tradeLog({ fee: 1n })]);
    const r = await confirm(quoteId, TX);
    expect(r.json).toMatchObject({ ok: false, verified: false });
    expect(r.json).not.toHaveProperty("outputs");
    const { readOutputRecord } = await import("@/lib/sdk/settlement");
    expect(await readOutputRecord({ quoteId, txHash: TX, wallet: WALLET, ...ID })).toEqual({ status: "absent" });
  });
  it("a reverted trade is reported as reverted; nothing recorded", async () => {
    const { quoteId, final } = await built();
    mine(final, [], WALLET, "reverted");
    expect((await confirm(quoteId, TX)).json).toMatchObject({ ok: false, reverted: true });
    expect(await history()).toHaveLength(0);
  });
  it("an unrelated transaction (not the built one) can't settle the build", async () => {
    const { quoteId, final } = await built();
    mine({ tx: { ...final.tx, data: `${final.tx.data.slice(0, -2)}00` } }, [tradeLog()]);
    const r = await confirm(quoteId, TX);
    expect(r.status).toBe(409);
    expect(await history()).toHaveLength(0);
  });
  it("the build record's wallet is authoritative: another wallet can't confirm it, nor a tx sent by another wallet", async () => {
    const { quoteId, final } = await built();
    mine(final, [tradeLog()]);
    expect((await confirm(quoteId, TX, OTHER)).status).toBe(409);
    mine(final, [tradeLog()], OTHER);
    expect((await confirm(quoteId, TX)).status).toBe(409);
    expect(await history()).toHaveLength(0);
  });
});

describe("fee: verified against the BUILD-TIME rate", () => {
  it("a live fee change after the build → the trade (at the new rate) is unverified; no history", async () => {
    const { quoteId, final } = await built();
    onchain.feeBps = 30n; // the Safe changed it before mining
    const gross = BigInt(MON_IN.amountIn as string);
    mine(final, [tradeLog({ fee: (gross * 30n) / 10_000n })]);
    expect((await confirm(quoteId, TX)).json).toMatchObject({ ok: false, verified: false });
    expect(await history()).toHaveLength(0);
  });
  it("the expected fee is floor(gross * buildFeeBps / 10000), independent of the live rate at confirm", async () => {
    const { quoteId, final } = await built();
    onchain.feeBps = 99n;
    vi.setSystemTime(epoch + 120_000);
    mine(final, [tradeLog()]);
    expect((await confirm(quoteId, TX)).json).toMatchObject({ ok: true, success: true });
  });
});

/* ── Outputs ───────────────────────────────────────────────────────────── */

describe("outputs", () => {
  const receipt = (logs: ReturnType<typeof tradeLog>[]) => ({ status: "success" as const, txHash: TX as `0x${string}`, logs: logs as never });
  it("settledTrade returns the VERIFIED amountOut / tokenOut / fee in exact base units", async () => {
    const a = await swap();
    const q = await a.quote(MON_IN);
    const t = await a.settledTrade!(receipt([tradeLog()]), { terms: q.terms, wallet: WALLET });
    expect(t).toMatchObject({ amountIn: 10n ** 19n, amountOut: 4_190_000n, fee: 25_000_000_000_000_000n, tokenOut: expect.stringMatching(/^0x754704/i), tokenIn: NATIVE, provider: "Uniswap v3" });
    expect(await a.settledTrade!(receipt([tradeLog()]), { terms: q.terms })).toBeNull(); // no build wallet → never verified
    expect(await a.settledTrade!(receipt([tradeLog()]), { wallet: WALLET })).toBeNull(); // no build terms → never verified
  });
  it("only an ERC-20 output is bindable: MON → USDC's amountOut is; USDC → MON's isn't", async () => {
    const a = await swap();
    const { canBind, staticErc20 } = await import("@/lib/plan/outputs");
    const decl = (canBind(a, "amountOut", "units") as { ok: true; declaration: Parameters<typeof staticErc20>[0] }).declaration;
    expect(staticErc20(decl, (k) => (MON_IN as Record<string, string>)[k])).toBe(USDC);
    expect(staticErc20(decl, (k) => (USDC_IN as Record<string, string>)[k])).toBeNull();
    const tok = (canBind(a, "tokenOut", "token") as { ok: true; declaration: Parameters<typeof staticErc20>[0] }).declaration;
    expect(staticErc20(tok, (k) => (USDC_IN as Record<string, string>)[k])).toBeNull();
  });
});
