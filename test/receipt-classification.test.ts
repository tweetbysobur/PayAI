import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, getAddress, pad, toEventSelector, type Hex } from "viem";

/**
 * Receipt classification on the user-signed confirm path, the forwarder's
 * fee-event provenance, and the executor audit trail.
 *
 * MOCKED: every log below is built in this test with the real event ABIs.
 * Nothing here is chain data, and no RPC is touched (the one RPC call in
 * buildAuditTrail — getBlock — is mocked).
 */

vi.mock("@/lib/monad/wallet", () => ({
  getPublicClient: () => ({ getBlock: async () => ({ timestamp: 1_800_000_000n }) }),
  getAgentAccount: () => null,
  getWalletClient: () => null,
}));

const WALLET = getAddress("0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
const RECIPIENT = getAddress("0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc");
const STRANGER = getAddress("0x90f79bf6eb2c4f870365e785982e1f101e93b906");
const USDC = getAddress("0x754704bc059f8c67012fed69bc8a327a5aafb603");
const FORWARDER = getAddress("0x8b2c7e8fa09fcd664dba9764fd63bf3a4c56464d");
const OLD_FORWARDER = getAddress("0x1111111111111111111111111111111111111111");
const EXECUTOR = getAddress("0x5caf11937acbaafd774c3906a5086a7507fae84d");
const VAULT = getAddress("0xc4ded0939e400f568472bee30c4b123a96f85b35");
const UNRELATED = getAddress("0x2222222222222222222222222222222222222222");
const TREASURY = getAddress("0xa282833b52b1b66d58bd2007081dcc037798c0b0");
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ONE_USDC = 1_000_000n;

const transferLog = (from: string, to: string, value: bigint, token: string = USDC) => ({
  address: token, topics: [TRANSFER, pad(from as Hex), pad(to as Hex)] as Hex[], data: pad(`0x${value.toString(16)}`) as Hex,
});
async function forwarderLogs(forwarder: string, gross: bigint, fee: bigint) {
  const { PAYAI_FORWARDER_ABI, FORWARDER_FEE_COLLECTED_ABI } = await import("@/lib/monad/forwarder");
  return [
    {
      address: forwarder,
      topics: encodeEventTopics({ abi: PAYAI_FORWARDER_ABI, eventName: "PaymentForwarded", args: { id: 3n, payer: WALLET, recipient: RECIPIENT } }) as Hex[],
      data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes32" }], [USDC, gross, pad("0x0")]),
    },
    {
      address: forwarder,
      topics: encodeEventTopics({ abi: FORWARDER_FEE_COLLECTED_ABI, eventName: "FeeCollected", args: { id: 3n } }) as Hex[],
      data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "address" }], [USDC, fee, TREASURY]),
    },
  ];
}
const ev = () => import("@/lib/payment/receiptEvidence");
const ALL_FEE_CONTRACTS = [FORWARDER, EXECUTOR, VAULT, null, null];

describe("B1 — ERC-20 direct-transfer branch: verified zero only for a plain transfer from this wallet", () => {
  it("a plain USDC transfer from the wallet, targeting the token, with no PayAI fee evidence → verified zero", async () => {
    const { directErc20FeeEvidence } = await ev();
    expect(directErc20FeeEvidence({
      txTo: USDC, token: USDC, decimals: 6, wallet: WALLET, recipient: RECIPIENT, minAmount: ONE_USDC,
      logs: [transferLog(WALLET, RECIPIENT, ONE_USDC)], feeContracts: ALL_FEE_CONTRACTS,
    })).toEqual({ kind: "none", received: { units: ONE_USDC, decimals: 6 } });
  });

  it("a FORWARDED payment reaching this branch (forwarder missing or rotated) is never a verified zero", async () => {
    const { directErc20FeeEvidence } = await ev();
    // V2 pays the recipient with transferFrom(payer → recipient, net): its USDC Transfer looks like a direct one.
    const logs = [transferLog(WALLET, RECIPIENT, ONE_USDC), transferLog(WALLET, TREASURY, 2506n), ...(await forwarderLogs(OLD_FORWARDER, ONE_USDC + 2506n, 2506n))];
    // Forwarder not configured at all in this deployment.
    expect(directErc20FeeEvidence({ txTo: OLD_FORWARDER, token: USDC, decimals: 6, wallet: WALLET, recipient: RECIPIENT, minAmount: ONE_USDC, logs, feeContracts: [null, null, null, null, null] }).kind).toBe("unverified");
    // Forwarder rotated: the configured one is new; the tx used the old one.
    expect(directErc20FeeEvidence({ txTo: OLD_FORWARDER, token: USDC, decimals: 6, wallet: WALLET, recipient: RECIPIENT, minAmount: ONE_USDC, logs, feeContracts: ALL_FEE_CONTRACTS }).kind).toBe("unverified");
    // Even if a tx reported the token as its target, the fee events alone rule it out.
    expect(directErc20FeeEvidence({ txTo: USDC, token: USDC, decimals: 6, wallet: WALLET, recipient: RECIPIENT, minAmount: ONE_USDC, logs, feeContracts: [] }).kind).toBe("unverified");
  });

  it("a Transfer from another sender is never a verified zero", async () => {
    const { directErc20FeeEvidence } = await ev();
    expect(directErc20FeeEvidence({
      txTo: USDC, token: USDC, decimals: 6, wallet: WALLET, recipient: RECIPIENT, minAmount: ONE_USDC,
      logs: [transferLog(STRANGER, RECIPIENT, ONE_USDC)], feeContracts: ALL_FEE_CONTRACTS,
    }).kind).toBe("unverified");
  });

  it("any log from a known PayAI fee contract, or a PayAI fee-event signature from anywhere → never a verified zero", async () => {
    const { directErc20FeeEvidence } = await ev();
    const base = { txTo: USDC, token: USDC, decimals: 6, wallet: WALLET, recipient: RECIPIENT, minAmount: ONE_USDC, feeContracts: ALL_FEE_CONTRACTS };
    for (const extra of [
      { address: EXECUTOR, topics: [pad("0x01")] as Hex[], data: "0x" as Hex },          // the payment executor took part
      { address: VAULT, topics: [pad("0x02")] as Hex[], data: "0x" as Hex },             // the automation vault took part
      ...(await forwarderLogs(UNRELATED, ONE_USDC, 0n)),                                 // fee events from an unknown address
    ]) {
      expect(directErc20FeeEvidence({ ...base, logs: [transferLog(WALLET, RECIPIENT, ONE_USDC), extra] }).kind, extra.address).toBe("unverified");
    }
  });

  it("the transaction must target the token contract itself (a helper contract stays unverified)", async () => {
    const { directErc20FeeEvidence } = await ev();
    expect(directErc20FeeEvidence({
      txTo: UNRELATED, token: USDC, decimals: 6, wallet: WALLET, recipient: RECIPIENT, minAmount: ONE_USDC,
      logs: [transferLog(WALLET, RECIPIENT, ONE_USDC)], feeContracts: ALL_FEE_CONTRACTS,
    }).kind).toBe("unverified");
  });

  it("the fee-event signatures are the real ones (forwarder, executor, vault ABIs and contract source)", async () => {
    const { PAYAI_FEE_EVENT_TOPICS } = await ev();
    const { PAYAI_FORWARDER_ABI, FORWARDER_FEE_COLLECTED_ABI } = await import("@/lib/monad/forwarder");
    const { PAYMENT_EXECUTOR_ABI } = await import("@/lib/monad/abi");
    const sel = (abi: readonly unknown[], name: string) => (encodeEventTopics({ abi: abi as never, eventName: name as never } as never)[0] as string).toLowerCase();
    expect(PAYAI_FEE_EVENT_TOPICS).toContain(sel(PAYAI_FORWARDER_ABI, "PaymentForwarded"));
    expect(PAYAI_FEE_EVENT_TOPICS).toContain(sel(FORWARDER_FEE_COLLECTED_ABI, "FeeCollected"));
    expect(PAYAI_FEE_EVENT_TOPICS).toContain(sel(PAYMENT_EXECUTOR_ABI, "PaymentExecuted"));
    // The vault's FeeCollected has its own signature — taken from the contract source.
    const vaultSrc = readFileSync(new URL("../contracts/contracts/AutomationVaultV2.sol", import.meta.url), "utf8");
    const decl = /event FeeCollected\(([^)]*)\);/.exec(vaultSrc)![1];
    expect(PAYAI_FEE_EVENT_TOPICS).toContain(toEventSelector(`event FeeCollected(${decl})`).toLowerCase());
  });
});

describe("USDC direct transfer — the receipt reports the amount actually received", () => {
  const base = { txTo: USDC, token: USDC, decimals: 6, wallet: WALLET, recipient: RECIPIENT, minAmount: ONE_USDC, feeContracts: ALL_FEE_CONTRACTS };
  const receiptFor = async (feeEvidence: import("@/lib/payment/feeMath").FeeEvidence) =>
    (await import("@/lib/payment/feeEngine")).buildReceipt({ feature: "send_payment", amount: 1, token: "USDC", gasFee: "0.0004", status: "executed", feeEvidence });

  it("1. a normal transfer: recipient received exactly the requested amount", async () => {
    const { directErc20FeeEvidence } = await ev();
    const r = await receiptFor(directErc20FeeEvidence({ ...base, logs: [transferLog(WALLET, RECIPIENT, ONE_USDC)] }));
    expect(r.paymentAmount).toBe(1);
    expect(r.recipientReceives).toBe("1 USDC");
    expect(r.totalCost).toBe("1 USDC + 0.0004 MON gas");
    expect(r.platformFee).toMatchObject({ fee: 0, isFree: true, status: "verified" });
  });

  it("2. an overpayment (accepted, as before): 'Payment amount' stays requested, 'Recipient received' is what moved", async () => {
    const { directErc20FeeEvidence } = await ev();
    const r = await receiptFor(directErc20FeeEvidence({ ...base, logs: [transferLog(WALLET, RECIPIENT, 1_250_000n)] }));
    expect(r.paymentAmount).toBe(1);
    expect(r.recipientReceives).toBe("1.25 USDC");
    expect(r.totalCost).toBe("1.25 USDC + 0.0004 MON gas");
  });

  it("3. an unrelated Transfer never determines the amount (another sender, another recipient, another token)", async () => {
    const { directErc20FeeEvidence } = await ev();
    const OTHER_TOKEN = getAddress("0x3333333333333333333333333333333333333333");
    const e = directErc20FeeEvidence({ ...base, logs: [
      transferLog(STRANGER, RECIPIENT, 9_000_000n),          // someone else paid the recipient too
      transferLog(WALLET, STRANGER, 7_000_000n),             // the wallet paid someone else
      transferLog(WALLET, RECIPIENT, 5_000_000n, OTHER_TOKEN), // a different token
      transferLog(WALLET, RECIPIENT, 1_100_000n),            // THE payment
    ] });
    expect(e).toEqual({ kind: "none", received: { units: 1_100_000n, decimals: 6 } });
    expect((await receiptFor(e)).recipientReceives).toBe("1.1 USDC");
  });

  it("4. missing or ambiguous evidence → no amount and no zero-fee claim", async () => {
    const { directErc20FeeEvidence } = await ev();
    const cases: [string, unknown[]][] = [
      ["no Transfer from the wallet at all", [transferLog(STRANGER, RECIPIENT, ONE_USDC)]],
      ["two Transfers from the wallet to the recipient (which is the payment?)", [transferLog(WALLET, RECIPIENT, ONE_USDC), transferLog(WALLET, RECIPIENT, 300_000n)]],
      ["the wallet's Transfer is below the requested amount", [transferLog(WALLET, RECIPIENT, 999_999n), transferLog(STRANGER, RECIPIENT, ONE_USDC)]],
      ["an unreadable Transfer value", [{ ...transferLog(WALLET, RECIPIENT, ONE_USDC), data: "0xnot-hex" as Hex }]],
    ];
    for (const [label, logs] of cases) {
      const e = directErc20FeeEvidence({ ...base, logs: logs as never });
      expect(e, label).toEqual({ kind: "unverified" });
      const r = await receiptFor(e);
      expect(r.recipientReceives, label).toBeNull();
      expect(r.platformFee.isFree, label).toBe(false);
      expect(r.feeStatus, label).toBe("unverified");
    }
  });
});

describe("B3 — native MON direct transfer reports the ACTUAL value received", () => {
  it("an overpayment (accepted, as before) shows what was really sent", async () => {
    const { directNativeFeeEvidence } = await ev();
    const e = directNativeFeeEvidence({ txTo: RECIPIENT, recipient: RECIPIENT, value: 1_500_000_000_000_000_000n, logs: [], feeContracts: ALL_FEE_CONTRACTS });
    expect(e).toEqual({ kind: "none", received: { units: 1_500_000_000_000_000_000n, decimals: 18 } });
    const { buildReceipt } = await import("@/lib/payment/feeEngine");
    const r = buildReceipt({ feature: "send_payment", amount: 1, token: "MON", gasFee: "0.001", status: "executed", feeEvidence: e });
    expect(r.paymentAmount).toBe(1);                     // what was requested
    expect(r.recipientReceives).toBe("1.5 MON");         // what actually moved
    expect(r.totalCost).toBe("1.5 MON + 0.001 MON gas");
    expect(r.platformFee).toMatchObject({ fee: 0, isFree: true, status: "verified" });
  });

  it("a PayAI fee contract as the recipient, or fee evidence in the logs, is never a verified zero", async () => {
    const { directNativeFeeEvidence } = await ev();
    expect(directNativeFeeEvidence({ txTo: FORWARDER, recipient: FORWARDER, value: 1n, logs: [], feeContracts: ALL_FEE_CONTRACTS }).kind).toBe("unverified");
    expect(directNativeFeeEvidence({ txTo: RECIPIENT, recipient: RECIPIENT, value: 1n, logs: await forwarderLogs(UNRELATED, 1n, 0n), feeContracts: [] }).kind).toBe("unverified");
  });
});

describe("A — forwarder fee provenance", () => {
  const expected = { payer: WALLET, recipient: RECIPIENT, token: USDC, amountUnits: ONE_USDC };
  const pf = (amount: bigint) => ({ id: 3n, payer: WALLET, recipient: RECIPIENT, token: USDC, amount, ref: pad("0x0") as Hex });

  it("FeeCollected present → event-backed, verified fee on the receipt", async () => {
    const { verifyForwardedNet } = await import("@/lib/monad/forwarder");
    const v = verifyForwardedNet(pf(ONE_USDC + 2506n), { id: 3n, token: USDC, feeAmount: 2506n, treasury: TREASURY }, expected);
    expect(v).toEqual({ fee: 2506n, feeOnTop: true, feeEvent: "collected" });
    const { feeEvidenceFromForward } = await ev();
    expect(feeEvidenceFromForward({ ...v!, decimals: 6 })).toEqual({ kind: "collected", feeUnits: 2506n, decimals: 6, basis: "on_top" });
  });

  it("FeeCollected absent → still ACCEPTED exactly as before (V1 compatibility), but the fee is unverified", async () => {
    const { verifyForwardedNet } = await import("@/lib/monad/forwarder");
    // A V1 forwarder: no fee, no FeeCollected; gross == amount.
    const v1 = verifyForwardedNet(pf(ONE_USDC), null, expected);
    expect(v1).not.toBeNull();
    expect(v1).toEqual({ fee: 0n, feeOnTop: true, feeEvent: "absent" });
    const { feeEvidenceFromForward } = await ev();
    expect(feeEvidenceFromForward({ ...v1!, decimals: 6 })).toEqual({ kind: "unverified" });
    // And a V2-shaped payment with a fee but no FeeCollected is still refused (unchanged).
    expect(verifyForwardedNet(pf(ONE_USDC + 2506n), null, expected)).toBeNull();
  });
});

describe("D2 — buildAuditTrail only trusts the executor's own PaymentExecuted", () => {
  async function executedLog(address: string, id: bigint) {
    const { PAYMENT_EXECUTOR_ABI } = await import("@/lib/monad/abi");
    return {
      address,
      topics: encodeEventTopics({ abi: PAYMENT_EXECUTOR_ABI, eventName: "PaymentExecuted", args: { id, agent: WALLET, merchant: RECIPIENT } }) as Hex[],
      data: encodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }, { type: "uint16" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
        [USDC, ONE_USDC, 5, pad("0x0"), pad("0x0"), pad("0x0")],
      ),
    };
  }
  async function feeLog(address: string, id: bigint, fee: bigint) {
    const { FORWARDER_FEE_COLLECTED_ABI } = await import("@/lib/monad/forwarder");
    return {
      address,
      topics: encodeEventTopics({ abi: FORWARDER_FEE_COLLECTED_ABI, eventName: "FeeCollected", args: { id } }) as Hex[],
      data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "address" }], [USDC, fee, TREASURY]),
    };
  }
  const receiptOf = (logs: unknown[]) => ({ blockNumber: 1n, from: WALLET, logs }) as never;

  it("an unrelated contract's PaymentExecuted (emitted first) never sets the payment id", async () => {
    const { __buildAuditTrailForTests } = await import("@/lib/monad/contracts");
    const trail = await __buildAuditTrailForTests(receiptOf([
      await executedLog(UNRELATED, 99n), await feeLog(UNRELATED, 99n, 1n),   // spoofed by another contract
      await executedLog(EXECUTOR, 7n), await feeLog(EXECUTOR, 7n, 2500n),    // the real one
    ]), EXECUTOR);
    expect(trail.event?.paymentId).toBe(7);
    expect(trail.feeCollected).toEqual({ feeUnits: "2500", token: USDC });
  });

  it("with only an unrelated contract's events, there is no payment id and no fee", async () => {
    const { __buildAuditTrailForTests } = await import("@/lib/monad/contracts");
    const trail = await __buildAuditTrailForTests(receiptOf([await executedLog(UNRELATED, 7n), await feeLog(UNRELATED, 7n, 2500n)]), EXECUTOR);
    expect(trail.event).toBeUndefined();
    expect(trail.feeCollected).toBeUndefined();
  });
});

describe("the confirm route uses the classifiers and keeps acceptance unchanged", () => {
  const route = readFileSync(new URL("../app/api/agent/confirm/route.ts", import.meta.url), "utf8");
  it("acceptance is still exactly the existing checks", () => {
    expect(route).toMatch(/matched = isNativeTransferTo\(tx, recipient, wanted\);/);
    expect(route).toMatch(/matched = hasErc20TransferTo\(receipt\.logs, usdc\.address, recipient, wanted\);/);
    expect(route).toMatch(/matched = verdict !== null;/);
  });
  it("the receipt evidence comes from the classifiers, never a bare 'none'", () => {
    expect(route).toMatch(/directErc20FeeEvidence\(\{\s*txTo: receipt\.to, token: usdc\.address, decimals: usdc\.decimals, wallet: walletAddress/);
    expect(route).toMatch(/directNativeFeeEvidence\(\{ txTo: tx\.to, recipient, value: tx\.value/);
    expect(route).toMatch(/feeEvidenceFromForward\(\{ \.\.\.verdict, decimals \}\)/);
    expect(route).not.toMatch(/kind: "none"/);
  });
});
