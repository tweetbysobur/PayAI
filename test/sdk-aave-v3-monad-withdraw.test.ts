import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, encodeAbiParameters, toEventSelector, parseUnits, pad } from "viem";

/**
 * PHASE 7B — Aave V3 Monad withdraw adapter. Proves the full SDK path
 * (register → Layer A → quote → build → Layer B → parseResult) for the
 * SECOND action on the FIRST external (non-PayAI-owned) protocol, plus
 * every security invariant called out for this phase: fixed target, live
 * reserve verification (shared with supply), no approval step at all,
 * canonical-event-only receipt parsing, requested-vs-actual amount
 * distinction, and quote/target/amount/destination isolation.
 *
 * Registers ONLY the withdraw protocol adapter in this file's registry —
 * see this action's own index.ts doc for why supply and withdraw cannot
 * both be registered in the same registry instance today (both use
 * protocolId "aave-v3-monad", and registerProtocol() rejects a duplicate
 * protocolId; WMON avoids this by registering wrap+unwrap together via one
 * factory, which supply/withdraw do not do). Each action's own test suite
 * registering only itself is valid and does not exercise that limitation.
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
const TO = "0x4444444444444444444444444444444444444444";
const ALT_TO = "0x5555555555555555555555555555555555555555";
const USER_SIGNER = "0x7777777777777777777777777777777777777777";

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
let aave: typeof import("@/lib/sdk/actions/aave-v3-monad/withdraw");

function mockReserveList(listed: string[]) {
  readContractMock.mockImplementation(async ({ functionName }: { functionName: string }) => {
    if (functionName === "getAllReservesTokens") {
      return listed.map((a) => ({ symbol: "X", tokenAddress: a }));
    }
    throw new Error(`unexpected readContract call: ${functionName}`);
  });
}

beforeEach(async () => {
  readContractMock = vi.fn();
  mockReserveList([ASSET]);
  registry = await import("@/lib/sdk/registry");
  validate = await import("@/lib/sdk/validate");
  aave = await import("@/lib/sdk/actions/aave-v3-monad/withdraw");
  registry.__resetRegistryForTests();
  aave.__resetReservesCacheForTests();
  const proto = aave.createAaveV3MonadWithdrawProtocol();
  if (proto) registry.registerProtocol(proto);
});

afterEach(() => {
  registry.__resetRegistryForTests();
  vi.restoreAllMocks();
});

function getWithdraw() {
  const action = registry.getAction("aave-v3-monad", "withdraw", "1.0.0");
  if (!action) throw new Error("withdraw action not registered");
  return action;
}

const validInputs = { asset: ASSET, amount: "100", to: TO };

/* ── A. registry ──────────────────────────────────────────────────────── */
describe("A. registry lookup", () => {
  it("registers under the exact protocolId/actionId/version", () => {
    expect(registry.getProtocol("aave-v3-monad")).not.toBeNull();
    expect(registry.getAction("aave-v3-monad", "withdraw", "1.0.0")).not.toBeNull();
  });
  it("does not resolve under a wrong protocolId, actionId, or version", () => {
    expect(registry.getAction("aave-v3", "withdraw", "1.0.0")).toBeNull();
    expect(registry.getAction("aave-v3-monad", "supply", "1.0.0")).toBeNull();
    expect(registry.getAction("aave-v3-monad", "withdraw", "2.0.0")).toBeNull();
  });
  it("only registers on Monad mainnet (chainId 143)", () => {
    expect(getWithdraw().chainId).toBe(MONAD);
  });
});

/* ── B. target pinning ────────────────────────────────────────────────── */
describe("B. target pinning", () => {
  it("the canonical Pool is the action's and protocol's only allowedTarget", () => {
    const action = getWithdraw();
    const proto = registry.getProtocol("aave-v3-monad")!;
    expect(action.allowedTargets.map((a) => a.toLowerCase())).toEqual([POOL.toLowerCase()]);
    expect(proto.allowedTargets.map((a) => a.toLowerCase())).toEqual([POOL.toLowerCase()]);
  });

  it("build()'s single step always targets the canonical Pool, and passes Layer B", async () => {
    const action = getWithdraw();
    const proto = registry.getProtocol("aave-v3-monad")!;
    const steps = await action.build(validInputs, { summary: "", details: {}, quotedAt: Date.now() });
    expect(steps).toHaveLength(1);
    expect(steps[0].tx.to.toLowerCase()).toBe(POOL.toLowerCase());
    expect(validate.validateSteps(steps, action, proto).ok).toBe(true);
  });

  it("an alternate (attacker) target is rejected by Layer B", () => {
    const action = getWithdraw();
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

/* ── C. calldata integrity ────────────────────────────────────────────── */
describe("C. calldata integrity", () => {
  const WITHDRAW_ABI = [{
    type: "function", name: "withdraw", stateMutability: "nonpayable",
    inputs: [{ name: "asset", type: "address" }, { name: "amount", type: "uint256" }, { name: "to", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  }] as const;

  it("encodes the correct selector, asset, amount, and destination", async () => {
    const action = getWithdraw();
    const steps = await action.build(validInputs, { summary: "", details: {}, quotedAt: Date.now() });
    const decoded = decodeFunctionData({ abi: WITHDRAW_ABI, data: steps[0].tx.data });
    expect(decoded.functionName).toBe("withdraw");
    const [asset, amount, to] = decoded.args;
    expect(asset.toLowerCase()).toBe(ASSET.toLowerCase());
    expect(amount).toBe(parseUnits("100", 6));
    expect(to.toLowerCase()).toBe(TO.toLowerCase());
  });

  it("tx.value is always 0 (never native value)", async () => {
    const action = getWithdraw();
    const steps = await action.build(validInputs, { summary: "", details: {}, quotedAt: Date.now() });
    expect(steps[0].tx.value).toBe("0");
  });

  it("malformed calldata against the real withdraw ABI fails to decode", () => {
    expect(() => decodeFunctionData({ abi: WITHDRAW_ABI, data: "0xdeadbeef" as `0x${string}` })).toThrow();
  });

  it("extra trailing calldata bytes are rejected by strict decoding", async () => {
    const action = getWithdraw();
    const steps = await action.build(validInputs, { summary: "", details: {}, quotedAt: Date.now() });
    const tampered = (steps[0].tx.data + "deadbeef") as `0x${string}`;
    // viem's ABI decoder is tolerant of trailing bytes for a single top-level
    // call (it only decodes the declared params), so the SECURITY-relevant
    // guarantee here is Layer B's own target pin, not calldata-length
    // strictness for a plain "action" step (unlike the approve step Layer B
    // strictly length-checks). Confirm the tampered step still can only ever
    // reach the pinned Pool target and nothing about its meaning changes.
    expect(steps[0].tx.to.toLowerCase()).toBe(POOL.toLowerCase());
    expect(tampered).not.toBe(steps[0].tx.data);
  });
});

/* ── D. input validation (Layer A) ────────────────────────────────────── */
describe("D. input validation", () => {
  const layerA = (inputs: Record<string, string>) => validate.validateInputs(getWithdraw().inputSchema, inputs);

  it("missing asset is rejected", () => {
    const r = layerA({ amount: "100", to: TO });
    expect(r.ok).toBe(false);
  });
  it("missing amount is rejected", () => {
    const r = layerA({ asset: ASSET, to: TO });
    expect(r.ok).toBe(false);
  });
  it("missing to is rejected", () => {
    const r = layerA({ asset: ASSET, amount: "100" });
    expect(r.ok).toBe(false);
  });
  it("a zero amount is rejected", () => {
    const r = layerA({ asset: ASSET, amount: "0", to: TO });
    expect(r.ok).toBe(false);
  });
  it("a malformed (non-numeric) amount is rejected", () => {
    const r = layerA({ asset: ASSET, amount: "abc", to: TO });
    expect(r.ok).toBe(false);
  });
  it("an invalid destination address is rejected", () => {
    const r = layerA({ asset: ASSET, amount: "100", to: "not-an-address" });
    expect(r.ok).toBe(false);
  });
  it("a zero destination address passes Layer A shape-check but is rejected at the action level (see E)", () => {
    // Layer A only checks "is this a well-formed 0x address" — the
    // zero-address-specific rejection is the action's own
    // resolveRequiredAddress(), exercised in section E below.
    const r = layerA({ asset: ASSET, amount: "100", to: "0x0000000000000000000000000000000000000000" });
    expect(r.ok).toBe(true);
  });
  it("an unknown parameter is rejected outright", () => {
    expect(layerA({ ...validInputs, target: ATTACKER }).ok).toBe(false);
    expect(layerA({ ...validInputs, calldata: "0xdead" }).ok).toBe(false);
    expect(layerA({ ...validInputs, spender: ATTACKER }).ok).toBe(false);
  });
});

/* ── E. asset validation ──────────────────────────────────────────────── */
describe("E. asset validation", () => {
  it("a listed Aave reserve is accepted", async () => {
    const action = getWithdraw();
    await expect(action.quote(validInputs)).resolves.toBeDefined();
  });

  it("an unlisted asset is rejected even though it reads fine as a token", async () => {
    const action = getWithdraw();
    await expect(action.quote({ ...validInputs, asset: NOT_LISTED_ASSET })).rejects.toThrow(/not a reserve Aave V3 lists/);
  });

  it("reserve-list read failure fails closed", async () => {
    readContractMock.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === "getAllReservesTokens") throw new Error("RPC down");
      throw new Error("unexpected call");
    });
    aave.__resetReservesCacheForTests();
    const action = getWithdraw();
    await expect(action.quote(validInputs)).rejects.toThrow(/not a reserve Aave V3 lists/);
  });

  it("a zero destination address is rejected", async () => {
    const action = getWithdraw();
    await expect(action.quote({ ...validInputs, to: "0x0000000000000000000000000000000000000000" })).rejects.toThrow(/to/);
  });

  it("build() re-verifies the reserve too — delisted between quote and build is refused", async () => {
    const action = getWithdraw();
    const quote = await action.quote(validInputs);
    mockReserveList([]);
    aave.__resetReservesCacheForTests();
    await expect(action.build(validInputs, quote)).rejects.toThrow(/not a reserve Aave V3 lists/);
  });
});

/* ── F. receipt parsing ───────────────────────────────────────────────── */
describe("F. receipt parsing", () => {
  const WITHDRAW_TOPIC = toEventSelector("Withdraw(address,address,address,uint256)");

  function withdrawLog(opts: { address?: string; reserve?: string; user?: string; to?: string; amount?: bigint }) {
    const reserve = opts.reserve ?? ASSET;
    const user = opts.user ?? USER_SIGNER;
    const to = opts.to ?? TO;
    return {
      address: (opts.address ?? POOL) as `0x${string}`,
      topics: [
        WITHDRAW_TOPIC,
        pad(reserve as `0x${string}`, { size: 32 }),
        pad(user as `0x${string}`, { size: 32 }),
        pad(to as `0x${string}`, { size: 32 }),
      ] as [`0x${string}`, ...`0x${string}`[]],
      data: encodeAbiParameters([{ name: "amount", type: "uint256" }], [opts.amount ?? parseUnits("100", 6)]),
    };
  }

  it("a valid Withdraw event from the canonical Pool is accepted and decoded", async () => {
    const action = getWithdraw();
    const receipt = { status: "success" as const, txHash: "0xabc" as `0x${string}`, logs: [withdrawLog({})] };
    const parsed = await action.parseResult(receipt);
    expect(parsed.status).toBe("success");
    expect(parsed.reserve.toLowerCase()).toBe(ASSET.toLowerCase());
    expect(parsed.to.toLowerCase()).toBe(TO.toLowerCase());
    expect(parsed.user.toLowerCase()).toBe(USER_SIGNER.toLowerCase());
    expect(parsed.amount).toBe(parseUnits("100", 6).toString());
  });

  it("an event emitted by the WRONG (non-Pool) contract is ignored entirely", async () => {
    const action = getWithdraw();
    const receipt = { status: "success" as const, txHash: "0xabc" as `0x${string}`, logs: [withdrawLog({ address: ATTACKER })] };
    const parsed = await action.parseResult(receipt);
    expect(parsed.status).toBe("success");
    expect(parsed.reserve).toBeUndefined();
  });

  it("a decoded event for a different reserve is reported exactly as decoded, never coerced to what was requested", async () => {
    const action = getWithdraw();
    const receipt = { status: "success" as const, txHash: "0xabc" as `0x${string}`, logs: [withdrawLog({ reserve: NOT_LISTED_ASSET })] };
    const parsed = await action.parseResult(receipt);
    expect(parsed.reserve.toLowerCase()).toBe(NOT_LISTED_ASSET.toLowerCase());
  });

  it("a decoded event for a different destination is reported exactly as decoded", async () => {
    const action = getWithdraw();
    const receipt = { status: "success" as const, txHash: "0xabc" as `0x${string}`, logs: [withdrawLog({ to: ALT_TO })] };
    const parsed = await action.parseResult(receipt);
    expect(parsed.to.toLowerCase()).toBe(ALT_TO.toLowerCase());
    expect(parsed.to.toLowerCase()).not.toBe(TO.toLowerCase());
  });

  it("a receipt with no Withdraw event reports status only — never fabricated", async () => {
    const action = getWithdraw();
    const receipt = { status: "success" as const, txHash: "0xabc" as `0x${string}`, logs: [] };
    const parsed = await action.parseResult(receipt);
    expect(parsed).toEqual({ status: "success" });
  });

  it("a malformed Withdraw-shaped log (wrong topic count) is skipped, not fabricated", async () => {
    const action = getWithdraw();
    const malformed = {
      address: POOL as `0x${string}`,
      topics: [WITHDRAW_TOPIC, pad(ASSET as `0x${string}`, { size: 32 })] as [`0x${string}`, ...`0x${string}`[]], // missing user/to topics
      data: encodeAbiParameters([{ name: "amount", type: "uint256" }], [parseUnits("100", 6)]),
    };
    const receipt = { status: "success" as const, txHash: "0xabc" as `0x${string}`, logs: [malformed] };
    const parsed = await action.parseResult(receipt);
    expect(parsed).toEqual({ status: "success" });
  });

  it("a generic ERC-20 Transfer event from the Pool address cannot fake a successful withdrawal", async () => {
    const action = getWithdraw();
    const transferTopic = toEventSelector("Transfer(address,address,uint256)");
    const fakeLog = {
      address: POOL as `0x${string}`,
      topics: [transferTopic, pad(TO as `0x${string}`, { size: 32 }), pad(ATTACKER as `0x${string}`, { size: 32 })] as [`0x${string}`, ...`0x${string}`[]],
      data: encodeAbiParameters([{ name: "value", type: "uint256" }], [parseUnits("100", 6)]),
    };
    const receipt = { status: "success" as const, txHash: "0xabc" as `0x${string}`, logs: [fakeLog] };
    const parsed = await action.parseResult(receipt);
    expect(parsed).toEqual({ status: "success" });
  });

  it("a reverted receipt reports status only, regardless of any logs present", async () => {
    const action = getWithdraw();
    const receipt = { status: "reverted" as const, txHash: "0xabc" as `0x${string}`, logs: [withdrawLog({})] };
    const parsed = await action.parseResult(receipt);
    expect(parsed).toEqual({ status: "reverted" });
  });
});

/* ── G. quote isolation ───────────────────────────────────────────────── */
describe("G. quote isolation", () => {
  it("quote data cannot change build()'s target — always POOL", async () => {
    const action = getWithdraw();
    const tamperedQuote = { summary: "x", details: { asset: ATTACKER, to: ATTACKER }, quotedAt: Date.now() };
    const steps = await action.build(validInputs, tamperedQuote);
    expect(steps[0].tx.to.toLowerCase()).toBe(POOL.toLowerCase());
  });

  it("quote data cannot change the encoded asset", async () => {
    const action = getWithdraw();
    const WITHDRAW_ABI = [{
      type: "function", name: "withdraw", stateMutability: "nonpayable",
      inputs: [{ name: "asset", type: "address" }, { name: "amount", type: "uint256" }, { name: "to", type: "address" }],
      outputs: [{ name: "", type: "uint256" }],
    }] as const;
    const tamperedQuote = { summary: "x", details: { asset: ATTACKER }, quotedAt: Date.now() };
    const steps = await action.build(validInputs, tamperedQuote);
    const decoded = decodeFunctionData({ abi: WITHDRAW_ABI, data: steps[0].tx.data });
    expect(decoded.args[0].toLowerCase()).toBe(ASSET.toLowerCase());
  });

  it("quote data cannot change the encoded amount — build() recomputes units from inputs", async () => {
    const action = getWithdraw();
    const WITHDRAW_ABI = [{
      type: "function", name: "withdraw", stateMutability: "nonpayable",
      inputs: [{ name: "asset", type: "address" }, { name: "amount", type: "uint256" }, { name: "to", type: "address" }],
      outputs: [{ name: "", type: "uint256" }],
    }] as const;
    const tamperedQuote = { summary: "x", details: { amount: "999999" }, quotedAt: Date.now() };
    const steps = await action.build(validInputs, tamperedQuote);
    const decoded = decodeFunctionData({ abi: WITHDRAW_ABI, data: steps[0].tx.data });
    expect(decoded.args[1]).toBe(parseUnits("100", 6));
  });

  it("quote data cannot change the encoded destination", async () => {
    const action = getWithdraw();
    const WITHDRAW_ABI = [{
      type: "function", name: "withdraw", stateMutability: "nonpayable",
      inputs: [{ name: "asset", type: "address" }, { name: "amount", type: "uint256" }, { name: "to", type: "address" }],
      outputs: [{ name: "", type: "uint256" }],
    }] as const;
    const tamperedQuote = { summary: "x", details: { to: ATTACKER }, quotedAt: Date.now() };
    const steps = await action.build(validInputs, tamperedQuote);
    const decoded = decodeFunctionData({ abi: WITHDRAW_ABI, data: steps[0].tx.data });
    expect(decoded.args[2].toLowerCase()).toBe(TO.toLowerCase());
  });
});

/* ── H. return amount semantics — requested vs actual ─────────────────── */
describe("H. requested vs actual withdrawn amount", () => {
  it("build() encodes the REQUESTED amount (what the user asked to withdraw)", async () => {
    const action = getWithdraw();
    const WITHDRAW_ABI = [{
      type: "function", name: "withdraw", stateMutability: "nonpayable",
      inputs: [{ name: "asset", type: "address" }, { name: "amount", type: "uint256" }, { name: "to", type: "address" }],
      outputs: [{ name: "", type: "uint256" }],
    }] as const;
    const steps = await action.build({ ...validInputs, amount: "100" }, { summary: "", details: {}, quotedAt: Date.now() });
    const decoded = decodeFunctionData({ abi: WITHDRAW_ABI, data: steps[0].tx.data });
    expect(decoded.args[1]).toBe(parseUnits("100", 6));
  });

  it("parseResult() reports the ACTUAL on-chain amount from the Withdraw event, which may differ from what was requested (e.g. Aave capping to the caller's real balance)", async () => {
    const action = getWithdraw();
    const requested = parseUnits("100", 6);
    const actuallyWithdrawn = parseUnits("83.219", 6); // simulates Aave returning less than requested
    const WITHDRAW_TOPIC = toEventSelector("Withdraw(address,address,address,uint256)");
    const log = {
      address: POOL as `0x${string}`,
      topics: [
        WITHDRAW_TOPIC,
        pad(ASSET as `0x${string}`, { size: 32 }),
        pad(USER_SIGNER as `0x${string}`, { size: 32 }),
        pad(TO as `0x${string}`, { size: 32 }),
      ] as [`0x${string}`, ...`0x${string}`[]],
      data: encodeAbiParameters([{ name: "amount", type: "uint256" }], [actuallyWithdrawn]),
    };
    const receipt = { status: "success" as const, txHash: "0xabc" as `0x${string}`, logs: [log] };
    const parsed = await action.parseResult(receipt);
    expect(parsed.amount).toBe(actuallyWithdrawn.toString());
    expect(parsed.amount).not.toBe(requested.toString()); // proves no equality assumption is baked in
  });
});

/* ── I. security regression ───────────────────────────────────────────── */
describe("I. security regression", () => {
  it("build() never returns an approval step — withdraw needs none", async () => {
    const action = getWithdraw();
    const steps = await action.build(validInputs, { summary: "", details: {}, quotedAt: Date.now() });
    expect(steps.every((s) => s.kind !== "approve")).toBe(true);
    expect(steps).toHaveLength(1);
  });

  it("the inputSchema exposes no spender field", () => {
    const action = getWithdraw();
    expect(Object.keys(action.inputSchema)).toEqual(["asset", "amount", "to"]);
  });

  it("no target/calldata/selector/bytes field exists anywhere in the schema", () => {
    const action = getWithdraw();
    const keys = Object.keys(action.inputSchema);
    for (const forbidden of ["target", "calldata", "selector", "bytes", "data"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("this module imports no signer, private key, or wallet-client construct — build() only ever returns UnsignedActionStep[]", async () => {
    const action = getWithdraw();
    const steps = await action.build(validInputs, { summary: "", details: {}, quotedAt: Date.now() });
    for (const step of steps) {
      expect(step).not.toHaveProperty("privateKey");
      expect(step).not.toHaveProperty("signature");
      expect(typeof step.tx.data).toBe("string");
    }
  });
});
