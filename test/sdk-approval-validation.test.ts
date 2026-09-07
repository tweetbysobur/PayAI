import { describe, expect, it } from "vitest";
import { encodeFunctionData, maxUint256 } from "viem";
import type { Action, ProtocolAdapter, UnsignedActionStep } from "@/lib/sdk/types";
import { validateSteps } from "@/lib/sdk/validate";

/**
 * Phase 5A — Layer B approval-step validation. An "approve" step targets the
 * user's TOKEN (arbitrary), so it can't be gated by tx.to like an action step;
 * security comes from proving the allowance can only ever reach a canonical,
 * allowlisted PayAI contract, for a bounded amount, via exactly approve() and
 * nothing else. These tests assume a MALICIOUS build() and prove every variant
 * fails closed, while the one legitimate shape passes.
 *
 * ERC-20 split stays DISABLED — this validates the boundary only; no real
 * approve step is produced by any action yet.
 */

const SPLIT = "0xaC98a844E0F9688EA9758Db05c134b8B4BCeAf6F"; // canonical spender (allowlisted)
const TOKEN = "0x754704Bc059F5a0Ce29e278A6D0eBa96b6aafb60"; // a user-chosen ERC-20
const ROUTER = "0x1234567890123456789012345678901234567890"; // an unrelated contract
const OTHER_PAYAI = "0x4ce7B3036595eDA699Aebeb47b34fd4bc4F80709"; // e.g. the forwarder — NOT this action's spender
const ZERO = "0x0000000000000000000000000000000000000000";

const APPROVE_ABI = [{
  type: "function", name: "approve", stateMutability: "nonpayable",
  inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }],
}] as const;
const TRANSFER_ABI = [{
  type: "function", name: "transfer", stateMutability: "nonpayable",
  inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }],
}] as const;

function approveData(spender: string, amount: bigint) {
  return encodeFunctionData({ abi: APPROVE_ABI, functionName: "approve", args: [spender as `0x${string}`, amount] });
}

/** An action + protocol whose ONLY allowlisted target is the canonical
 *  SplitSettlement — the spender an approve step is allowed to authorize. */
function fixture(): { action: Action; protocol: ProtocolAdapter } {
  const action = {
    protocolId: "payai-settlement", actionId: "split_payment", version: "1.0.0",
    name: "Split", description: "d", chainId: 143, allowedTargets: [SPLIT as `0x${string}`],
    inputSchema: {}, async quote() { return { summary: "", details: {}, quotedAt: Date.now() }; },
    async build() { return []; }, async parseResult() { return {}; },
  } as unknown as Action;
  const protocol = {
    protocolId: "payai-settlement", name: "PayAI Split", chainId: 143,
    allowedTargets: [SPLIT as `0x${string}`], actions: [action],
  } as unknown as ProtocolAdapter;
  return { action, protocol };
}

/** An approve step, defaulting to the fully-valid shape; overrides let each
 *  test corrupt exactly one thing the way a malicious build() would. */
function approveStep(over: Partial<{ to: string; data: `0x${string}`; value: string; approval: UnsignedActionStep["approval"] }> = {}): UnsignedActionStep {
  const amount = 100n;
  return {
    kind: "approve", label: "Approve",
    tx: { to: (over.to ?? TOKEN) as `0x${string}`, data: over.data ?? approveData(SPLIT, amount), value: over.value ?? "0" },
    approval: over.approval ?? { token: TOKEN as `0x${string}`, spender: SPLIT as `0x${string}`, amount: "100" },
  };
}

const actionStep: UnsignedActionStep = {
  kind: "action", label: "splitPayment", tx: { to: SPLIT as `0x${string}`, data: "0xdeadbeef", value: "300" },
};

function check(steps: UnsignedActionStep[]) {
  const { action, protocol } = fixture();
  return validateSteps(steps, action, protocol);
}

describe("valid approval", () => {
  it("a correct approve(canonical, exact) to the declared token passes", () => {
    expect(check([approveStep(), actionStep]).ok).toBe(true);
  });
});

describe("spender attacks", () => {
  it("wrong spender in calldata (≠ declared) is rejected", () => {
    const r = check([approveStep({ data: approveData(ROUTER, 100n) })]);
    expect(r.ok).toBe(false); if (!r.ok) expect(r.code).toBe("APPROVAL_INVALID");
  });
  it("spender = router (declared+calldata consistent, but not allowlisted) is rejected", () => {
    const r = check([approveStep({ data: approveData(ROUTER, 100n), approval: { token: TOKEN as `0x${string}`, spender: ROUTER as `0x${string}`, amount: "100" } })]);
    expect(r.ok).toBe(false); if (!r.ok) expect(r.code).toBe("APPROVAL_INVALID");
  });
  it("spender = an unrelated PayAI contract (not THIS action's allowlist) is rejected", () => {
    const r = check([approveStep({ data: approveData(OTHER_PAYAI, 100n), approval: { token: TOKEN as `0x${string}`, spender: OTHER_PAYAI as `0x${string}`, amount: "100" } })]);
    expect(r.ok).toBe(false);
  });
  it("zero spender is rejected", () => {
    const r = check([approveStep({ data: approveData(ZERO, 100n), approval: { token: TOKEN as `0x${string}`, spender: ZERO as `0x${string}`, amount: "100" } })]);
    expect(r.ok).toBe(false);
  });
});

describe("token target attacks", () => {
  it("tx.to ≠ declared token is rejected", () => {
    const r = check([approveStep({ to: ROUTER })]);
    expect(r.ok).toBe(false); if (!r.ok) expect(r.code).toBe("APPROVAL_INVALID");
  });
});

describe("selector / calldata attacks", () => {
  it("wrong selector (transfer, not approve) is rejected", () => {
    const r = check([approveStep({ data: encodeFunctionData({ abi: TRANSFER_ABI, functionName: "transfer", args: [SPLIT as `0x${string}`, 100n] }) })]);
    expect(r.ok).toBe(false);
  });
  it("malformed (too-short) calldata is rejected", () => {
    const r = check([approveStep({ data: "0x095ea7b3" })]);
    expect(r.ok).toBe(false);
  });
  it("trailing calldata bytes are rejected", () => {
    const r = check([approveStep({ data: (approveData(SPLIT, 100n) + "deadbeef") as `0x${string}` })]);
    expect(r.ok).toBe(false);
  });
});

describe("amount attacks", () => {
  it("calldata amount ≠ declared amount is rejected", () => {
    const r = check([approveStep({ data: approveData(SPLIT, 101n) })]); // declared 100
    expect(r.ok).toBe(false);
  });
  it("unlimited approval (uint256 max) is rejected", () => {
    const r = check([approveStep({ data: approveData(SPLIT, maxUint256), approval: { token: TOKEN as `0x${string}`, spender: SPLIT as `0x${string}`, amount: maxUint256.toString() } })]);
    expect(r.ok).toBe(false);
  });
  it("zero approval is rejected", () => {
    const r = check([approveStep({ data: approveData(SPLIT, 0n), approval: { token: TOKEN as `0x${string}`, spender: SPLIT as `0x${string}`, amount: "0" } })]);
    expect(r.ok).toBe(false);
  });
});

describe("structural attacks", () => {
  it("an approve step with NO approval declaration is rejected", () => {
    const s = approveStep(); delete (s as { approval?: unknown }).approval;
    expect(check([s]).ok).toBe(false);
  });
  it("an approve step carrying native value is rejected", () => {
    expect(check([approveStep({ value: "1" })]).ok).toBe(false);
  });
  it("an extra approval to an unrelated contract, alongside a valid one, rejects the whole set", () => {
    const evil = approveStep({ to: ROUTER, data: approveData(ROUTER, 100n), approval: { token: ROUTER as `0x${string}`, spender: ROUTER as `0x${string}`, amount: "100" } });
    expect(check([approveStep(), evil, actionStep]).ok).toBe(false);
  });
  it("a valid approve followed by a WRONG action target rejects the whole set", () => {
    const badAction: UnsignedActionStep = { kind: "action", label: "x", tx: { to: ROUTER as `0x${string}`, data: "0xdead", value: "0" } };
    const r = check([approveStep(), badAction]);
    expect(r.ok).toBe(false); if (!r.ok) expect(r.code).toBe("TARGET_NOT_ALLOWLISTED");
  });
});

describe("regression: action-only step sets are unaffected", () => {
  it("a native action-only step to the canonical target still passes (no approve step)", () => {
    expect(check([actionStep]).ok).toBe(true);
  });
});
