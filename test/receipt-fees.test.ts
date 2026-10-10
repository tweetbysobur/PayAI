import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, getAddress, type Hex } from "viem";
import { NextRequest } from "next/server";

/**
 * Receipts report PayAI's fee from what the transaction PROVES, not from the
 * configured (env) rate:
 *   verified  — the settling contract's FeeCollected (zero or not), or no PayAI
 *               fee contract in the transaction at all;
 *   estimated — the configured rate, labelled as an estimate (e.g. simulation);
 *   unverified — a fee contract was involved but its fee event wasn't found.
 * Never "Free during Beta".
 *
 * MOCKED: every log and execution result below is constructed in this test
 * (encoded with the real event ABI). Nothing here is evidence of on-chain
 * behaviour, and no chain or RPC is touched.
 */

const ORIGINAL = { ...process.env };
beforeEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith("PAYAI_FEE_")) delete process.env[k];
  vi.resetModules();
});
afterEach(() => {
  process.env = { ...ORIGINAL };
  vi.resetModules();
  vi.doUnmock("@/lib/payment/engine");
});

const USDC = getAddress("0x754704bc059f8c67012fed69bc8a327a5aafb603");
const EXECUTOR = getAddress("0x5caf11937acbaafd774c3906a5086a7507fae84d");
const OTHER = getAddress("0x1111111111111111111111111111111111111111");
const TREASURY = getAddress("0xa282833b52b1b66d58bd2007081dcc037798c0b0");

async function receipt(input: Parameters<typeof import("@/lib/payment/feeEngine").buildReceipt>[0]) {
  return (await import("@/lib/payment/feeEngine")).buildReceipt(input);
}
const ev = () => import("@/lib/payment/receiptEvidence");

describe("receipt fee states", () => {
  it("verified non-zero fee ON TOP (forwarder): exact fee, recipient gets the amount, total = amount + fee", async () => {
    const { feeEvidenceFromForward } = await ev();
    const r = await receipt({
      feature: "send_payment", amount: 1, token: "USDC", gasFee: "0.0004", status: "executed",
      feeEvidence: feeEvidenceFromForward({ fee: 2506n, feeOnTop: true, feeEvent: "collected", decimals: 6 }),
    });
    expect(r.feeStatus).toBe("verified");
    expect(r.platformFee).toMatchObject({ fee: 0.002506, isFree: false, status: "verified", basis: "on_top" });
    expect(r.platformFee.label).toBe("0.002506 USDC — verified on-chain");
    expect(r.recipientReceives).toBe("1 USDC");
    expect(r.totalCost).toBe("1.002506 USDC + 0.0004 MON gas");
  });

  it("verified non-zero fee DEDUCTED (custodial PaymentExecutor): recipient gets amount − fee, total = amount", async () => {
    const { feeEvidenceFromExecution } = await ev();
    const r = await receipt({
      feature: "send_payment", amount: 1, token: "USDC", gasFee: "0.0004 MON", status: "executed",
      feeEvidence: feeEvidenceFromExecution({ mode: "monad", settledVia: "executor", feeCollected: { feeUnits: "2500", token: USDC, decimals: 6 } }),
    });
    expect(r.platformFee.label).toBe("0.0025 USDC (deducted from the payment) — verified on-chain");
    expect(r.platformFee.basis).toBe("deducted");
    expect(r.recipientReceives).toBe("0.9975 USDC");
    expect(r.totalCost).toBe("1 USDC + 0.0004 MON gas");
    expect(r.gasFee).toBe("0.0004"); // "… MON" suffix normalized, so the UI never shows "MON MON"
  });

  it("verified ZERO fee: a FeeCollected of 0, or no PayAI fee contract at all (direct transfer)", async () => {
    const { feeEvidenceFromForward, feeEvidenceFromExecution } = await ev();
    const zeroEvent = await receipt({
      feature: "send_payment", amount: 5, token: "USDC", status: "executed",
      feeEvidence: feeEvidenceFromForward({ fee: 0n, feeOnTop: true, feeEvent: "collected", decimals: 6 }),
    });
    expect(zeroEvent.platformFee).toMatchObject({ fee: 0, isFree: true, status: "verified", basis: "none", label: "None — verified on-chain" });
    expect(zeroEvent.totalCost).toBe("5 USDC");
    for (const e of [feeEvidenceFromExecution({ mode: "monad", settledVia: "direct" })]) {
      const r = await receipt({ feature: "send_payment", amount: 5, token: "MON", gasFee: "0.001", status: "executed", feeEvidence: e });
      expect(r.platformFee).toMatchObject({ fee: 0, isFree: true, status: "verified", basis: "none" });
      expect(r.platformFee.label).toMatch(/didn't go through a PayAI fee contract/);
      expect(r.totalCost).toBe("5.001 MON");
    }
  });

  it("missing fee event or data → 'not verified', never a number and never 'free'", async () => {
    const { feeEvidenceFromForward, feeEvidenceFromExecution } = await ev();
    const cases = [
      feeEvidenceFromForward({ fee: 0n, feeOnTop: true, feeEvent: "absent", decimals: 6 }),   // forwarder, no FeeCollected
      feeEvidenceFromExecution({ mode: "monad", settledVia: "executor" }),            // executor, no FeeCollected
      feeEvidenceFromExecution({ mode: "monad", settledVia: "vault" }),               // vault release: not decoded here
      feeEvidenceFromExecution({ mode: "monad" }),                                    // unknown route
      feeEvidenceFromExecution({ mode: "monad", settledVia: "executor", feeCollected: { feeUnits: "not-a-number", token: USDC, decimals: 6 } }),
    ];
    for (const e of cases) {
      expect(e.kind).toBe("unverified");
      const r = await receipt({ feature: "send_payment", amount: 3, token: "USDC", status: "executed", feeEvidence: e });
      expect(r.feeStatus).toBe("unverified");
      expect(r.platformFee.isFree).toBe(false);
      expect(r.platformFee.label).toMatch(/^Not verified/);
      expect(r.recipientReceives).toBeNull();
      expect(r.totalCost).toBe("3 USDC + PayAI fee (not verified)");
    }
  });

  it("a configured rate that disagrees with the actual fee never wins", async () => {
    const { feeEvidenceFromForward } = await ev();
    // Env says 0 but the contract collected 0.002506 → the receipt shows what was collected.
    let r = await receipt({ feature: "send_payment", amount: 1, token: "USDC", status: "executed", feeEvidence: feeEvidenceFromForward({ fee: 2506n, feeOnTop: true, feeEvent: "collected", decimals: 6 }) });
    expect(r.platformFee.fee).toBe(0.002506);
    // Env says 1% but no PayAI contract was involved → verified zero, not 1%.
    process.env.PAYAI_FEE_SEND_PAYMENT_BPS = "100";
    vi.resetModules();
    r = await receipt({ feature: "send_payment", amount: 1, token: "USDC", status: "executed", feeEvidence: (await ev()).feeEvidenceFromExecution({ mode: "monad", settledVia: "direct" }) });
    expect(r.platformFee).toMatchObject({ fee: 0, isFree: true, status: "verified" });
    // Without evidence the configured 1% is only an ESTIMATE, labelled and marked "≈".
    r = await receipt({ feature: "send_payment", amount: 200, token: "USDC", status: "executed" });
    expect(r.platformFee).toMatchObject({ fee: 2, status: "estimated", isFree: false });
    expect(r.platformFee.label).toBe("≈2 (estimated)");
    expect(r.totalCost).toBe("≈202 USDC");
  });

  it("nothing in the receipt module can print 'Free during Beta' any more", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of ["lib/payment/feeMath.ts", "lib/payment/feeEngine.ts", "app/dashboard/payments/page.tsx"]) {
      expect(readFileSync(new URL(`../${f}`, import.meta.url), "utf8"), f).not.toMatch(/Free during Beta/);
    }
  });
});

describe("decoding the collected fee from a receipt's logs (MOCKED logs)", () => {
  const FEE_COLLECTED = [{ type: "event", name: "FeeCollected", inputs: [
    { name: "id", type: "uint256", indexed: true }, { name: "token", type: "address", indexed: false },
    { name: "feeAmount", type: "uint256", indexed: false }, { name: "treasury", type: "address", indexed: false },
  ] }] as const;
  const log = (address: string, id: bigint, fee: bigint) => ({
    address,
    topics: encodeEventTopics({ abi: FEE_COLLECTED, eventName: "FeeCollected", args: { id } }) as `0x${string}`[],
    data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "address" }], [USDC, fee, TREASURY]) as Hex,
  });

  it("takes only the settling contract's FeeCollected for THIS payment id", async () => {
    const { decodeFeeCollected } = await import("@/lib/monad/forwarder");
    expect(decodeFeeCollected([log(EXECUTOR, 7n, 2500n)], EXECUTOR, 7n)?.feeAmount).toBe(2500n);
    expect(decodeFeeCollected([log(OTHER, 7n, 9999n)], EXECUTOR, 7n)).toBeNull();   // another contract's event
    expect(decodeFeeCollected([log(EXECUTOR, 8n, 9999n)], EXECUTOR, 7n)).toBeNull(); // another payment
    expect(decodeFeeCollected([log(EXECUTOR, 7n, 0n)], EXECUTOR, 7n)?.feeAmount).toBe(0n); // a verified zero
  });

  it("the executor's audit trail is given the executor address, and results carry how they settled", async () => {
    const { readFileSync } = await import("node:fs");
    const contracts = readFileSync(new URL("../lib/monad/contracts.ts", import.meta.url), "utf8");
    expect(contracts.match(/buildAuditTrail\(receipt, executor\)/g)?.length).toBe(3);
    expect(contracts).toMatch(/decodeFeeCollected\(receipt\.logs, executor, BigInt\(event\.paymentId\)\)/);
    const engine = readFileSync(new URL("../lib/payment/engine.ts", import.meta.url), "utf8");
    expect(engine.match(/settledVia: "executor"/g)?.length).toBe(3);
    expect(engine.match(/settledVia: "direct"/g)?.length).toBe(2);
    expect(engine).toMatch(/settledVia: "vault"/);
    expect(engine).toMatch(/settledVia: "simulation"/);
  });
});

describe("POST /api/agent custodial path (line ~577) now passes transaction evidence", () => {
  const post = (body: unknown) => new NextRequest("http://localhost/api/agent", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

  it("simulation (no chain): the receipt is an estimate labelled as simulated, never 'free'", async () => {
    process.env.PAYAI_MODE = "simulation";
    const { POST } = await import("@/app/api/agent/route");
    const res = await POST(post({ intent: `Send 5 USDC to ${OTHER}`, idempotencyKey: `t-${Math.random()}` }));
    const json = await res.json();
    expect(json.decision).toBe("executed");
    expect(json.receipt.feeStatus).toBe("estimated");
    expect(json.receipt.platformFee.label).toMatch(/simulation, nothing was charged/);
    expect(JSON.stringify(json.receipt)).not.toMatch(/Free during Beta/);
  });

  it("PaymentExecutor settlement (MOCKED execution result): the receipt shows the collected, deducted fee", async () => {
    process.env.PAYAI_MODE = "simulation"; // auth stays open; execution itself is mocked below
    vi.doMock("@/lib/payment/engine", async (importActual) => {
      const actual = await importActual<typeof import("@/lib/payment/engine")>();
      return {
        ...actual,
        // MOCKED: a settled PaymentExecutor result with a FeeCollected of 0.0125 USDC.
        execute: async () => ({
          status: "settled", mode: "monad", network: "monad", detail: "mocked", amount: 5, token: "USDC", recipient: OTHER,
          txHash: `0x${"ab".repeat(32)}`, gasFee: "0.0004 MON", settledVia: "executor",
          feeCollected: { feeUnits: "12500", token: USDC, decimals: 6 },
        }),
      };
    });
    const { POST } = await import("@/app/api/agent/route");
    const res = await POST(post({ intent: `Send 5 USDC to ${OTHER}`, idempotencyKey: `t-${Math.random()}` }));
    const json = await res.json();
    expect(json.decision).toBe("executed");
    expect(json.receipt).toMatchObject({ feeStatus: "verified", recipientReceives: "4.9875 USDC", totalCost: "5 USDC + 0.0004 MON gas", gasFee: "0.0004" });
    expect(json.receipt.platformFee.label).toBe("0.0125 USDC (deducted from the payment) — verified on-chain");
  });
});
