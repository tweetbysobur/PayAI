import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { encodeFunctionData, getAddress, pad, parseAbi, TransactionReceiptNotFoundError, type Hex } from "viem";

/**
 * POST /api/agent/confirm — recovery when the chain and PayAI's own records
 * disagree or are unavailable (R2).
 *
 * The route reads the CHAIN before judging the approval, so a payment that
 * settled is never reported as "not happened" because its approval is gone;
 * every response carries an explicit `state`; a dependency failure is
 * "unavailable", never "failed"; and every failure after the claim releases
 * it (except once the payment is in the log).
 *
 * MOCKED: the chain client (viem createPublicClient), the sanctions loader,
 * and — per test — failure switches on the idempotency store and the
 * transaction log. Approvals live in the real in-memory idempotency store.
 * Nothing is signed or sent.
 */

vi.setConfig({ testTimeout: 20_000 });

const WALLET = getAddress("0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
const RECIPIENT = getAddress("0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc");
const STRANGER = getAddress("0x90f79bf6eb2c4f870365e785982e1f101e93b906");
const USDC = getAddress("0x754704bc059f8c67012fed69bc8a327a5aafb603");
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TX = `0x${"ab".repeat(32)}` as Hex;
const ONE = 1_000_000n;
const TRANSFER_ABI = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);
const DIRECT = { to: USDC, data: encodeFunctionData({ abi: TRANSFER_ABI, functionName: "transfer", args: [RECIPIENT, ONE] }), value: "0x0", from: WALLET };

/* ── mocked chain ─────────────────────────────────────────────────────── */
const chain = {
  receipt: null as unknown,
  tx: null as unknown,
  receiptError: null as Error | null,
  txError: null as Error | null,
};
vi.mock("viem", async (orig) => {
  const actual = await orig<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: () => ({
      getTransactionReceipt: async () => {
        if (chain.receiptError) throw chain.receiptError;
        if (!chain.receipt) throw new actual.TransactionReceiptNotFoundError({ hash: TX });
        return chain.receipt;
      },
      getTransaction: async () => { if (chain.txError) throw chain.txError; return chain.tx; },
      getBlock: async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
    }),
  };
});

/* ── policy and storage switches ──────────────────────────────────────── */
const sanctioned = new Set<string>();
vi.mock("@/lib/payment/sanctions", async (orig) => {
  const actual = await orig<typeof import("@/lib/payment/sanctions")>();
  return { ...actual, ensureSanctionsLoaded: async () => {}, isSanctionedAddress: (a: string) => sanctioned.has(a.toLowerCase()) || actual.isSanctionedAddress(a) };
});
const fail = { claim: false, peek: false, complete: false, record: false };
vi.mock("@/lib/platform/idempotency", async (orig) => {
  const a = await orig<typeof import("@/lib/platform/idempotency")>();
  const kvDown = () => Promise.reject(new Error("KV unavailable (mocked)"));
  return {
    ...a,
    claimRequest: ((...x: Parameters<typeof a.claimRequest>) => (fail.claim ? kvDown() : a.claimRequest(...x))) as typeof a.claimRequest,
    peekRequestRecord: ((...x: Parameters<typeof a.peekRequestRecord>) => (fail.peek ? kvDown() : a.peekRequestRecord(...x))) as typeof a.peekRequestRecord,
    completeRequest: ((...x: Parameters<typeof a.completeRequest>) => (fail.complete ? kvDown() : a.completeRequest(...x))) as typeof a.completeRequest,
  };
});
vi.mock("@/lib/platform/store", async (orig) => {
  const a = await orig<typeof import("@/lib/platform/store")>();
  return { ...a, recordTx: ((...x: Parameters<typeof a.recordTx>) => (fail.record ? Promise.reject(new Error("log write failed (mocked)")) : a.recordTx(...x))) as typeof a.recordTx };
});

const ENV = ["MONAD_NETWORK", "MONAD_MAINNET_USDC", "MONAD_MAINNET_PAYAI_FORWARDER", "PAYAI_MAX_USD", "KV_REST_API_URL", "KV_REST_API_TOKEN"] as const;
beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  process.env.MONAD_NETWORK = "mainnet";
  process.env.MONAD_MAINNET_USDC = USDC;
  vi.resetModules();
  // The in-memory stores live on globalThis and survive resetModules.
  (globalThis as { __veripayIdem?: Map<string, unknown> }).__veripayIdem?.clear();
  (globalThis as { __veripayMem?: Map<string, unknown> }).__veripayMem?.clear();
  Object.assign(chain, { receipt: null, tx: null, receiptError: null, txError: null });
  Object.assign(fail, { claim: false, peek: false, complete: false, record: false });
  sanctioned.clear();
});
afterEach(() => vi.useRealTimers());

/* ── helpers ──────────────────────────────────────────────────────────── */
type Body = Record<string, unknown> & { state?: string; reason?: string; error?: string; success?: boolean; reverted?: boolean; txHash?: string; explorerUrl?: string; settlement?: Record<string, unknown> };
const intent = (amount = 1) => ({ action: "send_payment", amount, token: "USDC", recipient: RECIPIENT, purpose: null, network: "monad", rawText: "x", summary: "Send 1 USDC", confidence: 1 });
async function approve(id: string, amount = 1) {
  const { agentRequestKey, completeRequest } = await import("@/lib/platform/idempotency");
  await completeRequest(agentRequestKey("demo", WALLET, id), { decision: "ready_to_sign", intent: intent(amount), source: "deterministic", unsignedTx: DIRECT, requestId: id, success: false });
}
function mineSuccess(from: string = WALLET) {
  chain.tx = { hash: TX, from, to: USDC, input: DIRECT.data, value: 0n };
  chain.receipt = {
    status: "success", from, to: USDC, blockNumber: 77n, gasUsed: 50_000n, effectiveGasPrice: 1n,
    logs: [{ address: USDC, topics: [TRANSFER, pad(from as Hex), pad(RECIPIENT)], data: pad(`0x${ONE.toString(16)}`) }],
  };
}
async function confirm(requestId?: string, over: Record<string, unknown> = {}) {
  const { POST } = await import("@/app/api/agent/confirm/route");
  const res = await POST(new NextRequest("http://localhost/api/agent/confirm", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `10.4.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` },
    body: JSON.stringify({ rawText: "Send 1 USDC", walletAddress: WALLET, txHash: TX, ...(requestId ? { requestId } : {}), ...over }),
  }));
  return { status: res.status, body: (await res.json()) as Body };
}
async function logRows() {
  const { listTx } = await import("@/lib/platform/store");
  return (await listTx("demo", { sender: WALLET })).filter((t) => t.txHash?.toLowerCase() === TX);
}
async function claimFree() {
  const { agentConfirmKey, peekRequestRecord, claimRequest, releaseRequest } = await import("@/lib/platform/idempotency");
  if (await peekRequestRecord(agentConfirmKey(TX))) return false; // a finished confirmation
  const c = await claimRequest(agentConfirmKey(TX));
  if (c.claimed) await releaseRequest(agentConfirmKey(TX));
  return c.claimed;
}
/** Nothing a possibly-settled payer reads may invite another payment. */
const PAY_AGAIN = /start (the|a new) payment|start again|pay again|(?<!don't )send it again|retry the payment|try again/i;
function safeWording(b: Body) {
  expect(b.error).toBeTruthy();
  expect(b.error).not.toMatch(PAY_AGAIN);
}
/** An unmatched / held / unknown outcome is never a verified payment. */
function notVerified(b: Body) {
  expect(b.success).toBeUndefined();
  for (const k of ["intent", "trace", "receipt", "transaction"]) expect(b[k], k).toBeUndefined();
}

/* ── tests ────────────────────────────────────────────────────────────── */
describe("settled on-chain, approval missing or expired → settled_unmatched (evidence kept, nothing verified)", () => {
  it("no approval requestId at all", async () => {
    mineSuccess();
    const r = await confirm();
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ state: "settled_unmatched", reason: "approval_required", txHash: TX });
    expect(r.body.explorerUrl).toContain(TX);
    expect(r.body.settlement).toMatchObject({ txHash: TX, blockNumber: 77, status: "success" });
    expect(String(r.body.settlement?.from).toLowerCase()).toBe(WALLET.toLowerCase());
    expect(r.body.error).toMatch(/don't send it again/i);
    safeWording(r.body);
    notVerified(r.body);
    expect(await logRows()).toHaveLength(0);
    expect(await claimFree()).toBe(true); // released: a later confirm can still record it
  });

  it("an approval that never existed (or another instance's)", async () => {
    mineSuccess();
    const r = await confirm("never-stored");
    expect(r.body).toMatchObject({ state: "settled_unmatched", reason: "approval_not_found" });
    safeWording(r.body);
    notVerified(r.body);
    expect(await logRows()).toHaveLength(0);
  });

  it("an approval that EXPIRED before confirmation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await approve("old");
    vi.setSystemTime(Date.now() + 25 * 60 * 60 * 1000); // past the 24h approval TTL
    mineSuccess();
    const r = await confirm("old");
    expect(r.body).toMatchObject({ state: "settled_unmatched", reason: "approval_not_found" });
    safeWording(r.body);
    notVerified(r.body);
    expect(await logRows()).toHaveLength(0);
  });

  it("the same transaction confirms normally once its approval is visible again", async () => {
    mineSuccess();
    expect((await confirm("late")).body.state).toBe("settled_unmatched");
    await approve("late");
    const r = await confirm("late");
    expect(r.status).toBe(200);
    expect(r.body.state).toBe("confirmed");
    expect(await logRows()).toHaveLength(1);
  });

  it("a transaction from ANOTHER wallet is a mismatch, not this user's settlement", async () => {
    mineSuccess(STRANGER);
    const r = await confirm();
    expect(r.body).toMatchObject({ state: "mismatch", reason: "sender_mismatch" });
    expect(r.body.settlement).toBeUndefined();
    safeWording(r.body);
  });
});

describe("chain status is established before anything is concluded", () => {
  it("not mined yet → pending (409), claim released, later confirms", async () => {
    await approve("p");
    const r = await confirm("p");
    expect(r.status).toBe(409);
    expect(r.body.state).toBe("pending");
    expect(r.body.error).toMatch(/don't send it again/i);
    safeWording(r.body);
    expect(await claimFree()).toBe(true);
    mineSuccess();
    expect((await confirm("p")).body.state).toBe("confirmed");
  });

  it("reverted → reverted (the one state where a fresh payment is safe)", async () => {
    await approve("rv");
    mineSuccess();
    (chain.receipt as { status: string }).status = "reverted";
    const r = await confirm("rv");
    expect(r.body).toMatchObject({ state: "reverted", reverted: true, txHash: TX });
    expect(await logRows()).toHaveLength(0);
    expect(await claimFree()).toBe(true);
  });

  it("RPC unavailable → 503 rpc_unavailable (status unknown, not failed), claim released", async () => {
    await approve("u");
    chain.receiptError = new Error("fetch failed");
    const r = await confirm("u");
    expect(r.status).toBe(503);
    expect(r.body.state).toBe("rpc_unavailable");
    safeWording(r.body);
    expect(await claimFree()).toBe(true);
  });

  for (const msg of ["method not found", "resource not found", "header not found", "upstream: block not found"]) {
    it(`an ambiguous RPC error ("${msg}") is unavailable, never "not mined"`, async () => {
      await approve("amb");
      chain.receiptError = new Error(msg);
      const r = await confirm("amb");
      expect(r.status).toBe(503);
      expect(r.body.state).toBe("rpc_unavailable");
    });
  }

  it("only viem's own TransactionReceiptNotFoundError means pending — even when wrapped by name only", async () => {
    await approve("nf");
    const e = new Error("anything");
    e.name = "TransactionReceiptNotFoundError";
    chain.receiptError = e;
    expect((await confirm("nf")).body.state).toBe("pending");
    chain.receiptError = new TransactionReceiptNotFoundError({ hash: TX });
    expect((await confirm("nf")).body.state).toBe("pending");
  });

  it("the transaction/block read failing after the receipt → rpc_unavailable, claim released", async () => {
    await approve("t");
    mineSuccess();
    chain.txError = new Error("socket hang up");
    const r = await confirm("t");
    expect(r.status).toBe(503);
    expect(r.body.state).toBe("rpc_unavailable");
    expect(await claimFree()).toBe(true);
  });

  it("successful and matching → confirmed and recorded once", async () => {
    await approve("ok");
    mineSuccess();
    const r = await confirm("ok");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ state: "confirmed", success: true });
    expect(await logRows()).toHaveLength(1);
  });

  it("successful but NOT the approved payment → mismatch with evidence, nothing recorded", async () => {
    await approve("mm");
    mineSuccess();
    chain.tx = { ...(chain.tx as object), input: encodeFunctionData({ abi: TRANSFER_ABI, functionName: "transfer", args: [STRANGER, ONE] }) };
    const r = await confirm("mm");
    expect(r.body).toMatchObject({ state: "mismatch", reason: "calldata_recipient_mismatch" });
    expect(r.body.settlement).toMatchObject({ txHash: TX, blockNumber: 77 });
    safeWording(r.body);
    notVerified(r.body);
    expect(await logRows()).toHaveLength(0);
  });
});

describe("policy after settlement → policy_hold (never 'unsubmitted', never verified)", () => {
  it("compliance now rejects a payment that already settled", async () => {
    await approve("c");
    mineSuccess();
    sanctioned.add(RECIPIENT.toLowerCase());
    const r = await confirm("c");
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ state: "policy_hold", reason: "compliance", txHash: TX });
    expect(r.body.settlement).toMatchObject({ txHash: TX });
    expect(r.body.error).toMatch(/confirmed on-chain/i);
    safeWording(r.body);
    notVerified(r.body);
    expect(await logRows()).toHaveLength(0);
    expect(await claimFree()).toBe(true);
  });

  it("a guardrail cap now rejects a payment that already settled", async () => {
    process.env.PAYAI_MAX_USD = "0.5"; // read at module load; the approved payment is 1 USDC
    await approve("g");
    mineSuccess();
    const r = await confirm("g");
    expect(r.body).toMatchObject({ state: "policy_hold", reason: "guardrail" });
    notVerified(r.body);
    expect(await logRows()).toHaveLength(0);
  });

  it("policy is never consulted before the chain: an unmined payment is pending, not refused", async () => {
    sanctioned.add(RECIPIENT.toLowerCase());
    await approve("pp");
    expect((await confirm("pp")).body.state).toBe("pending");
  });
});

describe("storage failures and claims", () => {
  it("KV down at claim time → 503 store_unavailable, nothing claimed", async () => {
    await approve("k");
    mineSuccess();
    fail.claim = true;
    const r = await confirm("k");
    expect(r.status).toBe(503);
    expect(r.body.state).toBe("store_unavailable");
    safeWording(r.body);
    fail.claim = false;
    expect((await confirm("k")).body.state).toBe("confirmed");
  });

  it("KV failure reading the approval is NOT a missing approval → 503, claim released", async () => {
    await approve("kp");
    mineSuccess();
    fail.peek = true;
    const r = await confirm("kp");
    expect(r.status).toBe(503);
    expect(r.body.state).toBe("store_unavailable");
    expect(r.body.reason).toBeUndefined(); // not approval_not_found
    fail.peek = false;
    expect(await claimFree()).toBe(true);
    expect((await confirm("kp")).body.state).toBe("confirmed"); // retry after recovery
  });

  it("an exception after the claim (log write fails) releases it; the retry records exactly once", async () => {
    await approve("x");
    mineSuccess();
    fail.record = true;
    const r = await confirm("x");
    expect(r.status).toBe(503);
    expect(r.body.state).toBe("store_unavailable");
    safeWording(r.body);
    expect(await logRows()).toHaveLength(0);
    expect(await claimFree()).toBe(true);
    fail.record = false;
    expect((await confirm("x")).body.state).toBe("confirmed");
    expect(await logRows()).toHaveLength(1);
  });

  it("a failure AFTER the payment is logged keeps the claim (no second log row), says it is recorded", async () => {
    await approve("y");
    mineSuccess();
    fail.complete = true;
    const r = await confirm("y");
    expect(r.status).toBe(503);
    expect(r.body.state).toBe("store_unavailable");
    expect(r.body.error).toMatch(/confirmed and recorded/i);
    safeWording(r.body);
    expect(await logRows()).toHaveLength(1);
    fail.complete = false;
    const again = await confirm("y");
    expect(again.body.state).toBe("in_progress"); // claim held until its lease lapses
    expect(await logRows()).toHaveLength(1);
  });

  it("a claim abandoned by a dead request lapses with its lease (15 min), not after 24h", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await approve("dead");
    mineSuccess();
    const { agentConfirmKey, claimRequest } = await import("@/lib/platform/idempotency");
    expect((await claimRequest(agentConfirmKey(TX), { ttlSeconds: 900 })).claimed).toBe(true); // a request that then died
    expect((await confirm("dead")).body.state).toBe("in_progress");
    vi.setSystemTime(Date.now() + 901 * 1000);
    expect((await confirm("dead")).body.state).toBe("confirmed");
  });

  it("concurrent confirms of one transaction: exactly one records, the other is in_progress", async () => {
    await approve("cc");
    mineSuccess();
    const [a, b] = await Promise.all([confirm("cc"), confirm("cc")]);
    const states = [a.body.state, b.body.state].sort();
    expect(states).toEqual(["confirmed", "in_progress"].sort());
    expect(await logRows()).toHaveLength(1);
  });
});

describe("every non-confirmed state keeps the user from paying again", () => {
  it("in_progress and already_confirmed wording is safe too", async () => {
    await approve("w");
    mineSuccess();
    const { agentConfirmKey, claimRequest } = await import("@/lib/platform/idempotency");
    await claimRequest(agentConfirmKey(TX), { ttlSeconds: 900 });
    const busy = await confirm("w");
    expect(busy.body.state).toBe("in_progress");
    safeWording(busy.body);
    (globalThis as { __veripayIdem?: Map<string, unknown> }).__veripayIdem?.clear();
    await approve("w");
    expect((await confirm("w")).body.state).toBe("confirmed");
    const other = await confirm(undefined, {});
    expect(other.body.state).toBe("already_confirmed");
    safeWording(other.body);
  });

  it("the route has no wording that invites a new payment outside the definitive revert", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../app/api/agent/confirm/route.ts", import.meta.url), "utf8");
    // Only what the route can SAY: its string and template literals, with
    // comments removed first (they quote phrases like "try again later").
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
    const literals = (code.match(/"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g) ?? []).join("\n");
    expect(literals).not.toMatch(/start the payment again|pay again/i);
    expect(literals.match(/try again/gi) ?? []).toHaveLength(1);
    expect(src).toMatch(/failed on-chain \(reverted\)\. No funds were transferred\. You can safely try again\./);
    expect(src).not.toMatch(/could not be found\|not found/); // the old substring classifier is gone
  });
});
