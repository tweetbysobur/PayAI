import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { encodeAbiParameters, getAddress, parseUnits, toEventSelector } from "viem";
import type { Action, ActionReceipt } from "@/lib/sdk/types";

/**
 * Phase 2C Stage 2 — confirmed outputs: machine-readable facts a CONFIRMED
 * SDK action verifiably produced, from each action's STRICT verification of
 * its canonical event against the build's terms and wallet, checked against
 * its output declarations, and stored write-once under sdk-outputs:<quoteId>.
 *
 * The real swap / transfer / split actions are registered (mainnet, executor
 * and forwarder enabled); the RPC and KV are stubbed. The existing lenient
 * settlement/history paths are asserted unchanged alongside the strict one.
 */

const FORWARDER = "0x8b2c7E8FA09fCd664dbA9764FD63Bf3A4c56464D";
const EXECUTOR = "0xF17a916280321Ddb657c8EDd26B2a729F6E63b69";
const OTHER_EXECUTOR = "0x1111111111111111111111111111111111111111";
const SPLIT = "0xaC98a844E0F9688EA9758Db05c134b8B4BCeAf6F";
const TREASURY = "0xa282833b52b1b66d58bd2007081dcc037798c0b0";
const USDC = "0x754704bc059f5a0ce29e278a6d0eba96b6aafb60";
const USDC_CHECKSUM = getAddress(USDC);
const WMON = "0x3bd359c1119da7da1d913d1c4d2b7c461115433a";
const NATIVE = "0x0000000000000000000000000000000000000000";
const WALLET = "0x6b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c";
const RECIPIENT = "0x5e0d39b4c1a2f3e4d5c6b7a8f9e0d1c2b3a4f5e6";
const A = "0x5e0d39b4c1a2f3e4d5c6b7a8f9e0d1c2b3a4f5e6";
const B = "0x7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b";
const OTHER = "0x3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e";
const MAX_UINT256 = (1n << 256n) - 1n;

vi.mock("@/lib/platform/ratelimit", () => ({ rateLimited: async () => null }));
vi.mock("@/lib/payment/sanctions", () => ({
  ensureSanctionsLoaded: async () => {}, isSanctionedAddress: () => false, sanctionsListLoaded: () => true,
}));

const onchain = { feeBps: 25n as bigint, treasury: TREASURY as string, allowance: 0n as bigint };
const chain: {
  tx?: { from: string; to: string | null; input: string; value: bigint };
  receipt?: { status: "success" | "reverted"; from: string; logs: { address: string; topics: string[]; data: string }[] };
  /** Test-only: the receipt wait fails (provider timeout / unavailable). */
  receiptThrows?: boolean;
} = {};
vi.mock("@/lib/monad/wallet", () => ({
  getPublicClient: () => ({
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "feeBps") return onchain.feeBps;
      if (functionName === "treasury") return onchain.treasury;
      if (functionName === "allowance") return onchain.allowance;
      throw new Error(`unexpected read ${functionName}`);
    },
    waitForTransactionReceipt: async () => { if (chain.receiptThrows) throw new Error("timed out"); return chain.receipt; },
    getTransaction: async () => chain.tx,
  }),
}));

/** A KV stand-in honouring SET NX EX, off by default (in-memory paths). */
const kv = vi.hoisted(() => ({
  enabled: false,
  store: new Map<string, string>(),
  sets: [] as { key: string; opts?: { nx?: boolean; ex?: number } }[],
}));
vi.mock("@/lib/platform/kv", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/platform/kv")>();
  const fake = {
    async get(key: string) { const v = kv.store.get(key); return v === undefined ? null : JSON.parse(v); },
    async set(key: string, value: unknown, opts?: { nx?: boolean; ex?: number }) {
      kv.sets.push({ key, opts });
      if (opts?.nx && kv.store.has(key)) return null;
      kv.store.set(key, JSON.stringify(value));
      return "OK";
    },
    async del(key: string) { kv.store.delete(key); return 1; },
  };
  return { ...actual, getRedis: async () => (kv.enabled ? fake : null), kvEnabled: () => kv.enabled };
});

const ENV = ["MONAD_NETWORK", "MONAD_MAINNET_USDC", "MONAD_MAINNET_PAYAI_FORWARDER", "PAYAI_FORWARDER_ENABLED", "PAYAI_TREASURY_ADDRESS",
  "MONAD_MAINNET_PAYAI_TRADE_EXECUTOR", "PAYAI_TRADE_EXECUTOR_ENABLED", "MONAD_MAINNET_PAYAI_TRADE_EXECUTOR_V2", "PAYAI_TRADE_EXECUTOR_V2_ENABLED"] as const;
let saved: Record<string, string | undefined>;
beforeEach(async () => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  process.env.MONAD_NETWORK = "mainnet";
  process.env.MONAD_MAINNET_USDC = USDC;
  process.env.MONAD_MAINNET_PAYAI_FORWARDER = FORWARDER;
  process.env.PAYAI_FORWARDER_ENABLED = "true";
  process.env.MONAD_MAINNET_PAYAI_TRADE_EXECUTOR = EXECUTOR;
  process.env.PAYAI_TRADE_EXECUTOR_ENABLED = "true";
  delete process.env.MONAD_MAINNET_PAYAI_TRADE_EXECUTOR_V2;
  delete process.env.PAYAI_TRADE_EXECUTOR_V2_ENABLED;
  delete process.env.PAYAI_TREASURY_ADDRESS;
  onchain.feeBps = 25n; onchain.treasury = TREASURY; onchain.allowance = 0n;
  delete chain.tx; delete chain.receipt; delete chain.receiptThrows;
  kv.enabled = false; kv.store.clear(); kv.sets.length = 0;
  (globalThis as unknown as { __veripayIdem?: Map<string, unknown> }).__veripayIdem?.clear();
  (await import("@/lib/sdk/settlement")).__resetOutputRecordsForTests();
  (await import("@/lib/sdk/fees")).__resetPlatformFeeCacheForTests();
  const { __resetRegistryForTests } = await import("@/lib/sdk/registry");
  const { __resetBootstrapForTests, ensureBuiltinsRegistered } = await import("@/lib/sdk/bootstrap");
  __resetRegistryForTests();
  __resetBootstrapForTests();
  ensureBuiltinsRegistered();
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  vi.useRealTimers();
});

async function action(protocolId: string, actionId: string, version: string): Promise<Action> {
  const { getAction } = await import("@/lib/sdk/registry");
  const a = getAction(protocolId, actionId, version);
  if (!a) throw new Error(`${protocolId}/${actionId} not registered`);
  return a;
}
const swapAction = () => action("payai", "swap", "1.0.0");
const transferAction = () => action("payai", "transfer", "1.0.0");
const splitAction = () => action("payai-settlement", "split_payment", "2.0.0");
const receipt = (logs: ActionReceipt["logs"], status: "success" | "reverted" = "success"): ActionReceipt =>
  ({ status, txHash: `0x${"ab".repeat(32)}`, logs });
const addr = (a: string) => encodeAbiParameters([{ type: "address" }], [a as `0x${string}`]);
const u256 = (n: bigint) => encodeAbiParameters([{ type: "uint256" }], [n]);
async function check(a: Action, result: unknown) {
  const { checkOutputsAgainstDeclaration } = await import("@/lib/sdk/settlement");
  return checkOutputsAgainstDeclaration(a, result);
}

/* ── Swap ──────────────────────────────────────────────────────────────── */

const GROSS = parseUnits("10", 18);
const SWAP_TERMS = { executor: EXECUTOR.toLowerCase(), feeBps: "25", tokenIn: NATIVE, tokenOut: USDC, amountIn: GROSS.toString(), slippageBps: "50" };
const SWAP_CTX = { terms: SWAP_TERMS, wallet: WALLET };
function tradeLog(o: { emitter?: string; user?: string; venue?: number; tokenIn?: string; tokenOut?: string; amountIn?: bigint; amountOut?: bigint; fee?: bigint } = {}) {
  const gross = o.amountIn ?? GROSS;
  return {
    address: (o.emitter ?? EXECUTOR) as `0x${string}`,
    topics: [toEventSelector("TradeExecuted(uint256,address,uint8,address,address,uint256,uint256,uint256)"), u256(7n), addr(o.user ?? WALLET)],
    data: encodeAbiParameters(
      [{ type: "uint8" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      [o.venue ?? 0, (o.tokenIn ?? NATIVE) as `0x${string}`, (o.tokenOut ?? USDC_CHECKSUM) as `0x${string}`, gross, o.amountOut ?? 4_190_000n, o.fee ?? (gross * 25n) / 10_000n],
    ),
  };
}
const erc20Transfer = () => ({
  address: USDC as `0x${string}`,
  topics: [toEventSelector("Transfer(address,address,uint256)"), addr(EXECUTOR), addr(WALLET)],
  data: u256(4_190_000n),
});

describe("swap — outputs from the verified TradeExecuted", () => {
  it("1. a valid TradeExecuted produces verified outputs that pass the declaration check", async () => {
    const a = await swapAction();
    const r = await a.confirmedOutputs!(receipt([tradeLog()]), SWAP_CTX);
    expect(r).toEqual({
      outputs: {
        amountOut: { verified: true, type: "units", value: "4190000", token: USDC },
        tokenOut: { verified: true, type: "token", value: USDC },
        fee: { verified: true, type: "units", value: (GROSS * 25n / 10_000n).toString(), token: NATIVE },
      },
      denominations: { tokenIn: NATIVE, tokenOut: USDC },
    });
    expect((await check(a, r)).ok).toBe(true);
  });

  it("2–4. amountOut, tokenOut and fee are the event's own values (lowercased), not the preview's", async () => {
    const a = await swapAction();
    const r = await a.confirmedOutputs!(receipt([tradeLog({ amountOut: 5_123_456n })]), SWAP_CTX);
    expect(r!.outputs.amountOut).toMatchObject({ value: "5123456", token: USDC });
    expect(r!.outputs.tokenOut).toEqual({ verified: true, type: "token", value: USDC }); // event emitted the checksummed form
    expect(r!.outputs.fee).toMatchObject({ value: "25000000000000000", token: NATIVE }); // = floor(10e18 * 25 / 10000) at the BUILD rate
    // USDC → MON: amountOut is native MON (the zero address) and the fee is in USDC.
    const usdcIn = { ...SWAP_TERMS, tokenIn: USDC, tokenOut: NATIVE, amountIn: "35000000" };
    const r2 = await a.confirmedOutputs!(receipt([tradeLog({ tokenIn: USDC_CHECKSUM, tokenOut: NATIVE, amountIn: 35_000_000n, amountOut: 10n ** 18n })]), { terms: usdcIn, wallet: WALLET });
    expect(r2!.outputs).toEqual({
      amountOut: { verified: true, type: "units", value: (10n ** 18n).toString(), token: NATIVE },
      tokenOut: { verified: true, type: "token", value: NATIVE },
      fee: { verified: true, type: "units", value: "87500", token: USDC },
    });
    expect((await check(a, r2)).ok).toBe(true);
  });

  it("5–6. no TradeExecuted (a generic ERC-20 Transfer can't substitute), or two of them → no outputs", async () => {
    const a = await swapAction();
    expect(await a.confirmedOutputs!(receipt([]), SWAP_CTX)).toBeNull();
    expect(await a.confirmedOutputs!(receipt([erc20Transfer()]), SWAP_CTX)).toBeNull();
    expect(await a.confirmedOutputs!(receipt([tradeLog(), tradeLog()]), SWAP_CTX)).toBeNull();
    expect(await a.confirmedOutputs!(receipt([tradeLog()], "reverted"), SWAP_CTX)).toBeNull();
  });

  it("7. no client value can enter: outputs depend only on the receipt and the build record's terms + wallet", async () => {
    const a = await swapAction();
    expect(a.confirmedOutputs!.length).toBe(2);
    expect(await a.confirmedOutputs!(receipt([tradeLog()]), undefined)).toBeNull();
    expect(await a.confirmedOutputs!(receipt([tradeLog()]), { wallet: WALLET })).toBeNull();
    expect(await a.confirmedOutputs!(receipt([tradeLog()]), { terms: SWAP_TERMS })).toBeNull();
  });

  it.each([
    ["8. another wallet's trade", { user: OTHER }],
    ["9. another executor's event", { emitter: OTHER_EXECUTOR }],
    ["10. a different tokenIn", { tokenIn: USDC_CHECKSUM }],
    ["11. a different tokenOut", { tokenOut: WMON }],
    ["12. a different gross input", { amountIn: GROSS - 1n, fee: ((GROSS - 1n) * 25n) / 10_000n }],
    ["13. a different fee", { fee: 1n }],
    ["zero output", { amountOut: 0n }],
    ["an unknown venue", { venue: 2 }],
  ])("%s → no outputs", async (_l, o) => {
    const a = await swapAction();
    expect(await a.confirmedOutputs!(receipt([tradeLog(o)]), SWAP_CTX)).toBeNull();
  });

  it("14. a result that doesn't match the declarations is refused as a whole", async () => {
    const a = await swapAction();
    const good = (await a.confirmedOutputs!(receipt([tradeLog()]), SWAP_CTX))!;
    const variant = (f: (o: Record<string, unknown>, d: Record<string, unknown>) => void) => {
      const r = JSON.parse(JSON.stringify(good));
      f(r.outputs, r.denominations);
      return r;
    };
    const bad = [
      variant((o) => { o.amountOut = { verified: true, type: "token", value: USDC }; }),            // units declared, token returned
      variant((o) => { (o.amountOut as Record<string, unknown>).token = WMON; }),                    // wrong token
      variant((o) => { o.amountOutt = o.amountOut; delete o.amountOut; }),                           // wrong name
      variant((o) => { o.extra = o.fee; }),                                                         // unexpected output
      variant((o) => { delete o.fee; }),                                                            // missing output
      variant((o) => { (o.amountOut as Record<string, unknown>).value = "4.19"; }),                  // malformed number
      variant((o) => { (o.amountOut as Record<string, unknown>).verified = false; }),                // unverified
      variant((o) => { (o.tokenOut as Record<string, unknown>).value = WMON; }),                     // token output ≠ proven
      variant((_o, d) => { delete d.tokenIn; }),                                                    // no proven denomination
      variant((_o, d) => { d.tokenOut = USDC_CHECKSUM; }),                                          // non-canonical denomination
      variant((o) => { (o.amountOut as Record<string, unknown>).token = USDC_CHECKSUM; }),           // non-canonical address
    ];
    for (const r of bad) expect((await check(a, r)).ok, JSON.stringify(r)).toBe(false);
    expect((await check(a, null)).ok).toBe(false);
    expect((await check(a, { outputs: good.outputs })).ok).toBe(false);
    expect((await check({ outputs: undefined } as unknown as Action, good)).ok).toBe(false);
  });
});

/* ── Transfer ──────────────────────────────────────────────────────────── */

const FEE = usdc("0.05");
function usdc(n: string) { return parseUnits(n, 6); }
const TRANSFER_TERMS = {
  feeBps: "25", treasury: TREASURY, feeSource: FORWARDER.toLowerCase(), token: USDC, recipient: RECIPIENT,
  gross: usdc("20").toString(), fee: FEE.toString(), net: (usdc("20") - FEE).toString(),
};
const T_CTX = { terms: TRANSFER_TERMS, wallet: WALLET };
function paymentForwarded(o: { emitter?: string; id?: bigint; payer?: string; recipient?: string; token?: string; amount?: bigint } = {}) {
  return {
    address: (o.emitter ?? FORWARDER) as `0x${string}`,
    topics: [toEventSelector("PaymentForwarded(uint256,address,address,address,uint256,bytes32)"), u256(o.id ?? 77n), addr(o.payer ?? WALLET), addr(o.recipient ?? RECIPIENT)],
    data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes32" }], [(o.token ?? USDC) as `0x${string}`, o.amount ?? usdc("20"), `0x${"0".repeat(64)}`]),
  };
}
function feeCollected(o: { emitter?: string; id?: bigint; token?: string; fee?: bigint; treasury?: string } = {}) {
  return {
    address: (o.emitter ?? FORWARDER) as `0x${string}`,
    topics: [toEventSelector("FeeCollected(uint256,address,uint256,address)"), u256(o.id ?? 77n)],
    data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "address" }], [(o.token ?? USDC) as `0x${string}`, o.fee ?? FEE, (o.treasury ?? TREASURY) as `0x${string}`]),
  };
}

describe("transfer — outputs from the strict PaymentForwarded + FeeCollected verification", () => {
  it("15–18. a verified payment produces amount (net), gross, fee and token", async () => {
    const a = await transferAction();
    const r = await a.confirmedOutputs!(receipt([paymentForwarded(), feeCollected()]), T_CTX);
    expect(r).toEqual({
      outputs: {
        amount: { verified: true, type: "units", value: "19950000", token: USDC },
        gross: { verified: true, type: "units", value: "20000000", token: USDC },
        fee: { verified: true, type: "units", value: "50000", token: USDC },
        token: { verified: true, type: "token", value: USDC },
      },
      denominations: { token: USDC },
    });
    expect((await check(a, r)).ok).toBe(true);
  });

  it("native MON: the token is the zero address (real, verified — still never an ERC-20)", async () => {
    const a = await transferAction();
    const gross = parseUnits("1", 18);
    const fee = gross * 25n / 10_000n;
    const terms = { ...TRANSFER_TERMS, token: NATIVE, gross: gross.toString(), fee: fee.toString(), net: (gross - fee).toString() };
    const r = await a.confirmedOutputs!(receipt([paymentForwarded({ token: NATIVE, amount: gross }), feeCollected({ token: NATIVE, fee })]), { terms, wallet: WALLET });
    expect(r!.outputs.token).toEqual({ verified: true, type: "token", value: NATIVE });
    expect(r!.outputs.amount).toMatchObject({ token: NATIVE, value: (gross - fee).toString() });
    expect((await check(a, r)).ok).toBe(true);
  });

  it.each([
    ["payer is not the build wallet", [paymentForwarded({ payer: OTHER }), feeCollected()]],
    ["recipient differs from the terms", [paymentForwarded({ recipient: OTHER }), feeCollected()]],
    ["token differs from the terms", [paymentForwarded({ token: WMON }), feeCollected({ token: WMON })]],
    ["PaymentForwarded token differs (FeeCollected's matches)", [paymentForwarded({ token: WMON }), feeCollected()]],
    ["gross differs from the terms", [paymentForwarded({ amount: usdc("19") }), feeCollected()]],
    ["fee differs from the terms", [paymentForwarded(), feeCollected({ fee: FEE - 1n })]],
    ["treasury differs from the terms", [paymentForwarded(), feeCollected({ treasury: OTHER })]],
    ["FeeCollected token differs", [paymentForwarded(), feeCollected({ token: WMON })]],
    ["missing FeeCollected with a non-zero fee", [paymentForwarded()]],
    ["FeeCollected for another payment id", [paymentForwarded(), feeCollected({ id: 78n })]],
    ["FeeCollected from another emitter", [paymentForwarded(), feeCollected({ emitter: OTHER })]],
    ["PaymentForwarded from another emitter", [paymentForwarded({ emitter: OTHER }), feeCollected()]],
    ["two PaymentForwarded events", [paymentForwarded(), paymentForwarded({ id: 78n }), feeCollected(), feeCollected({ id: 78n })]],
    ["two FeeCollected events for the id", [paymentForwarded(), feeCollected(), feeCollected()]],
    ["no events at all", []],
  ])("%s → no outputs", async (_l, logs) => {
    const a = await transferAction();
    expect(await a.confirmedOutputs!(receipt(logs as ActionReceipt["logs"]), T_CTX)).toBeNull();
  });

  it("missing build terms or wallet, or a reverted receipt → no outputs", async () => {
    const a = await transferAction();
    const logs = [paymentForwarded(), feeCollected()];
    expect(await a.confirmedOutputs!(receipt(logs), { wallet: WALLET })).toBeNull();
    expect(await a.confirmedOutputs!(receipt(logs), { terms: TRANSFER_TERMS })).toBeNull();
    expect(await a.confirmedOutputs!(receipt(logs, "reverted"), T_CTX)).toBeNull();
    const { net: _n, ...noNet } = TRANSFER_TERMS;
    expect(await a.confirmedOutputs!(receipt(logs), { terms: noNet, wallet: WALLET })).toBeNull();
  });

  it("zero fee is checked explicitly: FeeCollected(0) is required, never inferred from its absence", async () => {
    const a = await transferAction();
    const terms = { ...TRANSFER_TERMS, feeBps: "0", fee: "0", net: TRANSFER_TERMS.gross };
    const ok = await a.confirmedOutputs!(receipt([paymentForwarded(), feeCollected({ fee: 0n })]), { terms, wallet: WALLET });
    expect(ok!.outputs.fee).toMatchObject({ value: "0" });
    expect(ok!.outputs.amount).toMatchObject({ value: TRANSFER_TERMS.gross });
    expect(await a.confirmedOutputs!(receipt([paymentForwarded()]), { terms, wallet: WALLET })).toBeNull();
    expect(await a.confirmedOutputs!(receipt([paymentForwarded(), feeCollected({ fee: 0n, treasury: OTHER })]), { terms, wallet: WALLET })).toBeNull();
  });

  it("19. where strict verification fails, the EXISTING lenient settlement is unchanged", async () => {
    const a = await transferAction();
    // Missing FeeCollected: history still sees a settled payment with fee 0 (today's behaviour)…
    const lenient = await a.settledOutflows!(receipt([paymentForwarded()]), T_CTX);
    expect(lenient.recipients).toHaveLength(1);
    expect(lenient.recipients[0].amountUnits).toBe(usdc("20"));
    expect(lenient.fee).toBeNull();
    // …and a payer mismatch too — but neither produces confirmed outputs.
    expect((await a.settledOutflows!(receipt([paymentForwarded({ payer: OTHER }), feeCollected()]), T_CTX)).recipients).toHaveLength(1);
    expect(await a.confirmedOutputs!(receipt([paymentForwarded()]), T_CTX)).toBeNull();
    expect(await a.confirmedOutputs!(receipt([paymentForwarded({ payer: OTHER }), feeCollected()]), T_CTX)).toBeNull();
    // parseResult unchanged too.
    expect((await a.parseResult(receipt([paymentForwarded(), feeCollected()]), T_CTX))["recipient received"]).toBe("19.95 USDC");
  });

  it("20. the treasury / fee leg never becomes a recipient output", async () => {
    const a = await transferAction();
    const r = (await a.confirmedOutputs!(receipt([paymentForwarded(), feeCollected()]), T_CTX))!;
    expect(Object.keys(r.outputs).sort()).toEqual(["amount", "fee", "gross", "token"]);
    expect(JSON.stringify(r)).not.toContain(TREASURY.slice(2));
    expect(JSON.stringify(r)).not.toContain(RECIPIENT.slice(2));
  });
});

/* ── Split ─────────────────────────────────────────────────────────────── */

const SPLIT_TERMS = {
  feeBps: "25", treasury: TREASURY, feeSource: FORWARDER.toLowerCase(), token: USDC,
  recipientTotal: "50000", fee: "125", gross: "50125",
};
const S_CTX = { terms: SPLIT_TERMS, wallet: WALLET };
function splitLog(recipients: string[], amounts: bigint[], o: { emitter?: string; payer?: string; token?: string; total?: bigint } = {}) {
  return {
    address: (o.emitter ?? SPLIT) as `0x${string}`,
    topics: [
      toEventSelector("SplitPaymentExecuted(uint256,address,address,bytes32,uint256,address[],uint256[])"),
      u256(7n), addr(o.payer ?? WALLET), addr(o.token ?? USDC),
    ],
    data: encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "address[]" }, { type: "uint256[]" }],
      [`0x${"0".repeat(64)}`, o.total ?? amounts.reduce((s, a) => s + a, 0n), recipients as `0x${string}`[], amounts],
    ),
  };
}
const goodSplit = () => splitLog([A, B, TREASURY], [30_000n, 20_000n, 125n]);

describe("split — outputs from the strict SplitPaymentExecuted verification", () => {
  it("21–23. a verified settlement produces recipientAmounts, fee and gross", async () => {
    const a = await splitAction();
    const r = await a.confirmedOutputs!(receipt([goodSplit()]), S_CTX);
    expect(r).toEqual({
      outputs: {
        recipientAmounts: { verified: true, type: "units[]", value: ["30000", "20000"], token: USDC },
        fee: { verified: true, type: "units", value: "125", token: USDC },
        gross: { verified: true, type: "units", value: "50125", token: USDC },
      },
      denominations: { token: USDC },
    });
    expect((await check(a, r)).ok).toBe(true);
  });

  it("24. the treasury fee leg is never in recipientAmounts", async () => {
    const a = await splitAction();
    const r = (await a.confirmedOutputs!(receipt([goodSplit()]), S_CTX))!;
    const amounts = (r.outputs.recipientAmounts as { value: string[] }).value;
    expect(amounts).toHaveLength(2);
    expect(amounts).not.toContain("125");
  });

  it("25. recipient order is preserved", async () => {
    const a = await splitAction();
    const r = (await a.confirmedOutputs!(receipt([splitLog([B, A, TREASURY], [20_000n, 30_000n, 125n])]), S_CTX))!;
    expect((r.outputs.recipientAmounts as { value: string[] }).value).toEqual(["20000", "30000"]);
  });

  it("native MON split: the token is the zero address", async () => {
    const a = await splitAction();
    const r = await a.confirmedOutputs!(receipt([splitLog([A, B, TREASURY], [30_000n, 20_000n, 125n], { token: NATIVE })]), { terms: { ...SPLIT_TERMS, token: NATIVE }, wallet: WALLET });
    expect(r!.outputs.recipientAmounts).toMatchObject({ token: NATIVE });
    expect((await check(a, r)).ok).toBe(true);
  });

  it.each([
    ["payer is not the build wallet", [splitLog([A, B, TREASURY], [30_000n, 20_000n, 125n], { payer: OTHER })]],
    ["token differs from the terms", [splitLog([A, B, TREASURY], [30_000n, 20_000n, 125n], { token: WMON })]],
    ["legs don't add up to the event total", [splitLog([A, B, TREASURY], [30_000n, 20_000n, 125n], { total: 50_126n })]],
    ["recipient total differs from the terms", [splitLog([A, B, TREASURY], [30_001n, 19_999n - 1n, 126n])]],
    ["gross differs from the terms", [splitLog([A, B, TREASURY], [30_000n, 20_001n, 125n])]],
    ["missing fee leg with a non-zero fee", [splitLog([A, B], [30_000n, 20_125n])]],
    ["fee leg with the wrong amount", [splitLog([A, B, TREASURY], [30_000n, 20_001n, 124n])]],
    ["fee leg not where build puts it (last)", [splitLog([TREASURY, A, B], [125n, 30_000n, 20_000n])]],
    ["the treasury also appears as a recipient", [splitLog([A, TREASURY, TREASURY], [30_000n, 20_000n, 125n])]],
    ["fee leg paid to another address", [splitLog([A, B, OTHER], [30_000n, 20_000n, 125n])]],
    ["an event from another contract", [splitLog([A, B, TREASURY], [30_000n, 20_000n, 125n], { emitter: OTHER })]],
    ["two settlement events", [goodSplit(), goodSplit()]],
    ["no settlement event", []],
  ])("26. %s → no outputs", async (_l, logs) => {
    const a = await splitAction();
    expect(await a.confirmedOutputs!(receipt(logs as ActionReceipt["logs"]), S_CTX)).toBeNull();
  });

  it("a treasury leg that isn't build's last leg never leaks into recipientAmounts, even when the last leg equals the fee", async () => {
    const a = await splitAction();
    // Terms consistent with [T:125, A:30000, B:125] read as "recipients = all but last".
    const terms = { ...SPLIT_TERMS, recipientTotal: "30125", gross: "30250" };
    expect(await a.confirmedOutputs!(receipt([splitLog([TREASURY, A, B], [125n, 30_000n, 125n])]), { terms, wallet: WALLET })).toBeNull();
  });

  it("build terms that don't add up (recipientTotal + fee ≠ gross) → no outputs", async () => {
    const a = await splitAction();
    expect(await a.confirmedOutputs!(receipt([goodSplit()]), { terms: { ...SPLIT_TERMS, recipientTotal: "49999" }, wallet: WALLET })).toBeNull();
  });

  it("missing terms or wallet, or a reverted receipt → no outputs", async () => {
    const a = await splitAction();
    expect(await a.confirmedOutputs!(receipt([goodSplit()]), { wallet: WALLET })).toBeNull();
    expect(await a.confirmedOutputs!(receipt([goodSplit()]), { terms: SPLIT_TERMS })).toBeNull();
    expect(await a.confirmedOutputs!(receipt([goodSplit()], "reverted"), S_CTX)).toBeNull();
  });

  it("zero fee is checked explicitly: no fee leg, and no leg to the treasury at all", async () => {
    const a = await splitAction();
    const terms = { ...SPLIT_TERMS, feeBps: "0", fee: "0", gross: "50000" };
    const r = await a.confirmedOutputs!(receipt([splitLog([A, B], [30_000n, 20_000n])]), { terms, wallet: WALLET });
    expect(r!.outputs).toMatchObject({ recipientAmounts: { value: ["30000", "20000"] }, fee: { value: "0" }, gross: { value: "50000" } });
    expect(await a.confirmedOutputs!(receipt([splitLog([A, TREASURY], [30_000n, 20_000n])]), { terms: { ...terms }, wallet: WALLET })).toBeNull();
  });

  it("where strict verification fails, the EXISTING lenient settlement is unchanged", async () => {
    const a = await splitAction();
    // Missing fee leg: history sees every leg as a recipient, fee null (today's behaviour).
    const lenient = await a.settledOutflows!(receipt([splitLog([A, B], [30_000n, 20_125n])]), S_CTX);
    expect(lenient.recipients.map((r) => r.amountUnits)).toEqual([30_000n, 20_125n]);
    expect(lenient.fee).toBeNull();
    expect((await a.settledOutflows!(receipt([splitLog([A, B, TREASURY], [30_000n, 20_000n, 125n], { payer: OTHER })]), S_CTX)).recipients).toHaveLength(2);
    expect(await a.confirmedOutputs!(receipt([splitLog([A, B], [30_000n, 20_125n])]), S_CTX)).toBeNull();
    // The valid case: lenient and strict agree.
    const both = await a.settledOutflows!(receipt([goodSplit()]), S_CTX);
    expect(both.recipients.map((r) => r.amountUnits)).toEqual([30_000n, 20_000n]);
    expect(both.fee?.amountUnits).toBe(125n);
  });
});

/* ── Type safety ───────────────────────────────────────────────────────── */

describe("verified output value shapes", () => {
  it("37. units: exact uint256 decimal strings only", async () => {
    const { isVerifiedOutputValue } = await import("@/lib/sdk/settlement");
    const u = (value: unknown) => ({ verified: true, type: "units", value, token: USDC });
    for (const ok of ["0", "1", "4190000", MAX_UINT256.toString()]) expect(isVerifiedOutputValue(u(ok)), ok).toBe(true);
    for (const bad of ["", "01", "-1", "1.0", "1e3", " 1", "0x10", (MAX_UINT256 + 1n).toString(), 1, 1n, null]) {
      expect(isVerifiedOutputValue(u(bad)), String(bad)).toBe(false);
    }
  });

  it("39. units[]: every member a uint256 string, non-empty", async () => {
    const { isVerifiedOutputValue } = await import("@/lib/sdk/settlement");
    const l = (value: unknown) => ({ verified: true, type: "units[]", value, token: USDC });
    expect(isVerifiedOutputValue(l(["1", "2"]))).toBe(true);
    for (const bad of [[], ["1", "x"], ["1", 2], ["1", (MAX_UINT256 + 1n).toString()], "1", null]) expect(isVerifiedOutputValue(l(bad)), JSON.stringify(bad)).toBe(false);
  });

  it("38. token: a lowercase 20-byte address; checksummed or malformed is refused (no coercion)", async () => {
    const { isVerifiedOutputValue } = await import("@/lib/sdk/settlement");
    const t = (value: unknown) => ({ verified: true, type: "token", value });
    expect(isVerifiedOutputValue(t(USDC))).toBe(true);
    expect(isVerifiedOutputValue(t(NATIVE))).toBe(true);
    for (const bad of [USDC_CHECKSUM, "0x1234", `${USDC}00`, "usdc", "", null]) expect(isVerifiedOutputValue(t(bad)), String(bad)).toBe(false);
    expect(isVerifiedOutputValue({ verified: true, type: "units", value: "1", token: USDC_CHECKSUM })).toBe(false);
  });

  it("41. unverified, mistyped or extra-keyed values are refused", async () => {
    const { isVerifiedOutputValue } = await import("@/lib/sdk/settlement");
    expect(isVerifiedOutputValue({ verified: false, type: "units", value: "1", token: USDC })).toBe(false);
    expect(isVerifiedOutputValue({ verified: "true", type: "units", value: "1", token: USDC })).toBe(false);
    expect(isVerifiedOutputValue({ type: "units", value: "1", token: USDC })).toBe(false);
    expect(isVerifiedOutputValue({ verified: true, type: "units[]", value: "1", token: USDC })).toBe(false);
    expect(isVerifiedOutputValue({ verified: true, type: "amount", value: "1", token: USDC })).toBe(false);
    expect(isVerifiedOutputValue({ verified: true, type: "units", value: "1" })).toBe(false);
    expect(isVerifiedOutputValue({ verified: true, type: "token", value: USDC, token: USDC })).toBe(false);
    expect(isVerifiedOutputValue({ verified: true, type: "units", value: "1", token: USDC, extra: 1 })).toBe(false);
  });

  it("40. a units output whose token isn't the proven denomination is refused", async () => {
    const a = await transferAction();
    const r = (await a.confirmedOutputs!(receipt([paymentForwarded(), feeCollected()]), T_CTX))!;
    const forged = JSON.parse(JSON.stringify(r));
    forged.outputs.amount.token = WMON;
    expect((await check(a, forged)).ok).toBe(false);
    const forgedDenom = JSON.parse(JSON.stringify(r));
    forgedDenom.denominations.token = WMON; // every output now disagrees with it
    expect((await check(a, forgedDenom)).ok).toBe(false);
  });

  it("42. native MON is represented as the zero address and stays non-bindable for the planner", async () => {
    const { validateIntentGraph } = await import("@/lib/plan/validate");
    const node = (nodeId: string, ref: [string, string, string], inputs: Record<string, unknown>, dependsOn: string[] = []) => ({
      nodeId, ref: { protocolId: ref[0], actionId: ref[1], version: ref[2] }, inputs, dependsOn,
      validation: { state: "pending" }, execution: { state: "pending" }, verification: { state: "pending" },
    });
    const text = `swap 35 USDC to MON and send it to ${RECIPIENT}`;
    const g = {
      id: "intent_outputs_01", version: 1, chainId: 143, wallet: WALLET, status: "draft",
      source: { text, adapter: "deterministic", adapterVersion: "1" },
      nodes: [
        node("n1", ["payai", "swap", "1.0.0"], { tokenIn: { kind: "literal", value: USDC }, tokenOut: { kind: "literal", value: NATIVE }, amountIn: { kind: "literal", value: "35000000" } }),
        node("n2", ["payai", "transfer", "1.0.0"], { recipient: { kind: "recipient", display: RECIPIENT, source: "address", address: RECIPIENT }, amount: { kind: "output", node: "n1", output: "amountOut" } }, ["n1"]),
      ],
    };
    const res = validateIntentGraph(g, { sessionWallet: WALLET, activeChainId: 143 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("NATIVE_OUTPUT_NOT_BINDABLE");
  });

  it("planner compatibility: a stored swap record's units output resolves in the Stage 1 resolver; a native one is refused there too", async () => {
    const { validateIntentGraph } = await import("@/lib/plan/validate");
    const { planIntent } = await import("@/lib/plan/planner");
    const { resolveStepInputs } = await import("@/lib/plan/resolve");
    const node = (nodeId: string, ref: [string, string, string], inputs: Record<string, unknown>, dependsOn: string[] = []) => ({
      nodeId, ref: { protocolId: ref[0], actionId: ref[1], version: ref[2] }, inputs, dependsOn,
      validation: { state: "pending" }, execution: { state: "pending" }, verification: { state: "pending" },
    });
    const text = `swap 10 MON to USDC and send the USDC to ${RECIPIENT}`;
    const res = validateIntentGraph({
      id: "intent_outputs_02", version: 1, chainId: 143, wallet: WALLET, status: "draft",
      source: { text, adapter: "deterministic", adapterVersion: "1" },
      nodes: [
        node("n1", ["payai", "swap", "1.0.0"], { tokenOut: { kind: "literal", value: USDC }, amountIn: { kind: "literal", value: GROSS.toString() } }),
        node("n2", ["payai", "transfer", "1.0.0"], { recipient: { kind: "recipient", display: RECIPIENT, source: "address", address: RECIPIENT }, token: { kind: "literal", value: USDC }, amount: { kind: "output", node: "n1", output: "amountOut" } }, ["n1"]),
      ],
    }, { sessionWallet: WALLET, activeChainId: 143 });
    if (!res.ok) throw new Error(JSON.stringify(res.error));
    const plan = planIntent(res.value, { sessionWallet: WALLET });
    const swap = await swapAction();
    const v = (await swap.confirmedOutputs!(receipt([tradeLog()]), SWAP_CTX))!;
    const confirmed = { n1: v.outputs } as never;
    const inputs = resolveStepInputs({ plan, graph: res.value, nodeId: "n2", sessionWallet: WALLET, confirmed });
    expect(inputs.amount).toBe("4190000");
    const nativeLike = { n1: { ...v.outputs, amountOut: { ...v.outputs.amountOut, token: NATIVE } } } as never;
    expect(() => resolveStepInputs({ plan, graph: res.value, nodeId: "n2", sessionWallet: WALLET, confirmed: nativeLike })).toThrow(expect.objectContaining({ code: "NATIVE_OUTPUT_NOT_BINDABLE" }));
  });
});

/* ── Storage ───────────────────────────────────────────────────────────── */

const QUOTE = "a".repeat(32);
const TX1 = `0x${"1".repeat(64)}`;
const TX2 = `0x${"2".repeat(64)}`;
const OUTS = { amount: { verified: true as const, type: "units" as const, value: "19950000", token: USDC } };
const rec = (o: Partial<Record<string, unknown>> = {}) => ({
  quoteId: QUOTE, txHash: TX1, wallet: WALLET, protocolId: "payai", actionId: "transfer", version: "1.0.0", outputs: OUTS, recordedAt: 1_700_000_000_000, ...o,
}) as import("@/lib/sdk/settlement").OutputRecord;
const ctxOf = (o: Partial<Record<string, string>> = {}) => ({ quoteId: QUOTE, txHash: TX1, wallet: WALLET, protocolId: "payai", actionId: "transfer", version: "1.0.0", ...o });

describe.each([["KV", true], ["in-memory fallback", false]])("write-once output records (%s)", (_l, useKv) => {
  beforeEach(() => { kv.enabled = useKv as boolean; });

  it("27. inserts and reads back the record for this exact transaction", async () => {
    const s = await import("@/lib/sdk/settlement");
    expect(await s.readOutputRecord(ctxOf())).toEqual({ status: "absent" });
    expect(await s.insertOutputRecordOnce(rec())).toMatchObject({ status: "recorded", record: { txHash: TX1, outputs: OUTS } });
    expect(await s.readOutputRecord(ctxOf())).toMatchObject({ status: "recorded", record: rec() });
  });

  it("28–30. write-once: neither the same tx nor another tx can replace it", async () => {
    const s = await import("@/lib/sdk/settlement");
    await s.insertOutputRecordOnce(rec());
    const changed = { amount: { ...OUTS.amount, value: "1" } };
    expect(await s.insertOutputRecordOnce(rec({ outputs: changed }))).toMatchObject({ status: "recorded", record: { outputs: OUTS } });
    expect(await s.insertOutputRecordOnce(rec({ txHash: TX2, outputs: changed }))).toMatchObject({ status: "already_recorded_for_another_tx", record: { txHash: TX1, outputs: OUTS } });
    expect(await s.readOutputRecord(ctxOf({ txHash: TX2 }))).toMatchObject({ status: "already_recorded_for_another_tx" });
    expect(await s.readOutputRecord(ctxOf())).toMatchObject({ status: "recorded", record: { outputs: OUTS } });
  });

  it("31–33. another wallet, action or quote never sees (or writes) this record", async () => {
    const s = await import("@/lib/sdk/settlement");
    await s.insertOutputRecordOnce(rec());
    expect(await s.readOutputRecord(ctxOf({ wallet: OTHER }))).toEqual({ status: "mismatch" });
    expect(await s.readOutputRecord(ctxOf({ actionId: "swap" }))).toEqual({ status: "mismatch" });
    expect(await s.readOutputRecord(ctxOf({ version: "1.0.1" }))).toEqual({ status: "mismatch" });
    expect(await s.readOutputRecord(ctxOf({ protocolId: "payai-settlement" }))).toEqual({ status: "mismatch" });
    expect(await s.readOutputRecord(ctxOf({ quoteId: "b".repeat(32) }))).toEqual({ status: "absent" });
    expect(await s.insertOutputRecordOnce(rec({ wallet: OTHER, txHash: TX2 }))).toEqual({ status: "mismatch" });
    expect(await s.insertOutputRecordOnce(rec({ actionId: "swap" }))).toEqual({ status: "mismatch" });
    expect(await s.readOutputRecord(ctxOf())).toMatchObject({ status: "recorded", record: { wallet: WALLET, actionId: "transfer" } });
  });

  it("34. a malformed record (stored or offered) is refused, never trusted or replaced", async () => {
    const s = await import("@/lib/sdk/settlement");
    for (const bad of [
      rec({ txHash: "0x12" }), rec({ wallet: WALLET.toUpperCase().replace("0X", "0x") }), rec({ outputs: {} }),
      rec({ outputs: { amount: { ...OUTS.amount, verified: false } } }), rec({ recordedAt: -1 }), rec({ quoteId: "x" }),
      { ...rec(), extra: true } as never,
    ]) expect(await s.insertOutputRecordOnce(bad), JSON.stringify(bad)).toEqual({ status: "malformed" });
    expect(await s.readOutputRecord(ctxOf())).toEqual({ status: "absent" });
    // A malformed value already at the key: reported, and never overwritten.
    if (useKv) kv.store.set(s.outputsKey(QUOTE), JSON.stringify({ quoteId: QUOTE, outputs: "lots" }));
    else (globalThis as unknown as { __payaiSdkOutputs: Map<string, unknown> }).__payaiSdkOutputs.set(s.outputsKey(QUOTE), { value: { quoteId: QUOTE }, expiresAt: Date.now() + 1e9 });
    expect(await s.readOutputRecord(ctxOf())).toEqual({ status: "malformed" });
    expect(await s.insertOutputRecordOnce(rec())).toEqual({ status: "malformed" });
    expect(await s.readOutputRecord(ctxOf())).toEqual({ status: "malformed" });
  });

  it("36. TTL is 24 hours", async () => {
    const s = await import("@/lib/sdk/settlement");
    expect(s.OUTPUTS_TTL_SECONDS).toBe(86_400);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.UTC(2026, 9, 3));
    await s.insertOutputRecordOnce(rec());
    if (useKv) {
      expect(kv.sets.filter((x) => x.key === s.outputsKey(QUOTE))).toEqual([{ key: s.outputsKey(QUOTE), opts: { nx: true, ex: 86_400 } }]);
    } else {
      vi.setSystemTime(Date.UTC(2026, 9, 3) + 86_400_000 - 1);
      expect((await s.readOutputRecord(ctxOf())).status).toBe("recorded");
      vi.setSystemTime(Date.UTC(2026, 9, 3) + 86_400_000);
      expect((await s.readOutputRecord(ctxOf())).status).toBe("absent");
    }
  });

  it("the stored record is a copy: mutating what was passed in or returned changes nothing stored", async () => {
    const s = await import("@/lib/sdk/settlement");
    const r = rec({ outputs: { amount: { ...OUTS.amount } } });
    const res = await s.insertOutputRecordOnce(r);
    (r.outputs.amount as { value: string }).value = "999";
    if (res.status === "recorded") (res.record.outputs.amount as { value: string }).value = "998";
    expect(await s.readOutputRecord(ctxOf())).toMatchObject({ record: { outputs: OUTS } });
  });
});

it("write is atomic: one SET NX EX carrying the complete record — no claim-then-overwrite", async () => {
  kv.enabled = true;
  const s = await import("@/lib/sdk/settlement");
  await s.insertOutputRecordOnce(rec());
  await s.insertOutputRecordOnce(rec({ txHash: TX2 }));
  const sets = kv.sets.filter((x) => x.key === s.outputsKey(QUOTE));
  expect(sets).toHaveLength(2);
  expect(sets.every((x) => x.opts?.nx === true && x.opts?.ex === 86_400)).toBe(true);
  expect(JSON.parse(kv.store.get(s.outputsKey(QUOTE))!)).toEqual(rec());
});

/* ── Through the real preview → build → confirm routes (transfer) ──────── */

describe("confirm route: outputs written once, returned only for their own transaction", () => {
  const ID = { protocolId: "payai", actionId: "transfer", version: "1.0.0" };
  const post = (url: string, body: unknown) => new NextRequest(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const I = { recipient: RECIPIENT, token: USDC, amount: usdc("20").toString() };
  let seq = 0;
  const hash = () => `0x${(++seq).toString(16).padStart(64, "c")}`;

  async function prepared() {
    const { POST: preview } = await import("@/app/api/ask/action/route");
    const pj = await (await preview(post("https://usepayai.xyz/api/ask/action", { ...ID, inputs: I }))).json();
    expect(pj.ok).toBe(true);
    const { POST: build } = await import("@/app/api/ask/action/build/route");
    const bj = await (await build(post("https://usepayai.xyz/api/ask/action/build", { ...ID, inputs: I, walletAddress: WALLET, quoteToken: pj.quoteToken }))).json();
    expect(bj.ok).toBe(true);
    return { quoteId: bj.quoteId as string, final: bj.steps.at(-1) as { tx: { to: string; data: string; value: string } } };
  }
  function mine(final: { tx: { to: string; data: string; value: string } }, logs = [paymentForwarded(), feeCollected()]) {
    chain.tx = { from: WALLET, to: final.tx.to, input: final.tx.data, value: BigInt(final.tx.value) };
    chain.receipt = { status: "success", from: WALLET, logs };
  }
  async function confirm(quoteId: string, txHash: string, extra: Record<string, unknown> = {}) {
    const { POST } = await import("@/app/api/ask/action/confirm/route");
    const res = await POST(post("https://usepayai.xyz/api/ask/action/confirm", { ...ID, txHash, walletAddress: WALLET, quoteId, ...extra }));
    return { status: res.status, json: await res.json() };
  }
  async function stored(quoteId: string, txHash: string) {
    const { readOutputRecord } = await import("@/lib/sdk/settlement");
    return readOutputRecord({ quoteId, txHash, wallet: WALLET, ...ID });
  }
  const EXPECTED = {
    amount: { verified: true, type: "units", value: "19950000", token: USDC },
    gross: { verified: true, type: "units", value: "20000000", token: USDC },
    fee: { verified: true, type: "units", value: "50000", token: USDC },
    token: { verified: true, type: "token", value: USDC },
  };

  it("27/35. a successful confirmation stores and returns the verified outputs; client-supplied outputs are ignored", async () => {
    const { quoteId, final } = await prepared();
    mine(final);
    const h = hash();
    const c = await confirm(quoteId, h, { outputs: { amount: { verified: true, type: "units", value: "1", token: USDC } }, amount: "1", amountOut: "1" });
    expect(c.json).toMatchObject({ ok: true, success: true, recorded: 1, outputsStatus: "recorded", outputs: EXPECTED });
    expect(await stored(quoteId, h)).toMatchObject({ status: "recorded", record: { quoteId, txHash: h, wallet: WALLET, outputs: EXPECTED } });
  });

  it("29. replaying the same transaction returns the same outputs", async () => {
    const { quoteId, final } = await prepared();
    mine(final);
    const h = hash();
    const first = await confirm(quoteId, h);
    const again = await confirm(quoteId, h);
    expect(again.json.replayed).toBe(true);
    expect(again.json.outputs).toEqual(first.json.outputs);
  });

  it("30/C. a second transaction for the same quote keeps its history but gets no outputs, and can't overwrite", async () => {
    const { quoteId, final } = await prepared();
    mine(final);
    const h1 = hash();
    await confirm(quoteId, h1);
    // The same built transaction signed again lands as a separate, real settlement.
    mine(final, [paymentForwarded({ id: 78n }), feeCollected({ id: 78n })]);
    const h2 = hash();
    const second = await confirm(quoteId, h2);
    expect(second.json).toMatchObject({ ok: true, recorded: 1, outputs: null, outputsStatus: "already_recorded_for_another_tx" });
    expect(await stored(quoteId, h1)).toMatchObject({ status: "recorded", record: { txHash: h1 } });
  });

  it("31–32. another wallet or another action identity can't confirm, so writes nothing", async () => {
    const { quoteId, final } = await prepared();
    mine(final);
    const h = hash();
    expect((await confirm(quoteId, h, { walletAddress: OTHER })).status).toBe(409);
    expect((await confirm(quoteId, h, { actionId: "swap" })).status).toBe(409);
    expect((await confirm(quoteId, h, { version: "1.0.1" })).status).toBe(409);
    expect(await stored(quoteId, h)).toEqual({ status: "absent" });
  });

  it("33. a confirmation for another quote can't touch this quote's record", async () => {
    const one = await prepared();
    mine(one.final);
    const h1 = hash();
    await confirm(one.quoteId, h1);
    expect((await confirm("f".repeat(32), hash())).status).toBe(409);
    expect(await stored(one.quoteId, h1)).toMatchObject({ status: "recorded" });
  });

  it("34. a malformed record already at the key: the settlement still confirms, outputs aren't returned, nothing is overwritten", async () => {
    const { quoteId, final } = await prepared();
    const { outputsKey } = await import("@/lib/sdk/settlement");
    (globalThis as unknown as { __payaiSdkOutputs: Map<string, unknown> }).__payaiSdkOutputs.set(outputsKey(quoteId), { value: { junk: true }, expiresAt: Date.now() + 1e9 });
    mine(final);
    const h = hash();
    const c = await confirm(quoteId, h);
    expect(c.json).toMatchObject({ ok: true, recorded: 1, outputs: null, outputsStatus: "unavailable" });
    expect(await stored(quoteId, h)).toEqual({ status: "malformed" });
  });

  it("B. settled for history but not strictly verifiable: history unchanged, outputs null, nothing stored", async () => {
    const { quoteId, final } = await prepared();
    mine(final, [paymentForwarded()]); // no FeeCollected
    const h = hash();
    const c = await confirm(quoteId, h);
    expect(c.json).toMatchObject({ ok: true, success: true, recorded: 1, outputs: null, outputsStatus: "unverified" });
    expect(await stored(quoteId, h)).toEqual({ status: "absent" });
  });

  it("an unverified settlement (existing semantics) returns no outputs and stores nothing", async () => {
    const { quoteId, final } = await prepared();
    mine(final, [paymentForwarded({ recipient: OTHER }), feeCollected()]);
    const h = hash();
    const c = await confirm(quoteId, h);
    expect(c.json).toMatchObject({ ok: false, verified: false });
    expect(c.json).not.toHaveProperty("outputs");
    expect(await stored(quoteId, h)).toEqual({ status: "absent" });
  });

  it("14. a result that fails the declaration check is refused: status invalid, nothing stored", async () => {
    const { quoteId, final } = await prepared();
    const a = await transferAction();
    const spy = vi.spyOn(a, "confirmedOutputs").mockResolvedValue({
      outputs: { ...EXPECTED, amount: { verified: true, type: "units", value: "19950000", token: WMON } } as never,
      denominations: { token: USDC },
    });
    mine(final);
    const h = hash();
    const c = await confirm(quoteId, h);
    expect(spy).toHaveBeenCalled();
    expect(c.json).toMatchObject({ ok: true, recorded: 1, outputs: null, outputsStatus: "invalid" });
    expect(await stored(quoteId, h)).toEqual({ status: "absent" });
  });

  it("a throwing confirmedOutputs never breaks an already-recorded confirmation", async () => {
    const { quoteId, final } = await prepared();
    const a = await transferAction();
    vi.spyOn(a, "confirmedOutputs").mockRejectedValue(new Error("boom"));
    mine(final);
    const c = await confirm(quoteId, hash());
    expect(c.json).toMatchObject({ ok: true, recorded: 1, outputs: null, outputsStatus: "unavailable" });
  });

  it("an action without confirmedOutputs gets an unchanged response shape", async () => {
    const wrap = await action("wmon", "wrap", "1.0.0");
    expect(wrap.confirmedOutputs).toBeUndefined();
  });
});

/* ══ Stage 5C-2e — build-record lifetime and confirm refusal codes ═════════ */

describe("5C-2e — sdk-build records live for the plan's lifetime; confirm refusals carry machine codes", () => {
  const ID = { protocolId: "payai", actionId: "transfer", version: "1.0.0" };
  const post = (url: string, body: unknown) => new NextRequest(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const I = { recipient: RECIPIENT, token: USDC, amount: usdc("20").toString() };
  let seq = 0;
  const hash = () => `0x${(++seq).toString(16).padStart(64, "e")}`;
  async function prepared() {
    const { POST: preview } = await import("@/app/api/ask/action/route");
    const pj = await (await preview(post("https://usepayai.xyz/api/ask/action", { ...ID, inputs: I }))).json();
    const { POST: build } = await import("@/app/api/ask/action/build/route");
    const bj = await (await build(post("https://usepayai.xyz/api/ask/action/build", { ...ID, inputs: I, walletAddress: WALLET, quoteToken: pj.quoteToken }))).json();
    expect(bj.ok).toBe(true);
    return { quoteId: bj.quoteId as string, final: bj.steps.at(-1) as { tx: { to: string; data: string; value: string } } };
  }
  function mine(final: { tx: { to: string; data: string; value: string } }, o: { from?: string; input?: string } = {}) {
    chain.tx = { from: o.from ?? WALLET, to: final.tx.to, input: o.input ?? final.tx.data, value: BigInt(final.tx.value) };
    chain.receipt = { status: "success", from: o.from ?? WALLET, logs: [paymentForwarded(), feeCollected()] };
  }
  async function confirm(quoteId: string, txHash: string, extra: Record<string, unknown> = {}) {
    const { POST } = await import("@/app/api/ask/action/confirm/route");
    const res = await POST(post("https://usepayai.xyz/api/ask/action/confirm", { ...ID, txHash, walletAddress: WALLET, quoteId, ...extra }));
    return { status: res.status, json: await res.json() };
  }

  it("R1: the sdk-build claim and record get PLAN_TTL + retention grace (8 days); other records keep the 24h default", async () => {
    kv.enabled = true;
    const { PLAN_TTL_SECONDS, PLAN_RETENTION_GRACE_SECONDS } = await import("@/lib/plan/store");
    const { IDEMPOTENCY_TTL_SECONDS } = await import("@/lib/platform/idempotency");
    const EXTENDED = PLAN_TTL_SECONDS + PLAN_RETENTION_GRACE_SECONDS;
    expect(EXTENDED).toBe(8 * 24 * 60 * 60);
    expect(IDEMPOTENCY_TTL_SECONDS).toBe(24 * 60 * 60);
    const { quoteId } = await prepared();
    const buildSets = kv.sets.filter((x) => x.key === `veripay:idem:sdk-build:${quoteId}`);
    expect(buildSets.map((x) => x.opts)).toEqual([{ nx: true, ex: EXTENDED }, { ex: EXTENDED }]);
    // Only sdk-build records got the extended lifetime; every other write in the flow is unchanged.
    expect(kv.sets.filter((x) => x.opts?.ex === EXTENDED).every((x) => x.key.startsWith("veripay:idem:sdk-build:"))).toBe(true);
    expect(kv.sets.filter((x) => x.key.startsWith("veripay:idem:") && !x.key.startsWith("veripay:idem:sdk-build:")).every((x) => x.opts?.ex === IDEMPOTENCY_TTL_SECONDS)).toBe(true);
  });

  it("R1 (in-memory fallback): a build record is still readable 25 hours later, and gone after 8 days", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.UTC(2026, 9, 3, 12));
      const { quoteId } = await prepared();
      const { peekRequest } = await import("@/lib/platform/idempotency");
      const { buildKey } = await import("@/lib/sdk/settlement");
      vi.setSystemTime(Date.UTC(2026, 9, 4, 13));
      expect(await peekRequest(buildKey(quoteId))).not.toBeNull();
      vi.setSystemTime(Date.UTC(2026, 9, 11, 12, 0, 1));
      expect(await peekRequest(buildKey(quoteId))).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("R2: BUILD_NOT_FOUND (409) — no build record for this quote / wallet / action", async () => {
    const { quoteId, final } = await prepared();
    mine(final);
    for (const extra of [{}, { walletAddress: OTHER }, { actionId: "swap" }]) {
      const q = Object.keys(extra).length ? quoteId : "f".repeat(32);
      expect(await confirm(q, hash(), extra)).toMatchObject({ status: 409, json: { ok: false, code: "BUILD_NOT_FOUND" } });
    }
  });
  it("R2: CONFIRM_IN_PROGRESS (409) — the same transaction is mid-confirmation", async () => {
    const { quoteId, final } = await prepared();
    mine(final);
    const h = hash();
    const { claimRequest } = await import("@/lib/platform/idempotency");
    const { settleKey } = await import("@/lib/sdk/settlement");
    await claimRequest(settleKey(h));
    expect(await confirm(quoteId, h)).toMatchObject({ status: 409, json: { ok: false, code: "CONFIRM_IN_PROGRESS" } });
  });
  it("R2: WRONG_SENDER (409) — mined, but not from the declared wallet", async () => {
    const { quoteId, final } = await prepared();
    mine(final, { from: OTHER });
    expect(await confirm(quoteId, hash())).toMatchObject({ status: 409, json: { ok: false, code: "WRONG_SENDER" } });
  });
  it("R2: TX_MISMATCH (409) — from the wallet, but not the built transaction", async () => {
    const { quoteId, final } = await prepared();
    mine(final, { input: "0xdeadbeef" });
    expect(await confirm(quoteId, hash())).toMatchObject({ status: 409, json: { ok: false, code: "TX_MISMATCH" } });
  });
  it("R2: RECEIPT_UNAVAILABLE (502) — the receipt couldn't be read; the claim is released for a retry", async () => {
    const { quoteId, final } = await prepared();
    mine(final);
    chain.receiptThrows = true;
    const h = hash();
    expect(await confirm(quoteId, h)).toMatchObject({ status: 502, json: { ok: false, code: "RECEIPT_UNAVAILABLE" } });
    chain.receiptThrows = false;
    expect((await confirm(quoteId, h)).json.ok).toBe(true);
  });
  it("R2: a successful confirmation's body is unchanged (no code field)", async () => {
    const { quoteId, final } = await prepared();
    mine(final);
    const c = await confirm(quoteId, hash());
    expect(c.status).toBe(200);
    expect(c.json).toMatchObject({ ok: true, success: true });
    expect("code" in c.json).toBe(false);
  });
});
