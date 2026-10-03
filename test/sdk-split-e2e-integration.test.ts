import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { decodeFunctionData, encodeAbiParameters, toEventSelector, parseUnits } from "viem";

/**
 * The FULL split pipeline through the REAL modules, native MON and ERC-20:
 *
 *   natural language → classifier (lib/ask/intent/split.ts)
 *                    → preview  /api/ask/action          (quote + policy + quote token)
 *                    → build    /api/ask/action/build    (token + Layer A + policy + Layer B)
 *                    → confirm  /api/ask/action/confirm  (build match + receipt + history)
 *
 * Only the wallet signature and the RPC client are stubbed — the RPC returns
 * the transaction exactly as the wallet would have sent the built step, and a
 * receipt carrying the canonical SplitPaymentExecuted event. History is read
 * back from the real (in-memory) transaction store.
 */

const CANONICAL = "0xaC98a844E0F9688EA9758Db05c134b8B4BCeAf6F";
const USDC = "0x754704Bc059F5a0Ce29e278A6D0eBa96b6aafb60";
const WALLET = "0x6b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c";
const A = "0x5e0d39b4c1a2f3e4d5c6b7a8f9e0d1c2b3a4f5e6";
const B = "0x7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b";
const NATIVE = "0x0000000000000000000000000000000000000000";

vi.mock("@/lib/platform/ratelimit", () => ({ rateLimited: async () => null }));
// Live fee terms (normally the wired forwarder's feeBps()/treasury()), fixed
// for this file; the reader itself is covered in sdk-split-fee.test.ts.
const FEE_TREASURY = "0xA282833B52b1B66D58bD2007081dCC037798C0b0";
vi.mock("@/lib/sdk/actions/split-settlement/fee", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/sdk/actions/split-settlement/fee")>()),
  readSplitFeeTerms: async () => ({ feeBps: 25, treasury: FEE_TREASURY, source: "0x8b2c7E8FA09fCd664dbA9764FD63Bf3A4c56464D" }),
}));
vi.mock("@/lib/payment/sanctions", () => ({
  ensureSanctionsLoaded: async () => {}, isSanctionedAddress: () => false, sanctionsListLoaded: () => true,
}));

/** What the stubbed RPC returns, set per test. */
const chain: {
  tx?: { from: string; to: string | null; input: string; value: bigint };
  receipt?: { status: "success" | "reverted"; from: string; logs: { address: string; topics: string[]; data: string }[] };
} = {};
vi.mock("@/lib/monad/wallet", () => ({
  getPublicClient: () => ({
    waitForTransactionReceipt: async () => chain.receipt,
    getTransaction: async () => chain.tx,
  }),
}));

const SPLIT_ABI = [{ type: "function", name: "splitPayment", stateMutability: "payable", inputs: [{ name: "token", type: "address" }, { name: "recipients", type: "address[]" }, { name: "amounts", type: "uint256[]" }, { name: "ref", type: "bytes32" }], outputs: [{ type: "uint256" }] }] as const;
const APPROVE_ABI = [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }] as const;

let saved: Record<string, string | undefined>;
beforeEach(async () => {
  saved = { MONAD_NETWORK: process.env.MONAD_NETWORK, MONAD_MAINNET_USDC: process.env.MONAD_MAINNET_USDC };
  process.env.MONAD_NETWORK = "mainnet"; process.env.MONAD_MAINNET_USDC = USDC;
  delete chain.tx; delete chain.receipt;
  const g = globalThis as unknown as { __veripayIdem?: Map<string, unknown> };
  g.__veripayIdem?.clear();
  const { __resetRegistryForTests } = await import("@/lib/sdk/registry");
  const { __resetBootstrapForTests } = await import("@/lib/sdk/bootstrap");
  __resetRegistryForTests();
  __resetBootstrapForTests();
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  const { __resetRegistryForTests } = await import("@/lib/sdk/registry");
  const { __resetBootstrapForTests } = await import("@/lib/sdk/bootstrap");
  __resetRegistryForTests();
  __resetBootstrapForTests();
});

const post = (url: string, body: unknown) => new NextRequest(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const ID = { protocolId: "payai-settlement", actionId: "split_payment", version: "2.0.0" };
let txCounter = 0;
const newHash = () => `0x${(++txCounter).toString(16).padStart(64, "a")}` as `0x${string}`;

function canonicalLog(token: string, recipients: readonly string[], amounts: readonly bigint[], settlementId = 7n) {
  const topics = [
    toEventSelector("SplitPaymentExecuted(uint256,address,address,bytes32,uint256,address[],uint256[])"),
    encodeAbiParameters([{ type: "uint256" }], [settlementId]),
    encodeAbiParameters([{ type: "address" }], [WALLET as `0x${string}`]),
    encodeAbiParameters([{ type: "address" }], [token.toLowerCase() as `0x${string}`]),
  ];
  const total = amounts.reduce((s, a) => s + a, 0n);
  const data = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint256" }, { type: "address[]" }, { type: "uint256[]" }],
    [`0x${"0".repeat(64)}`, total, recipients as `0x${string}`[], amounts as bigint[]],
  );
  return { address: CANONICAL, topics, data };
}

/** NL → classify → preview → build; returns what the wallet would sign. */
async function prepare(text: string) {
  const { routeRequest } = await import("@/lib/ask/intent/classify");
  const routed = await routeRequest(text, null);
  expect(routed.anthropic).toBe(false);
  const u = routed.understanding!;
  if (u.outcome !== "complete" || u.kind !== "protocol_action") throw new Error(`expected a split: ${JSON.stringify(u)}`);
  const inputs = u.slots.actionInputs!;
  const { POST: preview } = await import("@/app/api/ask/action/route");
  const pj = await (await preview(post("https://usepayai.xyz/api/ask/action", { ...ID, inputs }))).json();
  expect(pj.ok).toBe(true);
  const { POST: build } = await import("@/app/api/ask/action/build/route");
  const bj = await (await build(post("https://usepayai.xyz/api/ask/action/build", { ...ID, inputs, walletAddress: WALLET, quoteToken: pj.quoteToken }))).json();
  expect(bj.ok).toBe(true);
  const final = bj.steps[bj.steps.length - 1];
  const [token, recipients, amounts] = decodeFunctionData({ abi: SPLIT_ABI, data: final.tx.data }).args as [string, string[], bigint[], string];
  return { pj, bj, final, token, recipients, amounts };
}

/** The wallet "sends" exactly the built final step; the chain mines it. */
function mine(final: { tx: { to: string; data: string; value: string } }, receipt: NonNullable<typeof chain.receipt>) {
  chain.tx = { from: WALLET, to: final.tx.to, input: final.tx.data, value: BigInt(final.tx.value) };
  chain.receipt = receipt;
}

async function confirm(quoteId: string, txHash: string, wallet = WALLET) {
  const { POST } = await import("@/app/api/ask/action/confirm/route");
  const res = await POST(post("https://usepayai.xyz/api/ask/action/confirm", { ...ID, txHash, walletAddress: wallet, quoteId }));
  return { status: res.status, json: await res.json() };
}

async function historyFor(txHash: string) {
  const { listTx } = await import("@/lib/platform/store");
  const { resolveTenantId } = await import("@/lib/platform/tenant");
  const merchantId = await resolveTenantId(post("https://usepayai.xyz/x", {}));
  return (await listTx(merchantId, { sender: WALLET })).filter((t) => t.txHash === txHash);
}

describe("native MON — full pipeline", () => {
  it("NL → preview → build → confirm records ONE row per confirmed recipient, from the event", async () => {
    const { bj, final, token, recipients, amounts } = await prepare(`split 0.002 MON between ${A} and ${B}`);
    expect(bj.steps).toHaveLength(1);
    expect(final.tx.to.toLowerCase()).toBe(CANONICAL.toLowerCase());
    expect(token).toBe(NATIVE);
    // recipients 0.002 MON + floor(0.002 MON * 25 / 10000) = 0.000005 MON fee
    expect(final.tx.value).toBe(parseUnits("0.002005", 18).toString());

    const hash = newHash();
    mine(final, { status: "success", from: WALLET, logs: [canonicalLog(NATIVE, recipients, amounts)] });
    const { json } = await confirm(bj.quoteId, hash);
    expect(json.ok).toBe(true);
    expect(json.recorded).toBe(2);
    expect(json.details.settlementId).toBe("7");

    const rows = await historyFor(hash);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.recipient?.toLowerCase(), r.amount, r.token]).sort()).toEqual([
      [A.toLowerCase(), 0.001, "MON"], [B.toLowerCase(), 0.001, "MON"],
    ].sort());
    expect(rows.every((r) => r.action === "split_payment" && r.feature === "payment" && r.decision === "executed")).toBe(true);
  });

  it("history uses the CONFIRMED event amounts, not the preview or inputs", async () => {
    const { bj, final, recipients, amounts } = await prepare(`split 0.002 MON between ${A} and ${B}`);
    const hash = newHash();
    // The event is the source of truth for what settled.
    mine(final, { status: "success", from: WALLET, logs: [canonicalLog(NATIVE, recipients, [parseUnits("0.0015", 18), parseUnits("0.0005", 18), amounts[2]])] });
    await confirm(bj.quoteId, hash);
    const rows = await historyFor(hash);
    expect(rows.map((r) => r.amount).sort()).toEqual([0.0005, 0.0015]);
  });

  it("confirming the same transaction twice replays the outcome and records history ONCE", async () => {
    const { bj, final, recipients, amounts } = await prepare(`split 0.002 MON between ${A} and ${B}`);
    const hash = newHash();
    mine(final, { status: "success", from: WALLET, logs: [canonicalLog(NATIVE, recipients, amounts)] });
    expect((await confirm(bj.quoteId, hash)).json.ok).toBe(true);
    const again = await confirm(bj.quoteId, hash);
    expect(again.json.replayed).toBe(true);
    expect(await historyFor(hash)).toHaveLength(2);
  });

  it("a transaction that isn't byte-for-byte the built one is refused, and records nothing", async () => {
    const { bj, final, recipients, amounts } = await prepare(`split 0.002 MON between ${A} and ${B}`);
    const hash = newHash();
    mine(final, { status: "success", from: WALLET, logs: [canonicalLog(NATIVE, recipients, amounts)] });
    chain.tx = { ...chain.tx!, value: chain.tx!.value + 1n };
    const { status } = await confirm(bj.quoteId, hash);
    expect(status).toBe(409);
    expect(await historyFor(hash)).toHaveLength(0);
  });

  it("an unknown quoteId, or another wallet's confirm, is refused", async () => {
    const { bj, final, recipients, amounts } = await prepare(`split 0.002 MON between ${A} and ${B}`);
    const hash = newHash();
    mine(final, { status: "success", from: WALLET, logs: [canonicalLog(NATIVE, recipients, amounts)] });
    expect((await confirm("f".repeat(32), hash)).status).toBe(409);
    expect((await confirm(bj.quoteId, hash, A)).status).toBe(409);
    expect(await historyFor(hash)).toHaveLength(0);
  });

  it("a reverted settlement is reported as reverted and writes no history", async () => {
    const { bj, final } = await prepare(`split 0.002 MON between ${A} and ${B}`);
    const hash = newHash();
    mine(final, { status: "reverted", from: WALLET, logs: [] });
    const { json } = await confirm(bj.quoteId, hash);
    expect(json.ok).toBe(false);
    expect(json.reverted).toBe(true);
    expect(await historyFor(hash)).toHaveLength(0);
  });
});

describe("confirmed outputs (Phase 2C)", () => {
  it("a confirmed split stores recipientAmounts in order WITHOUT the treasury fee leg, plus fee and gross", async () => {
    const { bj, final, recipients, amounts } = await prepare(`split 0.05 USDC: 0.03 to ${A} and 0.02 to ${B}`);
    expect(recipients[2].toLowerCase()).toBe(FEE_TREASURY.toLowerCase());
    const hash = newHash();
    mine(final, { status: "success", from: WALLET, logs: [canonicalLog(USDC, recipients, amounts)] });
    const { json } = await confirm(bj.quoteId, hash);
    expect(json).toMatchObject({ ok: true, recorded: 2, outputsStatus: "recorded" });
    expect(json.outputs).toEqual({
      recipientAmounts: { verified: true, type: "units[]", value: ["30000", "20000"], token: USDC.toLowerCase() },
      fee: { verified: true, type: "units", value: "125", token: USDC.toLowerCase() },
      gross: { verified: true, type: "units", value: "50125", token: USDC.toLowerCase() },
    });
  });

  it("history from a lenient settlement is unchanged, but a fee leg that doesn't match the build yields no outputs", async () => {
    const { bj, final, recipients, amounts } = await prepare(`split 0.05 USDC: 0.03 to ${A} and 0.02 to ${B}`);
    const hash = newHash();
    // The event drops the fee leg: today's history still records both recipients…
    mine(final, { status: "success", from: WALLET, logs: [canonicalLog(USDC, recipients.slice(0, 2), [amounts[0], amounts[1] + amounts[2]])] });
    const { json } = await confirm(bj.quoteId, hash);
    expect(json).toMatchObject({ ok: true, recorded: 2, outputs: null, outputsStatus: "unverified" });
    expect(await historyFor(hash)).toHaveLength(2);
  });
});

describe("ERC-20 USDC — full pipeline", () => {
  it("custom amounts survive NL → approve(exact total) + split → confirm → history", async () => {
    const { bj, final, token, recipients, amounts } = await prepare(`split 0.05 USDC: 0.03 to ${A} and 0.02 to ${B}`);
    expect(bj.steps).toHaveLength(2);
    expect(bj.steps[0].kind).toBe("approve");
    const [spender, approveAmt] = decodeFunctionData({ abi: APPROVE_ABI, data: bj.steps[0].tx.data }).args as [string, bigint];
    expect(spender.toLowerCase()).toBe(CANONICAL.toLowerCase());
    expect(approveAmt).toBe(parseUnits("0.050125", 6)); // 0.05 to recipients + 0.000125 fee
    expect(token.toLowerCase()).toBe(USDC.toLowerCase());
    expect(amounts).toEqual([parseUnits("0.03", 6), parseUnits("0.02", 6), parseUnits("0.000125", 6)]);

    const hash = newHash();
    mine(final, { status: "success", from: WALLET, logs: [canonicalLog(USDC, recipients, amounts)] });
    const { json } = await confirm(bj.quoteId, hash);
    expect(json.ok).toBe(true);
    expect(json.details["recipients total"]).toBe("0.05 USDC"); // formatted with the token's real decimals
    expect(json.details["platform fee"]).toBe("0.000125 USDC");
    expect(json.details["total paid"]).toBe("0.050125 USDC");
    const rows = await historyFor(hash);
    expect(rows.map((r) => [r.recipient?.toLowerCase(), r.amount, r.token]).sort()).toEqual([
      [A.toLowerCase(), 0.03, "USDC"], [B.toLowerCase(), 0.02, "USDC"],
    ].sort());
  });
});
