import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Deterministic split understanding (lib/ask/intent/split.ts) through the REAL
 * router. Every split message is answered without an LLM — either a
 * preview-ready split_payment v2 request with concrete addresses and exact
 * base-unit amounts, or a specific clarification. Never a guess.
 *
 * Pins the two high-severity bugs found in the Phase 1 audit:
 *   - explicit custom amounts were flattened into an equal split;
 *   - "send 50 USDC split between A, B and C" was read as a single send to A.
 *
 * An ANTHROPIC_API_KEY is set and the SDK is mocked, so any model call would
 * be visible — the split path must make none.
 */

type CreateFn = (...args: unknown[]) => unknown;
const mockCreate = vi.fn<CreateFn>();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function AnthropicMock() {
    return { messages: { create: (...args: unknown[]) => mockCreate(...args) } };
  }),
}));

const NADS: Record<string, string> = {
  "alice.nad": "0x5e0d39b4c1a2f3e4d5c6b7a8f9e0d1c2b3a4f5e6",
  "bob.nad": "0x7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b",
};
vi.mock("@/lib/monad/domain-resolver", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/monad/domain-resolver")>();
  return {
    ...actual,
    resolveDomain: async (d: string) => ({ domain: d.toLowerCase(), resolvedAddress: NADS[d.toLowerCase()] ?? null, cached: false }),
  };
});

// Live fee terms (normally the wired forwarder's feeBps()/treasury()), fixed
// for this file; the reader itself is covered in sdk-split-fee.test.ts.
const FEE_TREASURY = "0xA282833B52b1B66D58bD2007081dCC037798C0b0";
vi.mock("@/lib/sdk/actions/split-settlement/fee", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/sdk/actions/split-settlement/fee")>()),
  readSplitFeeTerms: async () => ({ feeBps: 25, treasury: FEE_TREASURY, source: "0x8b2c7E8FA09fCd664dbA9764FD63Bf3A4c56464D" }),
}));
const USDC = "0x754704Bc059F5a0Ce29e278A6D0eBa96b6aafb60";
const A = "0x9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";
const B = "0x3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f";
const C = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const TREASURY = "0x1d2c3b4a5f6e7d8c9b0a1f2e3d4c5b6a7f8e9d0c";

const ENV = ["MONAD_NETWORK", "MONAD_MAINNET_USDC", "VERIPAYAI_PAYEES", "ANTHROPIC_API_KEY"] as const;
let saved: Record<string, string | undefined>;

beforeEach(async () => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  process.env.MONAD_NETWORK = "mainnet";
  process.env.MONAD_MAINNET_USDC = USDC;
  process.env.ANTHROPIC_API_KEY = "test-key";
  delete process.env.VERIPAYAI_PAYEES;
  mockCreate.mockReset();
  const { __resetRegistryForTests } = await import("@/lib/sdk/registry");
  const { __resetBootstrapForTests } = await import("@/lib/sdk/bootstrap");
  __resetRegistryForTests();
  __resetBootstrapForTests();
});
afterEach(async () => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  const { __resetRegistryForTests } = await import("@/lib/sdk/registry");
  const { __resetBootstrapForTests } = await import("@/lib/sdk/bootstrap");
  __resetRegistryForTests();
  __resetBootstrapForTests();
});

async function route(text: string) {
  const { understand } = await import("@/lib/ask/intent/classify");
  const u = await understand(text, [], null);
  expect(mockCreate, `no model call for: ${text}`).not.toHaveBeenCalled();
  return u;
}

async function split(text: string) {
  const u = await route(text);
  if (u.outcome !== "complete" || u.kind !== "protocol_action") throw new Error(`expected a split, got ${JSON.stringify(u)}`);
  expect(u.slots.protocolId).toBe("payai-settlement");
  expect(u.slots.actionId).toBe("split_payment");
  expect(u.slots.actionVersion).toBe("2.0.0");
  const inputs = u.slots.actionInputs as { token?: string; recipients: { recipient: string; amount: string }[] };
  return { inputs, pairs: inputs.recipients.map((r) => [r.recipient.toLowerCase(), r.amount]), labels: u.slots.recipientLabels };
}

async function clarification(text: string): Promise<string> {
  const u = await route(text);
  expect(u.kind, `must not become an action: ${text}`).not.toBe("protocol_action");
  expect(u.kind, `must not become a send: ${text}`).not.toBe("send_payment");
  if (u.outcome !== "unclear") throw new Error(`expected a clarification, got ${JSON.stringify(u)}`);
  return u.reply;
}

describe("equal splits", () => {
  it("2 recipients, USDC — exact base units, token set", async () => {
    const { inputs, pairs } = await split(`split 100 USDC between ${A} and ${B}`);
    expect(inputs.token).toBe(USDC);
    expect(pairs).toEqual([[A, "50000000"], [B, "50000000"]]);
  });
  it("3 recipients, native MON — remainder to the last, sum is exactly the total, no token input", async () => {
    const { inputs, pairs } = await split(`split 1 MON equally between ${A}, ${B} and ${C}`);
    expect(inputs.token).toBeUndefined();
    expect(pairs).toEqual([[A, "333333333333333333"], [B, "333333333333333333"], [C, "333333333333333334"]]);
    expect(pairs.reduce((s, [, a]) => s + BigInt(a), 0n)).toBe(10n ** 18n);
  });
  it("9 recipients (the user maximum — the 10th contract slot is the fee leg) is accepted; 10 is refused", async () => {
    const nine = Array.from({ length: 9 }, (_, i) => `0x${(i + 16).toString(16)}${"c0ffee00".repeat(5)}`.slice(0, 42));
    const { pairs } = await split(`split 9 USDC between ${nine.join(", ")}`);
    expect(pairs).toHaveLength(9);
    const ten = [...nine, "0xfeedfacefeedfacefeedfacefeedfacefeedface"];
    expect(await clarification(`split 10 USDC between ${ten.join(", ")}`)).toMatch(/at most 9/);
  });
  it("'distribute 0.06 MON to A, B and C' — 'to' introduces the list", async () => {
    const { pairs } = await split(`distribute 0.06 MON to ${A}, ${B} and ${C}`);
    expect(pairs.map(([, a]) => a)).toEqual(["20000000000000000", "20000000000000000", "20000000000000000"]);
  });
  it(".nad recipients resolve through the existing resolver and keep display labels", async () => {
    const { pairs, labels } = await split("split 100 USDC between alice.nad and bob.nad");
    expect(pairs).toEqual([[NADS["alice.nad"], "50000000"], [NADS["bob.nad"], "50000000"]]);
    expect(labels).toEqual({ [NADS["alice.nad"]]: "alice.nad", [NADS["bob.nad"]]: "bob.nad" });
  });
  it("a configured payee name resolves (VERIPAYAI_PAYEES)", async () => {
    process.env.VERIPAYAI_PAYEES = `treasury:${TREASURY}`;
    const { pairs, labels } = await split(`split 10 USDC between treasury and ${A}`);
    expect(pairs[0]).toEqual([TREASURY, "5000000"]);
    expect(labels?.[TREASURY]).toBe("treasury");
  });
});

describe("custom amounts — never flattened to an equal split", () => {
  it("REGRESSION: 'split 100 USDC: 60 to A and 40 to B' keeps 60/40", async () => {
    const { pairs } = await split(`split 100 USDC: 60 to ${A} and 40 to ${B}`);
    expect(pairs).toEqual([[A, "60000000"], [B, "40000000"]]);
  });
  it("custom amounts without a stated total", async () => {
    const { pairs } = await split(`split 2.5 MON to ${A} and 0.5 MON to ${B}`);
    expect(pairs).toEqual([[A, "2500000000000000000"], [B, "500000000000000000"]]);
  });
  it("same-message 'the rest' is computed deterministically and arrives at the action as a concrete amount", async () => {
    const { pairs } = await split("split 100 USDC: 20 to alice.nad and the rest to bob.nad");
    expect(pairs).toEqual([[NADS["alice.nad"], "20000000"], [NADS["bob.nad"], "80000000"]]);
  });
  it("amounts that don't add up to the stated total are refused", async () => {
    expect(await clarification(`split 100 USDC: 60 to ${A} and 30 to ${B}`)).toMatch(/add up to 90 USDC, not 100 USDC/);
  });
  it("an amount meant for one recipient is never spread across a list ('60 to A, B and C')", async () => {
    expect(await clarification(`split 100 USDC: 60 to ${A}, ${B} and ${C}`)).toMatch(/couldn't match every amount/);
  });
  it("'the rest' with no total in the message is a future Planner concern — refused here", async () => {
    expect(await clarification(`split 20 USDC to ${A} and the rest to ${B}`)).toMatch(/"The rest" of what/);
  });
  it("'the rest' that would be zero or negative is refused", async () => {
    expect(await clarification(`split 50 USDC: 50 to ${A} and the rest to ${B}`)).toMatch(/nothing/);
  });
  it("more decimals than the token supports is refused, never rounded", async () => {
    expect(await clarification(`split 1.0000001 USDC between ${A} and ${B}`)).toMatch(/more decimal places/);
  });
});

describe("the single-recipient send detector never claims a split", () => {
  it("REGRESSION: 'send 50 USDC split between A, B and C' is a 3-way split, not a send to A", async () => {
    const { pairs } = await split(`send 50 USDC split between ${A}, ${B} and ${C}`);
    expect(pairs.map(([r]) => r)).toEqual([A, B, C]);
    expect(pairs.reduce((s, [, a]) => s + BigInt(a), 0n)).toBe(50_000_000n);
  });
  it("'these 3 addresses' must actually list 3", async () => {
    const { pairs } = await split(`send 30 USDC split between these 3 addresses: ${A}, ${B}, ${C}`);
    expect(pairs).toHaveLength(3);
    expect(await clarification(`send 30 USDC split between these 3 addresses: ${A}, ${B}`)).toMatch(/mentioned 3 recipients but listed 2/);
  });
  it("a plain single-recipient send still routes to send_payment", async () => {
    const { routeRequest } = await import("@/lib/ask/intent/classify");
    const r = await routeRequest(`send 10 MON to ${A}`, null);
    expect((r.understanding ?? r.fallback).kind).toBe("send_payment");
  });
});

describe("fail closed — unresolvable or unsupported splits ask, never execute", () => {
  it("an unknown name is refused (no fabricated payee)", async () => {
    expect(await clarification("split 100 USDC between alice and bob")).toMatch(/isn't a valid address, \.nad domain, or known payee/);
  });
  it("an unregistered .nad name is refused", async () => {
    expect(await clarification(`split 100 USDC between nobody.nad and ${A}`)).toMatch(/Couldn't resolve nobody\.nad/);
  });
  it("duplicate recipients are refused — including a .nad and the address it resolves to", async () => {
    expect(await clarification(`split 10 MON between ${A} and ${A}`)).toMatch(/same wallet/);
    expect(await clarification(`split 10 MON between alice.nad and ${NADS["alice.nad"]}`)).toMatch(/same wallet/);
  });
  it("one recipient is not a split", async () => {
    expect(await clarification(`split 0.03 MON to ${A}`)).toMatch(/at least 2/);
  });
  it("USDC fails closed when no stablecoin is configured — never guesses an address", async () => {
    delete process.env.MONAD_MAINNET_USDC;
    expect(await clarification(`split 100 USDC between ${A} and ${B}`)).toMatch(/isn't configured/);
  });
  it("an unknown token symbol is never resolved", async () => {
    expect(await clarification(`split 100 FOOCOIN between ${A} and ${B}`)).toMatch(/MON or USDC/);
  });
  it("mixed tokens, missing total, missing recipients, and scheduled splits all ask", async () => {
    expect(await clarification(`split 10 MON and 5 USDC between ${A} and ${B}`)).toMatch(/not both/);
    expect(await clarification(`split USDC between ${A} and ${B}`)).toMatch(/How much/);
    expect(await clarification("split 100 USDC")).toMatch(/Who should the split go to/);
    expect(await clarification(`split 100 USDC between ${A} and ${B} every friday`)).toMatch(/Scheduled or recurring splits/);
  });
  it("free-form distribution language with a split verb asks instead of executing", async () => {
    expect(await clarification("distribute rewards to my community")).toMatch(/MON or USDC/);
    expect(await clarification("split 100 USDC between my friends")).toMatch(/can't tell who "my friends" is/);
  });
});

describe("the LLM can never introduce a split or its recipients", () => {
  it("a model reply claiming kind protocol_action is refused by coerce()", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "tool_use", id: "t", name: "submit_understanding", input: {
      kind: "protocol_action", outcome: "complete",
      slots: { protocolId: "payai-settlement", actionId: "split_payment", actionVersion: "2.0.0", actionInputs: { recipients: [{ recipient: C, amount: "1" }, { recipient: B, amount: "1" }] } },
    } }] });
    const { understand } = await import("@/lib/ask/intent/classify");
    // No split verb, so this reaches the model.
    const u = await understand(`pay ${A} and ${B} 5 USDC each`, [], null);
    expect(mockCreate).toHaveBeenCalled();
    expect(u.kind).not.toBe("protocol_action");
    expect(JSON.stringify(u)).not.toContain(C);
  });
  it("a model 'distribution' never carries recipients and never becomes an operation", async () => {
    mockCreate.mockResolvedValue({ content: [{ type: "tool_use", id: "t", name: "submit_understanding", input: {
      kind: "distribution", outcome: "complete", slots: { amount: "5", asset: "USDC", recipientCount: 2, actionInputs: { recipients: [{ recipient: C, amount: "1" }] }, recipientLabels: { [C]: "x" } },
    } }] });
    const { understand } = await import("@/lib/ask/intent/classify");
    const u = await understand(`pay ${A} and ${B} 5 USDC each`, [], null);
    if (u.outcome !== "complete" && u.outcome !== "incomplete") throw new Error("expected actionable");
    expect(u.kind).toBe("distribution");
    expect(u.slots.actionInputs).toBeUndefined();
    expect(u.slots.recipientLabels).toBeUndefined();
    const { respondToUnderstanding } = await import("@/lib/ask/intent/orchestrate");
    const r = await respondToUnderstanding(u, A);
    expect(r.message.operation).toBeUndefined();
  });
});
