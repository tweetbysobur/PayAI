import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeAbiParameters, toEventSelector, parseEther } from "viem";

/**
 * split_payment v2.0.0 against the audited, mainnet-deployed SplitSettlement
 * contract. Proves the whole path (register → Layer A → quote → build →
 * Layer B → parseResult / settledOutflows) plus the security invariants: the
 * canonical mainnet target is hard-bound, the orphan deploy is never accepted,
 * the user can supply no target/calldata, native value equals the exact total,
 * every amount is exact integer base units (no decimals, no floats), recipients
 * are unique and 2..10, and confirmed results come only from a
 * SplitPaymentExecuted event emitted BY the canonical address.
 *
 * getChain is mocked to a fixed mainnet id so the test is deterministic without
 * a live chain — the action code is exactly what production loads.
 */

const CANONICAL = "0xaC98a844E0F9688EA9758Db05c134b8B4BCeAf6F";
const ORPHAN = "0xfCD284AD855a0D1E0e1f1154C038D70cC33357dd";
const MONAD = 143;
const NATIVE = "0x0000000000000000000000000000000000000000";
const A = "0x5e0d39b4c1a2f3e4d5c6b7a8f9e0d1c2b3a4f5e6";
const B = "0x7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b";
const C = "0x9c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d";
const ONE = parseEther("1").toString();
const TWO = parseEther("2").toString();

vi.mock("@/lib/monad/config", () => ({
  getChain: () => ({ id: MONAD }),
}));

const SPLIT_ABI = [
  { type: "function", name: "splitPayment", stateMutability: "payable", inputs: [
    { name: "token", type: "address" }, { name: "recipients", type: "address[]" },
    { name: "amounts", type: "uint256[]" }, { name: "ref", type: "bytes32" } ], outputs: [{ type: "uint256" }] },
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
  const action = registry.getAction("payai-settlement", "split_payment", "2.0.0");
  if (!action) throw new Error("split action not registered");
  return action;
}
const list = (...pairs: [string, string][]) => ({ recipients: pairs.map(([recipient, amount]) => ({ recipient, amount })) });
const NO_QUOTE = { summary: "", details: {}, quotedAt: Date.now() };

/** n distinct real-looking addresses. */
function addrs(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `0x${(i + 1).toString(16).padStart(2, "0")}${"a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9".slice(0, 38)}`);
}

/* ── Registration ─────────────────────────────────────────────────────── */
describe("registration", () => {
  it("registers payai-settlement/split_payment@2.0.0 pinned to the canonical mainnet address — and NOT v1", () => {
    const proto = registry.getProtocol("payai-settlement");
    expect(proto?.chainId).toBe(MONAD);
    expect(proto?.allowedTargets.map((a) => a.toLowerCase())).toEqual([CANONICAL.toLowerCase()]);
    const action = getSplit();
    expect(action.chainId).toBe(MONAD);
    expect(action.allowedTargets.map((a) => a.toLowerCase())).toEqual([CANONICAL.toLowerCase()]);
    expect(registry.getAction("payai-settlement", "split_payment", "1.0.0")).toBeNull();
  });
  it("never includes the orphan address anywhere", () => {
    const proto = registry.getProtocol("payai-settlement");
    const all = [...(proto?.allowedTargets ?? []), ...getSplit().allowedTargets].map((a) => a.toLowerCase());
    expect(all).not.toContain(ORPHAN.toLowerCase());
  });
  it("the participant limits match the deployed contract (2..10)", () => {
    expect(split.SPLIT_MIN_RECIPIENTS).toBe(2);
    expect(split.SPLIT_MAX_RECIPIENTS).toBe(10);
  });
});

/* ── Inputs (Layer A) ─────────────────────────────────────────────────── */
describe("inputs (Layer A)", () => {
  const layerA = (inputs: unknown) => validate.validateInputs(getSplit().inputSchema, inputs as never);

  it("accepts 2, 3 and 10 recipients", () => {
    expect(layerA(list([A, ONE], [B, TWO])).ok).toBe(true);
    expect(layerA(list([A, ONE], [B, TWO], [C, ONE])).ok).toBe(true);
    expect(layerA({ recipients: addrs(10).map((r) => ({ recipient: r, amount: "1" })) }).ok).toBe(true);
  });
  it("rejects 1 recipient and 11 recipients", () => {
    expect(layerA(list([A, ONE])).ok).toBe(false);
    expect(layerA({ recipients: addrs(11).map((r) => ({ recipient: r, amount: "1" })) }).ok).toBe(false);
  });
  it("rejects a malformed recipient", () => {
    expect(layerA(list(["not-an-address", ONE], [B, TWO])).ok).toBe(false);
  });
  it("amounts must be exact positive integer base units — no zero, decimals, exponents, signs, leading zeros or separators", () => {
    for (const bad of ["0", "1.5", "1e18", "-1", "01", "1 000", "0x10", "", "1,000"]) {
      expect(layerA(list([A, bad], [B, TWO])).ok, `amount "${bad}"`).toBe(false);
    }
    expect(layerA(list([A, (1n << 256n).toString()], [B, TWO])).ok, "above uint256").toBe(false);
  });
  it("rejects an unknown top-level parameter and an unknown field inside a list item", () => {
    const top = layerA({ ...list([A, ONE], [B, TWO]), to: CANONICAL, data: "0xdead", value: "1" });
    expect(top.ok).toBe(false);
    if (!top.ok) expect(top.code).toBe("UNKNOWN_PARAMETER");
    const item = layerA({ recipients: [{ recipient: A, amount: ONE, to: CANONICAL }, { recipient: B, amount: TWO }] });
    expect(item.ok).toBe(false);
    if (!item.ok) expect(item.code).toBe("UNKNOWN_PARAMETER");
  });
  it("rejects type confusion: a string where the list goes, a list where a string goes, non-object items", () => {
    expect(layerA({ recipients: `${A}:${ONE}` }).ok).toBe(false);
    expect(layerA({ ...list([A, ONE], [B, TWO]), token: [NATIVE] }).ok).toBe(false);
    expect(layerA({ recipients: [A, B] }).ok).toBe(false);
    expect(layerA({ recipients: [{ recipient: A, amount: 1 }, { recipient: B, amount: 2 }] }).ok).toBe(false);
  });
});

/* ── Quote ────────────────────────────────────────────────────────────── */
describe("quote", () => {
  it("summarizes the split and lists every recipient/amount, no tx side effect", async () => {
    const q = await getSplit().quote(list([A, ONE], [B, TWO]));
    expect(q.summary).toBe("Split 3 MON between 2 recipients");
    expect(q.details.total).toBe("3 MON");
    expect(q.details.recipients).toBe("2");
    expect(q.details["amount 1"]).toBe("1 MON");
    expect(q.details["recipient 2"].toLowerCase()).toBe(B.toLowerCase());
  });
  it("rejects duplicate recipients (case-insensitive) even though the contract would accept them", async () => {
    await expect(getSplit().quote(list([A, ONE], [A.toUpperCase().replace("0X", "0x"), TWO]))).rejects.toThrow(/more than once/);
  });
  it("fails closed on a token that can't be resolved as an ERC-20 (ERC-20 enablement is covered in sdk-split-erc20)", async () => {
    await expect(getSplit().quote({ ...list([A, ONE], [B, TWO]), token: "0x754704Bc059F5a0Ce29e278A6D0eBa96b6aafb60" })).rejects.toThrow();
  });
});

/* ── Build ────────────────────────────────────────────────────────────── */
describe("build", () => {
  it("native: one step to the canonical target, value == exact total, exact integer amounts, no approve", async () => {
    const steps = await getSplit().build(list([A, ONE], [B, TWO]), NO_QUOTE);
    expect(steps).toHaveLength(1);
    const s = steps[0];
    expect(s.kind).toBe("action");
    expect(s.tx.to.toLowerCase()).toBe(CANONICAL.toLowerCase());
    expect(s.tx.value).toBe(parseEther("3").toString());
    const decoded = decodeFunctionData({ abi: SPLIT_ABI, data: s.tx.data as `0x${string}` });
    const [token, recipients, amounts, ref] = decoded.args as [string, string[], bigint[], string];
    expect(token).toBe(NATIVE);
    expect(recipients.map((r) => r.toLowerCase())).toEqual([A.toLowerCase(), B.toLowerCase()]);
    expect(amounts).toEqual([parseEther("1"), parseEther("2")]);
    expect(ref).toMatch(/^0x[0-9a-f]{64}$/i);
  });
  it("odd base-unit amounts pass through exactly — no rounding anywhere", async () => {
    const steps = await getSplit().build(list([A, "333333333333333333"], [B, "333333333333333334"]), NO_QUOTE);
    const [, , amounts] = decodeFunctionData({ abi: SPLIT_ABI, data: steps[0].tx.data as `0x${string}` }).args as [string, string[], bigint[], string];
    expect(amounts).toEqual([333333333333333333n, 333333333333333334n]);
    expect(steps[0].tx.value).toBe("666666666666666667");
  });
  it("rejects the zero address and the settlement contract itself as recipients, before any step exists", async () => {
    await expect(getSplit().build(list([NATIVE, ONE], [B, TWO]), NO_QUOTE)).rejects.toThrow(/zero address/);
    await expect(getSplit().build(list([CANONICAL, ONE], [B, TWO]), NO_QUOTE)).rejects.toThrow(/Split Settlement contract/);
  });
  it("outflows() reports exactly the recipients and base-unit amounts that build() pays", async () => {
    const out = await getSplit().outflows!(list([A, ONE], [B, TWO]));
    expect(out.map((o) => [o.recipient.toLowerCase(), o.amountUnits])).toEqual([[A.toLowerCase(), parseEther("1")], [B.toLowerCase(), parseEther("2")]]);
    expect(out.every((o) => o.token === NATIVE && o.symbol === "MON" && o.decimals === 18)).toBe(true);
  });
});

/* ── Layer B ──────────────────────────────────────────────────────────── */
describe("Layer B", () => {
  it("accepts the canonical target and rejects any other target in full", async () => {
    const action = getSplit();
    const proto = registry.getProtocol("payai-settlement")!;
    const good = await action.build(list([A, ONE], [B, TWO]), NO_QUOTE);
    expect(validate.validateSteps(good, action, proto).ok).toBe(true);

    const hostile = [{ kind: "action" as const, label: "drain", tx: { to: ORPHAN as `0x${string}`, data: "0xabcdef" as const, value: "0" } }];
    const r = validate.validateSteps(hostile, action, proto);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("TARGET_NOT_ALLOWLISTED");
  });
});

/* ── parseResult / settledOutflows ────────────────────────────────────── */
describe("confirmed results come only from the canonical event", () => {
  const TOPIC0 = toEventSelector("SplitPaymentExecuted(uint256,address,address,bytes32,uint256,address[],uint256[])");
  function eventLog(address: string, args: { settlementId: bigint; payer: string; token: string; totalAmount: bigint; recipients: string[]; amounts: bigint[] }) {
    const topics = [
      TOPIC0,
      encodeAbiParameters([{ type: "uint256" }], [args.settlementId]),
      encodeAbiParameters([{ type: "address" }], [args.payer as `0x${string}`]),
      encodeAbiParameters([{ type: "address" }], [args.token as `0x${string}`]),
    ] as `0x${string}`[];
    const data = encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "address[]" }, { type: "uint256[]" }],
      [`0x${"0".repeat(64)}`, args.totalAmount, args.recipients as `0x${string}`[], args.amounts],
    );
    return { address: address as `0x${string}`, topics, data };
  }
  const TX = `0x${"1".repeat(64)}` as `0x${string}`;

  it("decodes a canonical SplitPaymentExecuted into confirmed details and settled outflows", async () => {
    const log = eventLog(CANONICAL, { settlementId: 7n, payer: A, token: NATIVE, totalAmount: parseEther("3"), recipients: [B, C], amounts: [parseEther("1"), parseEther("2")] });
    const out = await getSplit().parseResult({ status: "success", txHash: TX, logs: [log] });
    expect(out.settlementId).toBe("7");
    expect(out.recipientCount).toBe("2");
    expect(out.total).toBe("3 MON");
    expect(out["amount 2"]).toBe("2 MON");
    const settled = await getSplit().settledOutflows!({ status: "success", txHash: TX, logs: [log] });
    expect(settled.map((o) => [o.recipient.toLowerCase(), o.amountUnits])).toEqual([[B.toLowerCase(), parseEther("1")], [C.toLowerCase(), parseEther("2")]]);
  });

  it("IGNORES a SplitPaymentExecuted from a NON-canonical address (e.g. the orphan)", async () => {
    const log = eventLog(ORPHAN, { settlementId: 99n, payer: A, token: NATIVE, totalAmount: parseEther("100"), recipients: [B], amounts: [parseEther("100")] });
    const out = await getSplit().parseResult({ status: "success", txHash: TX, logs: [log] });
    expect(out).toEqual({ status: "success" });
    expect(await getSplit().settledOutflows!({ status: "success", txHash: TX, logs: [log] })).toEqual([]);
  });

  it("a success with no settlement event reports only status — never fabricates a result", async () => {
    expect(await getSplit().parseResult({ status: "success", txHash: TX, logs: [] })).toEqual({ status: "success" });
    expect(await getSplit().settledOutflows!({ status: "success", txHash: TX, logs: [] })).toEqual([]);
  });

  it("a reverted receipt reports reverted and settles nothing, even with a canonical event present", async () => {
    const log = eventLog(CANONICAL, { settlementId: 1n, payer: A, token: NATIVE, totalAmount: parseEther("3"), recipients: [B, C], amounts: [parseEther("1"), parseEther("2")] });
    expect(await getSplit().parseResult({ status: "reverted", txHash: TX, logs: [log] })).toEqual({ status: "reverted" });
    expect(await getSplit().settledOutflows!({ status: "reverted", txHash: TX, logs: [log] })).toEqual([]);
  });
});

/* ── Security ─────────────────────────────────────────────────────────── */
describe("security invariants", () => {
  it("the schema exposes no to/data/value fields, top-level or per recipient", () => {
    const schema = getSplit().inputSchema;
    expect(Object.keys(schema).sort()).toEqual(["recipients", "token"]);
    const recipients = schema.recipients;
    expect(recipients.type).toBe("list");
    if (recipients.type === "list") expect(Object.keys(recipients.items).sort()).toEqual(["amount", "recipient"]);
  });
  it("every build target is the canonical address, for 2, 3 and 10 recipients", async () => {
    for (const n of [2, 3, 10]) {
      const steps = await getSplit().build({ recipients: addrs(n).map((r) => ({ recipient: r, amount: "500" })) }, NO_QUOTE);
      for (const s of steps) expect(s.tx.to.toLowerCase()).toBe(CANONICAL.toLowerCase());
    }
  });
});
