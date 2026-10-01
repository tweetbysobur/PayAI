import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { decodeFunctionData, parseEther } from "viem";

/**
 * The SDK preview → build boundary, driven through the REAL routes with the
 * real split_payment v2 action (MONAD_NETWORK=mainnet registers it against its
 * canonical address):
 *
 *   - build REQUIRES the preview's signed quote token; a missing, forged or
 *     cross-action token fails closed;
 *   - quotedAt comes only from the verified token — a body quotedAt is
 *     ignored, so a stale quote can't be refreshed by the client;
 *   - the token binds the exact inputs: any tampering is refused;
 *   - one build per quote (quoteId idempotency);
 *   - the shared payment policy (sanctions / zero / cap) blocks at preview
 *     AND at build, before any step exists.
 *
 * Sanctions are mocked to a fixed list so the test never fetches the remote
 * OFAC list.
 */

const CANONICAL = "0xaC98a844E0F9688EA9758Db05c134b8B4BCeAf6F";
const WALLET = "0x6b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c";
const A = "0x5e0d39b4c1a2f3e4d5c6b7a8f9e0d1c2b3a4f5e6";
const B = "0x7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b";
const SANCTIONED = "0x8589427373d6d84e98730d7795d8f6f8731fda16";

vi.mock("@/lib/platform/ratelimit", () => ({ rateLimited: async () => null }));
vi.mock("@/lib/payment/sanctions", () => ({
  ensureSanctionsLoaded: async () => {},
  isSanctionedAddress: (a: string) => a.toLowerCase() === SANCTIONED,
  sanctionsListLoaded: () => true,
}));

const SPLIT_ABI = [
  { type: "function", name: "splitPayment", stateMutability: "payable", inputs: [
    { name: "token", type: "address" }, { name: "recipients", type: "address[]" },
    { name: "amounts", type: "uint256[]" }, { name: "ref", type: "bytes32" } ], outputs: [{ type: "uint256" }] },
] as const;

let priorNetwork: string | undefined;
beforeEach(async () => {
  priorNetwork = process.env.MONAD_NETWORK;
  process.env.MONAD_NETWORK = "mainnet";
  const { __resetRegistryForTests } = await import("@/lib/sdk/registry");
  const { __resetBootstrapForTests } = await import("@/lib/sdk/bootstrap");
  __resetRegistryForTests();
  __resetBootstrapForTests();
});
afterEach(async () => {
  vi.useRealTimers();
  if (priorNetwork === undefined) delete process.env.MONAD_NETWORK; else process.env.MONAD_NETWORK = priorNetwork;
  const { __resetRegistryForTests } = await import("@/lib/sdk/registry");
  const { __resetBootstrapForTests } = await import("@/lib/sdk/bootstrap");
  __resetRegistryForTests();
  __resetBootstrapForTests();
});

const req = (url: string, body: unknown) =>
  new NextRequest(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const ID = { protocolId: "payai-settlement", actionId: "split_payment", version: "2.0.0" };
const inputsOf = (...pairs: [string, string][]) => ({ recipients: pairs.map(([recipient, amount]) => ({ recipient, amount })) });
const NATIVE_INPUTS = inputsOf([A, parseEther("1").toString()], [B, parseEther("2").toString()]);

async function preview(inputs: unknown = NATIVE_INPUTS) {
  const { POST } = await import("@/app/api/ask/action/route");
  return (await POST(req("https://usepayai.xyz/api/ask/action", { ...ID, inputs }))).json();
}
async function build(body: Record<string, unknown>) {
  const { POST } = await import("@/app/api/ask/action/build/route");
  const res = await POST(req("https://usepayai.xyz/api/ask/action/build", { ...ID, walletAddress: WALLET, ...body }));
  return { status: res.status, json: await res.json() };
}

describe("preview (/api/ask/action)", () => {
  it("quotes the split and issues a quote token + quoteId — never steps", async () => {
    const pj = await preview();
    expect(pj.ok).toBe(true);
    expect(pj.summary).toBe("Split 3 MON between 2 recipients");
    expect(pj.details.total).toBe("3 MON");
    expect(pj.quoteToken).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(pj.quoteId).toMatch(/^[0-9a-f]{32}$/);
    expect(pj.steps).toBeUndefined();
    expect(pj.risk).toEqual(expect.objectContaining({ compliance: "approved" }));
  });
  it("rejects an invalid split cleanly with the action's own message (no crash)", async () => {
    const pj = await preview(inputsOf([A, "1"], [A, "2"]));
    expect(pj.ok).toBe(false);
    expect(pj.message).toMatch(/more than once/);
  });
});

describe("build (/api/ask/action/build) — the quote token is the boundary", () => {
  it("a valid token builds ONE native step to the canonical target with value == exact total", async () => {
    const pj = await preview();
    const { json } = await build({ inputs: NATIVE_INPUTS, quoteToken: pj.quoteToken });
    expect(json.ok).toBe(true);
    expect(json.quoteId).toBe(pj.quoteId);
    expect(json.steps).toHaveLength(1);
    expect(json.steps[0].tx.to.toLowerCase()).toBe(CANONICAL.toLowerCase());
    expect(json.steps[0].tx.value).toBe(parseEther("3").toString());
    const [token, recipients] = decodeFunctionData({ abi: SPLIT_ABI, data: json.steps[0].tx.data as `0x${string}` }).args as [string, string[], bigint[], string];
    expect(token).toBe("0x0000000000000000000000000000000000000000");
    expect(recipients.map((r) => r.toLowerCase())).toEqual([A.toLowerCase(), B.toLowerCase()]);
  });

  it("a missing token is refused (QUOTE_REQUIRED) — the server never manufactures freshness", async () => {
    const { status, json } = await build({ inputs: NATIVE_INPUTS, quotedAt: Date.now() });
    expect(status).toBe(400);
    expect(json.code).toBe("QUOTE_REQUIRED");
    expect(json.steps).toBeUndefined();
  });

  it("a forged token (bad signature) is refused", async () => {
    const pj = await preview();
    const [payload] = String(pj.quoteToken).split(".");
    const { json } = await build({ inputs: NATIVE_INPUTS, quoteToken: `${payload}.forgedsignature` });
    expect(json.ok).toBe(false);
    expect(json.code).toBe("QUOTE_REQUIRED");
  });

  it("tampered inputs — a different recipient or amount than previewed — are refused", async () => {
    const pj = await preview();
    const swapped = await build({ inputs: inputsOf([A, parseEther("1").toString()], [WALLET, parseEther("2").toString()]), quoteToken: pj.quoteToken });
    expect(swapped.json.code).toBe("QUOTE_REQUIRED");
    const bumped = await build({ inputs: inputsOf([A, parseEther("10").toString()], [B, parseEther("2").toString()]), quoteToken: pj.quoteToken });
    expect(bumped.json.code).toBe("QUOTE_REQUIRED");
    const reordered = await build({ inputs: inputsOf([B, parseEther("2").toString()], [A, parseEther("1").toString()]), quoteToken: pj.quoteToken });
    expect(reordered.json.code).toBe("QUOTE_REQUIRED");
  });

  it("a token for one action can't build another (identity is bound)", async () => {
    const pj = await preview();
    const { json } = await build({ protocolId: "wmon", actionId: "wrap", version: "1.0.0", inputs: { amount: "1" }, quoteToken: pj.quoteToken });
    expect(json.ok).toBe(false);
    expect(json.code).toBe("QUOTE_REQUIRED");
  });

  it("a stale quote is refused — and a fresh quotedAt in the BODY can't revive it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
    const pj = await preview();
    vi.setSystemTime(new Date("2026-10-01T12:10:00Z")); // 10 minutes later
    const { json } = await build({ inputs: NATIVE_INPUTS, quoteToken: pj.quoteToken, quotedAt: Date.now() });
    expect(json.ok).toBe(false);
    expect(json.code).toBe("QUOTE_STALE");
  });

  it("one build per quote: a second build of the same quote is refused (409), not re-issued", async () => {
    const pj = await preview();
    const first = await build({ inputs: NATIVE_INPUTS, quoteToken: pj.quoteToken });
    expect(first.json.ok).toBe(true);
    const second = await build({ inputs: NATIVE_INPUTS, quoteToken: pj.quoteToken });
    expect(second.status).toBe(409);
    expect(second.json.code).toBe("ALREADY_BUILT");
    expect(second.json.steps).toBeUndefined();
  });
});

describe("shared payment policy — blocks before any step exists", () => {
  it("a sanctioned recipient is blocked at preview", async () => {
    const pj = await preview(inputsOf([A, "1000"], [SANCTIONED, "1000"]));
    expect(pj.ok).toBe(false);
    expect(pj.code).toBe("POLICY_BLOCKED");
    expect(pj.quoteToken).toBeUndefined();
  });

  it("…and at build, even if the preview were skipped (policy is authoritative at build)", async () => {
    const { issueQuoteToken } = await import("@/lib/sdk/quoteToken");
    const inputs = inputsOf([A, "1000"], [SANCTIONED, "1000"]);
    const { quoteToken } = issueQuoteToken({ ...ID, chainId: 143 }, inputs, Date.now());
    const { json } = await build({ inputs, quoteToken });
    expect(json.ok).toBe(false);
    expect(json.code).toBe("POLICY_BLOCKED");
    expect(json.steps).toBeUndefined();
  });

  it("risk is scored on the TOTAL — many small payments can't step under the amount thresholds", async () => {
    const { enforcePaymentPolicy } = await import("@/lib/sdk/policy");
    const small = (n: number) => Array.from({ length: n }, (_, i) => ({
      recipient: `0x${(i + 16).toString(16)}${"ab".repeat(19)}` as `0x${string}`,
      amountUnits: 100n * 10n ** 18n, token: "0x0000000000000000000000000000000000000000" as `0x${string}`, symbol: "MON", decimals: 18,
    }));
    const one = await enforcePaymentPolicy(small(1));
    const ten = await enforcePaymentPolicy(small(10));
    expect(ten.riskScore).toBeGreaterThan(one.riskScore); // 1000 MON total vs 100
    expect(ten.allowed).toBe(true);
  });
});
