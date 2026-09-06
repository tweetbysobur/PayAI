import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeAbiParameters, toEventSelector, parseUnits, pad } from "viem";

/**
 * PHASE 7C — proves the CONSOLIDATED Aave V3 Monad adapter
 * (createAaveV3MonadProtocol) registers supply and withdraw TOGETHER, in
 * one real registry instance, under one protocolId — the exact scenario
 * the two standalone Phase 7A/7B factories could never exercise (each
 * registers only itself; two separate `protocolId: "aave-v3-monad"`
 * adapters can never both be registered at once). Also re-proves, against
 * this new consolidated registration path specifically, every core
 * security invariant already covered by the per-action suites — not to
 * duplicate that coverage wholesale, but to confirm none of it silently
 * broke when the two actions started sharing one adapter.
 *
 * WMON and split-settlement are registered alongside Aave in several tests
 * here specifically to prove requirement N: consolidating Aave does not
 * perturb any other already-registered protocol's behavior.
 */

const POOL = "0x69a5F9AD4f96ebf0a0C792dD42a01cC5C0102fef";
const WMON = "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A";
const SPLIT = "0xaC98a844E0F9688EA9758Db05c134b8B4BCeAf6F";
const MONAD = 143;
const ASSET = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603"; // curated Monad USDC
const NOT_LISTED_ASSET = "0x9999999999999999999999999999999999999999";
const ATTACKER = "0x6666666666666666666666666666666666666666";
const USER_ADDR = "0x4444444444444444444444444444444444444444";

let readContractMock: ReturnType<typeof vi.fn<(args: { functionName: string; args?: readonly unknown[] }) => unknown>>;

vi.mock("@/lib/monad/config", () => ({
  getChain: () => ({ id: MONAD }),
  getWrappedNative: () => WMON,
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
let aave: typeof import("@/lib/sdk/actions/aave-v3-monad");
let wmon: typeof import("@/lib/sdk/actions/wmon");
let split: typeof import("@/lib/sdk/actions/split-settlement");

function mockReserveList(listed: string[]) {
  readContractMock.mockImplementation(async ({ functionName }: { functionName: string }) => {
    if (functionName === "getAllReservesTokens") return listed.map((a) => ({ symbol: "X", tokenAddress: a }));
    if (functionName === "getReserveData") return [0n, 0n, 0n, 0n, 0n, 35_000_000_000_000_000_000_000_000n, 0n, 0n, 0n, 0n, 0n, 0n];
    throw new Error(`unexpected readContract call: ${functionName}`);
  });
}

beforeEach(async () => {
  readContractMock = vi.fn();
  mockReserveList([ASSET]);
  registry = await import("@/lib/sdk/registry");
  validate = await import("@/lib/sdk/validate");
  aave = await import("@/lib/sdk/actions/aave-v3-monad");
  wmon = await import("@/lib/sdk/actions/wmon");
  split = await import("@/lib/sdk/actions/split-settlement");
  registry.__resetRegistryForTests();
  aave.__resetReservesCacheForTests();
});

afterEach(() => {
  registry.__resetRegistryForTests();
  vi.restoreAllMocks();
});

/* ── A. one protocol registration succeeds ────────────────────────────── */
describe("A. one protocol registration succeeds", () => {
  it("registers supply and withdraw together via a single registerProtocol() call, with no error", () => {
    const proto = aave.createAaveV3MonadProtocol()!;
    expect(proto.protocolId).toBe("aave-v3-monad");
    expect(proto.actions).toHaveLength(2);
    expect(() => registry.registerProtocol(proto)).not.toThrow();
  });

  it("only registers on Monad mainnet (chainId 143)", () => {
    const proto = aave.createAaveV3MonadProtocol()!;
    expect(proto.chainId).toBe(MONAD);
  });
});

/* ── B. both action IDs resolve ───────────────────────────────────────── */
describe("B. both action IDs resolve", () => {
  beforeEach(() => registry.registerProtocol(aave.createAaveV3MonadProtocol()!));

  it("aave-v3-monad / supply / 1.0.0 resolves", () => {
    const action = registry.getAction("aave-v3-monad", "supply", "1.0.0");
    expect(action).not.toBeNull();
    expect(action!.actionId).toBe("supply");
  });

  it("aave-v3-monad / withdraw / 1.0.0 resolves", () => {
    const action = registry.getAction("aave-v3-monad", "withdraw", "1.0.0");
    expect(action).not.toBeNull();
    expect(action!.actionId).toBe("withdraw");
  });
});

/* ── C. unknown action fails ──────────────────────────────────────────── */
describe("C. unknown action fails", () => {
  beforeEach(() => registry.registerProtocol(aave.createAaveV3MonadProtocol()!));

  it("an unregistered actionId under aave-v3-monad returns null", () => {
    expect(registry.getAction("aave-v3-monad", "borrow", "1.0.0")).toBeNull();
  });

  it("resolveExecutable reports ACTION_NOT_FOUND for it", () => {
    const request = {
      protocolId: "aave-v3-monad", actionId: "borrow", version: "1.0.0",
      inputs: {}, walletAddress: USER_ADDR as `0x${string}`, chainId: MONAD, quotedAt: Date.now(),
    };
    const result = validate.resolveExecutable(request, MONAD);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("ACTION_NOT_FOUND");
  });
});

/* ── D. unknown version fails ─────────────────────────────────────────── */
describe("D. unknown version fails", () => {
  beforeEach(() => registry.registerProtocol(aave.createAaveV3MonadProtocol()!));

  it("supply at a version other than 1.0.0 returns null", () => {
    expect(registry.getAction("aave-v3-monad", "supply", "2.0.0")).toBeNull();
  });
  it("withdraw at a version other than 1.0.0 returns null", () => {
    expect(registry.getAction("aave-v3-monad", "withdraw", "9.9.9")).toBeNull();
  });
  it("resolveExecutable reports VERSION_MISMATCH (not ACTION_NOT_FOUND) since the actionId IS known", () => {
    const request = {
      protocolId: "aave-v3-monad", actionId: "supply", version: "2.0.0",
      inputs: {}, walletAddress: USER_ADDR as `0x${string}`, chainId: MONAD, quotedAt: Date.now(),
    };
    const result = validate.resolveExecutable(request, MONAD);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("VERSION_MISMATCH");
  });
});

/* ── E. supply and withdraw cannot collide ────────────────────────────── */
describe("E. supply and withdraw cannot collide", () => {
  it("registering the consolidated adapter twice is rejected as a duplicate protocol (proves no silent merge/overwrite)", () => {
    registry.registerProtocol(aave.createAaveV3MonadProtocol()!);
    expect(() => registry.registerProtocol(aave.createAaveV3MonadProtocol()!)).toThrow(/already registered/);
  });

  it("each action keeps its own distinct actionId/inputSchema/allowedTargets — nothing bleeds between them", () => {
    registry.registerProtocol(aave.createAaveV3MonadProtocol()!);
    const supply = registry.getAction("aave-v3-monad", "supply", "1.0.0")!;
    const withdraw = registry.getAction("aave-v3-monad", "withdraw", "1.0.0")!;
    expect(supply.actionId).not.toBe(withdraw.actionId);
    expect(Object.keys(supply.inputSchema).sort()).toEqual(["amount", "asset", "onBehalfOf"]);
    expect(Object.keys(withdraw.inputSchema).sort()).toEqual(["amount", "asset", "to"]);
  });

  it("listActionVersions for supply never includes withdraw's version and vice versa (they are namespaced by actionId)", () => {
    registry.registerProtocol(aave.createAaveV3MonadProtocol()!);
    expect(registry.listActionVersions("aave-v3-monad", "supply")).toEqual(["1.0.0"]);
    expect(registry.listActionVersions("aave-v3-monad", "withdraw")).toEqual(["1.0.0"]);
  });
});

/* ── F/G. target pinning for both actions, from the consolidated adapter ─ */
describe("F. supply target remains pinned", () => {
  beforeEach(() => registry.registerProtocol(aave.createAaveV3MonadProtocol()!));

  it("supply.allowedTargets is exactly [POOL]", () => {
    const supply = registry.getAction("aave-v3-monad", "supply", "1.0.0")!;
    expect(supply.allowedTargets.map((a) => a.toLowerCase())).toEqual([POOL.toLowerCase()]);
  });

  it("a supply action step forged to target an alternate address is rejected by Layer B", () => {
    const supply = registry.getAction("aave-v3-monad", "supply", "1.0.0")!;
    const proto = registry.getProtocol("aave-v3-monad")!;
    const forged = [{ kind: "action" as const, label: "forged", tx: { to: ATTACKER as `0x${string}`, data: "0x12345678" as `0x${string}`, value: "0" } }];
    const result = validate.validateSteps(forged, supply, proto);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("TARGET_NOT_ALLOWLISTED");
  });
});

describe("G. withdraw target remains pinned", () => {
  beforeEach(() => registry.registerProtocol(aave.createAaveV3MonadProtocol()!));

  it("withdraw.allowedTargets is exactly [POOL]", () => {
    const withdraw = registry.getAction("aave-v3-monad", "withdraw", "1.0.0")!;
    expect(withdraw.allowedTargets.map((a) => a.toLowerCase())).toEqual([POOL.toLowerCase()]);
  });

  it("a withdraw action step forged to target an alternate address is rejected by Layer B", () => {
    const withdraw = registry.getAction("aave-v3-monad", "withdraw", "1.0.0")!;
    const proto = registry.getProtocol("aave-v3-monad")!;
    const forged = [{ kind: "action" as const, label: "forged", tx: { to: ATTACKER as `0x${string}`, data: "0x12345678" as `0x${string}`, value: "0" } }];
    const result = validate.validateSteps(forged, withdraw, proto);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("TARGET_NOT_ALLOWLISTED");
  });
});

/* ── H. supply approval spender remains pinned ────────────────────────── */
describe("H. supply approval spender remains pinned", () => {
  beforeEach(() => registry.registerProtocol(aave.createAaveV3MonadProtocol()!));

  it("build()'s approval step declares spender = POOL, and passes Layer B", async () => {
    const supply = registry.getAction("aave-v3-monad", "supply", "1.0.0")!;
    const proto = registry.getProtocol("aave-v3-monad")!;
    const steps = await supply.build({ asset: ASSET, amount: "100", onBehalfOf: USER_ADDR }, { summary: "", details: {}, quotedAt: Date.now() });
    const approveStep = steps.find((s) => s.kind === "approve")!;
    expect(approveStep.approval!.spender.toLowerCase()).toBe(POOL.toLowerCase());
    expect(validate.validateSteps(steps, supply, proto).ok).toBe(true);
  });
});

/* ── I. withdraw has no approval step ─────────────────────────────────── */
describe("I. withdraw has no approval step", () => {
  beforeEach(() => registry.registerProtocol(aave.createAaveV3MonadProtocol()!));

  it("withdraw.build() returns exactly one step, never kind='approve'", async () => {
    const withdraw = registry.getAction("aave-v3-monad", "withdraw", "1.0.0")!;
    const steps = await withdraw.build({ asset: ASSET, amount: "100", to: USER_ADDR }, { summary: "", details: {}, quotedAt: Date.now() });
    expect(steps).toHaveLength(1);
    expect(steps.every((s) => s.kind !== "approve")).toBe(true);
  });
});

/* ── J. supply reserve validation remains fail-closed ─────────────────── */
describe("J. supply reserve validation remains fail-closed", () => {
  beforeEach(() => registry.registerProtocol(aave.createAaveV3MonadProtocol()!));

  it("an unlisted asset is rejected", async () => {
    const supply = registry.getAction("aave-v3-monad", "supply", "1.0.0")!;
    await expect(supply.quote({ asset: NOT_LISTED_ASSET, amount: "100", onBehalfOf: USER_ADDR })).rejects.toThrow(/not a reserve Aave V3 lists/);
  });

  it("a reserve-list RPC failure is rejected, never assumed safe", async () => {
    readContractMock.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === "getAllReservesTokens") throw new Error("RPC down");
      throw new Error("unexpected call");
    });
    aave.__resetReservesCacheForTests();
    const supply = registry.getAction("aave-v3-monad", "supply", "1.0.0")!;
    await expect(supply.quote({ asset: ASSET, amount: "100", onBehalfOf: USER_ADDR })).rejects.toThrow(/not a reserve Aave V3 lists/);
  });
});

/* ── K. withdraw reserve validation remains fail-closed ───────────────── */
describe("K. withdraw reserve validation remains fail-closed", () => {
  beforeEach(() => registry.registerProtocol(aave.createAaveV3MonadProtocol()!));

  it("an unlisted asset is rejected", async () => {
    const withdraw = registry.getAction("aave-v3-monad", "withdraw", "1.0.0")!;
    await expect(withdraw.quote({ asset: NOT_LISTED_ASSET, amount: "100", to: USER_ADDR })).rejects.toThrow(/not a reserve Aave V3 lists/);
  });

  it("a reserve-list RPC failure is rejected, never assumed safe", async () => {
    readContractMock.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === "getAllReservesTokens") throw new Error("RPC down");
      throw new Error("unexpected call");
    });
    aave.__resetReservesCacheForTests();
    const withdraw = registry.getAction("aave-v3-monad", "withdraw", "1.0.0")!;
    await expect(withdraw.quote({ asset: ASSET, amount: "100", to: USER_ADDR })).rejects.toThrow(/not a reserve Aave V3 lists/);
  });
});

/* ── L. supply receipt parsing remains canonical-event-only ──────────── */
describe("L. supply receipt parsing remains canonical-event-only", () => {
  beforeEach(() => registry.registerProtocol(aave.createAaveV3MonadProtocol()!));
  const SUPPLY_TOPIC = toEventSelector("Supply(address,address,address,uint256,uint16)");

  it("a Supply event from a non-Pool address is ignored", async () => {
    const supply = registry.getAction("aave-v3-monad", "supply", "1.0.0")!;
    const log = {
      address: ATTACKER as `0x${string}`,
      topics: [SUPPLY_TOPIC, pad(ASSET as `0x${string}`, { size: 32 }), pad(USER_ADDR as `0x${string}`, { size: 32 }), pad("0x0" as `0x${string}`, { size: 32 })] as [`0x${string}`, ...`0x${string}`[]],
      data: encodeAbiParameters([{ name: "user", type: "address" }, { name: "amount", type: "uint256" }], [USER_ADDR as `0x${string}`, parseUnits("100", 6)]),
    };
    const parsed = await supply.parseResult({ status: "success", txHash: "0xabc" as `0x${string}`, logs: [log] });
    expect(parsed).toEqual({ status: "success" });
  });

  it("a real Supply event from the canonical Pool decodes correctly through the consolidated registration", async () => {
    const supply = registry.getAction("aave-v3-monad", "supply", "1.0.0")!;
    const log = {
      address: POOL as `0x${string}`,
      topics: [SUPPLY_TOPIC, pad(ASSET as `0x${string}`, { size: 32 }), pad(USER_ADDR as `0x${string}`, { size: 32 }), pad("0x0" as `0x${string}`, { size: 32 })] as [`0x${string}`, ...`0x${string}`[]],
      data: encodeAbiParameters([{ name: "user", type: "address" }, { name: "amount", type: "uint256" }], [USER_ADDR as `0x${string}`, parseUnits("100", 6)]),
    };
    const parsed = await supply.parseResult({ status: "success", txHash: "0xabc" as `0x${string}`, logs: [log] });
    expect(parsed.reserve.toLowerCase()).toBe(ASSET.toLowerCase());
    expect(parsed.amount).toBe(parseUnits("100", 6).toString());
  });
});

/* ── M. withdraw receipt parsing remains canonical-event-only ─────────── */
describe("M. withdraw receipt parsing remains canonical-event-only", () => {
  beforeEach(() => registry.registerProtocol(aave.createAaveV3MonadProtocol()!));
  const WITHDRAW_TOPIC = toEventSelector("Withdraw(address,address,address,uint256)");

  it("a Withdraw event from a non-Pool address is ignored", async () => {
    const withdraw = registry.getAction("aave-v3-monad", "withdraw", "1.0.0")!;
    const log = {
      address: ATTACKER as `0x${string}`,
      topics: [WITHDRAW_TOPIC, pad(ASSET as `0x${string}`, { size: 32 }), pad(USER_ADDR as `0x${string}`, { size: 32 }), pad(USER_ADDR as `0x${string}`, { size: 32 })] as [`0x${string}`, ...`0x${string}`[]],
      data: encodeAbiParameters([{ name: "amount", type: "uint256" }], [parseUnits("100", 6)]),
    };
    const parsed = await withdraw.parseResult({ status: "success", txHash: "0xabc" as `0x${string}`, logs: [log] });
    expect(parsed).toEqual({ status: "success" });
  });

  it("a real Withdraw event from the canonical Pool decodes correctly, reporting the ACTUAL event amount", async () => {
    const withdraw = registry.getAction("aave-v3-monad", "withdraw", "1.0.0")!;
    const actual = parseUnits("83.5", 6);
    const log = {
      address: POOL as `0x${string}`,
      topics: [WITHDRAW_TOPIC, pad(ASSET as `0x${string}`, { size: 32 }), pad(USER_ADDR as `0x${string}`, { size: 32 }), pad(USER_ADDR as `0x${string}`, { size: 32 })] as [`0x${string}`, ...`0x${string}`[]],
      data: encodeAbiParameters([{ name: "amount", type: "uint256" }], [actual]),
    };
    const parsed = await withdraw.parseResult({ status: "success", txHash: "0xabc" as `0x${string}`, logs: [log] });
    expect(parsed.reserve.toLowerCase()).toBe(ASSET.toLowerCase());
    expect(parsed.amount).toBe(actual.toString());
    expect(parsed.amount).not.toBe(parseUnits("100", 6).toString()); // never coerced to a requested amount
  });
});

/* ── N. WMON, split-settlement, and other SDK behavior stay unchanged ── */
describe("N. existing WMON, SplitSettlement, and other SDK behavior remains unchanged when Aave is consolidated alongside them", () => {
  it("registering WMON, split-settlement, and the consolidated Aave adapter together in one registry all succeed with no collision", () => {
    registry.registerProtocol(wmon.createWmonProtocol()!);
    registry.registerProtocol(split.createSplitSettlementProtocol()!);
    expect(() => registry.registerProtocol(aave.createAaveV3MonadProtocol()!)).not.toThrow();

    expect(registry.getAction("wmon", "wrap", "1.0.0")).not.toBeNull();
    expect(registry.getAction("wmon", "unwrap", "1.0.0")).not.toBeNull();
    expect(registry.getAction("payai-settlement", "split_payment", "1.0.0")).not.toBeNull();
    expect(registry.getAction("aave-v3-monad", "supply", "1.0.0")).not.toBeNull();
    expect(registry.getAction("aave-v3-monad", "withdraw", "1.0.0")).not.toBeNull();
  });

  it("WMON's own wrap build() still targets only WMON, unaffected by Aave's registration", async () => {
    registry.registerProtocol(wmon.createWmonProtocol()!);
    registry.registerProtocol(aave.createAaveV3MonadProtocol()!);
    const wrap = registry.getAction("wmon", "wrap", "1.0.0")!;
    const steps = await wrap.build({ amount: "1" }, { summary: "", details: {}, quotedAt: Date.now() });
    expect(steps[0].tx.to.toLowerCase()).toBe(WMON.toLowerCase());
  });

  it("split-settlement's own allowedTargets still resolve only to its own canonical contract, unaffected by Aave's registration", () => {
    registry.registerProtocol(split.createSplitSettlementProtocol()!);
    registry.registerProtocol(aave.createAaveV3MonadProtocol()!);
    const splitProto = registry.getProtocol("payai-settlement")!;
    expect(splitProto.allowedTargets.map((a) => a.toLowerCase())).toEqual([SPLIT.toLowerCase()]);
  });

  it("listActionsForChain(143) includes WMON, split, and BOTH Aave actions, with no cross-contamination of allowedTargets", () => {
    registry.registerProtocol(wmon.createWmonProtocol()!);
    registry.registerProtocol(split.createSplitSettlementProtocol()!);
    registry.registerProtocol(aave.createAaveV3MonadProtocol()!);
    const actions = registry.listActionsForChain(MONAD);
    const byId = new Map(actions.map((a) => [`${a.protocolId}/${a.actionId}`, a]));
    expect(byId.get("wmon/wrap")!.allowedTargets.map((a) => a.toLowerCase())).toEqual([WMON.toLowerCase()]);
    expect(byId.get("aave-v3-monad/supply")!.allowedTargets.map((a) => a.toLowerCase())).toEqual([POOL.toLowerCase()]);
    expect(byId.get("aave-v3-monad/withdraw")!.allowedTargets.map((a) => a.toLowerCase())).toEqual([POOL.toLowerCase()]);
  });
});

/* ── Extra: referralCode / no-arbitrary-calldata / quote-isolation still hold through the consolidated path ── */
describe("consolidated-path spot checks of already-reviewed invariants", () => {
  beforeEach(() => registry.registerProtocol(aave.createAaveV3MonadProtocol()!));

  it("supply's referralCode is still hardcoded to 0 when built via the consolidated registration", async () => {
    const SUPPLY_ABI = [{
      type: "function", name: "supply", stateMutability: "nonpayable",
      inputs: [{ name: "asset", type: "address" }, { name: "amount", type: "uint256" }, { name: "onBehalfOf", type: "address" }, { name: "referralCode", type: "uint16" }],
      outputs: [],
    }] as const;
    const supply = registry.getAction("aave-v3-monad", "supply", "1.0.0")!;
    const steps = await supply.build({ asset: ASSET, amount: "100", onBehalfOf: USER_ADDR }, { summary: "", details: {}, quotedAt: Date.now() });
    const actionStep = steps.find((s) => s.kind === "action")!;
    const decoded = decodeFunctionData({ abi: SUPPLY_ABI, data: actionStep.tx.data });
    expect(decoded.args[3]).toBe(0);
  });

  it("neither action's inputSchema exposes target/calldata/spender", () => {
    const supply = registry.getAction("aave-v3-monad", "supply", "1.0.0")!;
    const withdraw = registry.getAction("aave-v3-monad", "withdraw", "1.0.0")!;
    for (const action of [supply, withdraw]) {
      for (const forbidden of ["target", "calldata", "spender", "selector"]) {
        expect(Object.keys(action.inputSchema)).not.toContain(forbidden);
      }
    }
  });

  it("quote details cannot influence either action's build() output target/amount/asset", async () => {
    const supply = registry.getAction("aave-v3-monad", "supply", "1.0.0")!;
    const withdraw = registry.getAction("aave-v3-monad", "withdraw", "1.0.0")!;
    const tampered = { summary: "x", details: { asset: ATTACKER, amount: "999999", spender: ATTACKER }, quotedAt: Date.now() };

    const supplySteps = await supply.build({ asset: ASSET, amount: "100", onBehalfOf: USER_ADDR }, tampered);
    expect(supplySteps.find((s) => s.kind === "action")!.tx.to.toLowerCase()).toBe(POOL.toLowerCase());
    expect(supplySteps.find((s) => s.kind === "approve")!.approval!.amount).toBe(parseUnits("100", 6).toString());

    const withdrawSteps = await withdraw.build({ asset: ASSET, amount: "100", to: USER_ADDR }, tampered);
    expect(withdrawSteps[0].tx.to.toLowerCase()).toBe(POOL.toLowerCase());
  });
});
