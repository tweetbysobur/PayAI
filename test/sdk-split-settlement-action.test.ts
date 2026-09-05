import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeAbiParameters, toEventSelector, parseEther } from "viem";

/**
 * Phase 5 — the second real SDK action, split_payment, against the audited,
 * mainnet-deployed SplitSettlement contract. Proves the whole path
 * (register → Layer A → quote → build → Layer B → parseResult) plus the
 * Phase-5-specific security invariants: the canonical mainnet target is
 * hard-bound, the orphan deploy is never accepted, the user can supply no
 * target/calldata, native value equals the exact total, a non-native token is
 * rejected (native-only v1), mismatched recipient/amount pairs are rejected,
 * and confirmedDetails come only from a SplitPaymentExecuted event emitted BY
 * the canonical address.
 *
 * getChain is mocked to a fixed mainnet id so the test is deterministic without
 * a live chain — the action code is exactly what production loads.
 */

const CANONICAL = "0xaC98a844E0F9688EA9758Db05c134b8B4BCeAf6F";
const ORPHAN = "0xfCD284AD855a0D1E0e1f1154C038D70cC33357dd";
const MONAD = 143;
const NATIVE = "0x0000000000000000000000000000000000000000";
const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const C = "0x3333333333333333333333333333333333333333";

vi.mock("@/lib/monad/config", () => ({
  getChain: () => ({ id: MONAD }),
}));

// The exact splitPayment + event ABI, redeclared here so the test decodes the
// action's build() output and encodes synthetic receipt logs independently of
// the action's own (unexported) ABI constant.
const SPLIT_ABI = [
  { type: "function", name: "splitPayment", stateMutability: "payable", inputs: [
    { name: "token", type: "address" }, { name: "recipients", type: "address[]" },
    { name: "amounts", type: "uint256[]" }, { name: "ref", type: "bytes32" } ], outputs: [{ type: "uint256" }] },
  { type: "event", name: "SplitPaymentExecuted", inputs: [
    { name: "settlementId", type: "uint256", indexed: true },
    { name: "payer", type: "address", indexed: true },
    { name: "token", type: "address", indexed: true },
    { name: "ref", type: "bytes32", indexed: false },
    { name: "totalAmount", type: "uint256", indexed: false },
    { name: "recipients", type: "address[]", indexed: false },
    { name: "amounts", type: "uint256[]", indexed: false } ] },
] as const;

let registry: typeof import("@/lib/sdk/registry");
let validate: typeof import("@/lib/sdk/validate");
let split: typeof import("@/lib/sdk/actions/split-settlement");

beforeEach(async () => {
  registry = await import("@/lib/sdk/registry");
  validate = await import("@/lib/sdk/validate");
  split = await import("@/lib/sdk/actions/split-settlement");
  registry.__resetRegistryForTests();
  const proto = split.createSplitSettlementProtocol();
  if (proto) registry.registerProtocol(proto);
});

afterEach(() => {
  registry.__resetRegistryForTests();
  vi.restoreAllMocks();
});

function getSplit() {
  const action = registry.getAction("payai-settlement", "split_payment", "1.0.0");
  if (!action) throw new Error("split action not registered");
  return action;
}

/* ── Registration ─────────────────────────────────────────────────────── */
describe("registration", () => {
  it("registers payai-settlement/split_payment@1.0.0 pinned to the canonical mainnet address", () => {
    const proto = registry.getProtocol("payai-settlement");
    expect(proto?.chainId).toBe(MONAD);
    expect(proto?.allowedTargets.map((a) => a.toLowerCase())).toEqual([CANONICAL.toLowerCase()]);
    const action = getSplit();
    expect(action.version).toBe("1.0.0");
    expect(action.chainId).toBe(MONAD);
    expect(action.allowedTargets.map((a) => a.toLowerCase())).toEqual([CANONICAL.toLowerCase()]);
  });
  it("never includes the orphan address anywhere", () => {
    const proto = registry.getProtocol("payai-settlement");
    const all = [...(proto?.allowedTargets ?? []), ...getSplit().allowedTargets].map((a) => a.toLowerCase());
    expect(all).not.toContain(ORPHAN.toLowerCase());
  });
});

/* ── Inputs (Layer A) ─────────────────────────────────────────────────── */
describe("inputs (Layer A)", () => {
  const layerA = (inputs: Record<string, string>) => validate.validateInputs(getSplit().inputSchema, inputs);

  it("accepts 1 / 2 / 3 recipients", () => {
    expect(layerA({ recipient1: A, amount1: "1" }).ok).toBe(true);
    expect(layerA({ recipient1: A, amount1: "1", recipient2: B, amount2: "2" }).ok).toBe(true);
    expect(layerA({ recipient1: A, amount1: "1", recipient2: B, amount2: "2", recipient3: C, amount3: "3" }).ok).toBe(true);
  });
  it("rejects a malformed recipient", () => {
    const r = layerA({ recipient1: "not-an-address", amount1: "1" });
    expect(r.ok).toBe(false);
  });
  it("rejects a zero amount", () => {
    const r = layerA({ recipient1: A, amount1: "0" });
    expect(r.ok).toBe(false);
  });
  it("rejects an unknown parameter (no arbitrary fields)", () => {
    const r = layerA({ recipient1: A, amount1: "1", to: CANONICAL, data: "0xdead", value: "1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("UNKNOWN_PARAMETER");
  });
});

/* ── Quote ────────────────────────────────────────────────────────────── */
describe("quote", () => {
  it("summarizes the split and lists every recipient/amount, no tx side effect", async () => {
    const q = await getSplit().quote({ recipient1: A, amount1: "1", recipient2: B, amount2: "2" });
    expect(q.summary).toBe("Split 3 MON between 2 recipients");
    expect(q.details.total).toBe("3 MON");
    expect(q.details.recipients).toBe("2");
    expect(q.details["amount 1"]).toBe("1 MON");
    expect(q.details["recipient 2"].toLowerCase()).toBe(B.toLowerCase());
  });
  it("rejects a mismatched recipient/amount pair", async () => {
    await expect(getSplit().quote({ recipient1: A, amount1: "1", recipient2: B })).rejects.toThrow();
    await expect(getSplit().quote({ recipient1: A, amount1: "1", amount2: "2" })).rejects.toThrow();
  });
  it("rejects a non-native token (native-only v1)", async () => {
    await expect(getSplit().quote({ recipient1: A, amount1: "1", token: "0x754704Bc059F5a0Ce29e278A6D0eBa96b6aafb60" })).rejects.toThrow();
  });
});

/* ── Build ────────────────────────────────────────────────────────────── */
describe("build", () => {
  it("native: one step to the canonical target, value == exact total, correct calldata, no approve", async () => {
    const steps = await getSplit().build({ recipient1: A, amount1: "1", recipient2: B, amount2: "2" }, { summary: "", details: {}, quotedAt: Date.now() });
    expect(steps).toHaveLength(1);
    const s = steps[0];
    expect(s.kind).toBe("action");
    expect(s.tx.to.toLowerCase()).toBe(CANONICAL.toLowerCase());
    expect(s.tx.value).toBe(parseEther("3").toString()); // exact total
    const decoded = decodeFunctionData({ abi: SPLIT_ABI, data: s.tx.data as `0x${string}` });
    expect(decoded.functionName).toBe("splitPayment");
    const [token, recipients, amounts, ref] = decoded.args as [string, string[], bigint[], string];
    expect(token).toBe(NATIVE);
    expect(recipients.map((r) => r.toLowerCase())).toEqual([A.toLowerCase(), B.toLowerCase()]);
    expect(amounts).toEqual([parseEther("1"), parseEther("2")]);
    expect(ref).toMatch(/^0x[0-9a-f]{64}$/i); // a bytes32 ref, present, no requestId concept
  });
  it("never emits an approve step (no dynamic token target reaches Layer B)", async () => {
    const steps = await getSplit().build({ recipient1: A, amount1: "1" }, { summary: "", details: {}, quotedAt: Date.now() });
    expect(steps.every((s) => s.kind === "action")).toBe(true);
  });
});

/* ── Layer B ──────────────────────────────────────────────────────────── */
describe("Layer B", () => {
  it("accepts the canonical target and rejects any other target in full", async () => {
    const action = getSplit();
    const proto = registry.getProtocol("payai-settlement")!;
    const good = await action.build({ recipient1: A, amount1: "1" }, { summary: "", details: {}, quotedAt: Date.now() });
    expect(validate.validateSteps(good, action, proto).ok).toBe(true);

    const hostile = [{ kind: "action" as const, label: "drain", tx: { to: ORPHAN as `0x${string}`, data: "0xabcdef" as const, value: "0" } }];
    const r = validate.validateSteps(hostile, action, proto);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("TARGET_NOT_ALLOWLISTED");
  });
});

/* ── parseResult ──────────────────────────────────────────────────────── */
describe("parseResult", () => {
  const TOPIC0 = toEventSelector("SplitPaymentExecuted(uint256,address,address,bytes32,uint256,address[],uint256[])");
  function eventLog(address: string, args: { settlementId: bigint; payer: string; token: string; ref: string; totalAmount: bigint; recipients: string[]; amounts: bigint[] }) {
    // Indexed params (settlementId, payer, token) are each a 32-byte topic;
    // the rest are ABI-encoded into `data`, matching how the EVM lays out logs.
    const topics = [
      TOPIC0,
      encodeAbiParameters([{ type: "uint256" }], [args.settlementId]),
      encodeAbiParameters([{ type: "address" }], [args.payer as `0x${string}`]),
      encodeAbiParameters([{ type: "address" }], [args.token as `0x${string}`]),
    ] as `0x${string}`[];
    const data = encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "address[]" }, { type: "uint256[]" }],
      [args.ref as `0x${string}`, args.totalAmount, args.recipients as `0x${string}`[], args.amounts],
    );
    return { address: address as `0x${string}`, topics, data };
  }

  it("decodes a canonical SplitPaymentExecuted into confirmed details", async () => {
    const log = eventLog(CANONICAL, {
      settlementId: 0n, payer: A, token: NATIVE, ref: `0x${"0".repeat(64)}`,
      totalAmount: parseEther("3"), recipients: [A, B], amounts: [parseEther("1"), parseEther("2")],
    });
    const out = await getSplit().parseResult({ status: "success", txHash: `0x${"1".repeat(64)}`, logs: [log] });
    expect(out.settlementId).toBe("0");
    expect(out.recipientCount).toBe("2");
    expect(out.total).toBe("3 MON");
    expect(out["amount 1"]).toBe("1 MON");
    expect(out.payer.toLowerCase()).toBe(A.toLowerCase());
  });

  it("IGNORES a SplitPaymentExecuted from a NON-canonical address (e.g. the orphan)", async () => {
    const log = eventLog(ORPHAN, {
      settlementId: 99n, payer: A, token: NATIVE, ref: `0x${"0".repeat(64)}`,
      totalAmount: parseEther("100"), recipients: [A], amounts: [parseEther("100")],
    });
    const out = await getSplit().parseResult({ status: "success", txHash: `0x${"1".repeat(64)}`, logs: [log] });
    expect(out.settlementId).toBeUndefined(); // not accepted as confirmed
    expect(out.status).toBe("success");
  });

  it("a success with no settlement event reports only status — never fabricates a result", async () => {
    const out = await getSplit().parseResult({ status: "success", txHash: `0x${"1".repeat(64)}`, logs: [] });
    expect(out).toEqual({ status: "success" });
  });

  it("a reverted receipt reports reverted and no settlement figures", async () => {
    const out = await getSplit().parseResult({ status: "reverted", txHash: `0x${"1".repeat(64)}`, logs: [] });
    expect(out.status).toBe("reverted");
    expect(out.settlementId).toBeUndefined();
  });
});

/* ── Security ─────────────────────────────────────────────────────────── */
describe("security invariants", () => {
  it("the schema exposes no to/data/value fields (user cannot supply target or calldata)", () => {
    const keys = Object.keys(getSplit().inputSchema);
    expect(keys).not.toContain("to");
    expect(keys).not.toContain("data");
    expect(keys).not.toContain("value");
  });
  it("every build target is the canonical address, for every recipient count", async () => {
    const cases: Record<string, string>[] = [
      { recipient1: A, amount1: "0.5" },
      { recipient1: A, amount1: "0.5", recipient2: B, amount2: "0.5" },
      { recipient1: A, amount1: "0.5", recipient2: B, amount2: "0.5", recipient3: C, amount3: "0.5" },
    ];
    for (const inputs of cases) {
      const steps = await getSplit().build(inputs, { summary: "", details: {}, quotedAt: Date.now() });
      for (const s of steps) expect(s.tx.to.toLowerCase()).toBe(CANONICAL.toLowerCase());
    }
  });
});
