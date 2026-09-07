import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { decodeFunctionData, encodeAbiParameters, toEventSelector, parseUnits, formatUnits } from "viem";

/**
 * Phase 5C — the closest achievable substitute for live browser QA: the FULL
 * production pipeline composed end-to-end through the REAL modules, for both
 * native MON and ERC-20 (USDC):
 *
 *   natural language  → real classifier (routeRequest)
 *                     → real preview route  /api/ask/action        (quote)
 *                     → real build route    /api/ask/action/build  (Layer A + Layer B)
 *                     → real parseResult over a synthesized canonical receipt (confirmedDetails)
 *
 * Only the wallet signature and the RPC receipt fetch are stubbed — both are
 * physically impossible in this sandbox and both are thin adapters already
 * unit-covered. Everything security-relevant (routing, quote, build, target
 * pinning, exact approval, event parsing, confirmed-vs-preview separation) runs
 * as it would in production.
 */

const CANONICAL = "0xaC98a844E0F9688EA9758Db05c134b8B4BCeAf6F";
const USDC = "0x754704Bc059F5a0Ce29e278A6D0eBa96b6aafb60";
const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const NATIVE = "0x0000000000000000000000000000000000000000";

vi.mock("@/lib/platform/ratelimit", () => ({ rateLimited: async () => null }));

const APPROVE_ABI = [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }] as const;
const SPLIT_ABI = [{ type: "function", name: "splitPayment", stateMutability: "payable", inputs: [{ name: "token", type: "address" }, { name: "recipients", type: "address[]" }, { name: "amounts", type: "uint256[]" }, { name: "ref", type: "bytes32" }], outputs: [{ type: "uint256" }] }] as const;

let priorNet: string | undefined;
let priorUsdc: string | undefined;

beforeEach(async () => {
  priorNet = process.env.MONAD_NETWORK; priorUsdc = process.env.MONAD_MAINNET_USDC;
  process.env.MONAD_NETWORK = "mainnet"; process.env.MONAD_MAINNET_USDC = USDC;
  const { __resetRegistryForTests } = await import("@/lib/sdk/registry");
  const { __resetBootstrapForTests } = await import("@/lib/sdk/bootstrap");
  __resetRegistryForTests();
  __resetBootstrapForTests();
});
afterEach(async () => {
  if (priorNet === undefined) delete process.env.MONAD_NETWORK; else process.env.MONAD_NETWORK = priorNet;
  if (priorUsdc === undefined) delete process.env.MONAD_MAINNET_USDC; else process.env.MONAD_MAINNET_USDC = priorUsdc;
  const { __resetRegistryForTests } = await import("@/lib/sdk/registry");
  const { __resetBootstrapForTests } = await import("@/lib/sdk/bootstrap");
  __resetRegistryForTests();
  __resetBootstrapForTests();
});

const post = (url: string, body: unknown) => new NextRequest(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** Synthesize the exact SplitPaymentExecuted log a real settlement emits, from
 *  the canonical address — what parseResult reads out of the receipt. */
function canonicalReceipt(txHash: string, settlementId: bigint, payer: string, token: string, total: bigint, recipients: string[], amounts: bigint[]) {
  const topic0 = toEventSelector("SplitPaymentExecuted(uint256,address,address,bytes32,uint256,address[],uint256[])");
  const topics = [
    topic0,
    encodeAbiParameters([{ type: "uint256" }], [settlementId]),
    encodeAbiParameters([{ type: "address" }], [payer as `0x${string}`]),
    encodeAbiParameters([{ type: "address" }], [token as `0x${string}`]),
  ] as `0x${string}`[];
  const data = encodeAbiParameters(
    [{ type: "bytes32" }, { type: "uint256" }, { type: "address[]" }, { type: "uint256[]" }],
    [`0x${"0".repeat(64)}` as `0x${string}`, total, recipients as `0x${string}`[], amounts],
  );
  return { status: "success" as const, txHash: txHash as `0x${string}`, logs: [{ address: CANONICAL as `0x${string}`, topics, data }] };
}

describe("native MON — full pipeline", () => {
  it("NL → classify → preview → build → parseResult, all real modules", async () => {
    // 1. classifier
    const { routeRequest } = await import("@/lib/ask/intent/classify");
    const routed = await routeRequest(`split 0.002 MON between ${A} and ${B}`, null);
    expect(routed.anthropic).toBe(false);
    const u = routed.understanding!;
    if (u.outcome !== "complete") throw new Error("expected complete");
    expect(u.kind).toBe("protocol_action");
    const inputs = u.slots.actionInputs!; // exactly what dispatchProtocolAction forwards

    // 2. preview route (quote)
    const { POST: preview } = await import("@/app/api/ask/action/route");
    const pj = await (await preview(post("https://usepayai.xyz/api/ask/action", { protocolId: "payai-settlement", actionId: "split_payment", version: "1.0.0", inputs }))).json();
    expect(pj.ok).toBe(true);
    expect(pj.summary).toBe("Split 0.002 MON between 2 recipients");
    expect(pj.details.token).toBe("MON (native)");

    // 3. build route (Layer A + Layer B)
    const { POST: build } = await import("@/app/api/ask/action/build/route");
    const bj = await (await build(post("https://usepayai.xyz/api/ask/action/build", { protocolId: "payai-settlement", actionId: "split_payment", version: "1.0.0", inputs, walletAddress: A, quotedAt: pj.quotedAt }))).json();
    expect(bj.ok).toBe(true);
    expect(bj.steps).toHaveLength(1);
    expect(bj.steps[0].tx.to.toLowerCase()).toBe(CANONICAL.toLowerCase());
    const dec = decodeFunctionData({ abi: SPLIT_ABI, data: bj.steps[0].tx.data as `0x${string}` });
    const [token, recipients, amounts] = dec.args as [string, string[], bigint[], string];
    expect(token).toBe(NATIVE);
    // value equals the exact total the calldata will move
    const total = amounts.reduce((x, y) => x + y, 0n);
    expect(bj.steps[0].tx.value).toBe(total.toString());
    expect(total).toBe(parseUnits("0.002", 18));

    // 4. parseResult over the receipt a real settlement would produce
    const { getAction } = await import("@/lib/sdk/registry");
    const action = getAction("payai-settlement", "split_payment", "1.0.0")!;
    const confirmed = await action.parseResult(canonicalReceipt("0xsettle", 0n, A, token, total, recipients, amounts));
    expect(confirmed.settlementId).toBe("0");
    expect(confirmed.total).toBe("0.002 MON");
    // confirmed is DISTINCT from the preview prediction (never masquerades)
    expect(confirmed.status).toBe("success");
    expect(confirmed.recipientCount).toBe("2");
  });
});

describe("ERC-20 USDC — full pipeline", () => {
  it("NL → classify → preview → build (approve+split) → parseResult, all real modules", async () => {
    // 1. classifier resolves USDC deterministically
    const { routeRequest } = await import("@/lib/ask/intent/classify");
    const routed = await routeRequest(`split 0.02 USDC between ${A} and ${B}`, null);
    const u = routed.understanding!;
    if (u.outcome !== "complete") throw new Error("expected complete");
    expect(u.kind).toBe("protocol_action");
    const inputs = u.slots.actionInputs!;
    expect(inputs.token.toLowerCase()).toBe(USDC.toLowerCase());

    // 2. preview
    const { POST: preview } = await import("@/app/api/ask/action/route");
    const pj = await (await preview(post("https://usepayai.xyz/api/ask/action", { protocolId: "payai-settlement", actionId: "split_payment", version: "1.0.0", inputs }))).json();
    expect(pj.ok).toBe(true);
    expect(pj.summary).toBe("Split 0.02 USDC between 2 recipients");
    expect(pj.details.token).toContain("USDC");

    // 3. build — approve FIRST (to token, spender=canonical, exact total), then split (to canonical, value 0)
    const { POST: build } = await import("@/app/api/ask/action/build/route");
    const bj = await (await build(post("https://usepayai.xyz/api/ask/action/build", { protocolId: "payai-settlement", actionId: "split_payment", version: "1.0.0", inputs, walletAddress: A, quotedAt: pj.quotedAt }))).json();
    expect(bj.ok).toBe(true); // build route runs Layer B on the approve step (5A) and the split step
    expect(bj.steps).toHaveLength(2);
    expect(bj.steps[0].kind).toBe("approve");
    expect(bj.steps[0].tx.to.toLowerCase()).toBe(USDC.toLowerCase());
    const appr = decodeFunctionData({ abi: APPROVE_ABI, data: bj.steps[0].tx.data as `0x${string}` });
    const [spender, approveAmt] = appr.args as [string, bigint];
    expect(spender.toLowerCase()).toBe(CANONICAL.toLowerCase());
    expect(approveAmt).toBe(parseUnits("0.02", 6)); // exact total, base units

    expect(bj.steps[1].kind).toBe("action");
    expect(bj.steps[1].tx.to.toLowerCase()).toBe(CANONICAL.toLowerCase());
    expect(bj.steps[1].tx.value).toBe("0");
    const dec = decodeFunctionData({ abi: SPLIT_ABI, data: bj.steps[1].tx.data as `0x${string}` });
    const [token, recipients, amounts] = dec.args as [string, string[], bigint[], string];
    expect(token.toLowerCase()).toBe(USDC.toLowerCase());
    const total = amounts.reduce((x, y) => x + y, 0n);
    expect(approveAmt).toBe(total); // approval == settlement spend

    // 4. parseResult over the canonical event
    const { getAction } = await import("@/lib/sdk/registry");
    const action = getAction("payai-settlement", "split_payment", "1.0.0")!;
    const confirmed = await action.parseResult(canonicalReceipt("0xsettle2", 7n, A, token, total, recipients, amounts));
    expect(confirmed.settlementId).toBe("7");
    expect(confirmed.token.toLowerCase()).toBe(USDC.toLowerCase());
    // ERC-20 amounts are base units in confirmedDetails (documented cosmetic limitation)
    expect(confirmed.total).toBe(total.toString());
    expect(formatUnits(BigInt(confirmed.total), 6)).toBe("0.02");
  });
});
