import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * End-to-end proof of the Phase 1 SDK path against the FIRST real action,
 * WMON wrap/unwrap:
 *   register → validate inputs (Layer A) → quote → build → validate targets
 *   (Layer B) → parse a confirmed receipt.
 *
 * The WMON address and chain id come from the app's own config
 * (getWrappedNative/getChain), mocked here to a fixed mainnet value so the
 * test is deterministic without a live chain — the action code itself is
 * unchanged, exactly what production loads.
 */

const WMON = "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A";
const MONAD = 143;

vi.mock("@/lib/monad/config", () => ({
  getWrappedNative: () => WMON,
  getChain: () => ({ id: MONAD }),
}));

let registry: typeof import("@/lib/sdk/registry");
let validate: typeof import("@/lib/sdk/validate");
let wmon: typeof import("@/lib/sdk/actions/wmon");

beforeEach(async () => {
  registry = await import("@/lib/sdk/registry");
  validate = await import("@/lib/sdk/validate");
  wmon = await import("@/lib/sdk/actions/wmon");
  registry.__resetRegistryForTests();
});
afterEach(() => registry.__resetRegistryForTests());

describe("WMON action — registration + shape", () => {
  it("builds a protocol pinned to the real WMON address and active chain", () => {
    const protocol = wmon.createWmonProtocol()!;
    expect(protocol.allowedTargets).toEqual([WMON]);
    expect(protocol.chainId).toBe(MONAD);
    expect(protocol.actions.map((a) => a.actionId).sort()).toEqual(["unwrap", "wrap"]);
  });

  it("registers cleanly through the real registry (allowlist/semver/scoping all pass)", () => {
    expect(() => registry.registerProtocol(wmon.createWmonProtocol()!)).not.toThrow();
    expect(registry.getAction("wmon", "wrap", "1.0.0")).not.toBeNull();
    expect(registry.getAction("wmon", "unwrap", "1.0.0")).not.toBeNull();
  });
});

describe("WMON wrap — full path", () => {
  beforeEach(() => registry.registerProtocol(wmon.createWmonProtocol()!));

  it("a valid wrap request passes resolution + input validation, quotes 1:1, and builds a single WMON-targeted step that passes Layer B", async () => {
    const request = {
      protocolId: "wmon", actionId: "wrap", version: "1.0.0",
      inputs: { amount: "2.5" }, walletAddress: "0x9999999999999999999999999999999999999999" as `0x${string}`,
      chainId: MONAD, quotedAt: Date.now(),
    };
    const gated = validate.validateForQuote(request, MONAD);
    expect(gated.ok).toBe(true);
    if (!gated.ok) throw new Error(gated.message);

    const quote = await gated.value.action.quote(gated.value.inputs);
    expect(quote.summary).toContain("Wrap 2.5 MON");
    expect(quote.details.rate).toBe("1 MON = 1 WMON");

    const steps = await gated.value.action.build(gated.value.inputs, quote);
    expect(steps).toHaveLength(1);
    expect(steps[0].kind).toBe("action");
    expect(steps[0].tx.to.toLowerCase()).toBe(WMON.toLowerCase());
    // value carries the wrapped amount in wei; no ERC-20 approval step exists.
    expect(steps[0].tx.value).toBe((2_500_000_000_000_000_000n).toString());

    const targetCheck = validate.validateSteps(steps, gated.value.action, gated.value.protocol);
    expect(targetCheck.ok).toBe(true);
  });

  it("unwrap builds a withdraw call with zero native value, still WMON-targeted", async () => {
    const action = registry.getAction("wmon", "unwrap", "1.0.0")!;
    const steps = await action.build({ amount: "1" }, { summary: "", details: {}, quotedAt: Date.now() });
    expect(steps[0].tx.to.toLowerCase()).toBe(WMON.toLowerCase());
    expect(steps[0].tx.value).toBe("0"); // unwrap sends no native value
    const protocol = wmon.createWmonProtocol()!;
    expect(validate.validateSteps(steps, action, protocol).ok).toBe(true);
  });

  it("rejects a wrap with a non-positive amount at Layer A, before any step is built", () => {
    const request = {
      protocolId: "wmon", actionId: "wrap", version: "1.0.0",
      inputs: { amount: "0" }, walletAddress: "0x9999999999999999999999999999999999999999" as `0x${string}`,
      chainId: MONAD, quotedAt: Date.now(),
    };
    const gated = validate.validateForQuote(request, MONAD);
    expect(gated.ok).toBe(false);
    if (!gated.ok) expect(gated.code).toBe("SCHEMA_VALIDATION_FAILED");
  });
});

describe("WMON parseResult — real event decoding", () => {
  it("decodes the wrapped amount from a real Deposit event", async () => {
    const action = registry.getAction("wmon", "wrap", "1.0.0") ?? (registry.registerProtocol(wmon.createWmonProtocol()!), registry.getAction("wmon", "wrap", "1.0.0")!);
    // Deposit(address indexed dst, uint256 wad) topic0 + a 1e18 wad.
    const depositTopic = "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c";
    const receipt = {
      status: "success" as const, txHash: "0xabc" as `0x${string}`,
      logs: [{
        address: WMON as `0x${string}`,
        topics: [depositTopic, "0x0000000000000000000000009999999999999999999999999999999999999999"] as `0x${string}`[],
        data: ("0x" + (10n ** 18n).toString(16).padStart(64, "0")) as `0x${string}`,
      }],
    };
    const parsed = await action.parseResult(receipt);
    expect(parsed.status).toBe("success");
    expect(parsed.wrapped).toBe("1");
  });

  it("a reverted receipt reports status only, never a fabricated amount", async () => {
    registry.registerProtocol(wmon.createWmonProtocol()!);
    const action = registry.getAction("wmon", "wrap", "1.0.0")!;
    const parsed = await action.parseResult({ status: "reverted", txHash: "0xabc" as `0x${string}`, logs: [] });
    expect(parsed.status).toBe("reverted");
    expect(parsed.wrapped).toBeUndefined();
  });
});
