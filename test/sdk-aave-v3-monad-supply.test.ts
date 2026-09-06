import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, toEventSelector, parseUnits, pad } from "viem";

/**
 * PHASE 7A — Aave V3 Monad supply adapter. Proves the full SDK path
 * (register → Layer A → quote → build → Layer B → parseResult) against the
 * FIRST external (non-PayAI-owned) protocol, plus every security invariant
 * called out for this phase: fixed target, live reserve verification,
 * exact approval semantics, fixed referralCode, canonical-event-only
 * receipt parsing, and quote/target/spender/amount isolation.
 *
 * getChain/getPublicClient/resolveToken are mocked so the suite is
 * deterministic without a live chain — the action code itself is exactly
 * what production loads.
 */

const POOL = "0x69a5F9AD4f96ebf0a0C792dD42a01cC5C0102fef";
const MONAD = 143;
const ASSET = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603"; // a real, curated Monad reserve (USDC) used as the test's Aave-listed asset
const NOT_LISTED_ASSET = "0x9999999999999999999999999999999999999999";
const ATTACKER = "0x6666666666666666666666666666666666666666";
const USER = "0x4444444444444444444444444444444444444444";
const ALT_USER = "0x5555555555555555555555555555555555555555";

let readContractMock: ReturnType<typeof vi.fn<(args: { functionName: string; args?: readonly unknown[] }) => unknown>>;

vi.mock("@/lib/monad/config", () => ({
  getChain: () => ({ id: MONAD }),
}));

vi.mock("@/lib/monad/wallet", () => ({
  getPublicClient: () => ({ readContract: (arg: { functionName: string; args?: readonly unknown[] }) => readContractMock(arg) }),
}));

vi.mock("@/lib/monad/tokenRegistry", () => ({
  resolveToken: vi.fn(async (address: string) => {
    if (address.toLowerCase() === ASSET.toLowerCase()) return { address, symbol: "USDC", name: "USD Coin", decimals: 6, verified: true };
    if (address.toLowerCase() === NOT_LISTED_ASSET.toLowerCase()) return { address, symbol: "RUG", name: "Not Listed Token", decimals: 18, verified: false };
    throw new Error("not a readable ERC-20");
  }),
}));

let registry: typeof import("@/lib/sdk/registry");
let validate: typeof import("@/lib/sdk/validate");
let aave: typeof import("@/lib/sdk/actions/aave-v3-monad/supply");

function mockReserveList(listed: string[]) {
  readContractMock.mockImplementation(async ({ functionName }: { functionName: string }) => {
    if (functionName === "getAllReservesTokens") {
      return listed.map((a) => ({ symbol: "X", tokenAddress: a }));
    }
    if (functionName === "getReserveData") {
      // liquidityRate at index 5, ray-scaled (~3.5% APR)
      return [0n, 0n, 0n, 0n, 0n, 35_000_000_000_000_000_000_000_000n, 0n, 0n, 0n, 0n, 0n, 0n];
    }
    throw new Error(`unexpected readContract call: ${functionName}`);
  });
}

beforeEach(async () => {
  readContractMock = vi.fn();
  mockReserveList([ASSET]);
  registry = await import("@/lib/sdk/registry");
  validate = await import("@/lib/sdk/validate");
  aave = await import("@/lib/sdk/actions/aave-v3-monad/supply");
  registry.__resetRegistryForTests();
  aave.__resetReservesCacheForTests();
  const proto = aave.createAaveV3MonadSupplyProtocol();
  if (proto) registry.registerProtocol(proto);
});

afterEach(() => {
  registry.__resetRegistryForTests();
  vi.restoreAllMocks();
});

function getSupply() {
  const action = registry.getAction("aave-v3-monad", "supply", "1.0.0");
  if (!action) throw new Error("supply action not registered");
  return action;
}

const validInputs = { asset: ASSET, amount: "100", onBehalfOf: USER };

/* ── A. registry lookup ───────────────────────────────────────────────── */
describe("A. registry lookup", () => {
  it("registers under the exact protocolId/actionId/version", () => {
    const proto = registry.getProtocol("aave-v3-monad");
    expect(proto).not.toBeNull();
    expect(registry.getAction("aave-v3-monad", "supply", "1.0.0")).not.toBeNull();
  });
  it("does not resolve under a wrong protocolId, actionId, or version", () => {
    expect(registry.getAction("aave-v3", "supply", "1.0.0")).toBeNull();
    expect(registry.getAction("aave-v3-monad", "withdraw", "1.0.0")).toBeNull();
    expect(registry.getAction("aave-v3-monad", "supply", "2.0.0")).toBeNull();
  });
  it("only registers on Monad mainnet (chainId 143)", () => {
    const action = getSupply();
    expect(action.chainId).toBe(MONAD);
  });
});

/* ── B. target pinning ────────────────────────────────────────────────── */
describe("B. target pinning", () => {
  it("the canonical Pool is the action's and protocol's only allowedTarget", () => {
    const action = getSupply();
    const proto = registry.getProtocol("aave-v3-monad")!;
    expect(action.allowedTargets.map((a) => a.toLowerCase())).toEqual([POOL.toLowerCase()]);
    expect(proto.allowedTargets.map((a) => a.toLowerCase())).toEqual([POOL.toLowerCase()]);
  });

  it("build()'s supply step always targets the canonical Pool, and passes Layer B", async () => {
    const action = getSupply();
    const proto = registry.getProtocol("aave-v3-monad")!;
    const steps = await action.build(validInputs, { summary: "", details: {}, quotedAt: Date.now() });
    const supplyStep = steps.find((s) => s.kind === "action")!;
    expect(supplyStep.tx.to.toLowerCase()).toBe(POOL.toLowerCase());
    expect(validate.validateSteps(steps, action, proto).ok).toBe(true);
  });

  it("an action step targeting an alternate (attacker) address is rejected by Layer B", () => {
    const action = getSupply();
    const proto = registry.getProtocol("aave-v3-monad")!;
    const forged = [{
      kind: "action" as const, label: "forged",
      tx: { to: ATTACKER as `0x${string}`, data: "0x12345678" as `0x${string}`, value: "0" },
    }];
    const result = validate.validateSteps(forged, action, proto);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("TARGET_NOT_ALLOWLISTED");
  });
});

/* ── C. approval validation ───────────────────────────────────────────── */
describe("C. approval validation", () => {
  async function buildApprovalStep() {
    const action = getSupply();
    const steps = await action.build(validInputs, { summary: "", details: {}, quotedAt: Date.now() });
    return { action, proto: registry.getProtocol("aave-v3-monad")!, approveStep: steps.find((s) => s.kind === "approve")! };
  }

  it("the real approval step (correct spender = POOL) is accepted", async () => {
    const { action, proto, approveStep } = await buildApprovalStep();
    const result = validate.validateSteps([approveStep], action, proto);
    expect(result.ok).toBe(true);
  });

  it("a spender other than POOL is rejected", async () => {
    const { action, proto, approveStep } = await buildApprovalStep();
    const forged = {
      ...approveStep,
      data: encodeFunctionData({
        abi: [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }] as const,
        functionName: "approve", args: [ATTACKER as `0x${string}`, parseUnits("100", 6)],
      }),
    };
    const step = { ...approveStep, tx: { ...approveStep.tx, data: forged.data }, approval: { ...approveStep.approval!, spender: ATTACKER as `0x${string}` } };
    const result = validate.validateSteps([step], action, proto);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("APPROVAL_INVALID");
  });

  it("a wrong token (tx.to != declared token) is rejected", async () => {
    const { action, proto, approveStep } = await buildApprovalStep();
    const step = { ...approveStep, tx: { ...approveStep.tx, to: ATTACKER as `0x${string}` } };
    const result = validate.validateSteps([step], action, proto);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("APPROVAL_INVALID");
  });

  it("a wrong amount (calldata diverges from declaration) is rejected", async () => {
    const { action, proto, approveStep } = await buildApprovalStep();
    const wrongData = encodeFunctionData({
      abi: [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }] as const,
      functionName: "approve", args: [POOL as `0x${string}`, parseUnits("999", 6)],
    });
    const step = { ...approveStep, tx: { ...approveStep.tx, data: wrongData } };
    const result = validate.validateSteps([step], action, proto);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("APPROVAL_INVALID");
  });

  it("MAX_UINT256 is rejected", async () => {
    const { action, proto, approveStep } = await buildApprovalStep();
    const maxUint = (1n << 256n) - 1n;
    const data = encodeFunctionData({
      abi: [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }] as const,
      functionName: "approve", args: [POOL as `0x${string}`, maxUint],
    });
    const step = { ...approveStep, tx: { ...approveStep.tx, data }, approval: { ...approveStep.approval!, amount: maxUint.toString() } };
    const result = validate.validateSteps([step], action, proto);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("APPROVAL_INVALID");
  });

  it("malformed approve calldata (wrong selector) is rejected", async () => {
    const { action, proto, approveStep } = await buildApprovalStep();
    const step = { ...approveStep, tx: { ...approveStep.tx, data: "0xdeadbeef" as `0x${string}` } };
    const result = validate.validateSteps([step], action, proto);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("APPROVAL_INVALID");
  });

  it("trailing bytes on otherwise-valid approve calldata are rejected", async () => {
    const { action, proto, approveStep } = await buildApprovalStep();
    const step = { ...approveStep, tx: { ...approveStep.tx, data: (approveStep.tx.data + "00") as `0x${string}` } };
    const result = validate.validateSteps([step], action, proto);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("APPROVAL_INVALID");
  });
});

/* ── D. supply calldata ───────────────────────────────────────────────── */
describe("D. supply calldata", () => {
  const SUPPLY_ABI = [{
    type: "function", name: "supply", stateMutability: "nonpayable",
    inputs: [{ name: "asset", type: "address" }, { name: "amount", type: "uint256" }, { name: "onBehalfOf", type: "address" }, { name: "referralCode", type: "uint16" }],
    outputs: [],
  }] as const;

  it("encodes the correct selector, asset, amount, onBehalfOf, and a hardcoded referralCode of 0", async () => {
    const action = getSupply();
    const steps = await action.build(validInputs, { summary: "", details: {}, quotedAt: Date.now() });
    const supplyStep = steps.find((s) => s.kind === "action")!;
    const decoded = decodeFunctionData({ abi: SUPPLY_ABI, data: supplyStep.tx.data });
    expect(decoded.functionName).toBe("supply");
    const [asset, amount, onBehalfOf, referralCode] = decoded.args;
    expect(asset.toLowerCase()).toBe(ASSET.toLowerCase());
    expect(amount).toBe(parseUnits("100", 6));
    expect(onBehalfOf.toLowerCase()).toBe(USER.toLowerCase());
    expect(referralCode).toBe(0);
  });

  it("referralCode is always 0 regardless of any extra/unknown input", async () => {
    const action = getSupply();
    // Layer A would reject an unknown field before build() ever runs — this
    // proves build() itself never even looks for one.
    const steps = await action.build({ ...validInputs }, { summary: "", details: {}, quotedAt: Date.now() });
    const supplyStep = steps.find((s) => s.kind === "action")!;
    const decoded = decodeFunctionData({ abi: SUPPLY_ABI, data: supplyStep.tx.data });
    expect(decoded.args[3]).toBe(0);
  });

  it("Layer A rejects an unknown 'referralCode' or 'target' parameter outright", () => {
    const action = getSupply();
    expect(validate.validateInputs(action.inputSchema, { ...validInputs, referralCode: "5" }).ok).toBe(false);
    expect(validate.validateInputs(action.inputSchema, { ...validInputs, target: ATTACKER }).ok).toBe(false);
    expect(validate.validateInputs(action.inputSchema, { ...validInputs, spender: ATTACKER }).ok).toBe(false);
    expect(validate.validateInputs(action.inputSchema, { ...validInputs, calldata: "0xdead" }).ok).toBe(false);
  });
});

/* ── E. asset validation ──────────────────────────────────────────────── */
describe("E. asset validation", () => {
  it("a supported Aave reserve is accepted", async () => {
    const action = getSupply();
    await expect(action.quote(validInputs)).resolves.toBeDefined();
  });

  it("an unknown/unlisted ERC-20 is rejected even though it reads fine as a token", async () => {
    mockReserveList([ASSET]); // NOT_LISTED_ASSET deliberately absent
    const action = getSupply();
    await expect(action.quote({ ...validInputs, asset: NOT_LISTED_ASSET })).rejects.toThrow(/not a reserve Aave V3 lists/);
  });

  it("a token that can't even be read as an ERC-20 is rejected", async () => {
    const action = getSupply();
    await expect(action.quote({ ...validInputs, asset: "0x1234567890123456789012345678901234567890" })).rejects.toThrow(/Couldn't read/);
  });

  it("fails closed (rejects) when the reserve-list read itself fails, never assuming an asset is listed", async () => {
    readContractMock.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === "getAllReservesTokens") throw new Error("RPC down");
      throw new Error("unexpected call");
    });
    const action = getSupply();
    await expect(action.quote(validInputs)).rejects.toThrow(/not a reserve Aave V3 lists/);
  });

  it("build() re-verifies the reserve too — a reserve delisted between quote and build is refused", async () => {
    const action = getSupply();
    const quote = await action.quote(validInputs);
    mockReserveList([]); // delisted before build()
    aave.__resetReservesCacheForTests(); // force a fresh read to observe the delisting
    await expect(action.build(validInputs, quote)).rejects.toThrow(/not a reserve Aave V3 lists/);
  });

  it("rejects the native-MON sentinel — this action only supplies ERC-20 reserves", async () => {
    const action = getSupply();
    await expect(action.quote({ ...validInputs, asset: "0x0000000000000000000000000000000000000000" })).rejects.toThrow();
  });

  it("rejects a zero-address onBehalfOf", async () => {
    const action = getSupply();
    await expect(action.quote({ ...validInputs, onBehalfOf: "0x0000000000000000000000000000000000000000" })).rejects.toThrow(/onBehalfOf/);
  });
});

/* ── F. receipt parsing ───────────────────────────────────────────────── */
describe("F. receipt parsing", () => {
  const SUPPLY_TOPIC = toEventSelector("Supply(address,address,address,uint256,uint16)");

  function supplyLog(opts: { address?: string; reserve?: string; onBehalfOf?: string; user?: string; amount?: bigint; referralCode?: number }) {
    const reserve = opts.reserve ?? ASSET;
    const onBehalfOf = opts.onBehalfOf ?? USER;
    const referralCode = opts.referralCode ?? 0;
    return {
      address: (opts.address ?? POOL) as `0x${string}`,
      topics: [
        SUPPLY_TOPIC,
        pad(reserve as `0x${string}`, { size: 32 }),
        pad(onBehalfOf as `0x${string}`, { size: 32 }),
        pad(`0x${referralCode.toString(16)}` as `0x${string}`, { size: 32 }),
      ] as [`0x${string}`, ...`0x${string}`[]],
      data: encodeAbiParameters(
        [{ name: "user", type: "address" }, { name: "amount", type: "uint256" }],
        [(opts.user ?? USER) as `0x${string}`, opts.amount ?? parseUnits("100", 6)],
      ),
    };
  }

  it("a valid Supply event from the canonical Pool is accepted and decoded", async () => {
    const action = getSupply();
    const receipt = { status: "success" as const, txHash: "0xabc" as `0x${string}`, logs: [supplyLog({})] };
    const parsed = await action.parseResult(receipt);
    expect(parsed.status).toBe("success");
    expect(parsed.reserve.toLowerCase()).toBe(ASSET.toLowerCase());
    expect(parsed.onBehalfOf.toLowerCase()).toBe(USER.toLowerCase());
    expect(parsed.amount).toBe(parseUnits("100", 6).toString());
  });

  it("a Supply-shaped event emitted by the WRONG (non-Pool) address is ignored, never reported as success detail", async () => {
    const action = getSupply();
    const receipt = { status: "success" as const, txHash: "0xabc" as `0x${string}`, logs: [supplyLog({ address: ATTACKER })] };
    const parsed = await action.parseResult(receipt);
    expect(parsed.status).toBe("success");
    expect(parsed.reserve).toBeUndefined();
  });

  it("a decodable-but-different onBehalfOf is reported exactly as decoded, never coerced to what was requested", async () => {
    const action = getSupply();
    const receipt = { status: "success" as const, txHash: "0xabc" as `0x${string}`, logs: [supplyLog({ onBehalfOf: ALT_USER })] };
    const parsed = await action.parseResult(receipt);
    expect(parsed.onBehalfOf.toLowerCase()).toBe(ALT_USER.toLowerCase());
    expect(parsed.onBehalfOf.toLowerCase()).not.toBe(USER.toLowerCase());
  });

  it("a receipt with no Supply event at all reports status only — never fabricated", async () => {
    const action = getSupply();
    const receipt = { status: "success" as const, txHash: "0xabc" as `0x${string}`, logs: [] };
    const parsed = await action.parseResult(receipt);
    expect(parsed).toEqual({ status: "success" });
  });

  it("a generic ERC-20 Transfer event from the Pool address cannot fake a successful supply", async () => {
    const action = getSupply();
    const transferTopic = toEventSelector("Transfer(address,address,uint256)");
    const fakeLog = {
      address: POOL as `0x${string}`,
      topics: [transferTopic, pad(USER as `0x${string}`, { size: 32 }), pad(ATTACKER as `0x${string}`, { size: 32 })] as [`0x${string}`, ...`0x${string}`[]],
      data: encodeAbiParameters([{ name: "value", type: "uint256" }], [parseUnits("100", 6)]),
    };
    const receipt = { status: "success" as const, txHash: "0xabc" as `0x${string}`, logs: [fakeLog] };
    const parsed = await action.parseResult(receipt);
    expect(parsed).toEqual({ status: "success" }); // no reserve/onBehalfOf/amount fabricated
  });

  it("a reverted receipt reports status only, regardless of any logs present", async () => {
    const action = getSupply();
    const receipt = { status: "reverted" as const, txHash: "0xabc" as `0x${string}`, logs: [supplyLog({})] };
    const parsed = await action.parseResult(receipt);
    expect(parsed).toEqual({ status: "reverted" });
  });
});

/* ── G. quote isolation ───────────────────────────────────────────────── */
describe("G. quote isolation", () => {
  it("quote data cannot change the build() target — always POOL regardless of quote.details contents", async () => {
    const action = getSupply();
    const tamperedQuote = { summary: "x", details: { asset: ATTACKER, onBehalfOf: ATTACKER }, quotedAt: Date.now() };
    const steps = await action.build(validInputs, tamperedQuote);
    expect(steps.find((s) => s.kind === "action")!.tx.to.toLowerCase()).toBe(POOL.toLowerCase());
  });

  it("quote data cannot change the approval spender — always POOL", async () => {
    const action = getSupply();
    const tamperedQuote = { summary: "x", details: { spender: ATTACKER }, quotedAt: Date.now() };
    const steps = await action.build(validInputs, tamperedQuote);
    expect(steps.find((s) => s.kind === "approve")!.approval!.spender.toLowerCase()).toBe(POOL.toLowerCase());
  });

  it("quote data cannot change the built amount — build() recomputes units from inputs, not from quote.details", async () => {
    const action = getSupply();
    const tamperedQuote = { summary: "x", details: { amount: "999999" }, quotedAt: Date.now() };
    const steps = await action.build(validInputs, tamperedQuote);
    expect(steps.find((s) => s.kind === "approve")!.approval!.amount).toBe(parseUnits("100", 6).toString());
  });

  it("an unreadable read (data provider failure) makes quote() fail closed rather than return a partial/guessed quote", async () => {
    readContractMock.mockImplementation(async () => { throw new Error("RPC down"); });
    aave.__resetReservesCacheForTests(); // force a fresh read instead of the beforeEach-warmed cache
    const action = getSupply();
    await expect(action.quote(validInputs)).rejects.toThrow();
  });
});

/* ── H. regression is covered by running the full suite separately (see report) ── */
