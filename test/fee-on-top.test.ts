import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { decodeFunctionData, parseEther, parseUnits } from "viem";
import { feeOfGross, feeOnTop, fromUnits, grossForNet, maxNetFor, toUnits } from "@/lib/payment/feeOnTop";
import { verifyForwardedNet, type DecodedFeeCollected, type DecodedPaymentForwarded } from "@/lib/monad/forwarder";

/**
 * PayAI's fee is charged ON TOP everywhere: the amount a user asks to move
 * arrives (or is swapped) in full, and the fee is debited from their balance
 * in addition. The contracts are unchanged — they take
 * floor(gross × bps / 10000) out of what they're handed — so PayAI hands them
 * the smallest gross whose net is exactly the user's amount.
 */

/* ── The math ──────────────────────────────────────────────────────────── */

describe("grossForNet: the smallest gross whose contract net is exactly the amount", () => {
  const nets = [0n, 1n, 2n, 3n, 399n, 400n, 401n, 9_999n, 10_000n, 20_000000n, 123_456789n, 10n ** 18n, 10n ** 18n + 7n, 98_765_432_109_876_543_210n];
  for (const bps of [0, 1, 7, 25, 33, 99, 100]) {
    it(`exact and minimal at ${bps} bps`, () => {
      for (const net of nets) {
        const g = grossForNet(net, bps);
        expect(g - feeOfGross(g, bps), `net ${net}`).toBe(net);
        if (g > 0n) expect(g - 1n - feeOfGross(g - 1n, bps), `minimal for ${net}`).toBeLessThan(net);
      }
    });
  }
  it("matches the hand-checked values", () => {
    expect(feeOnTop(20_000000n, 25)).toEqual({ net: 20_000000n, fee: 50125n, gross: 20_050125n });
    expect(feeOnTop(parseEther("1"), 25)).toEqual({ net: parseEther("1"), fee: 2506265664160401n, gross: 1002506265664160401n });
    expect(feeOnTop(399n, 25)).toEqual({ net: 399n, fee: 0n, gross: 399n }); // dust: the contract's fee floors to zero
  });
  it("refuses a rate the contracts can't have", () => {
    expect(() => grossForNet(1n, 101)).toThrow();
    expect(() => grossForNet(1n, -1)).toThrow();
    expect(() => grossForNet(1n, 2.5)).toThrow();
  });
});

describe("maxNetFor: the most that can be sent when the fee must also fit", () => {
  it("its gross never exceeds the balance, and one unit more wouldn't fit", () => {
    for (const bal of [0n, 1n, 1000n, 20_050124n, 20_050125n, 10n ** 18n]) {
      const n = maxNetFor(bal, 25);
      expect(grossForNet(n, 25)).toBeLessThanOrEqual(bal);
      expect(grossForNet(n + 1n, 25)).toBeGreaterThan(bal);
    }
    expect(maxNetFor(20_050125n, 25)).toBe(20_000000n);
  });
});

describe("toUnits / fromUnits", () => {
  it("round-trips exactly and refuses extra precision instead of rounding", () => {
    expect(toUnits("20", 6)).toBe(20_000000n);
    expect(toUnits("0.050125", 6)).toBe(50125n);
    expect(toUnits("1.0000000", 6)).toBe(1_000000n); // trailing zeros are fine
    expect(toUnits("1.0000001", 6)).toBeNull(); // a real 7th digit is refused
    expect(toUnits("1e3", 6)).toBeNull();
    expect(fromUnits(20_050125n, 6)).toBe("20.050125");
    expect(fromUnits(1002506265664160401n, 18)).toBe("1.002506265664160401");
    expect(fromUnits(0n, 18)).toBe("0");
  });
});

/* ── Verifying a forwarded payment: the recipient's NET must be the amount ─ */

describe("verifyForwardedNet", () => {
  const PAYER = "0x1234567890abcdef1234567890abcdef12345678" as const;
  const TO = "0x9f8e7d6c5b4a39281706f5e4d3c2b1a098765432" as const;
  const USDC = "0x754704bc059f5a0ce29e278a6d0eba96b6aafb60" as const;
  const TREASURY = "0x00000000000000000000000000000000000000ee" as const;
  const expected = { payer: PAYER, recipient: TO, token: USDC, amountUnits: 20_000000n };
  const ev = (amount: bigint, o: Partial<DecodedPaymentForwarded> = {}): DecodedPaymentForwarded => ({
    id: 1n, payer: PAYER, recipient: TO, token: USDC, amount, ref: `0x${"0".repeat(64)}`, ...o,
  });
  const fc = (feeAmount: bigint, o: Partial<DecodedFeeCollected> = {}): DecodedFeeCollected => ({ id: 1n, token: USDC, feeAmount, treasury: TREASURY, ...o });

  it("fee on top: gross 20.050125 with fee 0.050125 delivers exactly 20 → verified", () => {
    expect(verifyForwardedNet(ev(20_050125n), fc(50125n), expected)).toEqual({ fee: 50125n, feeOnTop: true, feeEvent: "collected" });
  });
  it("a payment built before the fee moved on top (gross == amount) still verifies — it is what the user signed", () => {
    expect(verifyForwardedNet(ev(20_000000n), fc(50000n), expected)).toEqual({ fee: 50000n, feeOnTop: false, feeEvent: "collected" });
  });
  it.each([
    ["a recipient short by one unit", ev(20_050124n), fc(50125n)],
    ["an overpaid gross", ev(20_100000n), fc(50000n)],
    ["another payer", ev(20_050125n, { payer: TO }), fc(50125n)],
    ["another recipient", ev(20_050125n, { recipient: PAYER }), fc(50125n)],
    ["another token", ev(20_050125n, { token: TREASURY }), fc(50125n)],
    ["a fee in another token", ev(20_050125n), fc(50125n, { token: TREASURY })],
    ["a fee above the contracts' 1% cap", ev(20_400000n), fc(400000n)],
  ])("refuses %s", (_l, e, f) => {
    expect(verifyForwardedNet(e, f, expected)).toBeNull();
  });
});

/* ── /api/agent: the interactive send charges the fee on top ───────────── */

const FORWARDER = "0x8b2c7E8FA09fCd664dbA9764FD63Bf3A4c56464D";
const USDC = "0x754704bc059f5a0ce29e278a6d0eba96b6aafb60";
const TREASURY = "0x00000000000000000000000000000000000000ee";
const USER = "0x1234567890abcdef1234567890abcdef12345678";
const TO = "0x9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";

const chain = { feeBps: 25n, mon: parseEther("5"), usdc: parseUnits("100", 6), allowance: 0n };
vi.mock("@/lib/monad/wallet", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/monad/wallet")>();
  return {
    ...actual,
    getPublicClient: () => ({
      getBalance: async () => chain.mon,
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === "feeBps") return chain.feeBps;
        if (functionName === "treasury") return TREASURY;
        if (functionName === "balanceOf") return chain.usdc;
        if (functionName === "allowance") return chain.allowance;
        throw new Error(`unexpected read ${functionName}`);
      },
    }),
  };
});
vi.mock("@/lib/payment/sanctions", () => ({ ensureSanctionsLoaded: async () => {}, isSanctionedAddress: () => false, sanctionsListLoaded: () => true }));
vi.mock("@/lib/platform/ratelimit", () => ({ rateLimited: async () => null }));

const ENV = ["PAYAI_MODE", "MONAD_NETWORK", "MONAD_MAINNET_PAYAI_FORWARDER", "PAYAI_FORWARDER_ENABLED", "MONAD_MAINNET_USDC", "ANTHROPIC_API_KEY", "PAYAI_TREASURY_ADDRESS"] as const;
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  process.env.PAYAI_MODE = "monad";
  process.env.MONAD_NETWORK = "mainnet";
  process.env.MONAD_MAINNET_PAYAI_FORWARDER = FORWARDER;
  process.env.PAYAI_FORWARDER_ENABLED = "true";
  process.env.MONAD_MAINNET_USDC = USDC;
  Object.assign(chain, { feeBps: 25n, mon: parseEther("5"), usdc: parseUnits("100", 6), allowance: 0n });
  vi.resetModules();
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const FWD_ABI = [
  { type: "function", name: "forwardPaymentNative", stateMutability: "payable", inputs: [{ name: "recipient", type: "address" }, { name: "amount", type: "uint256" }, { name: "ref", type: "bytes32" }], outputs: [] },
  { type: "function", name: "forwardPayment", stateMutability: "nonpayable", inputs: [{ name: "token", type: "address" }, { name: "recipient", type: "address" }, { name: "amount", type: "uint256" }, { name: "ref", type: "bytes32" }], outputs: [] },
] as const;
const APPROVE_ABI = [{ type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }] as const;

async function send(intent: string) {
  const { POST } = await import("@/app/api/agent/route");
  const res = await POST(new NextRequest("http://localhost/api/agent", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ intent, walletAddress: USER, idempotencyKey: `fee-${Math.random()}`, skipLLMRefinement: true }),
  }));
  return { status: res.status, json: await res.json() };
}

describe("/api/agent send: the recipient gets the amount; the fee is added on top", () => {
  it("USDC: forward and exact approval are for the gross (20.050125), and the fee is itemized", async () => {
    const { status, json } = await send(`Send 20 USDC to ${TO}`);
    expect(status).toBe(200);
    expect(json.decision).toBe("ready_to_sign");
    const fwd = decodeFunctionData({ abi: FWD_ABI, data: json.unsignedTx.data });
    expect(fwd.functionName).toBe("forwardPayment");
    expect((fwd.args[1] as string).toLowerCase()).toBe(TO);
    expect(fwd.args[2]).toBe(20_050125n);
    const appr = decodeFunctionData({ abi: APPROVE_ABI, data: json.approvalTx.data });
    expect(appr.args).toEqual([FORWARDER, 20_050125n]);
    expect(json.approvalLabel).toBe("Approve 20.050125 USDC for PayAI");
    expect(json.platformFee).toEqual({ amount: "0.050125", total: "20.050125", token: "USDC", percent: "0.25%" });
    expect(json.intent.amount).toBe(20); // what the recipient receives
  });

  it("MON: the forward's value is the gross", async () => {
    const { json } = await send(`Send 1 MON to ${TO}`);
    expect(json.decision).toBe("ready_to_sign");
    expect(BigInt(json.unsignedTx.value)).toBe(1002506265664160401n);
    const fwd = decodeFunctionData({ abi: FWD_ABI, data: json.unsignedTx.data });
    expect(fwd.args[1]).toBe(1002506265664160401n);
    expect(json.platformFee).toMatchObject({ amount: "0.002506265664160401", total: "1.002506265664160401", token: "MON" });
  });

  it("a balance that covers the amount but not the fee is refused before signing, and says so", async () => {
    chain.usdc = parseUnits("20.03", 6);
    const { status, json } = await send(`Send 20 USDC to ${TO}`);
    expect(status).toBe(422);
    expect(json.decision).toBe("refused");
    const why = (json.guardrail.violations as string[]).join(" ");
    expect(why).toMatch(/covers the 20 USDC but not the fee on top/);
    expect(why).toMatch(/0\.050125 USDC PayAI fee/);
    expect(why).toMatch(/You can send up to 19\.979925 USDC\./); // 20030000 − floor(20030000 × 25 / 10000)
    expect(json.unsignedTx).toBeUndefined();
  });

  it("an unreadable fee rate refuses the payment rather than guessing", async () => {
    chain.feeBps = 101n; // out of the contracts' range — a broken read
    const { status, json } = await send(`Send 20 USDC to ${TO}`);
    expect(status).toBe(422);
    expect(json.unsignedTx).toBeUndefined();
  });
});

/* ── Automations: a run with the fee on top releases / pulls the gross ─── */

describe("automation runs (fee on top only for automations created with it)", () => {
  const VAULT = "0x00000000000000000000000000000000000000aa";
  const EXECUTOR = "0x00000000000000000000000000000000000000bb";
  async function harness(reserved: bigint, allowance = 10n ** 30n) {
    const calls: { functionName: string; args: readonly unknown[] }[] = [];
    vi.doMock("@/lib/monad/wallet", () => ({
      getAgentAccount: () => ({ address: "0x00000000000000000000000000000000000000cc" }),
      getWalletClient: () => ({ writeContract: async () => `0x${"9".repeat(64)}` }),
      getPublicClient: () => ({
        readContract: async ({ functionName }: { functionName: string }) => {
          if (functionName === "feeBps") return 25n;
          if (functionName === "isReleaseProcessed" || functionName === "isRequestProcessed") return false;
          if (functionName === "reservedBalance") return reserved;
          if (functionName === "allowance") return allowance;
          throw new Error(`unexpected read ${functionName}`);
        },
        simulateContract: async (req: { functionName: string; args: readonly unknown[] }) => { calls.push(req); return { request: req }; },
        waitForTransactionReceipt: async () => ({ status: "success", gasUsed: 1n, effectiveGasPrice: 1n, blockNumber: 1n, logs: [], from: "0x00000000000000000000000000000000000000cc" }),
        getBlock: async () => ({ timestamp: 1n }),
      }),
    }));
    const c = await import("@/lib/monad/contracts");
    return { c, calls };
  }
  afterEach(() => vi.doUnmock("@/lib/monad/wallet"));

  it("reserved funds: releases amount + fee so the recipient gets exactly the amount", async () => {
    const { c, calls } = await harness(parseUnits("100", 6));
    await c.releaseFromVault({ automationId: "sch_test-1", amount: 20, tokenDecimals: 6, requestId: "r1", vaultAddress: VAULT, feeOnTop: true });
    expect(calls[0].functionName).toBe("release");
    expect(calls[0].args[1]).toBe(20_050125n);
  });
  it("reserved funds, created before the change (no flag): releases exactly the amount, as it was funded", async () => {
    const { c, calls } = await harness(parseUnits("100", 6));
    await c.releaseFromVault({ automationId: "sch_test-2", amount: 20, tokenDecimals: 6, requestId: "r2", vaultAddress: VAULT });
    expect(calls[0].args[1]).toBe(20_000000n);
  });
  it("a reservation that covers the payment but not the fee says so, and nothing is released", async () => {
    const { c, calls } = await harness(20_000000n);
    await expect(c.releaseFromVault({ automationId: "sch_test-3", amount: 20, tokenDecimals: 6, requestId: "r3", vaultAddress: VAULT, feeOnTop: true }))
      .rejects.toThrow(/covers this payment but not PayAI's fee on top/);
    expect(calls).toHaveLength(0);
  });
  it("wallet automation: the executor pulls amount + fee", async () => {
    const { c, calls } = await harness(0n);
    await c.executePaymentFromViaExecutor({
      from: USER as `0x${string}`, token: USDC as `0x${string}`, tokenDecimals: 6, merchant: TO as `0x${string}`, amount: 20,
      riskScore: 0, decisionMeta: "{}", ref: null, requestId: "r4", executorAddress: EXECUTOR as `0x${string}`, feeOnTop: true,
    });
    expect(calls[0].functionName).toBe("executePaymentFrom");
    expect(calls[0].args[3]).toBe(20_050125n);
  });
  it("wallet automation: an allowance that covers the amount but not the fee refuses before any transaction", async () => {
    const { c, calls } = await harness(0n, 20_000000n);
    await expect(c.executePaymentFromViaExecutor({
      from: USER as `0x${string}`, token: USDC as `0x${string}`, tokenDecimals: 6, merchant: TO as `0x${string}`, amount: 20,
      riskScore: 0, decisionMeta: "{}", ref: null, requestId: "r5", executorAddress: EXECUTOR as `0x${string}`, feeOnTop: true,
    })).rejects.toThrow(/WALLET_AUTHORIZATION_UNAVAILABLE/);
    expect(calls).toHaveLength(0);
  });
});
