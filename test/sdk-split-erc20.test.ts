import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const ROUTER = "0x9999999999999999999999999999999999999999";

const APPROVE_ABI = [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }] as const;
const SPLIT_ABI = [{ type: "function", name: "splitPayment", stateMutability: "payable", inputs: [{ name: "token", type: "address" }, { name: "recipients", type: "address[]" }, { name: "amounts", type: "uint256[]" }, { name: "ref", type: "bytes32" }], outputs: [{ type: "uint256" }] }] as const;

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
  const a = registry.getAction("payai-settlement", "split_payment", "1.0.0");
  if (!a) throw new Error("not registered");
  return a;
}
const q = { summary: "", details: {}, quotedAt: Date.now() };

describe("ERC-20 build", () => {
  it("produces [approve, splitPayment]: approve→token, split→canonical, value 0", async () => {
    const steps = await action().build({ token: USDC, recipient1: A, amount1: "60", recipient2: B, amount2: "40" }, q);
    expect(steps).toHaveLength(2);
    expect(steps[0].kind).toBe("approve");
    expect(steps[1].kind).toBe("action");
    expect(steps[0].tx.to.toLowerCase()).toBe(USDC.toLowerCase());
    expect(steps[0].tx.value).toBe("0");
    expect(steps[1].tx.to.toLowerCase()).toBe(CANONICAL.toLowerCase());
    expect(steps[1].tx.value).toBe("0"); // no native value for an ERC-20 split
  });

  it("approves the EXACT total (== sum of amounts), to the canonical spender, with matching metadata", async () => {
    const steps = await action().build({ token: USDC, recipient1: A, amount1: "60", recipient2: B, amount2: "40" }, q);
    const total = parseUnits("100", 6);
    const dec = decodeFunctionData({ abi: APPROVE_ABI, data: steps[0].tx.data as `0x${string}` });
    const [spender, amount] = dec.args as [string, bigint];
    expect(spender.toLowerCase()).toBe(CANONICAL.toLowerCase());
    expect(amount).toBe(total);
    expect(steps[0].approval).toEqual({ token: getAddress(USDC), spender: CANONICAL, amount: total.toString() });
  });

  it("splitPayment carries the token arg + correct recipients/amounts in base units", async () => {
    const steps = await action().build({ token: USDC, recipient1: A, amount1: "60", recipient2: B, amount2: "40" }, q);
    const dec = decodeFunctionData({ abi: SPLIT_ABI, data: steps[1].tx.data as `0x${string}` });
    const [token, recipients, amounts] = dec.args as [string, string[], bigint[], string];
    expect(token.toLowerCase()).toBe(USDC.toLowerCase());
    expect(recipients.map((r) => r.toLowerCase())).toEqual([A.toLowerCase(), B.toLowerCase()]);
    expect(amounts).toEqual([parseUnits("60", 6), parseUnits("40", 6)]);
  });

  it("the whole ERC-20 step set passes Layer B (approve spender allowlisted; split target canonical)", async () => {
    const a = action();
    const proto = registry.getProtocol("payai-settlement")!;
    const steps = await a.build({ token: USDC, recipient1: A, amount1: "60", recipient2: B, amount2: "40" }, q);
    expect(validate.validateSteps(steps, a, proto).ok).toBe(true);
  });

  it("one / three recipients also build cleanly", async () => {
    const one = await action().build({ token: USDC, recipient1: A, amount1: "10" }, q);
    expect(one).toHaveLength(2);
    const three = await action().build({ token: USDC, recipient1: A, amount1: "10", recipient2: B, amount2: "20", recipient3: ROUTER, amount3: "30" }, q);
    const dec = decodeFunctionData({ abi: APPROVE_ABI, data: three[0].tx.data as `0x${string}` });
    expect((dec.args as [string, bigint])[1]).toBe(parseUnits("60", 6));
  });
});

describe("ERC-20 quote", () => {
  it("summarizes in USDC with per-recipient amounts and the token identity", async () => {
    const res = await action().quote({ token: USDC, recipient1: A, amount1: "60", recipient2: B, amount2: "40" });
    expect(res.summary).toBe("Split 100 USDC between 2 recipients");
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
  it("a mismatched recipient/amount pair is rejected", async () => {
    await expect(action().build({ token: USDC, recipient1: A, amount1: "60", recipient2: B }, q)).rejects.toThrow();
  });
  it("a zero amount is rejected", async () => {
    await expect(action().quote({ token: USDC, recipient1: A, amount1: "0" })).rejects.toThrow();
  });
  it("an amount below the token's smallest unit is rejected", async () => {
    // 0.0000001 USDC rounds to 0 base units at 6 decimals.
    await expect(action().build({ token: USDC, recipient1: A, amount1: "0.0000001" }, q)).rejects.toThrow();
  });
});

describe("recipients the contract would revert are rejected before any signature", () => {
  it("zero-address recipient is rejected at quote and build", async () => {
    const zero = "0x0000000000000000000000000000000000000000";
    await expect(action().quote({ token: USDC, recipient1: zero, amount1: "1" })).rejects.toThrow(/zero address/);
    await expect(action().build({ token: USDC, recipient1: zero, amount1: "1" }, q)).rejects.toThrow(/zero address/);
  });
  it("the SplitSettlement contract as recipient is rejected (no approve step produced)", async () => {
    await expect(action().build({ token: USDC, recipient1: CANONICAL, amount1: "1" }, q)).rejects.toThrow(/contract itself/);
  });
});
