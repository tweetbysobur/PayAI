import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { encodeFunctionData, getAddress, pad, parseAbi, type Hex } from "viem";
import { grantCookieFor } from "./walletGrantCookie";

/**
 * Payment approvals and confirmations require proof that the caller controls
 * the wallet: the signed, httpOnly wallet grant (lib/auth/walletGrant.ts).
 * A wallet address in the body, a public tx hash or an approval requestId is
 * not proof. Without it, anyone could create approvals for someone else's
 * wallet, confirm their payment under another tenant, or read a stored
 * confirmation back.
 *
 * MOCKED: chain client, balance checks, fee-terms read, sanctions loader.
 * Approvals and claims use the real in-memory stores. Nothing is signed or
 * sent (the grant cookie is minted with the test secret).
 */

vi.setConfig({ testTimeout: 20_000 });

const VICTIM = getAddress("0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
const ATTACKER = getAddress("0x90f79bf6eb2c4f870365e785982e1f101e93b906");
const RECIPIENT = getAddress("0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc");
const USDC = getAddress("0x754704bc059f8c67012fed69bc8a327a5aafb603");
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TX = `0x${"ab".repeat(32)}` as Hex;
const SEND = `Send 1 USDC to ${RECIPIENT}`;
const DATA = encodeFunctionData({ abi: parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]), functionName: "transfer", args: [RECIPIENT, 1_000_000n] });

const chain = { receipt: null as unknown, tx: null as unknown };
vi.mock("viem", async (orig) => {
  const actual = await orig<typeof import("viem")>();
  return {
    ...actual,
    createPublicClient: () => ({
      getTransactionReceipt: async () => { if (!chain.receipt) throw new actual.TransactionReceiptNotFoundError({ hash: TX }); return chain.receipt; },
      getTransaction: async () => chain.tx,
      getBlock: async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
    }),
  };
});
vi.mock("@/lib/monad/balance", async (orig) => ({ ...(await orig<typeof import("@/lib/monad/balance")>()), insufficientBalanceReason: async () => null, insufficientWithFeeReason: async () => null }));
vi.mock("@/lib/sdk/fees", async (orig) => ({ ...(await orig<typeof import("@/lib/sdk/fees")>()), readPlatformFeeTerms: async () => ({ feeBps: 25 }) }));
vi.mock("@/lib/payment/sanctions", async (orig) => ({ ...(await orig<typeof import("@/lib/payment/sanctions")>()), ensureSanctionsLoaded: async () => {} }));

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv("MONAD_NETWORK", "mainnet");
  vi.stubEnv("MONAD_MAINNET_USDC", USDC);
  vi.stubEnv("PAYAI_FORWARDER_ENABLED", "");
  vi.stubEnv("ANTHROPIC_API_KEY", "");
  vi.stubEnv("KV_REST_API_URL", "");
  vi.stubEnv("KV_REST_API_TOKEN", "");
  (globalThis as { __veripayIdem?: Map<string, unknown> }).__veripayIdem?.clear();
  (globalThis as { __veripayMem?: Map<string, unknown> }).__veripayMem?.clear();
  chain.receipt = null;
  chain.tx = null;
});

type Body = Record<string, unknown> & { state?: string; code?: string; error?: string; decision?: string; unsignedTx?: unknown; success?: boolean; reason?: string };
const req = (path: string, body: unknown, headers: Record<string, string>) => new NextRequest(`http://localhost${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-forwarded-for": `10.7.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, ...headers },
  body: JSON.stringify(body),
});
async function agent(walletAddress: string, headers: Record<string, string>, idempotencyKey = "k-1") {
  const { POST } = await import("@/app/api/agent/route");
  const res = await POST(req("/api/agent", { intent: SEND, walletAddress, idempotencyKey }, headers));
  return { status: res.status, body: (await res.json()) as Body };
}
async function confirm(walletAddress: string, headers: Record<string, string>, requestId = "k-1") {
  const { POST } = await import("@/app/api/agent/confirm/route");
  const res = await POST(req("/api/agent/confirm", { rawText: SEND, walletAddress, txHash: TX, requestId }, headers));
  return { status: res.status, body: (await res.json()) as Body };
}
function victimPaid() {
  chain.tx = { hash: TX, from: VICTIM, to: USDC, input: DATA, value: 0n };
  chain.receipt = {
    status: "success", from: VICTIM, to: USDC, blockNumber: 7n, gasUsed: 50_000n, effectiveGasPrice: 1n,
    logs: [{ address: USDC, topics: [TRANSFER, pad(VICTIM), pad(RECIPIENT)], data: pad("0xf4240") }],
  };
}
const idem = () => (globalThis as { __veripayIdem?: Map<string, unknown> }).__veripayIdem;
const logRows = async () => {
  const { listTx } = await import("@/lib/platform/store");
  return (await listTx("demo")).filter((t) => t.txHash?.toLowerCase() === TX);
};
const forged = { cookie: "payai_wallet_grant=eyJhZGRyZXNzIjoiMHg3MDk5Nzk3MGM1MTgxMmRjM2EwMTBjN2QwMWI1MGUwZDE3ZGM3OWM4IiwiZXhwaXJlc0F0Ijo5OTk5OTk5OTk5OTk5fQ.not-a-real-signature" };
const PAY_AGAIN = /start (the|a new) payment|pay again|(?<!don't )send it again|try again/i;

describe("/api/agent issues payment approvals only to the wallet's proven owner", () => {
  it("no grant → 401, nothing to sign, nothing stored", async () => {
    const r = await agent(VICTIM, {});
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ code: "wallet_grant_required", state: "wallet_grant_required" });
    expect(r.body.unsignedTx).toBeUndefined();
    expect(r.body.error).toMatch(/nothing was sent/i);
    expect(idem()?.size ?? 0).toBe(0); // the claim was released, no approval stored
  });

  it("a grant for ANOTHER wallet is not proof → 401", async () => {
    const r = await agent(VICTIM, grantCookieFor(ATTACKER));
    expect(r.status).toBe(401);
    expect(r.body.unsignedTx).toBeUndefined();
  });

  it("a forged or expired grant is not proof → 401", async () => {
    expect((await agent(VICTIM, forged)).status).toBe(401);
    const { encodeWalletGrant, WALLET_GRANT_COOKIE } = await import("@/lib/auth/walletGrant");
    const expired = { cookie: `${WALLET_GRANT_COOKIE}=${encodeWalletGrant(VICTIM, Date.now() - 1000)}` };
    expect((await agent(VICTIM, expired)).status).toBe(401);
  });

  it("the wallet's own grant → the approval is issued as before", async () => {
    const r = await agent(VICTIM, grantCookieFor(VICTIM));
    expect(r.status).toBe(200);
    expect(r.body.decision).toBe("ready_to_sign");
    expect(r.body.unsignedTx).toMatchObject({ from: VICTIM });
  });

  it("read-only requests (no payment approval) still don't need a grant", async () => {
    const { POST } = await import("@/app/api/agent/route");
    const res = await POST(req("/api/agent", { intent: "Send 20 USDC to Alice", walletAddress: VICTIM, idempotencyKey: "r-1" }, {}));
    expect(res.status).not.toBe(401); // refused for its own reason (unknown payee), not for ownership
  });
});

describe("/api/agent/confirm: only the wallet's proven owner may confirm or read a confirmation", () => {
  it("no grant → 401 before anything is read or claimed; never 'pay again'", async () => {
    victimPaid();
    const r = await confirm(VICTIM, {});
    expect(r.status).toBe(401);
    expect(r.body.state).toBe("wallet_grant_required");
    expect(r.body.error).toMatch(/don't send it again/i);
    expect(r.body.error).not.toMatch(PAY_AGAIN);
    expect(idem()?.size ?? 0).toBe(0);
  });

  it("an attacker cannot create an approval for the victim, nor confirm the victim's payment", async () => {
    victimPaid();
    // 1. Approval for the victim's wallet with the attacker's own grant: refused.
    expect((await agent(VICTIM, grantCookieFor(ATTACKER), "evil")).status).toBe(401);
    // 2. Confirming the victim's tx as the victim, without the victim's grant: refused.
    expect((await confirm(VICTIM, grantCookieFor(ATTACKER), "evil")).status).toBe(401);
    // 3. Confirming it as the attacker's own wallet: the tx isn't from that wallet.
    const own = await confirm(ATTACKER, grantCookieFor(ATTACKER), "evil");
    expect(own.body.state).toBe("mismatch");
    expect(own.body.reason).toBe("sender_mismatch");
    expect(await logRows()).toHaveLength(0);
    // 4. The victim's own flow is unaffected and records exactly once.
    expect((await agent(VICTIM, grantCookieFor(VICTIM), "mine")).body.decision).toBe("ready_to_sign");
    const ok = await confirm(VICTIM, grantCookieFor(VICTIM), "mine");
    expect(ok.status).toBe(200);
    expect(ok.body.state).toBe("confirmed");
    expect(await logRows()).toHaveLength(1);
  });

  it("knowing the victim's requestId and tx hash discloses nothing without the victim's grant", async () => {
    victimPaid();
    await agent(VICTIM, grantCookieFor(VICTIM), "mine");
    expect((await confirm(VICTIM, grantCookieFor(VICTIM), "mine")).status).toBe(200);
    const snoop = await confirm(VICTIM, grantCookieFor(ATTACKER), "mine");
    expect(snoop.status).toBe(401);
    for (const k of ["intent", "trace", "receipt", "transaction", "sender"]) expect(snoop.body[k], k).toBeUndefined();
    // The owner's retry still replays.
    const again = await confirm(VICTIM, grantCookieFor(VICTIM), "mine");
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
  });

  it("if grants can't be verified (production without AUTH_SESSION_SECRET) the grant is refused, never treated as proof", async () => {
    // decodeWalletGrant swallows the missing-secret throw and returns null,
    // so an unverifiable grant reads as "no grant": refused, fail closed.
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_SESSION_SECRET", "");
    victimPaid();
    const c = await confirm(VICTIM, { cookie: "payai_wallet_grant=a.b" });
    expect(c.status).toBe(401);
    expect(c.body.state).toBe("wallet_grant_required");
    expect(c.body.error).not.toMatch(PAY_AGAIN);
    // Production without KV also fails closed on durable storage (503) first.
    const a = await agent(VICTIM, { cookie: "payai_wallet_grant=a.b" });
    expect([401, 503]).toContain(a.status);
    expect(a.body.unsignedTx).toBeUndefined();
    expect(idem()?.size ?? 0).toBe(0);
    expect(await logRows()).toHaveLength(0);
  });
});
