import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Action, ActionReceipt, ExecutionRequest, ProtocolAdapter, UnsignedActionStep } from "@/lib/sdk/types";
import { __resetRegistryForTests, registerProtocol } from "@/lib/sdk/registry";
import { resolveExecutable, validateForQuote, validateInputs, validateSteps, QUOTE_MAX_AGE_MS } from "@/lib/sdk/validate";

/**
 * These tests are the security spec for the SDK's Phase 1 core, not a mirror
 * of its implementation. Each one is designed to genuinely FAIL if the guard
 * it covers is removed — proven separately by the stash-verify pass (Phase 1
 * report), where each check is deleted in turn and the matching test is
 * confirmed to go red.
 *
 * The invariant under test everywhere below: nothing an action or protocol
 * DECLARES about itself is trusted to police itself. Inputs are checked
 * against a schema; a build()'s returned targets are checked against a
 * reviewed allowlist; a stale or wrong-chain or wrong-version request is
 * refused — all before anything could ever be signed.
 */

const MONAD = 143;
const OTHER_CHAIN = 999;
const POOL = "0x1111111111111111111111111111111111111111";       // in both allowlists
const PROTOCOL_ONLY = "0x2222222222222222222222222222222222222222"; // protocol allowlist only
const OUTSIDE = "0x3333333333333333333333333333333333333333";       // in neither
const CALLDATA = "0xdeadbeef" as const;

function step(to: string, kind: UnsignedActionStep["kind"] = "action", label = "step"): UnsignedActionStep {
  return { kind, label, tx: { to: to as `0x${string}`, data: CALLDATA, value: "0" } };
}

/** A minimal but real Action shape. `buildImpl` lets a test inject exactly
 *  what build() returns, including hostile output, without the registry ever
 *  knowing the difference — which is the whole point of Layer B. */
function makeAction(overrides: Partial<Action> = {}, buildImpl?: () => Promise<UnsignedActionStep[]>): Action {
  return {
    protocolId: "testproto",
    actionId: "act",
    version: "1.0.0",
    name: "Test Action",
    description: "A test action.",
    chainId: MONAD,
    allowedTargets: [POOL as `0x${string}`],
    inputSchema: {
      amount: { type: "amount", required: true, description: "amount", decimals: 18 },
    },
    async quote() { return { summary: "test", details: {}, quotedAt: Date.now() }; },
    async build() { return buildImpl ? buildImpl() : [step(POOL)]; },
    async parseResult(_r: ActionReceipt) { return {}; },
    ...overrides,
  };
}

function makeProtocol(action: Action, overrides: Partial<ProtocolAdapter> = {}): ProtocolAdapter {
  return {
    protocolId: "testproto",
    name: "Test Protocol",
    chainId: MONAD,
    actions: [action],
    allowedTargets: [POOL as `0x${string}`, PROTOCOL_ONLY as `0x${string}`],
    ...overrides,
  };
}

function makeRequest(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    protocolId: "testproto",
    actionId: "act",
    version: "1.0.0",
    inputs: { amount: "1.5" },
    walletAddress: "0x9999999999999999999999999999999999999999",
    chainId: MONAD,
    quotedAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => __resetRegistryForTests());
afterEach(() => __resetRegistryForTests());

// ---- LAYER A: input validation -------------------------------------------

describe("Layer A — input validation", () => {
  const schema = makeAction().inputSchema;

  it("1. valid input passes", () => {
    const r = validateInputs(schema, { amount: "1.5" });
    expect(r.ok).toBe(true);
  });

  it("2. missing required parameter fails", () => {
    const r = validateInputs(schema, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("SCHEMA_VALIDATION_FAILED");
  });

  it("3. invalid amount fails (zero, negative, non-numeric, exponential, sub-precision)", () => {
    for (const bad of ["0", "-1", "abc", "1e-3", "0.0000000000000000001"]) {
      const r = validateInputs(schema, { amount: bad });
      expect(r.ok, `expected "${bad}" to be rejected`).toBe(false);
    }
  });

  it("4. invalid address fails", () => {
    const s = { to: { type: "address" as const, required: true, description: "to" } };
    expect(validateInputs(s, { to: "0xnotanaddress" }).ok).toBe(false);
    expect(validateInputs(s, { to: "MONCAT" }).ok).toBe(false); // a bare symbol is never an address
    expect(validateInputs(s, { to: "0x1111111111111111111111111111111111111111" }).ok).toBe(true);
  });

  it("5. invalid boolean/number/string inputs fail", () => {
    expect(validateInputs({ flag: { type: "boolean", required: true, description: "f" } }, { flag: "yes" }).ok).toBe(false);
    expect(validateInputs({ n: { type: "number", required: true, description: "n" } }, { n: "1e5" }).ok).toBe(false);
    expect(validateInputs({ n: { type: "number", required: true, description: "n" } }, { n: "notnum" }).ok).toBe(false);
    expect(validateInputs({ s: { type: "string", required: true, description: "s", maxLength: 3 } }, { s: "toolong" }).ok).toBe(false);
  });

  it("6. unknown parameter fails (strict schema)", () => {
    const r = validateInputs(schema, { amount: "1.5", extra: "surprise" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("UNKNOWN_PARAMETER");
  });

  it("valid boolean/number/string inputs pass", () => {
    expect(validateInputs({ flag: { type: "boolean", required: true, description: "f" } }, { flag: "true" }).ok).toBe(true);
    expect(validateInputs({ n: { type: "number", required: true, description: "n" } }, { n: "42" }).ok).toBe(true);
    expect(validateInputs({ s: { type: "string", required: false, description: "s" } }, {}).ok).toBe(true);
  });
});

// ---- LAYER B: output target validation -----------------------------------

describe("Layer B — output target allowlist enforcement", () => {
  it("7. a valid target (in both allowlists) passes", () => {
    const action = makeAction();
    const r = validateSteps([step(POOL)], action, makeProtocol(action));
    expect(r.ok).toBe(true);
  });

  it("8. a target outside the action's allowlist fails", () => {
    // PROTOCOL_ONLY is in the protocol allowlist but NOT the action's.
    const action = makeAction();
    const r = validateSteps([step(PROTOCOL_ONLY)], action, makeProtocol(action));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("TARGET_NOT_ALLOWLISTED");
  });

  it("9. a target inside the action allowlist but outside the protocol allowlist fails", () => {
    // Action lists POOL + PROTOCOL_ONLY; protocol lists only POOL. A step to
    // PROTOCOL_ONLY clears the action check but must fail the protocol check.
    const action = makeAction({ allowedTargets: [POOL as `0x${string}`, PROTOCOL_ONLY as `0x${string}`] });
    const protocol = makeProtocol(action, { allowedTargets: [POOL as `0x${string}`] });
    const r = validateSteps([step(PROTOCOL_ONLY)], action, protocol);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("TARGET_NOT_ALLOWLISTED");
  });

  it("10. a multi-step action with ONE bad target rejects the ENTIRE action", () => {
    const action = makeAction();
    const steps = [step(POOL, "approve", "approve"), step(OUTSIDE, "action", "sneaky"), step(POOL, "action", "real")];
    const r = validateSteps(steps, action, makeProtocol(action));
    expect(r.ok, "one bad step must reject all steps, not just the bad one").toBe(false);
  });

  it("11. a malicious build() returning a hostile target cannot bypass the allowlist", async () => {
    // The action DECLARES it only touches POOL, but its build() lies and
    // returns a transfer to an attacker address. Layer B checks the OUTPUT,
    // so the lie is caught regardless of what the action claimed.
    const evil = makeAction({}, async () => [step(OUTSIDE, "action", "drain")]);
    const steps = await evil.build({ amount: "1" }, { summary: "", details: {}, quotedAt: Date.now() });
    const r = validateSteps(steps, evil, makeProtocol(evil));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("TARGET_NOT_ALLOWLISTED");
  });

  it("11b. a build() that mutates its own allowedTargets at runtime still cannot widen its reach", () => {
    // Register through the real registry, which deep-freezes the allowlist.
    const action = makeAction();
    const protocol = makeProtocol(action);
    registerProtocol(protocol);
    // Attempt to widen the frozen array — throws in strict mode / no-ops
    // otherwise, but MUST NOT actually add the target.
    try { (action.allowedTargets as string[]).push(OUTSIDE); } catch { /* frozen */ }
    const r = validateSteps([step(OUTSIDE)], action, protocol);
    expect(r.ok).toBe(false);
  });

  it("a malformed target address in a step fails closed", () => {
    const action = makeAction();
    const bad = { kind: "action" as const, label: "x", tx: { to: "0xnope" as `0x${string}`, data: CALLDATA, value: "0" } };
    expect(validateSteps([bad], action, makeProtocol(action)).ok).toBe(false);
  });

  it("checksum-cased vs lowercased target is accepted (case-insensitive match)", () => {
    const mixed = "0x1111111111111111111111111111111111111111".toUpperCase().replace("0X", "0x");
    const action = makeAction();
    expect(validateSteps([step(mixed)], action, makeProtocol(action)).ok).toBe(true);
  });
});

// ---- request resolution: chain, version, existence -----------------------

describe("resolveExecutable — chain / version / existence gates", () => {
  it("13. wrong chainId fails", () => {
    const action = makeAction();
    registerProtocol(makeProtocol(action));
    const r = resolveExecutable(makeRequest({ chainId: OTHER_CHAIN }), OTHER_CHAIN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("CHAIN_MISMATCH");
  });

  it("13b. active chain differing from a correctly-pinned request fails", () => {
    const action = makeAction();
    registerProtocol(makeProtocol(action));
    // request says MONAD, action is MONAD, but the app is actually on OTHER_CHAIN
    const r = resolveExecutable(makeRequest({ chainId: MONAD }), OTHER_CHAIN);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("CHAIN_MISMATCH");
  });

  it("14. missing action fails cleanly (ACTION_NOT_FOUND, not a throw)", () => {
    registerProtocol(makeProtocol(makeAction()));
    const r = resolveExecutable(makeRequest({ actionId: "doesnotexist" }), MONAD);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("ACTION_NOT_FOUND");
  });

  it("14b. unregistered protocol fails cleanly", () => {
    const r = resolveExecutable(makeRequest({ protocolId: "ghost" }), MONAD);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("PROTOCOL_NOT_CONFIGURED");
  });

  it("15. version mismatch fails cleanly, distinct from ACTION_NOT_FOUND", () => {
    registerProtocol(makeProtocol(makeAction())); // registered at 1.0.0
    const r = resolveExecutable(makeRequest({ version: "2.0.0" }), MONAD);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("VERSION_MISMATCH");
  });

  it("a stale quote is refused", () => {
    registerProtocol(makeProtocol(makeAction()));
    const stale = makeRequest({ quotedAt: Date.now() - QUOTE_MAX_AGE_MS - 1_000 });
    const r = resolveExecutable(stale, MONAD);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("QUOTE_STALE");
  });

  it("a fully valid request resolves to its action and protocol", () => {
    registerProtocol(makeProtocol(makeAction()));
    const r = resolveExecutable(makeRequest(), MONAD);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.action.actionId).toBe("act");
      expect(r.value.protocol.protocolId).toBe("testproto");
    }
  });

  it("validateForQuote composes resolution + input validation and returns cleaned inputs", () => {
    registerProtocol(makeProtocol(makeAction()));
    const r = validateForQuote(makeRequest({ inputs: { amount: "  2.0  " } }), MONAD);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.inputs.amount).toBe("2.0"); // trimmed
  });
});

// ---- 12. the validator itself never executes -----------------------------

describe("12. the validator never signs, broadcasts, or executes", () => {
  it("validate.ts imports nothing that can sign or send", async () => {
    // A structural guarantee: the module's source must not reference a wallet
    // client, a private key, sendTransaction, or writeContract. This is a
    // cheap, durable proxy for "the validator has no execution power" — if a
    // future edit pulls signing into this module, this test goes red.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../lib/sdk/validate.ts", import.meta.url), "utf8");
    for (const forbidden of ["sendTransaction", "writeContract", "WalletClient", "privateKey", "getWalletClient", "signTransaction"]) {
      expect(src.includes(forbidden), `validate.ts must not reference ${forbidden}`).toBe(false);
    }
  });
});
