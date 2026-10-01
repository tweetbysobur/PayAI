import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, maxUint256, parseEther, parseUnits, toEventSelector } from "viem";
import type { Action, ProtocolAdapter } from "@/lib/sdk/types";

/**
 * Phase 2B — payai/transfer@1.0.0: the existing PayAI send, as an SDK action.
 *
 * It settles exactly like today's production send: through the PayAI
 * forwarder (PayAIForwarderV2), whose own fee mechanism takes
 * floor(gross * feeBps / 10000) out of the amount sent — the recipient
 * receives gross − fee. Same rate, same treasury, same contract; no second
 * fee path. Rate/treasury are the live on-chain terms (lib/sdk/fees.ts),
 * bound into the quote token.
 *
 * Only the forwarder is a transaction target (allowlisted); there is no
 * direct-transfer path in the SDK action, so no step can target an
 * arbitrary address. The RPC is stubbed; everything else is real.
 */

const FORWARDER = "0x8b2c7E8FA09fCd664dbA9764FD63Bf3A4c56464D";
const TREASURY = "0xA282833B52b1B66D58bD2007081dCC037798C0b0";
const USDC = "0x754704bc059f5a0ce29e278a6d0eba96b6aafb60";
const NATIVE = "0x0000000000000000000000000000000000000000";
const WALLET = "0x6b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c";
const RECIPIENT = "0x5e0d39b4c1a2f3e4d5c6b7a8f9e0d1c2b3a4f5e6";
const OTHER = "0x3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e";
const ID = { protocolId: "payai", actionId: "transfer", version: "1.0.0" };

vi.mock("@/lib/platform/ratelimit", () => ({ rateLimited: async () => null }));
vi.mock("@/lib/payment/sanctions", () => ({
  ensureSanctionsLoaded: async () => {}, isSanctionedAddress: () => false, sanctionsListLoaded: () => true,
}));

/** Live fee terms + RPC, as the stub reports them. */
const onchain = { feeBps: 25n as bigint, treasury: TREASURY as string, allowance: 0n as bigint };
const chain: {
  tx?: { from: string; to: string | null; input: string; value: bigint };
  receipt?: { status: "success" | "reverted"; from: string; logs: { address: string; topics: string[]; data: string }[] };
} = {};
vi.mock("@/lib/monad/wallet", () => ({
  getPublicClient: () => ({
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "feeBps") return onchain.feeBps;
      if (functionName === "treasury") return onchain.treasury;
      if (functionName === "allowance") return onchain.allowance;
      throw new Error(`unexpected read ${functionName}`);
    },
    waitForTransactionReceipt: async () => chain.receipt,
    getTransaction: async () => chain.tx,
  }),
}));

const FWD_ABI = [
  { type: "function", name: "forwardPaymentNative", stateMutability: "payable", inputs: [{ name: "recipient", type: "address" }, { name: "amount", type: "uint256" }, { name: "ref", type: "bytes32" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "forwardPayment", stateMutability: "nonpayable", inputs: [{ name: "token", type: "address" }, { name: "recipient", type: "address" }, { name: "amount", type: "uint256" }, { name: "ref", type: "bytes32" }], outputs: [{ type: "uint256" }] },
] as const;
const APPROVE_ABI = [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }] as const;

const ENV = ["MONAD_NETWORK", "MONAD_MAINNET_USDC", "MONAD_MAINNET_PAYAI_FORWARDER", "PAYAI_FORWARDER_ENABLED", "PAYAI_TREASURY_ADDRESS"] as const;
let saved: Record<string, string | undefined>;
beforeEach(async () => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  process.env.MONAD_NETWORK = "mainnet";
  process.env.MONAD_MAINNET_USDC = USDC;
  process.env.MONAD_MAINNET_PAYAI_FORWARDER = FORWARDER;
  process.env.PAYAI_FORWARDER_ENABLED = "true";
  delete process.env.PAYAI_TREASURY_ADDRESS;
  onchain.feeBps = 25n; onchain.treasury = TREASURY; onchain.allowance = 0n;
  delete chain.tx; delete chain.receipt;
  (globalThis as unknown as { __veripayIdem?: Map<string, unknown> }).__veripayIdem?.clear();
  (await import("@/lib/sdk/fees")).__resetPlatformFeeCacheForTests();
  const { __resetRegistryForTests } = await import("@/lib/sdk/registry");
  const { __resetBootstrapForTests } = await import("@/lib/sdk/bootstrap");
  __resetRegistryForTests();
  __resetBootstrapForTests();
});
afterEach(() => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  vi.useRealTimers();
});

async function transfer(): Promise<Action> {
  const { ensureBuiltinsRegistered } = await import("@/lib/sdk/bootstrap");
  const { getAction } = await import("@/lib/sdk/registry");
  ensureBuiltinsRegistered();
  const a = getAction("payai", "transfer", "1.0.0");
  if (!a) throw new Error("transfer not registered");
  return a;
}
const usdc = (n: string) => parseUnits(n, 6);
const inputs = (recipient: string, amount: bigint, token?: string) => ({ recipient, amount: amount.toString(), ...(token ? { token } : {}) });
async function buildOf(i: Record<string, string>) {
  const a = await transfer();
  return a.build(i, await a.quote(i));
}

/* ── Registration and declarations ─────────────────────────────────────── */

describe("registration", () => {
  it("payai/transfer@1.0.0, pinned to the configured forwarder as its ONLY target", async () => {
    const a = await transfer();
    expect(a.chainId).toBe(143);
    expect(a.allowedTargets.map((t) => t.toLowerCase())).toEqual([FORWARDER.toLowerCase()]);
    const { getProtocol } = await import("@/lib/sdk/registry");
    expect(getProtocol("payai")!.allowedTargets.map((t) => t.toLowerCase())).toEqual([FORWARDER.toLowerCase()]);
  });
  it("is not registered when forwarder payments are disabled — there is no direct-transfer path", async () => {
    process.env.PAYAI_FORWARDER_ENABLED = "false";
    const { ensureBuiltinsRegistered } = await import("@/lib/sdk/bootstrap");
    const { getAction } = await import("@/lib/sdk/registry");
    ensureBuiltinsRegistered();
    expect(getAction("payai", "transfer", "1.0.0")).toBeNull();
  });
  it("schema: exactly recipient (address), token (token), amount (units) — no to/data/spender/value", async () => {
    const a = await transfer();
    expect(Object.keys(a.inputSchema).sort()).toEqual(["amount", "recipient", "token"]);
    expect(a.inputSchema.recipient.type).toBe("address");
    expect(a.inputSchema.amount.type).toBe("units");
    expect(a.inputSchema.token.type).toBe("token");
  });
  it("declares confirmed outputs the planner can bind: amount, gross, fee (units in `token`) and token", async () => {
    const a = await transfer();
    expect(a.outputs).toMatchObject({
      amount: { type: "units", denominatedIn: { input: "token" } },
      gross: { type: "units", denominatedIn: { input: "token" } },
      fee: { type: "units", denominatedIn: { input: "token" } },
      token: { type: "token" },
    });
    // A recipient is never a bindable output — an address may only enter a
    // later node through recipient provenance, not from another action.
    expect(a.outputs).not.toHaveProperty("recipient");
  });
});

/* ── Fee, quote, build ─────────────────────────────────────────────────── */

describe("fee: the forwarder's own mechanism — floor(gross * 25 / 10000), out of the amount sent", () => {
  it("quote: 20 USDC sent → 0.05 USDC fee → 19.95 USDC received; terms bound", async () => {
    const a = await transfer();
    const q = await a.quote(inputs(RECIPIENT, usdc("20"), USDC));
    expect(q.details["you send"]).toBe("20 USDC");
    expect(q.details["platform fee"]).toBe("0.05 USDC");
    expect(q.details["recipient receives"]).toBe("19.95 USDC");
    expect(q.terms).toMatchObject({ feeBps: "25", treasury: TREASURY.toLowerCase(), feeSource: FORWARDER.toLowerCase(), gross: "20000000", fee: "50000", net: "19950000" });
  });
  it("native: 1 MON → 0.0025 MON fee; tiny amounts floor the fee to 0", async () => {
    const a = await transfer();
    expect((await a.quote(inputs(RECIPIENT, parseEther("1")))).terms).toMatchObject({ fee: parseEther("0.0025").toString() });
    expect((await a.quote(inputs(RECIPIENT, 399n))).terms).toMatchObject({ fee: "0", net: "399" });
  });
});

describe("build", () => {
  it("native MON: ONE step to the forwarder, forwardPaymentNative(recipient, gross), value == gross", async () => {
    const steps = await buildOf(inputs(RECIPIENT, parseEther("1")));
    expect(steps).toHaveLength(1);
    expect(steps[0].tx.to.toLowerCase()).toBe(FORWARDER.toLowerCase());
    expect(steps[0].tx.value).toBe(parseEther("1").toString());
    const d = decodeFunctionData({ abi: FWD_ABI, data: steps[0].tx.data });
    expect(d.functionName).toBe("forwardPaymentNative");
    const [recipient, amount] = d.args as [string, bigint, string];
    expect(recipient.toLowerCase()).toBe(RECIPIENT);
    expect(amount).toBe(parseEther("1"));
  });
  it("ERC-20: EXACT approve(forwarder, gross) then forwardPayment(token, recipient, gross); passes Layer B", async () => {
    const a = await transfer();
    const steps = await buildOf(inputs(RECIPIENT, usdc("20"), USDC));
    expect(steps.map((s) => s.kind)).toEqual(["approve", "action"]);
    const [spender, approved] = decodeFunctionData({ abi: APPROVE_ABI, data: steps[0].tx.data }).args as [string, bigint];
    expect(spender.toLowerCase()).toBe(FORWARDER.toLowerCase());
    expect(approved).toBe(usdc("20"));
    expect(steps[0].approval).toEqual({ token: expect.stringMatching(/0x754704bc/i), spender: expect.stringMatching(/0x8b2c7e8f/i), amount: "20000000" });
    const d = decodeFunctionData({ abi: FWD_ABI, data: steps[1].tx.data });
    expect(d.functionName).toBe("forwardPayment");
    const [token, recipient, amount] = d.args as [string, string, bigint, string];
    expect([token.toLowerCase(), recipient.toLowerCase(), amount]).toEqual([USDC, RECIPIENT, usdc("20")]);
    expect(steps[1].tx.value).toBe("0");
    const { validateSteps } = await import("@/lib/sdk/validate");
    const { getProtocol } = await import("@/lib/sdk/registry");
    expect(validateSteps(steps, a, getProtocol("payai")!).ok).toBe(true);
  });
  it("ERC-20: an existing allowance that already covers the amount skips the approval, like today's send", async () => {
    onchain.allowance = usdc("20");
    const a = await transfer();
    const i = inputs(RECIPIENT, usdc("20"), USDC);
    // The build route passes the session wallet; with it, the allowance is checked.
    expect((await a.build(i, await a.quote(i), { wallet: WALLET })).map((s) => s.kind)).toEqual(["action"]);
    // Without a wallet the allowance can't be checked — approve exactly, never skip on a guess.
    expect((await a.build(i, await a.quote(i))).map((s) => s.kind)).toEqual(["approve", "action"]);
    // An allowance one unit short still approves.
    onchain.allowance = usdc("20") - 1n;
    expect((await a.build(i, await a.quote(i), { wallet: WALLET })).map((s) => s.kind)).toEqual(["approve", "action"]);
  });
  it("build refuses without the quote's fee terms, or with terms that don't match", async () => {
    const a = await transfer();
    const i = inputs(RECIPIENT, usdc("20"), USDC);
    await expect(a.build(i, { summary: "", details: {}, quotedAt: Date.now() })).rejects.toThrow(/fee terms/i);
    const q = await a.quote(i);
    await expect(a.build(i, { ...q, terms: { ...q.terms!, fee: "1" } })).rejects.toThrow(/fee terms/i);
  });
});

/* ── Inputs and recipients ─────────────────────────────────────────────── */

describe("invalid inputs", () => {
  const layerA = async (i: unknown) => {
    const { validateInputs } = await import("@/lib/sdk/validate");
    return validateInputs((await transfer()).inputSchema, i as never);
  };
  it("zero, malformed and decimal amounts", async () => {
    for (const amount of ["0", "-1", "1.5", "1e6", "abc", ""]) expect((await layerA({ recipient: RECIPIENT, amount })).ok, amount).toBe(false);
  });
  it("unknown / extra inputs (to, data, spender, value)", async () => {
    for (const extra of ["to", "data", "spender", "value", "memo"]) {
      const r = await layerA({ recipient: RECIPIENT, amount: "1", [extra]: RECIPIENT });
      expect(r.ok, extra).toBe(false);
      if (!r.ok) expect(r.code).toBe("UNKNOWN_PARAMETER");
    }
  });
  it("malformed recipient", async () => {
    expect((await layerA({ recipient: "alice", amount: "1" })).ok).toBe(false);
  });
  it("unknown token: only native MON and PayAI's configured stablecoin", async () => {
    await expect((await transfer()).quote(inputs(RECIPIENT, 1000n, OTHER))).rejects.toThrow(/token/i);
  });
  it("zero address, the forwarder itself, and the token contract are refused as recipients", async () => {
    const a = await transfer();
    await expect(a.quote(inputs(NATIVE, 1000n))).rejects.toThrow(/zero address/);
    await expect(a.quote(inputs(FORWARDER, 1000n))).rejects.toThrow(/forwarder/i);
    await expect(a.quote(inputs(USDC, 1000n, USDC))).rejects.toThrow(/token contract/i);
  });
  it("wrong chain: a request for another chain is refused by the registry gate", async () => {
    const a = await transfer();
    const { resolveExecutable } = await import("@/lib/sdk/validate");
    const r = resolveExecutable({ ...ID, inputs: {}, walletAddress: WALLET, chainId: 10143, quotedAt: Date.now() }, 143);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("CHAIN_MISMATCH");
    expect(a.chainId).toBe(143);
  });
});

describe("recipient provenance through the Intent IR (Phase 0 / 2A rules) — with the REAL action", () => {
  const graph = (recipient: Record<string, unknown>, text: string) => ({
    id: "intent_transfer_01", version: 1, chainId: 143, wallet: WALLET, status: "draft",
    source: { text, adapter: "deterministic", adapterVersion: "1" },
    nodes: [{
      nodeId: "n1", ref: ID, dependsOn: [],
      inputs: { recipient, token: { kind: "literal", value: USDC }, amount: { kind: "literal", value: "20000000" } },
      validation: { state: "pending" }, execution: { state: "pending" }, verification: { state: "pending" },
    }],
  });
  const validate = async (g: unknown) => {
    await transfer();
    const { validateIntentGraph } = await import("@/lib/plan/validate");
    return validateIntentGraph(g, { sessionWallet: WALLET, activeChainId: 143 });
  };
  it("explicit address the user typed, a .nad name, and a configured payee are all representable", async () => {
    expect((await validate(graph({ kind: "recipient", display: RECIPIENT, source: "address", address: RECIPIENT }, `send 20 USDC to ${RECIPIENT}`))).ok).toBe(true);
    expect((await validate(graph({ kind: "recipient", display: "alice.nad", source: "nad" }, "send 20 USDC to alice.nad"))).ok).toBe(true);
    expect((await validate(graph({ kind: "recipient", display: "treasury", source: "payee" }, "send 20 USDC to treasury"))).ok).toBe(true);
  });
  it("an invented recipient — not in the user's text — is refused", async () => {
    const r = await validate(graph({ kind: "recipient", display: OTHER, source: "address", address: OTHER }, `send 20 USDC to ${RECIPIENT}`));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("RECIPIENT_PROVENANCE");
  });
  it("a raw literal address (no provenance) is refused", async () => {
    const r = await validate(graph({ kind: "literal", value: RECIPIENT }, `send 20 USDC to ${RECIPIENT}`));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_RECIPIENT");
  });
  it("planner compatibility: swap → transfer is structurally valid (transfer.amount = swap.amountOut)", async () => {
    await transfer();
    const { registerProtocol } = await import("@/lib/sdk/registry");
    const notCalled = async (): Promise<never> => { throw new Error("not callable"); };
    const swap: ProtocolAdapter = {
      protocolId: "payai-swap", name: "swap fixture", chainId: 143, allowedTargets: ["0x00000000000000000000000000000000000000f1"],
      actions: [{
        protocolId: "payai-swap", actionId: "swap", version: "1.0.0", name: "Swap", description: "fixture", chainId: 143,
        allowedTargets: ["0x00000000000000000000000000000000000000f1"],
        inputSchema: { tokenOut: { type: "token", required: true, description: "out" }, amountIn: { type: "units", required: true, description: "in" } },
        outputs: { amountOut: { type: "units", description: "out", denominatedIn: { input: "tokenOut" } } },
        quote: notCalled, build: notCalled, parseResult: notCalled,
      }],
    };
    registerProtocol(swap);
    const { validateIntentGraph } = await import("@/lib/plan/validate");
    const text = `swap 10 MON to USDC and send the USDC to ${RECIPIENT}`;
    const r = validateIntentGraph({
      id: "intent_swap_xfer", version: 1, chainId: 143, wallet: WALLET, status: "draft",
      source: { text, adapter: "deterministic", adapterVersion: "1" },
      nodes: [
        { nodeId: "n1", ref: { protocolId: "payai-swap", actionId: "swap", version: "1.0.0" }, dependsOn: [], inputs: { tokenOut: { kind: "literal", value: USDC }, amountIn: { kind: "literal", value: "1" } }, validation: { state: "pending" }, execution: { state: "pending" }, verification: { state: "pending" } },
        { nodeId: "n2", ref: ID, dependsOn: ["n1"], inputs: { recipient: { kind: "recipient", display: RECIPIENT, source: "address", address: RECIPIENT }, token: { kind: "literal", value: USDC }, amount: { kind: "output", node: "n1", output: "amountOut" } }, validation: { state: "pending" }, execution: { state: "pending" }, verification: { state: "pending" } },
      ],
    }, { sessionWallet: WALLET, activeChainId: 143 });
    expect(r.ok).toBe(true);
  });
});

/* ── Layer B: nothing arbitrary can reach a signer ─────────────────────── */

describe("Layer B rejects a hostile or buggy transfer build", () => {
  async function check(steps: Parameters<Action["build"]> extends never ? never : import("@/lib/sdk/types").UnsignedActionStep[]) {
    const a = await transfer();
    const { validateSteps } = await import("@/lib/sdk/validate");
    const { getProtocol } = await import("@/lib/sdk/registry");
    return validateSteps(steps, a, getProtocol("payai")!);
  }
  const approve = (spender: string, amount: bigint, declared = amount) => ({
    kind: "approve" as const, label: "a",
    tx: { to: USDC as `0x${string}`, data: encodeFunctionData({ abi: APPROVE_ABI, functionName: "approve", args: [spender as `0x${string}`, amount] }), value: "0" },
    approval: { token: USDC as `0x${string}`, spender: spender as `0x${string}`, amount: declared.toString() },
  });
  const forward = (to = FORWARDER, data: `0x${string}` = "0xdeadbeef") => ({ kind: "action" as const, label: "f", tx: { to: to as `0x${string}`, data, value: "0" } });

  it("arbitrary target", async () => { expect((await check([forward(OTHER)])).ok).toBe(false); });
  it("arbitrary calldata to an arbitrary contract", async () => { expect((await check([forward(OTHER, "0xa9059cbb")])).ok).toBe(false); });
  it("arbitrary spender", async () => { expect((await check([approve(OTHER, usdc("20")), forward()])).ok).toBe(false); });
  it("unlimited approval", async () => { expect((await check([approve(FORWARDER, maxUint256), forward()])).ok).toBe(false); });
  it("approval whose calldata doesn't match its declaration", async () => { expect((await check([approve(FORWARDER, usdc("20"), usdc("19")), forward()])).ok).toBe(false); });
});

/* ── Through the real preview → build → confirm routes ─────────────────── */

describe("quote → build → sign → receipt → canonical result → history", () => {
  const post = (url: string, body: unknown) => new NextRequest(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const I = inputs(RECIPIENT, usdc("20"), USDC);

  async function preview(i = I) {
    await transfer();
    const { POST } = await import("@/app/api/ask/action/route");
    return (await POST(post("https://usepayai.xyz/api/ask/action", { ...ID, inputs: i }))).json();
  }
  async function build(quoteToken: string, i = I) {
    const { POST } = await import("@/app/api/ask/action/build/route");
    const res = await POST(post("https://usepayai.xyz/api/ask/action/build", { ...ID, inputs: i, walletAddress: WALLET, quoteToken }));
    return { status: res.status, json: await res.json() };
  }
  async function confirm(quoteId: string, txHash: string, wallet = WALLET) {
    const { POST } = await import("@/app/api/ask/action/confirm/route");
    const res = await POST(post("https://usepayai.xyz/api/ask/action/confirm", { ...ID, txHash, walletAddress: wallet, quoteId }));
    return { status: res.status, json: await res.json() };
  }

  function forwarderLogs(opts: { emitter?: string; recipient?: string; amount?: bigint; fee?: bigint } = {}) {
    const emitter = opts.emitter ?? FORWARDER;
    const id = 77n;
    const pf = {
      address: emitter,
      topics: [
        toEventSelector("PaymentForwarded(uint256,address,address,address,uint256,bytes32)"),
        encodeAbiParameters([{ type: "uint256" }], [id]),
        encodeAbiParameters([{ type: "address" }], [WALLET as `0x${string}`]),
        encodeAbiParameters([{ type: "address" }], [(opts.recipient ?? RECIPIENT) as `0x${string}`]),
      ],
      data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes32" }], [USDC as `0x${string}`, opts.amount ?? usdc("20"), `0x${"0".repeat(64)}`]),
    };
    const fc = {
      address: emitter,
      topics: [toEventSelector("FeeCollected(uint256,address,uint256,address)"), encodeAbiParameters([{ type: "uint256" }], [id])],
      data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "address" }], [USDC as `0x${string}`, opts.fee ?? usdc("0.05"), TREASURY as `0x${string}`]),
    };
    return [pf, fc];
  }
  function mine(final: { tx: { to: string; data: string; value: string } }, logs = forwarderLogs(), from = WALLET) {
    chain.tx = { from, to: final.tx.to, input: final.tx.data, value: BigInt(final.tx.value) };
    chain.receipt = { status: "success", from, logs };
  }
  async function historyFor(txHash: string) {
    const { listTx } = await import("@/lib/platform/store");
    return (await listTx("demo", { sender: WALLET })).filter((t) => t.txHash === txHash);
  }

  it("end to end: canonical result + ONE history row shaped like today's send (send_payment, gross amount) with the fee on the settlement", async () => {
    const pj = await preview();
    expect(pj.ok).toBe(true);
    expect(pj.details["recipient receives"]).toBe("19.95 USDC");
    const b = await build(pj.quoteToken);
    expect(b.json.ok).toBe(true);
    mine(b.json.steps[b.json.steps.length - 1]);
    const hash = `0x${"1".repeat(64)}`;
    const c = await confirm(b.json.quoteId, hash);
    expect(c.json.ok).toBe(true);
    expect(c.json.details).toMatchObject({ recipient: expect.stringMatching(/0x5e0d39b4/i), "you sent": "20 USDC", "platform fee": "0.05 USDC", "recipient received": "19.95 USDC", transaction: hash });
    expect(c.json.details.treasury.toLowerCase()).toBe(TREASURY.toLowerCase());

    const rows = await historyFor(hash);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "send_payment", feature: "payment", amount: 20, token: "USDC", decision: "executed" });
    expect(rows[0].recipient?.toLowerCase()).toBe(RECIPIENT);
    expect(rows[0].settlement).toMatchObject({ recipientCount: 1, recipientTotal: "19950000", platformFee: "50000", grossPaid: "20000000" });
  });

  it("duplicate execution: one build per quote; confirming the same tx twice records history once", async () => {
    const pj = await preview();
    const b = await build(pj.quoteToken);
    expect((await build(pj.quoteToken)).json.code).toBe("ALREADY_BUILT");
    mine(b.json.steps[b.json.steps.length - 1]);
    const hash = `0x${"2".repeat(64)}`;
    expect((await confirm(b.json.quoteId, hash)).json.ok).toBe(true);
    expect((await confirm(b.json.quoteId, hash)).json.replayed).toBe(true);
    expect(await historyFor(hash)).toHaveLength(1);
  });

  it("stale quote is refused", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
    const pj = await preview();
    vi.setSystemTime(new Date("2026-10-01T12:10:00Z"));
    expect((await build(pj.quoteToken)).json.code).toBe("QUOTE_STALE");
  });

  it("missing quote token, and a fee-term change since preview, are refused", async () => {
    const { POST } = await import("@/app/api/ask/action/build/route");
    const res = await POST(post("https://usepayai.xyz/api/ask/action/build", { ...ID, inputs: I, walletAddress: WALLET }));
    expect((await res.json()).code).toBe("QUOTE_REQUIRED");
    const pj = await preview();
    onchain.feeBps = 30n;
    (await import("@/lib/sdk/fees")).__resetPlatformFeeCacheForTests();
    expect((await build(pj.quoteToken)).json.code).toBe("FEE_TERMS_CHANGED");
  });

  it("receipt sender mismatch is refused, and nothing is recorded", async () => {
    const pj = await preview();
    const b = await build(pj.quoteToken);
    mine(b.json.steps[b.json.steps.length - 1], forwarderLogs(), OTHER);
    const hash = `0x${"3".repeat(64)}`;
    expect((await confirm(b.json.quoteId, hash)).status).toBe(409);
    expect(await historyFor(hash)).toHaveLength(0);
  });

  it("incorrect transfer log (wrong emitter, recipient or amount) is never reported as a settled transfer", async () => {
    for (const [n, logs] of [
      [4, forwarderLogs({ emitter: OTHER })],
      [5, forwarderLogs({ recipient: OTHER })],
      [6, forwarderLogs({ amount: usdc("19") })],
    ] as const) {
      const pj = await preview();
      const b = await build(pj.quoteToken);
      mine(b.json.steps[b.json.steps.length - 1], logs as never);
      const hash = `0x${String(n).repeat(64)}`;
      const c = await confirm(b.json.quoteId, hash);
      expect(c.json.ok, `case ${n}`).toBe(false);
      expect(await historyFor(hash)).toHaveLength(0);
    }
  });
});
