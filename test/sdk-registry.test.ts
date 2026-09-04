import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Action, ActionReceipt, ProtocolAdapter, UnsignedActionStep } from "@/lib/sdk/types";
import {
  __resetRegistryForTests, getAction, getProtocol, hasAction, listActions,
  listActionsForChain, listActionVersions, registerProtocol, SdkRegistryError,
} from "@/lib/sdk/registry";

/**
 * The registry's job in Stage 1 is narrow: store PayAI-authored action
 * modules and hand them back by exact identity, while refusing at
 * registration time any declaration that would be unsafe to admit at all —
 * an empty/malformed allowlist, a version that isn't semver, an action that
 * tries to reach outside its own protocol's allowlist, a duplicate. These
 * tests cover that boundary; the deeper allowlist-enforcement-at-execution
 * lives in sdk-validate.test.ts.
 */

const MONAD = 143;
const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const OUTSIDE = "0xcccccccccccccccccccccccccccccccccccccccc";

function action(overrides: Partial<Action> = {}): Action {
  return {
    protocolId: "p", actionId: "a", version: "1.0.0", name: "A", description: "d",
    chainId: MONAD, allowedTargets: [A as `0x${string}`],
    inputSchema: {},
    async quote() { return { summary: "", details: {}, quotedAt: Date.now() }; },
    async build() { return [] as UnsignedActionStep[]; },
    async parseResult(_r: ActionReceipt) { return {}; },
    ...overrides,
  };
}

function protocol(overrides: Partial<ProtocolAdapter> = {}): ProtocolAdapter {
  return {
    protocolId: "p", name: "P", chainId: MONAD,
    allowedTargets: [A as `0x${string}`, B as `0x${string}`],
    actions: [action()],
    ...overrides,
  };
}

beforeEach(() => __resetRegistryForTests());
afterEach(() => __resetRegistryForTests());

describe("registerProtocol / lookups", () => {
  it("registers and retrieves a protocol and its action by exact identity", () => {
    registerProtocol(protocol());
    expect(getProtocol("p")?.name).toBe("P");
    expect(getAction("p", "a", "1.0.0")?.name).toBe("A");
    expect(hasAction("p", "a", "1.0.0")).toBe(true);
  });

  it("getAction is EXACT on version — a different version returns null, never the newest", () => {
    registerProtocol(protocol());
    expect(getAction("p", "a", "2.0.0")).toBeNull();
    expect(listActionVersions("p", "a")).toEqual(["1.0.0"]);
  });

  it("lists all actions and actions-for-chain", () => {
    registerProtocol(protocol());
    expect(listActions()).toHaveLength(1);
    expect(listActionsForChain(MONAD)).toHaveLength(1);
    expect(listActionsForChain(999)).toHaveLength(0);
  });

  it("supports two versions of the same action side by side", () => {
    registerProtocol(protocol({ actions: [action({ version: "1.0.0" }), action({ version: "1.1.0" })] }));
    expect(getAction("p", "a", "1.0.0")).not.toBeNull();
    expect(getAction("p", "a", "1.1.0")).not.toBeNull();
    expect(listActionVersions("p", "a").sort()).toEqual(["1.0.0", "1.1.0"]);
  });
});

describe("registerProtocol rejects unsafe declarations at registration", () => {
  it("a duplicate protocolId is rejected", () => {
    registerProtocol(protocol());
    expect(() => registerProtocol(protocol())).toThrow(SdkRegistryError);
  });

  it("an empty protocol allowlist is rejected", () => {
    expect(() => registerProtocol(protocol({ allowedTargets: [] }))).toThrow(SdkRegistryError);
  });

  it("an empty action allowlist is rejected", () => {
    expect(() => registerProtocol(protocol({ actions: [action({ allowedTargets: [] })] }))).toThrow(SdkRegistryError);
  });

  it("a malformed address in an allowlist is rejected", () => {
    expect(() => registerProtocol(protocol({ allowedTargets: ["0xnope" as `0x${string}`] }))).toThrow(SdkRegistryError);
  });

  it("a non-semver version is rejected", () => {
    expect(() => registerProtocol(protocol({ actions: [action({ version: "v1" })] }))).toThrow(SdkRegistryError);
  });

  it("an action whose allowlist escapes its protocol's allowlist is rejected at registration", () => {
    expect(() => registerProtocol(protocol({ actions: [action({ allowedTargets: [OUTSIDE as `0x${string}`] })] }))).toThrow(SdkRegistryError);
  });

  it("an action whose protocolId disagrees with the adapter is rejected", () => {
    expect(() => registerProtocol(protocol({ actions: [action({ protocolId: "other" })] }))).toThrow(SdkRegistryError);
  });

  it("a duplicate (actionId, version) within one protocol is rejected", () => {
    expect(() => registerProtocol(protocol({ actions: [action(), action()] }))).toThrow(SdkRegistryError);
  });
});

describe("allowlists are frozen after registration", () => {
  it("a registered action's allowedTargets cannot be widened in place", () => {
    const p = protocol();
    registerProtocol(p);
    const a = getAction("p", "a", "1.0.0")!;
    expect(Object.isFrozen(a.allowedTargets)).toBe(true);
    expect(() => { (a.allowedTargets as string[]).push(OUTSIDE); }).toThrow();
  });

  it("a registered protocol's allowedTargets cannot be widened in place", () => {
    registerProtocol(protocol());
    const p = getProtocol("p")!;
    expect(Object.isFrozen(p.allowedTargets)).toBe(true);
  });
});
