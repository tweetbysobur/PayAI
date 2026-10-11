import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { encodeFunctionData, getAddress, pad, parseAbi, type Hex } from "viem";
import { grantCookieFor } from "./walletGrantCookie";

/**
 * /api/agent's client-chosen idempotencyKey is stored in its own namespace
 * (agentRequestKey: tenant + wallet scoped, hashed), never as a raw key in the
 * store every route shares — so a client cannot read, replay or occupy a
 * server-owned key (`sdk-settle:<txHash>`, `sdk-build:<quoteId>`,
 * `confirm:<txHash>`, `swap-settle:`, `link-settle:`, …). /api/agent/confirm
 * reads the approval it replays through the same function.
 *
 * MOCKED: the wallet balance checks, the forwarder's fee-terms read, the
 * allowance read and the chain client. No RPC is touched and nothing is
 * signed or sent. Everything else is the real route code and the real
 * in-memory idempotency store.
 */

vi.setConfig({ testTimeout: 20_000 });

const WALLET = getAddress("0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
const OTHER_WALLET = getAddress("0x90f79bf6eb2c4f870365e785982e1f101e93b906");
const RECIPIENT = getAddress("0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc");
const USDC = getAddress("0x754704bc059f8c67012fed69bc8a327a5aafb603");
const FORWARDER = getAddress("0x8b2c7e8fa09fcd664dba9764fd63bf3a4c56464d");
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TX = `0x${"ab".repeat(32)}` as Hex;
const QUOTE = "0123456789abcdef0123456789abcdef";
const SEND = `Send 1 USDC to ${RECIPIENT}`;

vi.mock("@/lib/monad/balance", async (orig) => ({
  ...(await orig<typeof import("@/lib/monad/balance")>()),
  insufficientBalanceReason: async () => null,
  insufficientWithFeeReason: async () => null,
}));
vi.mock("@/lib/sdk/fees", async (orig) => ({
  ...(await orig<typeof import("@/lib/sdk/fees")>()),
  readPlatformFeeTerms: async () => ({ feeBps: 25 }),
}));
vi.mock("@/lib/monad/wallet", async (orig) => ({
  ...(await orig<typeof import("@/lib/monad/wallet")>()),
  getPublicClient: () => ({ readContract: async () => 0n }),
}));
vi.mock("@/lib/payment/sanctions", async (orig) => ({ ...(await orig<typeof import("@/lib/payment/sanctions")>()), ensureSanctionsLoaded: async () => {} }));

const chain = { receipt: null as unknown, tx: null as unknown };
vi.mock("viem", async (orig) => {
  const actual = await orig<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: () => ({
      // viem's own not-found error — what a node with no receipt produces.
      getTransactionReceipt: async () => { if (!chain.receipt) throw new actual.TransactionReceiptNotFoundError({ hash: TX }); return chain.receipt; },
      getTransaction: async () => chain.tx,
      getBlock: async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
    }),
  };
});

const ENV = ["MONAD_NETWORK", "MONAD_MAINNET_USDC", "MONAD_MAINNET_PAYAI_FORWARDER", "PAYAI_FORWARDER_ENABLED", "PAYAI_MODE", "ANTHROPIC_API_KEY", "KV_REST_API_URL", "KV_REST_API_TOKEN"] as const;

beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  process.env.MONAD_NETWORK = "mainnet";
  process.env.MONAD_MAINNET_USDC = USDC;
  vi.resetModules();
  // The in-memory store lives on globalThis and survives resetModules.
  (globalThis as { __veripayIdem?: Map<string, unknown> }).__veripayIdem?.clear();
  chain.receipt = null;
  chain.tx = null;
});

type Json = Record<string, unknown> & {
  decision?: string; replayed?: boolean; requestId?: string; success?: boolean;
  unsignedTx?: { to: string; data: string; value: string; from: string };
  trace?: { step: string; detail: string }[];
  intent?: { recipient?: string };
};
const req = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `10.2.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, ...grantCookieFor((body as { walletAddress?: unknown }).walletAddress), ...headers },
    body: JSON.stringify(body),
  });
async function agent(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const { POST } = await import("@/app/api/agent/route");
  const res = await POST(req("/api/agent", { walletAddress: WALLET, ...body }, headers));
  return { status: res.status, body: (await res.json()) as Json };
}
async function confirm(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const { POST } = await import("@/app/api/agent/confirm/route");
  const res = await POST(req("/api/agent/confirm", { rawText: SEND, walletAddress: WALLET, txHash: TX, ...body }, headers));
  return { status: res.status, body: (await res.json()) as Json };
}
const idem = () => import("@/lib/platform/idempotency");
/** The USDC payment the direct-transfer approval asks for, mined. */
function mineDirectPayment(from: string = WALLET) {
  // The mined transaction itself — the confirm route checks it against the
  // stored unsignedTx (sender, target, calldata, value), not just the logs.
  chain.tx = {
    hash: TX, from, to: USDC, value: 0n,
    input: encodeFunctionData({ abi: parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]), functionName: "transfer", args: [RECIPIENT, 1_000_000n] }),
  };
  chain.receipt = {
    status: "success", from, to: USDC, blockNumber: 7n, gasUsed: 50_000n, effectiveGasPrice: 1n,
    logs: [{ address: USDC, topics: [TRANSFER, pad(from as Hex), pad(RECIPIENT)], data: pad("0xf4240") }],
  };
}
/** The confirm route settled against the stored approval (its trace says so). */
const replayedApproval = (b: Json) => (b.trace ?? []).some((t) => t.step === "intent" && /^Approved intent/.test(t.detail));

const RESERVED = [
  `sdk-settle:${TX}`, `sdk-build:${QUOTE}`, `sdk-outputs:${QUOTE}`, `confirm:${TX}`,
  `swap-settle:${TX}`, `link-settle:${TX}`, "sch:abc:1", "automation-create:abc", "telegram-update:1", "refund-lock:abc",
];

describe("client idempotency keys never reach server-owned keys", () => {
  it("1. a client key cannot occupy a reserved key: every one stays free for the server", async () => {
    for (const k of RESERVED) await agent({ intent: "Send 20 USDC to Alice", idempotencyKey: k });
    const { claimRequest } = await idem();
    // claimed:true means nothing was there — not done, not in progress.
    for (const k of RESERVED) expect(await claimRequest(k), k).toEqual({ claimed: true });
  });

  it("2. a client key cannot read a server record back through /api/agent", async () => {
    const { completeRequest } = await idem();
    const secret = { ok: true, verdict: "SERVER-ONLY-SECRET", intent: { recipient: OTHER_WALLET } };
    for (const k of RESERVED) await completeRequest(k, secret);
    for (const k of RESERVED) {
      const r = await agent({ intent: "Send 20 USDC to Alice", idempotencyKey: k });
      expect(r.body.replayed, k).toBeUndefined();
      expect(JSON.stringify(r.body), k).not.toContain("SERVER-ONLY-SECRET");
      expect(r.body.decision, k).toBe("refused"); // a fresh run of this request, not the stored record
    }
  });

  it("2b. /api/agent/confirm cannot replay a server record's intent by naming its key as requestId", async () => {
    const { completeRequest } = await idem();
    // Another payment's stored confirmation, naming a different recipient.
    await completeRequest(`confirm:0x${"cd".repeat(32)}`, { intent: { action: "send_payment", amount: 1, token: "USDC", recipient: OTHER_WALLET, network: "monad", summary: "x", confidence: 1, rawText: "x", purpose: null } });
    mineDirectPayment();
    const r = await confirm({ requestId: `confirm:0x${"cd".repeat(32)}` });
    // The server record is not an approval: refused, and nothing of it leaks.
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe("approval_not_found");
    expect(replayedApproval(r.body)).toBe(false);
    expect(JSON.stringify(r.body).toLowerCase()).not.toContain(OTHER_WALLET.toLowerCase());
  });

  it("the storage key is namespaced, hashed and tenant/wallet scoped; it never names a server key", async () => {
    const { agentRequestKey } = await idem();
    for (const k of RESERVED) {
      const key = agentRequestKey("demo", WALLET, k);
      expect(key).toMatch(/^agent-req:[0-9a-f]{64}$/);
      expect(RESERVED.some((r) => key === r || key.startsWith(r.split(":")[0] + ":"))).toBe(false);
    }
    expect(agentRequestKey("demo", WALLET, "x")).toBe(agentRequestKey("demo", WALLET.toLowerCase(), "x"));
    expect(agentRequestKey("demo", WALLET, "x")).not.toBe(agentRequestKey("demo", OTHER_WALLET, "x"));
    expect(agentRequestKey("demo", WALLET, "x")).not.toBe(agentRequestKey("tenant-b", WALLET, "x"));
    expect(agentRequestKey("a:b", WALLET, "c")).not.toBe(agentRequestKey("a", WALLET, "b:c"));
  });
});

describe("legitimate retries and scoping", () => {
  it("3. the same caller's retry with the same key replays its own result", async () => {
    const first = await agent({ intent: SEND, idempotencyKey: "console-1-abc" });
    expect(first.body.decision).toBe("ready_to_sign");
    const again = await agent({ intent: SEND, idempotencyKey: "console-1-abc" });
    expect(again.body.replayed).toBe(true);
    expect(again.body.unsignedTx).toEqual(first.body.unsignedTx);
    expect(again.body.requestId).toBe("console-1-abc");
  });

  it("4a. the same key from another wallet does not replay the first wallet's result", async () => {
    await agent({ intent: SEND, idempotencyKey: "shared-key" });
    const other = await agent({ intent: SEND, idempotencyKey: "shared-key", walletAddress: OTHER_WALLET });
    expect(other.body.replayed).toBeUndefined();
    expect(other.body.unsignedTx?.from.toLowerCase()).toBe(OTHER_WALLET.toLowerCase());
  });

  it("4b. the same key from another tenant does not replay the first tenant's result", async () => {
    await agent({ intent: SEND, idempotencyKey: "tenant-key" });
    const { createMerchant } = await import("@/lib/platform/merchants");
    const m = await createMerchant("Tenant B");
    const r = await agent({ intent: SEND, idempotencyKey: "tenant-key" }, { "x-merchant-key": m.apiKey });
    expect(r.body.replayed).toBeUndefined();
  });

  it("confirm still replays the approved intent for the wallet that was approved — and only for it", async () => {
    const approval = await agent({ intent: SEND, idempotencyKey: "pay-1" });
    expect(approval.body.decision).toBe("ready_to_sign");
    mineDirectPayment();
    const ok = await confirm({ requestId: "pay-1" });
    expect(ok.status).toBe(200);
    expect(replayedApproval(ok.body)).toBe(true);

    // Another wallet naming the same requestId does not get that approval.
    chain.receipt = null;
    mineDirectPayment(OTHER_WALLET);
    const other = await confirm({ requestId: "pay-1", walletAddress: OTHER_WALLET, txHash: `0x${"ef".repeat(32)}` });
    expect(other.status).toBe(409);
    expect(other.body.reason).toBe("approval_not_found");
    expect(replayedApproval(other.body)).toBe(false);
  });
});

describe("5. requestId and transaction construction are unchanged", () => {
  it("direct path: the public requestId is the client key and the transfer is exactly transfer(recipient, amount)", async () => {
    const r = await agent({ intent: SEND, idempotencyKey: "console-42-xyz" });
    expect(r.body.requestId).toBe("console-42-xyz");
    expect(r.body.unsignedTx).toEqual({
      to: USDC,
      data: encodeFunctionData({ abi: parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]), functionName: "transfer", args: [RECIPIENT, 1_000_000n] }),
      value: "0x0",
      from: WALLET,
    });
  });

  it("forwarder path: the on-chain ref is still keccak(requestId) of the CLIENT key, not of the storage key", async () => {
    process.env.MONAD_MAINNET_PAYAI_FORWARDER = FORWARDER;
    process.env.PAYAI_FORWARDER_ENABLED = "true";
    const r = await agent({ intent: SEND, idempotencyKey: "ask-77-ref" });
    expect(r.body.decision).toBe("ready_to_sign");
    expect(r.body.requestId).toBe("ask-77-ref");
    const { buildForwardErc20TxUnits, toRef } = await import("@/lib/monad/forwarder");
    const { feeOnTop } = await import("@/lib/payment/feeOnTop");
    const gross = feeOnTop(1_000_000n, 25).gross;
    expect(r.body.unsignedTx).toEqual(buildForwardErc20TxUnits(FORWARDER, WALLET, USDC, RECIPIENT, gross, "ask-77-ref"));
    expect(r.body.unsignedTx?.data).toContain(toRef("ask-77-ref").slice(2));
    const { agentRequestKey } = await idem();
    expect(r.body.unsignedTx?.data).not.toContain(toRef(agentRequestKey("demo", WALLET, "ask-77-ref")).slice(2));
  });
});
