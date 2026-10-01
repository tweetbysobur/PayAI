import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeFunctionData, parseUnits, maxUint256, getAddress } from "viem";
import type { UnsignedActionStep } from "@/lib/sdk/types";

/**
 * Phase 5B — ERC-20 split enablement. Uses the REAL config (MONAD_NETWORK=mainnet
 * + a configured USDC) so getStablecoin() resolves the token with no chain read,
 * and the real split action registers against its canonical mainnet address.
 * Proves: the two-step approve→split build, exact approval (== sum of amounts),
 * the approve step's typed metadata + calldata, that the whole set passes Layer B,
 * and that a buggy/malicious variant is rejected by Layer B (spender, amount,
 * unlimited, non-canonical settlement target).
 */

const CANONICAL = "0xaC98a844E0F9688EA9758Db05c134b8B4BCeAf6F";
const USDC = "0x754704Bc059F5a0Ce29e278A6D0eBa96b6aafb60";
const A = "0x5e0d39b4c1a2f3e4d5c6b7a8f9e0d1c2b3a4f5e6";
const B = "0x7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b";
const ROUTER = "0x3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e";
/** USDC base units (6 decimals) — split v2 takes exact integers only. */
const usdc = (n: string) => parseUnits(n, 6).toString();
const pair = (recipient: string, amount: string) => ({ recipient, amount: usdc(amount) });

const APPROVE_ABI = [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }] as const;
const SPLIT_ABI = [{ type: "function", name: "splitPayment", stateMutability: "payable", inputs: [{ name: "token", type: "address" }, { name: "recipients", type: "address[]" }, { name: "amounts", type: "uint256[]" }, { name: "ref", type: "bytes32" }], outputs: [{ type: "uint256" }] }] as const;

const TREASURY = "0xA282833B52b1B66D58bD2007081dCC037798C0b0";
// Live fee terms, fixed for this file (the reader is tested in sdk-split-fee).
vi.mock("@/lib/sdk/actions/split-settlement/fee", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/sdk/actions/split-settlement/fee")>()),
  readSplitFeeTerms: async () => ({ feeBps: 25, treasury: TREASURY, source: "0x8b2c7E8FA09fCd664dbA9764FD63Bf3A4c56464D" }),
}));

let registry: typeof import("@/lib/sdk/registry");
let validate: typeof import("@/lib/sdk/validate");
let split: typeof import("@/lib/sdk/actions/split-settlement");
let priorNet: string | undefined;
let priorUsdc: string | undefined;

beforeEach(async () => {
  priorNet = process.env.MONAD_NETWORK; priorUsdc = process.env.MONAD_MAINNET_USDC;
  process.env.MONAD_NETWORK = "mainnet"; process.env.MONAD_MAINNET_USDC = USDC;
  registry = await import("@/lib/sdk/registry");
  validate = await import("@/lib/sdk/validate");
  split = await import("@/lib/sdk/actions/split-settlement");
  registry.__resetRegistryForTests();
  const proto = split.createSplitSettlementProtocol();
  if (proto) registry.registerProtocol(proto);
});
afterEach(() => {
  if (priorNet === undefined) delete process.env.MONAD_NETWORK; else process.env.MONAD_NETWORK = priorNet;
  if (priorUsdc === undefined) delete process.env.MONAD_MAINNET_USDC; else process.env.MONAD_MAINNET_USDC = priorUsdc;
  registry.__resetRegistryForTests();
});

function action() {
  const a = registry.getAction("payai-settlement", "split_payment", "2.0.0");
  if (!a) throw new Error("not registered");
  return a;
}
/** Build needs the quote's fee terms, so every build goes through a real quote. */
async function buildOf(inputs: Parameters<ReturnType<typeof action>["build"]>[0]) {
  const a = action();
  return a.build(inputs, await a.quote(inputs));
}

describe("ERC-20 build", () => {
  it("produces [approve, splitPayment]: approve→token, split→canonical, value 0", async () => {
    const steps = await buildOf({ token: USDC, recipients: [pair(A, "60"), pair(B, "40")] });
    expect(steps).toHaveLength(2);
    expect(steps[0].kind).toBe("approve");
    expect(steps[1].kind).toBe("action");
    expect(steps[0].tx.to.toLowerCase()).toBe(USDC.toLowerCase());
    expect(steps[0].tx.value).toBe("0");
    expect(steps[1].tx.to.toLowerCase()).toBe(CANONICAL.toLowerCase());
    expect(steps[1].tx.value).toBe("0"); // no native value for an ERC-20 split
  });

  it("approves the EXACT total (== sum of amounts), to the canonical spender, with matching metadata", async () => {
    const steps = await buildOf({ token: USDC, recipients: [pair(A, "60"), pair(B, "40")] });
    // 100 USDC to recipients + floor(100 USDC * 25 / 10000) = 0.25 USDC fee.
    const total = parseUnits("100.25", 6);
    const dec = decodeFunctionData({ abi: APPROVE_ABI, data: steps[0].tx.data as `0x${string}` });
    const [spender, amount] = dec.args as [string, bigint];
    expect(spender.toLowerCase()).toBe(CANONICAL.toLowerCase());
    expect(amount).toBe(total);
    expect(steps[0].approval).toEqual({ token: getAddress(USDC), spender: CANONICAL, amount: total.toString() });
  });

  it("splitPayment carries the token arg + correct recipients/amounts in base units", async () => {
    const steps = await buildOf({ token: USDC, recipients: [pair(A, "60"), pair(B, "40")] });
    const dec = decodeFunctionData({ abi: SPLIT_ABI, data: steps[1].tx.data as `0x${string}` });
    const [token, recipients, amounts] = dec.args as [string, string[], bigint[], string];
    expect(token.toLowerCase()).toBe(USDC.toLowerCase());
    expect(recipients.map((r) => r.toLowerCase())).toEqual([A.toLowerCase(), B.toLowerCase(), TREASURY.toLowerCase()]);
    expect(amounts).toEqual([parseUnits("60", 6), parseUnits("40", 6), parseUnits("0.25", 6)]);
  });

  it("the whole ERC-20 step set passes Layer B (approve spender allowlisted; split target canonical)", async () => {
    const a = action();
    const proto = registry.getProtocol("payai-settlement")!;
    const steps = await buildOf({ token: USDC, recipients: [pair(A, "60"), pair(B, "40")] });
    expect(validate.validateSteps(steps, a, proto).ok).toBe(true);
  });

  it("three recipients also build cleanly, approving exactly their sum plus the fee", async () => {
    const three = await buildOf({ token: USDC, recipients: [pair(A, "10"), pair(B, "20"), pair(ROUTER, "30")] });
    const dec = decodeFunctionData({ abi: APPROVE_ABI, data: three[0].tx.data as `0x${string}` });
    expect((dec.args as [string, bigint])[1]).toBe(parseUnits("60.15", 6));
  });
});

describe("ERC-20 quote", () => {
  it("summarizes in USDC with per-recipient amounts and the token identity", async () => {
    const res = await action().quote({ token: USDC, recipients: [pair(A, "60"), pair(B, "40")] });
    expect(res.summary).toBe("Split 100 USDC between 2 recipients (+ 0.25 USDC platform fee)");
    expect(res.details["platform fee"]).toBe("0.25 USDC");
    expect(res.details["total you pay"]).toBe("100.25 USDC");
    expect(res.details.total).toBe("100 USDC");
    expect(res.details.token).toContain("USDC");
    expect(res.details["amount 1"]).toBe("60 USDC");
  });
});

describe("action-build security (Layer B rejects a buggy/malicious variant)", () => {
  const proto = () => registry.getProtocol("payai-settlement")!;
  const goodSplit = (): UnsignedActionStep => ({ kind: "action", label: "s", tx: { to: CANONICAL as `0x${string}`, data: "0xdead", value: "0" } });
  const approveStep = (spender: string, amount: bigint, token = USDC): UnsignedActionStep => ({
    kind: "approve", label: "a",
    tx: { to: token as `0x${string}`, data: encodeFunctionData({ abi: APPROVE_ABI, functionName: "approve", args: [spender as `0x${string}`, amount] }), value: "0" },
    approval: { token: getAddress(token), spender: getAddress(spender), amount: amount.toString() },
  });

  it("approve(maliciousSpender, total) is rejected", () => {
    const r = validate.validateSteps([approveStep(ROUTER, parseUnits("100", 6)), goodSplit()], action(), proto());
    expect(r.ok).toBe(false); if (!r.ok) expect(r.code).toBe("APPROVAL_INVALID");
  });
  it("approve(canonical, uint256.max) is rejected", () => {
    const r = validate.validateSteps([approveStep(CANONICAL, maxUint256), goodSplit()], action(), proto());
    expect(r.ok).toBe(false);
  });
  it("a valid approve followed by splitPayment to a NON-canonical target is rejected", () => {
    const badSplit: UnsignedActionStep = { kind: "action", label: "s", tx: { to: ROUTER as `0x${string}`, data: "0xdead", value: "0" } };
    const r = validate.validateSteps([approveStep(CANONICAL, parseUnits("100", 6)), badSplit], action(), proto());
    expect(r.ok).toBe(false); if (!r.ok) expect(r.code).toBe("TARGET_NOT_ALLOWLISTED");
  });
});

describe("ERC-20 input failures", () => {
  it("a single recipient is rejected (a split needs at least two)", async () => {
    await expect(buildOf({ token: USDC, recipients: [pair(A, "60")] })).rejects.toThrow(/between 2 and 9/);
  });
  it("a zero amount is rejected", async () => {
    await expect(action().quote({ token: USDC, recipients: [{ recipient: A, amount: "0" }, pair(B, "1")] })).rejects.toThrow();
  });
  it("a decimal amount is rejected — amounts are exact base units, never parsed as decimals here", async () => {
    await expect(buildOf({ token: USDC, recipients: [{ recipient: A, amount: "0.5" }, pair(B, "1")] })).rejects.toThrow(/whole number of base units/);
  });
});

describe("recipients the contract would revert are rejected before any signature", () => {
  it("zero-address recipient is rejected at quote and build", async () => {
    const zero = "0x0000000000000000000000000000000000000000";
    await expect(action().quote({ token: USDC, recipients: [pair(zero, "1"), pair(B, "1")] })).rejects.toThrow(/zero address/);
    await expect(buildOf({ token: USDC, recipients: [pair(zero, "1"), pair(B, "1")] })).rejects.toThrow(/zero address/);
  });
  it("the SplitSettlement contract as recipient is rejected (no approve step produced)", async () => {
    await expect(buildOf({ token: USDC, recipients: [pair(CANONICAL, "1"), pair(B, "1")] })).rejects.toThrow(/contract itself/);
  });
  it("a duplicate recipient is rejected before any approve step exists", async () => {
    await expect(buildOf({ token: USDC, recipients: [pair(A, "1"), pair(A, "2")] })).rejects.toThrow(/more than once/);
  });
});
