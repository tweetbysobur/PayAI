import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { decodeFunctionData, parseEther } from "viem";

/**
 * Phase 5 — the split_payment action driven through the REAL preview
 * (/api/ask/action) and confirm-time build (/api/ask/action/build) routes, so
 * the server gate (resolve → Layer A → quote → build → Layer B) is proven where
 * it actually runs. MONAD_NETWORK=mainnet registers the real split protocol
 * against its canonical mainnet address.
 */

const CANONICAL = "0xaC98a844E0F9688EA9758Db05c134b8B4BCeAf6F";
const WALLET = "0x9999999999999999999999999999999999999999";
const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";

vi.mock("@/lib/platform/ratelimit", () => ({ rateLimited: async () => null }));

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
  if (priorNetwork === undefined) delete process.env.MONAD_NETWORK; else process.env.MONAD_NETWORK = priorNetwork;
  const { __resetRegistryForTests } = await import("@/lib/sdk/registry");
  const { __resetBootstrapForTests } = await import("@/lib/sdk/bootstrap");
  __resetRegistryForTests();
  __resetBootstrapForTests();
});

const req = (url: string, body: unknown) =>
  new NextRequest(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("preview route (/api/ask/action) for split_payment", () => {
  it("returns the quote summary + per-recipient details, no build", async () => {
    const { POST } = await import("@/app/api/ask/action/route");
    const res = await POST(req("https://usepayai.xyz/api/ask/action", {
      protocolId: "payai-settlement", actionId: "split_payment", version: "1.0.0",
      inputs: { recipient1: A, amount1: "1", recipient2: B, amount2: "2" },
    }));
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.summary).toBe("Split 3 MON between 2 recipients");
    expect(json.details.total).toBe("3 MON");
  });

  it("rejects a mismatched recipient/amount pair cleanly (no crash)", async () => {
    const { POST } = await import("@/app/api/ask/action/route");
    const res = await POST(req("https://usepayai.xyz/api/ask/action", {
      protocolId: "payai-settlement", actionId: "split_payment", version: "1.0.0",
      inputs: { recipient1: A, amount1: "1", recipient2: B },
    }));
    const json = await res.json();
    expect(json.ok).toBe(false);
  });
});

describe("build route (/api/ask/action/build) for split_payment", () => {
  it("builds ONE native step to the canonical target with value == exact total, passing Layer B", async () => {
    const { POST } = await import("@/app/api/ask/action/build/route");
    const res = await POST(req("https://usepayai.xyz/api/ask/action/build", {
      protocolId: "payai-settlement", actionId: "split_payment", version: "1.0.0",
      inputs: { recipient1: A, amount1: "1", recipient2: B, amount2: "2" },
      walletAddress: WALLET, quotedAt: Date.now(),
    }));
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.steps).toHaveLength(1);
    expect(json.steps[0].kind).toBe("action");
    expect(json.steps[0].tx.to.toLowerCase()).toBe(CANONICAL.toLowerCase());
    expect(json.steps[0].tx.value).toBe(parseEther("3").toString());
    const decoded = decodeFunctionData({ abi: SPLIT_ABI, data: json.steps[0].tx.data as `0x${string}` });
    const [token, recipients] = decoded.args as [string, string[], bigint[], string];
    expect(token).toBe("0x0000000000000000000000000000000000000000");
    expect(recipients.map((r) => r.toLowerCase())).toEqual([A.toLowerCase(), B.toLowerCase()]);
  });

  it("a token that can't be resolved (no stablecoin configured, unreadable on-chain) fails closed — no steps", async () => {
    const { POST } = await import("@/app/api/ask/action/build/route");
    const res = await POST(req("https://usepayai.xyz/api/ask/action/build", {
      protocolId: "payai-settlement", actionId: "split_payment", version: "1.0.0",
      inputs: { recipient1: A, amount1: "1", token: "0x754704Bc059F5a0Ce29e278A6D0eBa96b6aafb60" },
      walletAddress: WALLET, quotedAt: Date.now(),
    }));
    const json = await res.json();
    expect(json.ok).toBe(false);
  });

  it("a stale quote is refused (freshness enforced by the shared gate)", async () => {
    const { POST } = await import("@/app/api/ask/action/build/route");
    const res = await POST(req("https://usepayai.xyz/api/ask/action/build", {
      protocolId: "payai-settlement", actionId: "split_payment", version: "1.0.0",
      inputs: { recipient1: A, amount1: "1" },
      walletAddress: WALLET, quotedAt: Date.now() - 10 * 60_000,
    }));
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.code).toBe("QUOTE_STALE");
  });
});
