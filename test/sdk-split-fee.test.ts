import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { decodeFunctionData, encodeAbiParameters, parseEther, parseUnits, toEventSelector } from "viem";

/**
 * PayAI's 0.25% platform fee on split payments — charged ON TOP of the
 * user's exact recipient amounts, as ONE extra treasury leg in the same
 * atomic SplitSettlement transaction (no contract change):
 *
 *   fee = floor(recipientTotal * feeBps / 10000)        (no gross-up)
 *
 * feeBps and treasury come from the live on-chain fee configuration (the
 * wired PayAIForwarderV2's feeBps()/treasury()) — never a second rate. The
 * fee terms are bound into the signed quote, so a change between preview and
 * build refuses the build. The confirmed result and history separate the fee
 * from the recipients.
 */

const CANONICAL = "0xaC98a844E0F9688EA9758Db05c134b8B4BCeAf6F";
const TREASURY = "0xA282833B52b1B66D58bD2007081dCC037798C0b0";
const FORWARDER = "0x8b2c7E8FA09fCd664dbA9764FD63Bf3A4c56464D";
const USDC = "0x754704bc059f5a0ce29e278a6d0eba96b6aafb60";
const NATIVE = "0x0000000000000000000000000000000000000000";
const WALLET = "0x6b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c";
const A = "0x5e0d39b4c1a2f3e4d5c6b7a8f9e0d1c2b3a4f5e6";
const B = "0x7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b";

vi.mock("@/lib/platform/ratelimit", () => ({ rateLimited: async () => null }));
vi.mock("@/lib/payment/sanctions", () => ({
  ensureSanctionsLoaded: async () => {}, isSanctionedAddress: () => false, sanctionsListLoaded: () => true,
}));

/** The live on-chain fee configuration, as the stubbed RPC reports it. */
const onchain = { feeBps: 25n as bigint, treasury: TREASURY as string, fail: false };
const chain: {
  tx?: { from: string; to: string | null; input: string; value: bigint };
  receipt?: { status: "success" | "reverted"; from: string; logs: { address: string; topics: string[]; data: string }[] };
} = {};
vi.mock("@/lib/monad/wallet", () => ({
  getPublicClient: () => ({
    readContract: async ({ functionName }: { functionName: string }) => {
      if (onchain.fail) throw new Error("rpc down");
      if (functionName === "feeBps") return onchain.feeBps;
      if (functionName === "treasury") return onchain.treasury;
      throw new Error(`unexpected read ${functionName}`);
    },
    waitForTransactionReceipt: async () => chain.receipt,
    getTransaction: async () => chain.tx,
  }),
}));

const SPLIT_ABI = [{ type: "function", name: "splitPayment", stateMutability: "payable", inputs: [{ name: "token", type: "address" }, { name: "recipients", type: "address[]" }, { name: "amounts", type: "uint256[]" }, { name: "ref", type: "bytes32" }], outputs: [{ type: "uint256" }] }] as const;
const APPROVE_ABI = [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }] as const;

const ENV = ["MONAD_NETWORK", "MONAD_MAINNET_USDC", "MONAD_MAINNET_PAYAI_FORWARDER", "PAYAI_TREASURY_ADDRESS"] as const;
let saved: Record<string, string | undefined>;
beforeEach(async () => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  process.env.MONAD_NETWORK = "mainnet";
  process.env.MONAD_MAINNET_USDC = USDC;
  process.env.MONAD_MAINNET_PAYAI_FORWARDER = FORWARDER;
  delete process.env.PAYAI_TREASURY_ADDRESS;
  onchain.feeBps = 25n; onchain.treasury = TREASURY; onchain.fail = false;
  delete chain.tx; delete chain.receipt;
  (globalThis as unknown as { __veripayIdem?: Map<string, unknown> }).__veripayIdem?.clear();
  const fee = await import("@/lib/sdk/actions/split-settlement/fee");
  fee.__resetSplitFeeCacheForTests();
  const { __resetRegistryForTests } = await import("@/lib/sdk/registry");
  const { __resetBootstrapForTests } = await import("@/lib/sdk/bootstrap");
  __resetRegistryForTests();
  __resetBootstrapForTests();
});
afterEach(async () => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  vi.useRealTimers();
});

async function action() {
  const { ensureBuiltinsRegistered } = await import("@/lib/sdk/bootstrap");
  const { getAction } = await import("@/lib/sdk/registry");
  ensureBuiltinsRegistered();
  const a = getAction("payai-settlement", "split_payment", "2.0.0");
  if (!a) throw new Error("split not registered");
  return a;
}
const list = (token: string | null, ...pairs: [string, bigint][]) => ({
  ...(token ? { token } : {}),
  recipients: pairs.map(([recipient, amount]) => ({ recipient, amount: amount.toString() })),
});
const usdc = (n: string) => parseUnits(n, 6);

describe("fee calculation: floor(recipientTotal * feeBps / 10000), on top", () => {
  it("worked examples at 25 bps", async () => {
    const { splitPlatformFee } = await import("@/lib/sdk/actions/split-settlement/fee");
    expect(splitPlatformFee(usdc("100"), 25)).toBe(usdc("0.25"));      // 100 USDC  → 0.25 USDC
    expect(splitPlatformFee(usdc("20"), 25)).toBe(usdc("0.05"));       // 20 USDC   → 0.05 USDC
    expect(splitPlatformFee(usdc("33.333333"), 25)).toBe(83333n);      // floor(83333.3325)
    expect(splitPlatformFee(parseEther("1"), 25)).toBe(parseEther("0.0025"));
    expect(splitPlatformFee(399n, 25)).toBe(0n);                        // rounds down to zero
    expect(splitPlatformFee(400n, 25)).toBe(1n);
    expect(splitPlatformFee(usdc("100"), 0)).toBe(0n);
  });
});

describe("live fee terms are the authoritative source", () => {
  it("reads feeBps() and treasury() from the wired forwarder", async () => {
    const { readSplitFeeTerms } = await import("@/lib/sdk/actions/split-settlement/fee");
    const t = await readSplitFeeTerms();
    expect(t.feeBps).toBe(25);
    expect(t.treasury.toLowerCase()).toBe(TREASURY.toLowerCase());
    expect(t.source.toLowerCase()).toBe(FORWARDER.toLowerCase());
  });
  it("fails closed when PAYAI_TREASURY_ADDRESS is set and does not match the on-chain treasury", async () => {
    process.env.PAYAI_TREASURY_ADDRESS = "0x1d2c3b4a5f6e7d8c9b0a1f2e3d4c5b6a7f8e9d0c";
    const { readSplitFeeTerms } = await import("@/lib/sdk/actions/split-settlement/fee");
    await expect(readSplitFeeTerms()).rejects.toThrow(/treasury/i);
  });
  it("accepts a matching PAYAI_TREASURY_ADDRESS (case-insensitive)", async () => {
    process.env.PAYAI_TREASURY_ADDRESS = TREASURY.toLowerCase();
    const { readSplitFeeTerms } = await import("@/lib/sdk/actions/split-settlement/fee");
    await expect(readSplitFeeTerms()).resolves.toMatchObject({ feeBps: 25 });
  });
  it("fails closed when the fee config can't be read, is out of range, or the forwarder isn't configured", async () => {
    const fee = await import("@/lib/sdk/actions/split-settlement/fee");
    onchain.fail = true;
    await expect(fee.readSplitFeeTerms()).rejects.toThrow();
    onchain.fail = false; fee.__resetSplitFeeCacheForTests();
    onchain.feeBps = 101n;
    await expect(fee.readSplitFeeTerms()).rejects.toThrow();
    onchain.feeBps = 25n; fee.__resetSplitFeeCacheForTests();
    onchain.treasury = NATIVE;
    await expect(fee.readSplitFeeTerms()).rejects.toThrow();
    onchain.treasury = TREASURY; fee.__resetSplitFeeCacheForTests();
    delete process.env.MONAD_MAINNET_PAYAI_FORWARDER;
    await expect(fee.readSplitFeeTerms()).rejects.toThrow();
  });
});

describe("quote and build", () => {
  it("quote shows the platform fee and total you pay, and carries the fee terms", async () => {
    const a = await action();
    const q = await a.quote(list(USDC, [A, usdc("20")], [B, usdc("80")]));
    expect(q.details["platform fee"]).toBe("0.25 USDC");
    expect(q.details["total you pay"]).toBe("100.25 USDC");
    expect(q.details.total).toBe("100 USDC");
    expect(q.terms).toMatchObject({ feeBps: "25", treasury: TREASURY.toLowerCase(), fee: "250000", recipientTotal: "100000000", gross: "100250000" });
  });

  it("ERC-20: recipients receive EXACTLY their amounts; one treasury leg; approval == gross", async () => {
    const a = await action();
    const inputs = list(USDC, [A, usdc("20")], [B, usdc("80")]);
    const q = await a.quote(inputs);
    const steps = await a.build(inputs, q);
    const [spender, approved] = decodeFunctionData({ abi: APPROVE_ABI, data: steps[0].tx.data }).args as [string, bigint];
    expect(spender.toLowerCase()).toBe(CANONICAL.toLowerCase());
    expect(approved).toBe(usdc("100.25"));
    expect(steps[0].approval?.amount).toBe(usdc("100.25").toString());
    const [, recipients, amounts] = decodeFunctionData({ abi: SPLIT_ABI, data: steps[1].tx.data }).args as [string, string[], bigint[], string];
    expect(recipients.map((r) => r.toLowerCase())).toEqual([A, B, TREASURY.toLowerCase()]);
    expect(amounts).toEqual([usdc("20"), usdc("80"), usdc("0.25")]);
    expect(steps[1].tx.value).toBe("0");
  });

  it("native MON: value == recipients + fee, fee leg last", async () => {
    const a = await action();
    const inputs = list(null, [A, parseEther("1")], [B, parseEther("3")]);
    const steps = await a.build(inputs, await a.quote(inputs));
    expect(steps).toHaveLength(1);
    expect(steps[0].tx.value).toBe(parseEther("4.01").toString());
    const [, recipients, amounts] = decodeFunctionData({ abi: SPLIT_ABI, data: steps[0].tx.data }).args as [string, string[], bigint[], string];
    expect(recipients[2].toLowerCase()).toBe(TREASURY.toLowerCase());
    expect(amounts).toEqual([parseEther("1"), parseEther("3"), parseEther("0.01")]);
  });

  it("a fee that floors to zero adds no treasury leg (the contract rejects zero amounts)", async () => {
    const a = await action();
    const inputs = list(USDC, [A, 100n], [B, 200n]);
    const q = await a.quote(inputs);
    expect(q.terms?.fee).toBe("0");
    const steps = await a.build(inputs, q);
    const [, recipients] = decodeFunctionData({ abi: SPLIT_ABI, data: steps[1].tx.data }).args as [string, string[], bigint[], string];
    expect(recipients).toHaveLength(2);
  });

  it("build refuses without fee terms, or with terms that don't match the inputs", async () => {
    const a = await action();
    const inputs = list(USDC, [A, usdc("20")], [B, usdc("80")]);
    await expect(a.build(inputs, { summary: "", details: {}, quotedAt: Date.now() })).rejects.toThrow(/fee terms/i);
    const q = await a.quote(inputs);
    await expect(a.build(inputs, { ...q, terms: { ...q.terms!, fee: "1" } })).rejects.toThrow(/fee terms/i);
  });

  it("at most 9 user recipients — rejected at Layer A and at quote, before any transaction exists", async () => {
    const a = await action();
    const { validateInputs } = await import("@/lib/sdk/validate");
    const ten = Array.from({ length: 10 }, (_, i) => [`0x${(i + 16).toString(16)}${"ab".repeat(19)}`, 1000n] as [string, bigint]);
    expect(validateInputs(a.inputSchema, list(USDC, ...ten)).ok).toBe(false);
    await expect(a.quote(list(USDC, ...ten))).rejects.toThrow(/between 2 and 9/);
    expect(validateInputs(a.inputSchema, list(USDC, ...ten.slice(0, 9))).ok).toBe(true);
  });

  it("the treasury can't be named as a user recipient (the fee leg stays unambiguous)", async () => {
    const a = await action();
    await expect(a.quote(list(USDC, [A, usdc("1")], [TREASURY, usdc("1")]))).rejects.toThrow(/treasury/i);
  });

  it("policy outflows are the user's recipients only — the fee leg isn't a payment to screen", async () => {
    const a = await action();
    const out = await a.outflows!(list(USDC, [A, usdc("20")], [B, usdc("80")]));
    expect(out.map((o) => o.recipient.toLowerCase())).toEqual([A, B]);
  });
});

describe("routes: fee terms bound preview → build", () => {
  const post = (url: string, body: unknown) => new NextRequest(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const ID = { protocolId: "payai-settlement", actionId: "split_payment", version: "2.0.0" };
  const INPUTS = list(USDC, [A, usdc("20")], [B, usdc("80")]);

  async function preview() {
    const { POST } = await import("@/app/api/ask/action/route");
    return (await POST(post("https://usepayai.xyz/api/ask/action", { ...ID, inputs: INPUTS }))).json();
  }
  async function build(quoteToken: string) {
    const { POST } = await import("@/app/api/ask/action/build/route");
    return (await POST(post("https://usepayai.xyz/api/ask/action/build", { ...ID, inputs: INPUTS, walletAddress: WALLET, quoteToken }))).json();
  }

  it("unchanged terms build normally", async () => {
    const pj = await preview();
    expect(pj.ok).toBe(true);
    expect(pj.details["platform fee"]).toBe("0.25 USDC");
    expect((await build(pj.quoteToken)).ok).toBe(true);
  });

  it("a fee-rate change between preview and build refuses the build", async () => {
    const pj = await preview();
    onchain.feeBps = 30n;
    (await import("@/lib/sdk/actions/split-settlement/fee")).__resetSplitFeeCacheForTests();
    const bj = await build(pj.quoteToken);
    expect(bj.ok).toBe(false);
    expect(bj.code).toBe("FEE_TERMS_CHANGED");
    expect(bj.steps).toBeUndefined();
  });

  it("a treasury change between preview and build refuses the build", async () => {
    const pj = await preview();
    onchain.treasury = "0x1d2c3b4a5f6e7d8c9b0a1f2e3d4c5b6a7f8e9d0c";
    (await import("@/lib/sdk/actions/split-settlement/fee")).__resetSplitFeeCacheForTests();
    const bj = await build(pj.quoteToken);
    expect(bj.ok).toBe(false);
    expect(bj.code).toBe("FEE_TERMS_CHANGED");
  });

  it("after a refused build the same preview can't be retried into a build (fresh preview required)", async () => {
    const pj = await preview();
    onchain.feeBps = 30n;
    (await import("@/lib/sdk/actions/split-settlement/fee")).__resetSplitFeeCacheForTests();
    expect((await build(pj.quoteToken)).code).toBe("FEE_TERMS_CHANGED");
    // Even once the terms are back, this preview is spent — no build on it.
    onchain.feeBps = 25n;
    (await import("@/lib/sdk/actions/split-settlement/fee")).__resetSplitFeeCacheForTests();
    const again = await build(pj.quoteToken);
    expect(again.ok).toBe(false);
    expect(again.code).toBe("ALREADY_BUILT");
  });
});

describe("confirmed result and history separate the fee from recipients", () => {
  function eventLog(token: string, recipients: string[], amounts: bigint[]) {
    const topics = [
      toEventSelector("SplitPaymentExecuted(uint256,address,address,bytes32,uint256,address[],uint256[])"),
      encodeAbiParameters([{ type: "uint256" }], [9n]),
      encodeAbiParameters([{ type: "address" }], [WALLET as `0x${string}`]),
      encodeAbiParameters([{ type: "address" }], [token as `0x${string}`]),
    ];
    const data = encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "address[]" }, { type: "uint256[]" }],
      [`0x${"0".repeat(64)}`, amounts.reduce((s, x) => s + x, 0n), recipients as `0x${string}`[], amounts],
    );
    return { address: CANONICAL, topics, data };
  }

  it("parseResult with the build's terms reports recipients, recipient total, fee, treasury, gross and tx", async () => {
    const a = await action();
    const q = await a.quote(INPUTS_USDC());
    const receipt = { status: "success" as const, txHash: `0x${"c".repeat(64)}` as `0x${string}`, logs: [eventLog(USDC, [A, B, TREASURY.toLowerCase()], [usdc("20"), usdc("80"), usdc("0.25")])] as never };
    const out = await a.parseResult(receipt, { terms: q.terms });
    expect(out.recipientCount).toBe("2");
    expect(out["recipient 1"].toLowerCase()).toBe(A);
    expect(out["recipient 3"]).toBeUndefined();
    expect(out["recipients total"]).toBe("100 USDC");
    expect(out["platform fee"]).toBe("0.25 USDC");
    expect(out.treasury.toLowerCase()).toBe(TREASURY.toLowerCase());
    expect(out["total paid"]).toBe("100.25 USDC");
    expect(out.transaction).toBe(receipt.txHash);
    const settled = await a.settledOutflows!(receipt, { terms: q.terms });
    expect(settled.recipients.map((r) => r.recipient.toLowerCase())).toEqual([A, B]);
    expect(settled.fee).toMatchObject({ amountUnits: usdc("0.25") });
    expect(settled.fee?.treasury.toLowerCase()).toBe(TREASURY.toLowerCase());
  });

  it("end to end: history has one row per RECIPIENT, never the treasury, with the fee on the settlement", async () => {
    const post = (url: string, body: unknown) => new NextRequest(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const ID = { protocolId: "payai-settlement", actionId: "split_payment", version: "2.0.0" };
    const { POST: previewRoute } = await import("@/app/api/ask/action/route");
    const pj = await (await previewRoute(post("https://usepayai.xyz/api/ask/action", { ...ID, inputs: INPUTS_USDC() }))).json();
    const { POST: buildRoute } = await import("@/app/api/ask/action/build/route");
    const bj = await (await buildRoute(post("https://usepayai.xyz/api/ask/action/build", { ...ID, inputs: INPUTS_USDC(), walletAddress: WALLET, quoteToken: pj.quoteToken }))).json();
    expect(bj.ok).toBe(true);
    const final = bj.steps[bj.steps.length - 1];
    const [, recipients, amounts] = decodeFunctionData({ abi: SPLIT_ABI, data: final.tx.data }).args as [string, string[], bigint[], string];
    chain.tx = { from: WALLET, to: final.tx.to, input: final.tx.data, value: BigInt(final.tx.value) };
    chain.receipt = { status: "success", from: WALLET, logs: [eventLog(USDC, recipients.map((r) => r.toLowerCase()), amounts)] };
    const txHash = `0x${"d".repeat(64)}`;
    const { POST: confirmRoute } = await import("@/app/api/ask/action/confirm/route");
    const cj = await (await confirmRoute(post("https://usepayai.xyz/api/ask/action/confirm", { ...ID, txHash, walletAddress: WALLET, quoteId: bj.quoteId }))).json();
    expect(cj.ok).toBe(true);
    expect(cj.details["platform fee"]).toBe("0.25 USDC");
    expect(cj.recorded).toBe(2);

    const { listTx } = await import("@/lib/platform/store");
    const rows = (await listTx("demo", { sender: WALLET })).filter((t) => t.txHash === txHash);
    expect(rows.map((r) => r.recipient?.toLowerCase()).sort()).toEqual([A, B].sort());
    expect(rows.every((r) => r.recipient?.toLowerCase() !== TREASURY.toLowerCase())).toBe(true);
    expect(rows.map((r) => r.amount).sort()).toEqual([20, 80]);
    for (const r of rows) {
      expect(r.settlement).toMatchObject({ recipientCount: 2, recipientTotal: "100000000", platformFee: "250000", grossPaid: "100250000", decimals: 6, token: "USDC" });
      expect(r.settlement?.treasury?.toLowerCase()).toBe(TREASURY.toLowerCase());
    }
  });
});

function INPUTS_USDC() {
  return { token: USDC, recipients: [{ recipient: A, amount: usdc("20").toString() }, { recipient: B, amount: usdc("80").toString() }] };
}
