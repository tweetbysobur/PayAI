import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Action, ProtocolAdapter } from "@/lib/sdk/types";

/**
 * Phase 2A — the PayAI Intent IR and its deterministic validator
 * (lib/plan/). Nothing here executes: these tests only prove what the IR can
 * represent and what validation accepts or refuses.
 *
 * Real registry: MONAD_NETWORK=mainnet registers the built-ins (WMON,
 * payai-settlement/split_payment 2.0.0, Aave). Transfer and swap are NOT
 * production actions yet (Phases 2B/2D), so this file registers TEST-ONLY
 * fixtures for them — with the input schemas and output declarations those
 * actions are designed to have — purely so the future examples can be
 * represented and validated. Their quote/build are never called.
 */

const WALLET = "0x6b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c";
const OTHER_WALLET = "0x3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e";
const RECIPIENT = "0x5e0d39b4c1a2f3e4d5c6b7a8f9e0d1c2b3a4f5e6";
const USDC = "0x754704bc059f5a0ce29e278a6d0eba96b6aafb60";
const WMON = "0x3bd359c1119da7da1d913d1c4d2b7c461115433a";

const notCalled = async (): Promise<never> => { throw new Error("fixture: not callable in Phase 2A"); };
function fixture(protocolId: string, action: Omit<Action, "protocolId" | "chainId" | "allowedTargets" | "quote" | "build" | "parseResult">): ProtocolAdapter {
  const target = "0x00000000000000000000000000000000000000f1" as const;
  return {
    protocolId, name: `${protocolId} (test fixture)`, chainId: 143, allowedTargets: [target],
    actions: [{ ...action, protocolId, chainId: 143, allowedTargets: [target], quote: notCalled, build: notCalled, parseResult: notCalled } as Action],
  };
}
const TRANSFER = fixture("payai", {
  actionId: "transfer", version: "1.0.0", name: "Transfer", description: "test fixture",
  inputSchema: {
    recipient: { type: "address", required: true, description: "to" },
    token: { type: "token", required: false, description: "token (empty = MON)" },
    amount: { type: "units", required: true, description: "amount" },
  },
});
const SWAP = fixture("payai-swap", {
  actionId: "swap", version: "1.0.0", name: "Swap", description: "test fixture",
  inputSchema: {
    tokenIn: { type: "token", required: false, description: "in (empty = MON)" },
    tokenOut: { type: "token", required: true, description: "out" },
    amountIn: { type: "units", required: true, description: "amount in" },
  },
  outputs: {
    amountOut: { type: "units", description: "confirmed amount received", denominatedIn: { input: "tokenOut" } },
    // As the real payai/swap declares it (Phase 2D): the received token IS
    // the tokenOut input, so the IR can prove when it's an ERC-20.
    tokenOut: { type: "token", description: "token received", denominatedIn: { input: "tokenOut" } },
  },
});

let saved: string | undefined;
beforeEach(async () => {
  saved = process.env.MONAD_NETWORK;
  process.env.MONAD_NETWORK = "mainnet";
  const { __resetRegistryForTests, registerProtocol } = await import("@/lib/sdk/registry");
  const { __resetBootstrapForTests, ensureBuiltinsRegistered } = await import("@/lib/sdk/bootstrap");
  __resetRegistryForTests();
  __resetBootstrapForTests();
  ensureBuiltinsRegistered();
  registerProtocol(TRANSFER);
  registerProtocol(SWAP);
});
afterEach(async () => {
  if (saved === undefined) delete process.env.MONAD_NETWORK; else process.env.MONAD_NETWORK = saved;
  const { __resetRegistryForTests } = await import("@/lib/sdk/registry");
  const { __resetBootstrapForTests } = await import("@/lib/sdk/bootstrap");
  __resetRegistryForTests();
  __resetBootstrapForTests();
});

/* ── builders ───────────────────────────────────────────────────────────── */

const lit = (value: string) => ({ kind: "literal", value });
const out = (node: string, output: string) => ({ kind: "output", node, output });
const addr = (a: string) => ({ kind: "recipient", display: a, source: "address", address: a });
const payee = (name: string) => ({ kind: "recipient", display: name, source: "payee" });
const nad = (name: string) => ({ kind: "recipient", display: name, source: "nad" });

function node(nodeId: string, ref: [string, string, string], inputs: Record<string, unknown>, dependsOn: string[] = []) {
  return {
    nodeId, ref: { protocolId: ref[0], actionId: ref[1], version: ref[2] }, inputs, dependsOn,
    validation: { state: "pending" }, execution: { state: "pending" }, verification: { state: "pending" },
  };
}
const T = ["payai", "transfer", "1.0.0"] as [string, string, string];
const S = ["payai-swap", "swap", "1.0.0"] as [string, string, string];
const SPLIT = ["payai-settlement", "split_payment", "2.0.0"] as [string, string, string];

function graph(nodes: unknown[], text: string, extra: Record<string, unknown> = {}) {
  return {
    id: "intent_test_0001", version: 1, chainId: 143, wallet: WALLET, nodes, status: "draft",
    source: { text, adapter: "deterministic", adapterVersion: "1" }, ...extra,
  };
}

async function validate(raw: unknown, ctx: Partial<{ sessionWallet: string | null; activeChainId: number }> = {}) {
  const { validateIntentGraph } = await import("@/lib/plan/validate");
  return validateIntentGraph(raw, { sessionWallet: WALLET, activeChainId: 143, ...ctx });
}
async function expectValid(raw: unknown) {
  const r = await validate(raw);
  if (!r.ok) throw new Error(`expected valid, got ${JSON.stringify(r.error)}`);
  return r.value;
}
async function expectError(raw: unknown, code: string, ctx?: Partial<{ sessionWallet: string | null; activeChainId: number }>) {
  const r = await validate(raw, ctx);
  expect(r.ok, `expected ${code}`).toBe(false);
  if (!r.ok) expect(r.error.code).toBe(code);
  return r;
}

const SEND_TEXT = `send 20 USDC to ${RECIPIENT}`;
const sendNode = () => node("n1", T, { recipient: addr(RECIPIENT), token: lit(USDC), amount: lit("20000000") });

/* ── Valid ──────────────────────────────────────────────────────────────── */

describe("valid intents", () => {
  it("one transfer-like node", async () => {
    const g = await expectValid(graph([sendNode()], SEND_TEXT));
    expect(g.order).toEqual(["n1"]);
    expect(g.nodes[0].validation.state).toBe("valid");
    expect(g.wallet.toLowerCase()).toBe(WALLET);
  });

  it("one split node — the existing split_payment 2.0.0, with .nad and address recipients", async () => {
    const text = `split 100 USDC between alice.nad and ${RECIPIENT}`;
    await expectValid(graph([node("n1", SPLIT, {
      token: lit(USDC),
      recipients: { kind: "list", items: [
        { recipient: nad("alice.nad"), amount: lit("50000000") },
        { recipient: addr(RECIPIENT), amount: lit("50000000") },
      ] },
    })], text));
  });

  it("one swap node, as an action reference", async () => {
    await expectValid(graph([node("n1", S, { tokenOut: lit(USDC), amountIn: lit("10000000000000000000") })], "swap 10 MON to USDC"));
  });

  it("4 nodes is the maximum and is accepted", async () => {
    const text = `wrap 1 MON and send 20 USDC to ${RECIPIENT}`;
    const wrap = (id: string) => node(id, ["wmon", "wrap", "1.0.0"], { amount: lit("1") });
    await expectValid(graph([wrap("n1"), wrap("n2"), wrap("n3"), node("n4", T, { recipient: addr(RECIPIENT), token: lit(USDC), amount: lit("1") })], text));
  });

  it("two nodes with a dependency, and an output binding; order puts the producer first regardless of written order", async () => {
    const text = `swap 10 MON to USDC and send the USDC to ${RECIPIENT}`;
    const g = await expectValid(graph([
      node("send", T, { recipient: addr(RECIPIENT), token: out("swap", "tokenOut"), amount: out("swap", "amountOut") }, ["swap"]),
      node("swap", S, { tokenOut: lit(USDC), amountIn: lit("10000000000000000000") }),
    ], text));
    expect(g.order).toEqual(["swap", "send"]);
  });

  it("output binding: can a producer supply an input, decided from declarations alone", async () => {
    const { canBind } = await import("@/lib/plan/outputs");
    const { getAction } = await import("@/lib/sdk/registry");
    const swap = getAction("payai-swap", "swap", "1.0.0")!;
    const split = getAction("payai-settlement", "split_payment", "2.0.0")!;
    expect(canBind(swap, "amountOut", "units").ok).toBe(true);
    expect(canBind(swap, "tokenOut", "token").ok).toBe(true);
    expect(canBind(swap, "amountOut", "amount")).toMatchObject({ ok: false, code: "OUTPUT_TYPE_MISMATCH" }); // never into a decimal field
    expect(canBind(swap, "price", "units")).toMatchObject({ ok: false, code: "UNKNOWN_OUTPUT" });
    expect(canBind(split, "gross", "units").ok).toBe(true);
    expect(canBind(split, "recipientAmounts", "units")).toMatchObject({ ok: false, code: "OUTPUT_TYPE_MISMATCH" }); // lists aren't bindable
  });

  it("remainder representation", async () => {
    const text = "swap 50 MON to USDC, send 20 USDC to Alice and the rest to Bob";
    const g = await expectValid(graph([
      node("n1", S, { tokenOut: lit(USDC), amountIn: lit("50000000000000000000") }),
      node("n2", SPLIT, {
        token: lit(USDC),
        recipients: { kind: "list", items: [
          { recipient: payee("Alice"), amount: lit("20000000") },
          { recipient: payee("Bob"), amount: { kind: "remainder", node: "n1", output: "amountOut", minus: ["20000000"] } },
        ] },
      }, ["n1"]),
    ], text));
    const bob = (g.nodes[1].inputs.recipients as { items: Record<string, unknown>[] }).items[1].amount;
    expect(bob).toEqual({ kind: "remainder", node: "n1", output: "amountOut", minus: ["20000000"] });
  });
});

/* ── The exact future examples (represented and validated — never executed) ─ */

describe("future examples", () => {
  it("Example A: swap 10 MON to USDC and send the USDC to 0x… — transfer.amount = n1.amountOut", async () => {
    const text = `swap 10 MON to USDC and send the USDC to ${RECIPIENT}`;
    const g = await expectValid(graph([
      node("n1", S, { tokenOut: lit(USDC), amountIn: lit("10000000000000000000") }),
      node("n2", T, { recipient: addr(RECIPIENT), token: lit(USDC), amount: out("n1", "amountOut") }, ["n1"]),
    ], text));
    expect(g.order).toEqual(["n1", "n2"]);
    expect(g.nodes[1].dependsOn).toEqual(["n1"]);
    expect(g.nodes[1].inputs.amount).toEqual({ kind: "output", node: "n1", output: "amountOut" });
    expect(g.nodes.every((n) => n.execution.state === "pending" && n.verification.state === "pending")).toBe(true);
  });

  it("Example B: swap 50 MON to USDC, send 20 USDC to Alice and the rest to Bob — one split node", async () => {
    const text = "swap 50 MON to USDC, send 20 USDC to Alice and the rest to Bob";
    const g = await expectValid(graph([
      node("n1", S, { tokenOut: lit(USDC), amountIn: lit("50000000000000000000") }),
      node("n2", SPLIT, {
        token: lit(USDC),
        recipients: { kind: "list", items: [
          { recipient: payee("Alice"), amount: lit("20000000") },
          { recipient: payee("Bob"), amount: { kind: "remainder", node: "n1", output: "amountOut", minus: ["20000000"] } },
        ] },
      }, ["n1"]),
    ], text));
    expect(g.nodes[1].ref).toEqual({ protocolId: "payai-settlement", actionId: "split_payment", version: "2.0.0" });
    expect(g.order).toEqual(["n1", "n2"]);
  });
});

/* ── Invalid ────────────────────────────────────────────────────────────── */

describe("graph structure", () => {
  it("zero nodes", async () => { await expectError(graph([], SEND_TEXT), "NODE_COUNT"); });
  it("more than 4 nodes", async () => {
    const wrap = (id: string) => node(id, ["wmon", "wrap", "1.0.0"], { amount: lit("1") });
    await expectError(graph(["a1", "a2", "a3", "a4", "a5"].map(wrap), "wrap"), "NODE_COUNT");
  });
  it("duplicate node ids", async () => { await expectError(graph([sendNode(), sendNode()], SEND_TEXT), "DUPLICATE_NODE_ID"); });
  it("missing dependency", async () => {
    await expectError(graph([node("n1", T, { recipient: addr(RECIPIENT), token: lit(USDC), amount: lit("1") }, ["ghost"])], SEND_TEXT), "UNKNOWN_DEPENDENCY");
  });
  it("dependency cycle", async () => {
    const w = (id: string, dep: string) => node(id, ["wmon", "wrap", "1.0.0"], { amount: lit("1") }, [dep]);
    await expectError(graph([w("n1", "n2"), w("n2", "n3"), w("n3", "n1")], "wrap"), "CYCLE");
  });
  it("self dependency", async () => {
    await expectError(graph([node("n1", ["wmon", "wrap", "1.0.0"], { amount: lit("1") }, ["n1"])], "wrap"), "SELF_DEPENDENCY");
  });
  it("a binding to a node not listed in dependsOn", async () => {
    const text = `swap 10 MON to USDC and send the USDC to ${RECIPIENT}`;
    await expectError(graph([
      node("n1", S, { tokenOut: lit(USDC), amountIn: lit("1") }),
      node("n2", T, { recipient: addr(RECIPIENT), token: lit(USDC), amount: out("n1", "amountOut") }),
    ], text), "UNDECLARED_DEPENDENCY");
  });
  it("a draft can't claim progress (status, hashes, confirmed values)", async () => {
    await expectError(graph([sendNode()], SEND_TEXT, { status: "approved" }), "NOT_A_DRAFT");
    const confirmed = { ...sendNode(), execution: { state: "confirmed", txHash: `0x${"a".repeat(64)}` } };
    await expectError(graph([confirmed], SEND_TEXT), "NOT_A_DRAFT");
    const verified = { ...sendNode(), verification: { state: "pending", outputs: { amountOut: "999" } } };
    await expectError(graph([verified], SEND_TEXT), "NOT_A_DRAFT");
  });
  it("non-object / wrong IR version", async () => {
    await expectError("send it", "MALFORMED");
    await expectError(graph([sendNode()], SEND_TEXT, { version: 2 }), "UNSUPPORTED_VERSION");
  });
});

describe("registry resolution (existing SDK gate)", () => {
  it("unknown protocol", async () => {
    await expectError(graph([node("n1", ["evilproto", "drain", "1.0.0"], {})], SEND_TEXT), "PROTOCOL_NOT_CONFIGURED");
  });
  it("unknown action", async () => {
    await expectError(graph([node("n1", ["payai-settlement", "drain", "1.0.0"], {})], SEND_TEXT), "ACTION_NOT_FOUND");
  });
  it("wrong action version (split v1 no longer exists)", async () => {
    await expectError(graph([node("n1", ["payai-settlement", "split_payment", "1.0.0"], {})], SEND_TEXT), "VERSION_MISMATCH");
  });
  it("a free-standing approval node is impossible — no registered action is an approval", async () => {
    await expectError(graph([node("n1", ["payai-settlement", "approve", "2.0.0"], { spender: lit(RECIPIENT) })], SEND_TEXT), "ACTION_NOT_FOUND");
  });
});

describe("chain and wallet", () => {
  it("wrong chain on the graph", async () => { await expectError(graph([sendNode()], SEND_TEXT, { chainId: 1 }), "WRONG_CHAIN"); });
  it("the app pointed at another chain", async () => { await expectError(graph([sendNode()], SEND_TEXT), "WRONG_CHAIN", { activeChainId: 10143 }); });
  it("wallet mismatch — the graph's wallet must be the session's", async () => {
    await expectError(graph([sendNode()], SEND_TEXT, { wallet: OTHER_WALLET }), "WALLET_MISMATCH");
  });
  it("no session identity — nothing validates", async () => {
    await expectError(graph([sendNode()], SEND_TEXT), "NO_SESSION", { sessionWallet: null });
    await expectError(graph([sendNode()], SEND_TEXT), "NO_SESSION", { sessionWallet: "not-a-wallet" });
  });
});

describe("inputs and bindings", () => {
  it("unknown input", async () => {
    await expectError(graph([node("n1", T, { recipient: addr(RECIPIENT), amount: lit("1"), memo: lit("hi") })], SEND_TEXT), "UNKNOWN_INPUT");
  });
  it("invalid literal (Layer A): a decimal where base units are required", async () => {
    await expectError(graph([node("n1", T, { recipient: addr(RECIPIENT), amount: lit("20.5") })], SEND_TEXT), "INVALID_INPUT");
  });
  it("invalid output reference: an output the producer doesn't declare", async () => {
    const text = `swap 10 MON to USDC and send the USDC to ${RECIPIENT}`;
    await expectError(graph([
      node("n1", S, { tokenOut: lit(USDC), amountIn: lit("1") }),
      node("n2", T, { recipient: addr(RECIPIENT), token: lit(USDC), amount: out("n1", "bonus") }, ["n1"]),
    ], text), "UNKNOWN_OUTPUT");
  });
  it("an output type that can't fill the input (token into an amount)", async () => {
    const text = `swap 10 MON to USDC and send the USDC to ${RECIPIENT}`;
    await expectError(graph([
      node("n1", S, { tokenOut: lit(USDC), amountIn: lit("1") }),
      node("n2", T, { recipient: addr(RECIPIENT), token: lit(USDC), amount: out("n1", "tokenOut") }, ["n1"]),
    ], text), "OUTPUT_TYPE_MISMATCH");
  });
  it("an amount in a different token than the consumer pays", async () => {
    const text = `swap 10 MON to WMON and send the USDC to ${RECIPIENT}`;
    await expectError(graph([
      node("n1", S, { tokenOut: lit(WMON), amountIn: lit("1") }),
      node("n2", T, { recipient: addr(RECIPIENT), token: lit(USDC), amount: out("n1", "amountOut") }, ["n1"]),
    ], text), "TOKEN_MISMATCH");
  });
  it("a remainder must subtract exact base-unit amounts; only one remainder per list", async () => {
    const text = "swap 50 MON to USDC, send 20 USDC to Alice and the rest to Bob";
    const split = (minus: unknown, second?: unknown) => node("n2", SPLIT, {
      token: lit(USDC),
      recipients: { kind: "list", items: [
        { recipient: payee("Alice"), amount: second ?? lit("20000000") },
        { recipient: payee("Bob"), amount: { kind: "remainder", node: "n1", output: "amountOut", minus } },
      ] },
    }, ["n1"]);
    const swap = node("n1", S, { tokenOut: lit(USDC), amountIn: lit("1") });
    await expectError(graph([swap, split(["20.5"])], text), "INVALID_BINDING");
    await expectError(graph([swap, split([])], text), "INVALID_BINDING");
    await expectError(graph([swap, split(["1"], { kind: "remainder", node: "n1", output: "amountOut", minus: ["1"] })], text), "INVALID_BINDING");
  });
});

describe("native outputs are never bindable (Phase 2D)", () => {
  const NATIVE = "0x0000000000000000000000000000000000000000";
  it("USDC → MON: binding the native amountOut is refused", async () => {
    const text = `swap 35 USDC to MON and send it to ${RECIPIENT}`;
    await expectError(graph([
      node("n1", S, { tokenIn: lit(USDC), tokenOut: lit(NATIVE), amountIn: lit("35000000") }),
      node("n2", T, { recipient: addr(RECIPIENT), amount: out("n1", "amountOut") }, ["n1"]),
    ], text), "NATIVE_OUTPUT_NOT_BINDABLE");
  });
  it("USDC → MON: binding the native tokenOut is refused too", async () => {
    const text = `swap 35 USDC to MON and send it to ${RECIPIENT}`;
    await expectError(graph([
      node("n1", S, { tokenIn: lit(USDC), tokenOut: lit(NATIVE), amountIn: lit("35000000") }),
      node("n2", T, { recipient: addr(RECIPIENT), token: out("n1", "tokenOut"), amount: lit("1") }, ["n1"]),
    ], text), "NATIVE_OUTPUT_NOT_BINDABLE");
  });
  it("MON → USDC: the ERC-20 amountOut and tokenOut are bindable", async () => {
    const text = `swap 10 MON to USDC and send the USDC to ${RECIPIENT}`;
    await expectValid(graph([
      node("n1", S, { tokenOut: lit(USDC), amountIn: lit("10000000000000000000") }),
      node("n2", T, { recipient: addr(RECIPIENT), token: out("n1", "tokenOut"), amount: out("n1", "amountOut") }, ["n1"]),
    ], text));
  });
  it("a native MON transfer's amount output is refused (absent token = native)", async () => {
    const TX = fixtureTransferWithOutputs();
    const { registerProtocol } = await import("@/lib/sdk/registry");
    registerProtocol(TX);
    const text = `send 1 MON to ${RECIPIENT} and send it to ${RECIPIENT}`;
    await expectError(graph([
      node("n1", ["payai-tx", "transfer", "1.0.0"], { recipient: addr(RECIPIENT), amount: lit("1000000000000000000") }),
      node("n2", ["payai-tx", "transfer", "1.0.0"], { recipient: addr(RECIPIENT), amount: out("n1", "amount") }, ["n1"]),
    ], text), "NATIVE_OUTPUT_NOT_BINDABLE");
  });
  it("an output whose token is itself bound (unknown until execution) is refused", async () => {
    const text = `swap 10 MON to USDC, swap it and send it to ${RECIPIENT}`;
    await expectError(graph([
      node("n1", S, { tokenOut: lit(USDC), amountIn: lit("10000000000000000000") }),
      node("n2", S, { tokenIn: out("n1", "tokenOut"), tokenOut: out("n1", "tokenOut"), amountIn: out("n1", "amountOut") }, ["n1"]),
      node("n3", T, { recipient: addr(RECIPIENT), token: lit(USDC), amount: out("n2", "amountOut") }, ["n2"]),
    ], text), "NATIVE_OUTPUT_NOT_BINDABLE");
  });
  it("staticErc20: only a literal, non-zero address in the declared denomination proves an ERC-20", async () => {
    const { staticErc20 } = await import("@/lib/plan/outputs");
    const units = { type: "units", description: "x", denominatedIn: { input: "tokenOut" } } as const;
    expect(staticErc20(units, () => USDC.toUpperCase().replace("0X", "0x"))).toBe(USDC);
    expect(staticErc20(units, () => NATIVE)).toBeNull();
    expect(staticErc20(units, () => undefined)).toBeNull();
    expect(staticErc20(units, () => null)).toBeNull();
    expect(staticErc20({ type: "units", description: "x" }, () => USDC)).toBeNull();
    expect(staticErc20({ type: "units[]", description: "x", denominatedIn: { input: "token" } }, () => USDC)).toBeNull();
  });
});

/** A transfer whose outputs mirror payai/transfer's (amount in `token`). */
function fixtureTransferWithOutputs(): ProtocolAdapter {
  return fixture("payai-tx", {
    actionId: "transfer", version: "1.0.0", name: "Transfer", description: "test fixture",
    inputSchema: {
      recipient: { type: "address", required: true, description: "to" },
      token: { type: "token", required: false, description: "token (empty = MON)" },
      amount: { type: "units", required: true, description: "amount" },
    },
    outputs: { amount: { type: "units", description: "received", denominatedIn: { input: "token" } } },
  });
}

describe("execution details can't be smuggled in", () => {
  it("arbitrary calldata", async () => {
    await expectError(graph([{ ...sendNode(), data: "0xdeadbeef" }], SEND_TEXT), "FORBIDDEN_FIELD");
    await expectError(graph([node("n1", T, { recipient: addr(RECIPIENT), amount: lit("1"), data: lit("0xdeadbeef") })], SEND_TEXT), "FORBIDDEN_FIELD");
  });
  it("arbitrary target", async () => {
    await expectError(graph([{ ...sendNode(), to: RECIPIENT }], SEND_TEXT), "FORBIDDEN_FIELD");
    await expectError(graph([sendNode()], SEND_TEXT, { to: RECIPIENT }), "FORBIDDEN_FIELD");
  });
  it("arbitrary spender / approval", async () => {
    await expectError(graph([node("n1", T, { recipient: addr(RECIPIENT), amount: lit("1"), spender: lit(RECIPIENT) })], SEND_TEXT), "FORBIDDEN_FIELD");
    await expectError(graph([{ ...sendNode(), approval: { spender: RECIPIENT, amount: "max" } }], SEND_TEXT), "FORBIDDEN_FIELD");
  });
  it("auto-execute and skip-validation flags", async () => {
    await expectError(graph([sendNode()], SEND_TEXT, { autoExecute: true }), "FORBIDDEN_FIELD");
    await expectError(graph([{ ...sendNode(), skipValidation: true }], SEND_TEXT), "FORBIDDEN_FIELD");
  });
  it("a chain override on a node, and unknown keys anywhere", async () => {
    await expectError(graph([{ ...sendNode(), chain: 1 }], SEND_TEXT), "FORBIDDEN_FIELD");
    await expectError(graph([{ ...sendNode(), ref: { protocolId: "payai", actionId: "transfer", version: "1.0.0", abi: [] } }], SEND_TEXT), "FORBIDDEN_FIELD");
    await expectError(graph([{ ...sendNode(), extra: 1 }], SEND_TEXT), "MALFORMED");
  });
});

describe("recipients (Phase 0 provenance)", () => {
  it("invalid recipient: zero address, malformed address, bad .nad, bad payee name", async () => {
    const zero = "0x0000000000000000000000000000000000000000";
    await expectError(graph([node("n1", T, { recipient: addr(zero), amount: lit("1") })], `send 1 to ${zero}`), "INVALID_RECIPIENT");
    await expectError(graph([node("n1", T, { recipient: { kind: "recipient", display: "0x123", source: "address", address: "0x123" }, amount: lit("1") })], "send 1 to 0x123"), "INVALID_RECIPIENT");
    await expectError(graph([node("n1", T, { recipient: nad("alice"), amount: lit("1") })], "send 1 to alice"), "INVALID_RECIPIENT");
    await expectError(graph([node("n1", T, { recipient: payee("alice.nad"), amount: lit("1") })], "send 1 to alice.nad"), "INVALID_RECIPIENT");
  });
  it("an address input given as a raw literal is refused — it must be a recipient", async () => {
    await expectError(graph([node("n1", T, { recipient: lit(RECIPIENT), amount: lit("1") })], SEND_TEXT), "INVALID_RECIPIENT");
  });
  it("provenance: a recipient the user never wrote is refused (e.g. LLM-invented)", async () => {
    await expectError(graph([node("n1", T, { recipient: addr(OTHER_WALLET), amount: lit("1") })], SEND_TEXT), "RECIPIENT_PROVENANCE");
    await expectError(graph([node("n1", T, { recipient: payee("Mallory"), amount: lit("1") })], SEND_TEXT), "RECIPIENT_PROVENANCE");
  });
  it("provenance: an address-source recipient whose address differs from what the user wrote", async () => {
    await expectError(graph([node("n1", T, { recipient: { kind: "recipient", display: RECIPIENT, source: "address", address: OTHER_WALLET }, amount: lit("1") })], SEND_TEXT), "RECIPIENT_PROVENANCE");
  });
  it("provenance: .nad and payee recipients can't arrive pre-resolved — the server resolves them", async () => {
    const text = "send 1 USDC to alice.nad";
    await expectError(graph([node("n1", T, { recipient: { kind: "recipient", display: "alice.nad", source: "nad", address: OTHER_WALLET }, amount: lit("1") })], text), "RECIPIENT_PROVENANCE");
    await expectError(graph([node("n1", T, { recipient: { kind: "recipient", display: "Alice", source: "payee", address: OTHER_WALLET }, amount: lit("1") })], "send 1 USDC to Alice"), "RECIPIENT_PROVENANCE");
  });
});

describe("no execution", () => {
  it("validation never calls quote/build/parseResult on any action", async () => {
    // The fixtures throw if called; Example A validates without touching them.
    const text = `swap 10 MON to USDC and send the USDC to ${RECIPIENT}`;
    await expectValid(graph([
      node("n1", S, { tokenOut: lit(USDC), amountIn: lit("1") }),
      node("n2", T, { recipient: addr(RECIPIENT), token: lit(USDC), amount: out("n1", "amountOut") }, ["n1"]),
    ], text));
  });
  it("lib/plan has no signing, sending, chain-reading or LLM primitives", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const dir = new URL("../lib/plan/", import.meta.url);
    // Call-shaped, so the validator's own list of REFUSED keys ("privateKey",
    // "signature", …) doesn't count as using them.
    const forbidden = ["sendTransaction(", "writeContract(", "readContract(", "createWalletClient", "getPublicClient(", "privateKeyToAccount", "signTransaction(", "new Anthropic", "fetch(", "resolveRecipientInput(", "resolveDomain("];
    for (const f of readdirSync(dir)) {
      const src = readFileSync(new URL(f, dir), "utf8");
      for (const word of forbidden) expect(src.includes(word), `${f} must not reference ${word}`).toBe(false);
    }
  });
});
