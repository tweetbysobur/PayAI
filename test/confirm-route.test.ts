import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, getAddress, pad, parseAbi, TransactionReceiptNotFoundError, type Hex } from "viem";
import { grantCookieFor } from "./walletGrantCookie";

/**
 * POST /api/agent/confirm, driven as a route against a MOCKED chain.
 *
 * Nothing here is chain data: the receipt, transaction and block are built in
 * this file (logs with the real event ABIs), and viem's createPublicClient is
 * replaced so no RPC is touched. Approvals are stored with the real
 * idempotency store, exactly as /api/agent stores them.
 *
 * Two kinds of assertion, kept apart on purpose:
 *   ACCEPTANCE    — status / success / reason: was the payment accepted?
 *   CLASSIFICATION — body.receipt.platformFee: what the receipt claims about
 *                    the fee, decided from evidence and never by acceptance.
 */

vi.setConfig({ testTimeout: 20_000 });

const WALLET = getAddress("0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
const RECIPIENT = getAddress("0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc");
const STRANGER = getAddress("0x90f79bf6eb2c4f870365e785982e1f101e93b906");
const USDC = getAddress("0x754704bc059f8c67012fed69bc8a327a5aafb603");
const OTHER_TOKEN = getAddress("0x3333333333333333333333333333333333333333");
const FORWARDER = getAddress("0x8b2c7e8fa09fcd664dba9764fd63bf3a4c56464d");
const OLD_FORWARDER = getAddress("0x4ce7000000000000000000000000000000000709");
const HELPER = getAddress("0x2222222222222222222222222222222222222222");
const TREASURY = getAddress("0xa282833b52b1b66d58bd2007081dcc037798c0b0");
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const TX = `0x${"ab".repeat(32)}` as Hex;
const ONE = 1_000_000n; // 1 USDC
const GROSS = 1_002_506n; // 1 USDC + 0.25% of the gross, floored
const FEE = 2_506n;

const TRANSFER_ABI = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);
const NOW_S = 1_800_000_000n;

// The mocked chain: what the route's public client returns.
const chain = {
  receipt: null as unknown,
  tx: null as unknown,
  blockTimestamp: NOW_S,
  // viem's own not-found error — what a node with no receipt (not mined yet) produces.
  getTransactionReceipt: vi.fn(async () => { if (!chain.receipt) throw new TransactionReceiptNotFoundError({ hash: TX }); return chain.receipt; }),
  getTransaction: vi.fn(async () => chain.tx),
  getBlock: vi.fn(async () => ({ timestamp: chain.blockTimestamp })),
};
vi.mock("viem", async (orig) => ({ ...(await orig<typeof import("viem")>()), createPublicClient: () => chain }));
vi.mock("@/lib/payment/sanctions", async (orig) => ({ ...(await orig<typeof import("@/lib/payment/sanctions")>()), ensureSanctionsLoaded: async () => {} }));

const transferLog = (from: string, to: string, value: bigint, token: string = USDC) => ({
  address: token, topics: [TRANSFER, pad(from as Hex), pad(to as Hex)] as Hex[], data: pad(`0x${value.toString(16)}`) as Hex,
});
async function forwarderLogs(o: { forwarder?: string; gross: bigint; fee?: bigint | null; payer?: string; recipient?: string; token?: string; ref?: Hex; id?: bigint }) {
  const { PAYAI_FORWARDER_ABI, FORWARDER_FEE_COLLECTED_ABI } = await import("@/lib/monad/forwarder");
  const forwarder = o.forwarder ?? FORWARDER;
  const id = o.id ?? 3n;
  const logs: { address: string; topics: Hex[]; data: Hex }[] = [{
    address: forwarder,
    topics: encodeEventTopics({ abi: PAYAI_FORWARDER_ABI, eventName: "PaymentForwarded", args: { id, payer: (o.payer ?? WALLET) as Hex, recipient: (o.recipient ?? RECIPIENT) as Hex } }) as Hex[],
    data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes32" }], [(o.token ?? USDC) as Hex, o.gross, o.ref ?? pad("0x0")]),
  }];
  if (o.fee != null) {
    logs.push({
      address: forwarder,
      topics: encodeEventTopics({ abi: FORWARDER_FEE_COLLECTED_ABI, eventName: "FeeCollected", args: { id } }) as Hex[],
      data: encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "address" }], [(o.token ?? USDC) as Hex, o.fee, TREASURY]),
    });
  }
  return logs;
}

const ENV = ["MONAD_NETWORK", "MONAD_MAINNET_USDC", "MONAD_MAINNET_PAYAI_FORWARDER", "PAYAI_FORWARDER_ENABLED", "KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"] as const;

beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  process.env.MONAD_NETWORK = "mainnet";
  process.env.MONAD_MAINNET_USDC = USDC;
  process.env.MONAD_MAINNET_PAYAI_FORWARDER = FORWARDER;
  vi.resetModules();
  // The idempotency store keeps its map on globalThis, so it survives
  // resetModules — start every test with no claims and no stored approvals.
  (globalThis as { __veripayIdem?: Map<string, unknown> }).__veripayIdem?.clear();
  chain.receipt = null;
  chain.tx = null;
  chain.blockTimestamp = NOW_S;
});

const post = (body: unknown, headers: Record<string, string> = {}, path = "/api/agent/confirm") =>
  new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `10.1.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, ...grantCookieFor((body as { walletAddress?: unknown }).walletAddress), ...headers },
    body: JSON.stringify(body),
  });

/** The parts of the response these tests read. */
type Body = { success?: boolean; reason?: string; reverted?: boolean; receipt?: { platformFee?: { status: string; basis: string; isFree: boolean }; recipientReceives?: string }; transaction?: { sender: string } };
type Unsigned = { to: string; data: string; value: string; from: string };
const intentOf = (token: "USDC" | "MON", amount = 1) => ({
  action: "send_payment", amount, token, recipient: RECIPIENT, purpose: null, network: "monad",
  rawText: `Send ${amount} ${token}`, summary: `Send ${amount} ${token}`, confidence: 1,
});
const transferData = (to: string, amount: bigint) => encodeFunctionData({ abi: TRANSFER_ABI, functionName: "transfer", args: [to as Hex, amount] });
const forwardData = async (gross: bigint, recipient: string = RECIPIENT, ref: Hex = pad("0x0")) => (await import("@/lib/monad/forwarder")).encodeForwardPayment(USDC, recipient as Hex, gross, ref);
const forwardNativeData = async (gross: bigint, ref: Hex = pad("0x0")) => (await import("@/lib/monad/forwarder")).encodeForwardPaymentNative(RECIPIENT as Hex, gross, ref);

const DIRECT_USDC: Unsigned = { to: USDC, data: transferData(RECIPIENT, ONE), value: "0x0", from: WALLET };

/** Store an approval the way /api/agent does (real idempotency store, under
 *  /api/agent's own key for the shared demo tenant and this wallet). */
async function approve(id: string, unsignedTx: Unsigned | null, intent: object = intentOf("USDC"), extra: object = {}) {
  const { agentRequestKey, completeRequest } = await import("@/lib/platform/idempotency");
  await completeRequest(agentRequestKey("demo", WALLET, id), { decision: "ready_to_sign", intent, source: "deterministic", unsignedTx, approvalTx: null, requestId: id, success: false, ...extra });
}
/** Mine a transaction in the mocked chain. */
function mine(t: { to: string; input: string; value?: bigint; from?: string }, logs: unknown[], status: "success" | "reverted" = "success") {
  const from = t.from ?? WALLET;
  chain.receipt = { status, from, to: t.to, logs, blockNumber: 77n, gasUsed: 21_000n, effectiveGasPrice: 50_000_000_000n };
  chain.tx = { hash: TX, from, to: t.to, input: t.input, value: t.value ?? 0n };
}
async function confirm(id: string | undefined, over: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const { POST } = await import("@/app/api/agent/confirm/route");
  const res = await POST(post({ rawText: "Send 1 USDC", walletAddress: WALLET, txHash: TX, ...(id ? { requestId: id } : {}), ...over }, headers));
  return { status: res.status, body: (await res.json()) as Body };
}
const fee = (r: { body: Body }) => r.body.receipt?.platformFee;

describe("ACCEPTANCE — direct ERC-20 (rollback path: PAYAI_FORWARDER_ENABLED off)", () => {
  it("accepts the approved transfer; the receipt calls the fee a verified zero with the amount received", async () => {
    await approve("a1", DIRECT_USDC);
    mine({ to: USDC, input: DIRECT_USDC.data }, [transferLog(WALLET, RECIPIENT, ONE)]);
    const r = await confirm("a1");
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(r.body.transaction?.sender).toBe(WALLET);
    // classification, separately:
    expect(fee(r)).toMatchObject({ status: "verified", basis: "none" });
  });

  it("an overpayment is still accepted, and the receipt reports what actually moved", async () => {
    await approve("a2", DIRECT_USDC);
    mine({ to: USDC, input: transferData(RECIPIENT, 1_500_000n) }, [transferLog(WALLET, RECIPIENT, 1_500_000n)]);
    const r = await confirm("a2");
    expect(r.status).toBe(200);
    expect(r.body.receipt?.recipientReceives).toBe("1.5 USDC");
  });

  it("an underpayment is rejected", async () => {
    await approve("a3", DIRECT_USDC);
    mine({ to: USDC, input: transferData(RECIPIENT, 999_999n) }, [transferLog(WALLET, RECIPIENT, 999_999n)]);
    const r = await confirm("a3");
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe("underpaid");
  });

  it("rejects a transaction sent to the wrong target, even if USDC reached the recipient (unrelated tx)", async () => {
    await approve("a4", DIRECT_USDC);
    // The wallet called a helper contract; the logs still show wallet→recipient USDC.
    mine({ to: HELPER, input: "0xdeadbeef" }, [transferLog(WALLET, RECIPIENT, ONE)]);
    const r = await confirm("a4");
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe("tx_target_mismatch");
    expect(r.body.success).toBeUndefined();
  });

  it("rejects calldata that pays a different recipient, even with a wallet→recipient Transfer in the logs", async () => {
    await approve("a5", DIRECT_USDC);
    mine({ to: USDC, input: transferData(STRANGER, ONE) }, [transferLog(WALLET, STRANGER, ONE), transferLog(WALLET, RECIPIENT, ONE)]);
    const r = await confirm("a5");
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe("calldata_recipient_mismatch");
  });

  it("rejects non-transfer calldata sent to the token (e.g. transferFrom/approve)", async () => {
    await approve("a6", DIRECT_USDC);
    mine({ to: USDC, input: "0x095ea7b3" + "00".repeat(64) }, [transferLog(WALLET, RECIPIENT, ONE)]);
    const r = await confirm("a6");
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe("calldata_not_transfer");
  });

  it("rejects when the Transfer evidence is missing", async () => {
    await approve("a7", DIRECT_USDC);
    mine({ to: USDC, input: DIRECT_USDC.data }, []);
    const r = await confirm("a7");
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe("no_transfer_event");
  });

  it("rejects a third party's Transfer event (wrong payer) and a wrong-token event", async () => {
    await approve("a8", DIRECT_USDC);
    mine({ to: USDC, input: DIRECT_USDC.data }, [transferLog(STRANGER, RECIPIENT, ONE)]);
    expect((await confirm("a8")).body.reason).toBe("no_transfer_event");

    await approve("a9", DIRECT_USDC);
    mine({ to: USDC, input: DIRECT_USDC.data }, [transferLog(WALLET, RECIPIENT, ONE, OTHER_TOKEN)]);
    expect((await confirm("a9")).body.reason).toBe("no_transfer_event");
  });

  it("rejects ambiguous evidence (two matching Transfers) rather than guessing which is the payment", async () => {
    await approve("a10", DIRECT_USDC);
    mine({ to: USDC, input: DIRECT_USDC.data }, [transferLog(WALLET, RECIPIENT, ONE), transferLog(WALLET, RECIPIENT, ONE)]);
    expect((await confirm("a10")).body.reason).toBe("ambiguous_transfer_events");
  });

  it("rejects a reverted transaction and a not-yet-mined one", async () => {
    await approve("a11", DIRECT_USDC);
    mine({ to: USDC, input: DIRECT_USDC.data }, [transferLog(WALLET, RECIPIENT, ONE)], "reverted");
    const reverted = await confirm("a11");
    expect(reverted.status).toBe(409);
    expect(reverted.body.reverted).toBe(true);

    chain.receipt = null;
    const pending = await confirm("a11");
    expect(pending.status).toBe(409);
    expect(pending.body.success).toBeUndefined();
  });

  it("rejects a transaction not sent from the declared wallet", async () => {
    await approve("a12", DIRECT_USDC);
    mine({ to: USDC, input: DIRECT_USDC.data, from: STRANGER }, [transferLog(STRANGER, RECIPIENT, ONE)]);
    const r = await confirm("a12");
    expect(r.status).toBe(409);
  });
});

describe("ACCEPTANCE — the stored approval is required and binding", () => {
  it("no requestId: refused, even though rawText would parse to a valid payment", async () => {
    mine({ to: USDC, input: DIRECT_USDC.data }, [transferLog(WALLET, RECIPIENT, ONE)]);
    const r = await confirm(undefined, { rawText: `Send 1 USDC to ${RECIPIENT}` });
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe("approval_required");
    expect(r.body.success).toBeUndefined();
  });

  it("unknown / expired approval: refused, rawText is not a substitute", async () => {
    mine({ to: USDC, input: DIRECT_USDC.data }, [transferLog(WALLET, RECIPIENT, ONE)]);
    const r = await confirm("never-stored", { rawText: `Send 1 USDC to ${RECIPIENT}` });
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe("approval_not_found");
  });

  it("a claimed-but-unfinished approval (not 'done') is not an approval", async () => {
    const { agentRequestKey, claimRequest } = await import("@/lib/platform/idempotency");
    await claimRequest(agentRequestKey("demo", WALLET, "half"));
    mine({ to: USDC, input: DIRECT_USDC.data }, [transferLog(WALLET, RECIPIENT, ONE)]);
    expect((await confirm("half")).body.reason).toBe("approval_not_found");
  });

  it("a stored record that is not a ready_to_sign transfer is refused", async () => {
    await approve("blocked", DIRECT_USDC, intentOf("USDC"), { decision: "blocked" });
    mine({ to: USDC, input: DIRECT_USDC.data }, [transferLog(WALLET, RECIPIENT, ONE)]);
    // The record exists but isn't a usable approval: the settled payment is
    // reported unmatched (evidence kept), never verified against it.
    const r = await confirm("blocked");
    expect(r.body.reason).toBe("approval_invalid");
    expect((r.body as Record<string, unknown>).state).toBe("settled_unmatched");
  });

  it("a payment that differs from the stored unsignedTx is refused (approval is for another recipient)", async () => {
    // The stored approval pays STRANGER; the chain shows a valid payment to RECIPIENT of the intent.
    await approve("diff", { ...DIRECT_USDC, data: transferData(STRANGER, ONE) });
    mine({ to: USDC, input: DIRECT_USDC.data }, [transferLog(WALLET, RECIPIENT, ONE)]);
    const r = await confirm("diff");
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe("stored_calldata_mismatch");
  });

  it("an approval that is none of the supported payment paths is refused", async () => {
    await approve("weird", { to: HELPER, data: "0xdeadbeef", value: "0x0", from: WALLET });
    mine({ to: HELPER, input: "0xdeadbeef" }, [transferLog(WALLET, RECIPIENT, ONE)]);
    const r = await confirm("weird");
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe("unsupported_path");
  });

  it("an approval issued to a different wallet cannot be used by this wallet", async () => {
    await approve("other-wallet", { ...DIRECT_USDC, from: STRANGER });
    mine({ to: USDC, input: DIRECT_USDC.data }, [transferLog(WALLET, RECIPIENT, ONE)]);
    expect((await confirm("other-wallet")).status).toBe(409);
  });

  it("a transaction mined before the approval existed is refused (creation-time check)", async () => {
    await approve("early", DIRECT_USDC);
    mine({ to: USDC, input: DIRECT_USDC.data }, [transferLog(WALLET, RECIPIENT, ONE)]);
    chain.blockTimestamp = BigInt(Math.floor(Date.now() / 1000) - 3_600); // an hour before the approval
    const r = await confirm("early");
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe("mined_before_approval");

    chain.blockTimestamp = BigInt(Math.floor(Date.now() / 1000) + 5); // mined just after approval
    expect((await confirm("early")).status).toBe(200);
  });

  it("a rejected confirm releases its claim, so the genuine transaction can still be confirmed", async () => {
    await approve("retry", DIRECT_USDC);
    mine({ to: HELPER, input: "0x" }, [transferLog(WALLET, RECIPIENT, ONE)]);
    expect((await confirm("retry")).status).toBe(409);
    mine({ to: USDC, input: DIRECT_USDC.data }, [transferLog(WALLET, RECIPIENT, ONE)]);
    expect((await confirm("retry")).status).toBe(200);
  });
});

describe("ACCEPTANCE — forwarder payments (V2 fee on top, V1 legacy)", () => {
  it("V2: accepts the approved forward; the receipt shows the verified fee", async () => {
    const data = await forwardData(GROSS);
    await approve("f1", { to: FORWARDER, data, value: "0x0", from: WALLET });
    mine({ to: FORWARDER, input: data }, await forwarderLogs({ gross: GROSS, fee: FEE }));
    const r = await confirm("f1");
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    // classification:
    expect(fee(r)).toMatchObject({ status: "verified", basis: "on_top" });
    expect(r.body.receipt?.recipientReceives).toBe("1 USDC");
  });

  it("V1 (no fee, no FeeCollected, gross == amount): accepted; the fee is NOT claimed as verified", async () => {
    const data = await forwardData(ONE);
    await approve("f2", { to: FORWARDER, data, value: "0x0", from: WALLET });
    mine({ to: FORWARDER, input: data }, await forwarderLogs({ gross: ONE, fee: null }));
    const r = await confirm("f2");
    expect(r.status).toBe(200); // acceptance per the verified path
    expect(fee(r)?.status).toBe("unverified"); // classification: missing evidence is not a zero fee
    expect(fee(r)?.isFree).toBe(false);
  });

  it("missing FeeCollected on an on-top payment is rejected (net != approved amount), never treated as a zero fee", async () => {
    const data = await forwardData(GROSS);
    await approve("f3", { to: FORWARDER, data, value: "0x0", from: WALLET });
    mine({ to: FORWARDER, input: data }, await forwarderLogs({ gross: GROSS, fee: null }));
    const r = await confirm("f3");
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe("forwarded_event_mismatch");
  });

  it("a payment approved through a forwarder that is no longer configured still verifies (legacy / in-flight)", async () => {
    const data = await forwardData(ONE);
    await approve("f4", { to: OLD_FORWARDER, data, value: "0x0", from: WALLET });
    mine({ to: OLD_FORWARDER, input: data }, await forwarderLogs({ forwarder: OLD_FORWARDER, gross: ONE, fee: null }));
    const r = await confirm("f4");
    expect(r.status).toBe(200);
    expect(fee(r)?.status).toBe("unverified");
  });

  it("native MON through the forwarder: accepted, value and calldata bound to the approval", async () => {
    const gross = 1_002_506_265_664_160_402n;
    const data = await forwardNativeData(gross);
    await approve("f5", { to: FORWARDER, data, value: `0x${gross.toString(16)}`, from: WALLET }, intentOf("MON"));
    mine({ to: FORWARDER, input: data, value: gross }, await forwarderLogs({ gross, fee: 2_506_265_664_160_402n, token: "0x0000000000000000000000000000000000000000" }));
    const r = await confirm("f5");
    expect(r.status).toBe(200);
    // wrong value → refused
    await approve("f5b", { to: FORWARDER, data, value: `0x${gross.toString(16)}`, from: WALLET }, intentOf("MON"));
    mine({ to: FORWARDER, input: data, value: gross - 1n }, await forwarderLogs({ gross, fee: 2_506_265_664_160_402n, token: "0x0000000000000000000000000000000000000000" }));
    expect((await confirm("f5b", { txHash: `0x${"cd".repeat(32)}` })).body.reason).toBe("value_differs_from_approval");
  });

  it("rejects a forwarder tx whose target is not the approved forwarder, even with a PaymentForwarded from the approved one", async () => {
    const data = await forwardData(GROSS);
    await approve("f6", { to: FORWARDER, data, value: "0x0", from: WALLET });
    mine({ to: HELPER, input: data }, await forwarderLogs({ gross: GROSS, fee: FEE }));
    expect((await confirm("f6")).body.reason).toBe("tx_target_mismatch");
  });

  it("rejects different calldata (a forward of another amount/recipient) than the approval", async () => {
    const data = await forwardData(GROSS);
    await approve("f7", { to: FORWARDER, data, value: "0x0", from: WALLET });
    mine({ to: FORWARDER, input: await forwardData(GROSS, STRANGER) }, await forwarderLogs({ gross: GROSS, fee: FEE, recipient: STRANGER }));
    expect((await confirm("f7")).body.reason).toBe("calldata_differs_from_approval");
  });

  it("rejects events from the wrong contract, the wrong payer, recipient or token", async () => {
    const data = await forwardData(GROSS);
    const stored = { to: FORWARDER, data, value: "0x0", from: WALLET };
    const cases: [string, Parameters<typeof forwarderLogs>[0]][] = [
      ["f8a", { forwarder: HELPER, gross: GROSS, fee: FEE }],
      ["f8b", { gross: GROSS, fee: FEE, payer: STRANGER }],
      ["f8c", { gross: GROSS, fee: FEE, recipient: STRANGER }],
      ["f8d", { gross: GROSS, fee: FEE, token: OTHER_TOKEN }],
    ];
    for (const [id, o] of cases) {
      await approve(id, stored);
      mine({ to: FORWARDER, input: data }, await forwarderLogs(o));
      const r = await confirm(id);
      expect(r.status, id).toBe(409);
      expect(r.body.success, id).toBeUndefined();
    }
  });

  it("rejects a fee event that is not the forwarder's, or a fee above the 1% sanity cap", async () => {
    const data = await forwardData(GROSS);
    await approve("f9", { to: FORWARDER, data, value: "0x0", from: WALLET });
    mine({ to: FORWARDER, input: data }, await forwarderLogs({ gross: GROSS, fee: 20_000n }));
    expect((await confirm("f9")).status).toBe(409);
  });

  it("rejects two PaymentForwarded events (ambiguous) instead of picking the first", async () => {
    const data = await forwardData(GROSS);
    await approve("f10", { to: FORWARDER, data, value: "0x0", from: WALLET });
    const one = await forwarderLogs({ gross: GROSS, fee: FEE });
    const two = await forwarderLogs({ gross: GROSS, fee: FEE, id: 4n });
    mine({ to: FORWARDER, input: data }, [...one, ...two]);
    expect((await confirm("f10")).body.reason).toBe("ambiguous_forwarded_events");
  });

  it("a forwarder-shaped tx is never accepted through the direct-transfer logic", async () => {
    // Approval is a direct transfer; the wallet instead sent a forward (USDC reaches the recipient).
    await approve("f11", DIRECT_USDC);
    const data = await forwardData(GROSS);
    mine({ to: FORWARDER, input: data }, [transferLog(WALLET, RECIPIENT, ONE), ...(await forwarderLogs({ gross: GROSS, fee: FEE }))]);
    expect((await confirm("f11")).body.reason).toBe("tx_target_mismatch");
  });
});

describe("ACCEPTANCE — direct native MON", () => {
  const MON_UNSIGNED: Unsigned = { to: RECIPIENT, data: "0x", value: `0x${(10n ** 18n).toString(16)}`, from: WALLET };

  it("accepts the approved transfer, and an overpayment; rejects an underpayment", async () => {
    await approve("n1", MON_UNSIGNED, intentOf("MON"));
    mine({ to: RECIPIENT, input: "0x", value: 10n ** 18n }, []);
    const ok = await confirm("n1");
    expect(ok.status).toBe(200);
    expect(fee(ok)).toMatchObject({ status: "verified", basis: "none" });

    await approve("n2", MON_UNSIGNED, intentOf("MON"));
    mine({ to: RECIPIENT, input: "0x", value: 2n * 10n ** 18n }, []);
    const over = await confirm("n2", { txHash: `0x${"cd".repeat(32)}` });
    expect(over.status).toBe(200);
    expect(over.body.receipt?.recipientReceives).toBe("2 MON");

    await approve("n3", MON_UNSIGNED, intentOf("MON"));
    mine({ to: RECIPIENT, input: "0x", value: 10n ** 18n - 1n }, []);
    expect((await confirm("n3", { txHash: `0x${"ef".repeat(32)}` })).body.reason).toBe("underpaid");
  });

  it("rejects a native tx to another address, or with calldata", async () => {
    await approve("n4", MON_UNSIGNED, intentOf("MON"));
    mine({ to: STRANGER, input: "0x", value: 10n ** 18n }, []);
    expect((await confirm("n4")).body.reason).toBe("tx_target_mismatch");

    await approve("n5", MON_UNSIGNED, intentOf("MON"));
    mine({ to: RECIPIENT, input: "0x1234", value: 10n ** 18n }, []);
    expect((await confirm("n5", { txHash: `0x${"cd".repeat(32)}` })).body.reason).toBe("unexpected_calldata");
  });
});

describe("source: the generic predicate no longer decides acceptance here", () => {
  it("the confirm route does not use hasErc20TransferTo / rawText parsing", async () => {
    const { readFileSync } = await import("node:fs");
    const route = readFileSync(new URL("../app/api/agent/confirm/route.ts", import.meta.url), "utf8");
    expect(route).not.toMatch(/hasErc20TransferTo\(/);
    expect(route).not.toMatch(/parseIntent\(/);
  });
});

/* ── Phase 1: idempotency namespaces and confirmation-result access ─────────
 * The confirmation of a payment is stored under a server-owned key, and is
 * replayed only to the caller it belongs to (same approval requestId, wallet
 * and tenant). These do NOT authenticate the caller or make deduplication
 * durable — later phases.
 */
describe("confirmation replay: only to the caller it belongs to", () => {
  /** Settle approval `id` once, as its rightful caller. */
  async function settled(id: string) {
    await approve(id, DIRECT_USDC);
    mine({ to: USDC, input: DIRECT_USDC.data }, [transferLog(WALLET, RECIPIENT, ONE)]);
    const first = await confirm(id);
    expect(first.status).toBe(200);
    return first;
  }
  const DETAIL_KEYS = ["intent", "trace", "receipt", "transaction", "compliance", "risk", "sender", "explorerUrl", "transactionHash"];
  const leaksNothing = (body: Record<string, unknown>) => {
    for (const k of DETAIL_KEYS) expect(body[k], k).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/Send 1 USDC|0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc/i);
  };

  it("the rightful caller's retry replays the stored result", async () => {
    const first = await settled("own");
    const again = await confirm("own");
    expect(again.status).toBe(200);
    expect((again.body as Record<string, unknown>).replayed).toBe(true);
    expect(again.body.transaction).toEqual(first.body.transaction);
    expect(again.body.receipt).toEqual(first.body.receipt);
  });

  it("the same transaction hash in another hex casing is the same confirmation (owner replay, never a second record)", async () => {
    const { listTx } = await import("@/lib/platform/store");
    // The in-memory log outlives a test; count the rows this test adds.
    const rows = async () => (await listTx("demo", { sender: WALLET })).filter((t) => t.txHash?.toLowerCase() === TX).length;
    const before = await rows();
    await settled("case");
    const upper = await confirm("case", { txHash: `0x${TX.slice(2).toUpperCase()}` });
    expect(upper.status).toBe(200);
    expect((upper.body as Record<string, unknown>).replayed).toBe(true);
    expect(await rows()).toBe(before + 1);
  });

  it("knowing only the public transaction hash discloses nothing", async () => {
    await settled("victim");
    for (const [label, over] of [
      ["no requestId", {}],
      ["another wallet, no requestId", { walletAddress: STRANGER }],
      ["another wallet, the right requestId", { walletAddress: STRANGER, requestId: "victim" }],
      ["the right wallet, a guessed requestId", { requestId: "guess" }],
    ] as const) {
      const r = await confirm(undefined, over);
      expect(r.status, label).toBe(409);
      expect(r.body.reason, label).toBe("already_confirmed");
      leaksNothing(r.body as Record<string, unknown>);
    }
  });

  it("another tenant presenting the right requestId and wallet gets nothing back", async () => {
    await settled("tenant");
    const { createMerchant } = await import("@/lib/platform/merchants");
    const other = await createMerchant("Other Co");
    const r = await confirm("tenant", {}, { "x-merchant-key": other.apiKey });
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe("already_confirmed");
    leaksNothing(r.body as Record<string, unknown>);
  });

  it("an in-flight confirmation reveals nothing either", async () => {
    const { agentConfirmKey, claimRequest } = await import("@/lib/platform/idempotency");
    await claimRequest(agentConfirmKey(TX));
    const r = await confirm("anyone");
    expect(r.status).toBe(409);
    leaksNothing(r.body as Record<string, unknown>);
  });
});

describe("client idempotency keys cannot reach server-owned keys", () => {
  /** POST /api/agent with a chosen idempotencyKey. "Alice" is no known payee,
   *  so the pipeline refuses — after claiming and storing under that key. */
  async function agentWithKey(idempotencyKey: string, headers: Record<string, string> = {}) {
    const { POST } = await import("@/app/api/agent/route");
    const res = await POST(post({ intent: "Send 20 USDC to Alice", walletAddress: WALLET, idempotencyKey }, headers, "/api/agent"));
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }
  const TX_LOWER = TX.toLowerCase();
  const RESERVED = [`agent-confirm:${TX_LOWER}`, `confirm:${TX_LOWER}`, `swap-settle:${TX_LOWER}`, `sdk-settle:${TX_LOWER}`, `link-settle:${TX_LOWER}`];

  it("/api/agent cannot occupy a reserved confirmation key: the real confirmation still records", async () => {
    for (const k of RESERVED) await agentWithKey(k);
    const { agentConfirmKey, peekRequestRecord } = await import("@/lib/platform/idempotency");
    expect(await peekRequestRecord(agentConfirmKey(TX))).toBeNull();
    for (const k of RESERVED) expect(await peekRequestRecord(k), k).toBeNull(); // nothing written under the raw key

    await approve("real", DIRECT_USDC);
    mine({ to: USDC, input: DIRECT_USDC.data }, [transferLog(WALLET, RECIPIENT, ONE)]);
    const r = await confirm("real");
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect((r.body as Record<string, unknown>).replayed).toBeUndefined();
  });

  it("/api/agent cannot read a stored confirmation back by naming its key", async () => {
    await approve("paid", DIRECT_USDC);
    mine({ to: USDC, input: DIRECT_USDC.data }, [transferLog(WALLET, RECIPIENT, ONE)]);
    expect((await confirm("paid")).status).toBe(200);
    for (const k of RESERVED) {
      const r = await agentWithKey(k);
      expect(r.body.replayed, k).toBeUndefined();
      expect(r.body.decision, k).toBe("refused"); // a fresh pipeline run, not the stored payment
      expect(r.body.transaction ?? null, k).toBeNull();
      expect(r.body.receipt, k).toBeUndefined();
    }
  });

  it("/api/agent's own retry still replays for the same tenant and wallet", async () => {
    const first = await agentWithKey("console-1-abc");
    const again = await agentWithKey("console-1-abc");
    expect(again.body.replayed).toBe(true);
    expect(again.body.decision).toBe(first.body.decision);
    expect(again.body.requestId).toBe("console-1-abc"); // the client-visible id is unchanged
  });

  it("the same client key from another tenant does not replay the first tenant's result", async () => {
    await agentWithKey("shared-key");
    const { createMerchant } = await import("@/lib/platform/merchants");
    const other = await createMerchant("Tenant B");
    const r = await agentWithKey("shared-key", { "x-merchant-key": other.apiKey });
    expect(r.body.replayed).toBeUndefined();
  });

  it("namespaces cannot collide: agent keys never equal or prefix a server key, and are tenant/wallet scoped", async () => {
    const { agentConfirmKey, agentRequestKey } = await import("@/lib/platform/idempotency");
    const k = agentRequestKey("demo", WALLET, agentConfirmKey(TX));
    expect(k).toMatch(/^agent-req:[0-9a-f]{64}$/);
    expect(k).not.toBe(agentConfirmKey(TX));
    for (const prefix of ["agent-confirm:", "confirm:", "swap-settle:", "sdk-settle:", "sdk-build:", "link-settle:", "sch:", "automation-create:", "telegram-update:", "refund-lock:"]) {
      expect(k.startsWith(prefix), prefix).toBe(false);
    }
    expect(agentRequestKey("demo", WALLET, "x")).toBe(agentRequestKey("demo", WALLET.toLowerCase(), "x"));
    expect(agentRequestKey("demo", WALLET, "x")).not.toBe(agentRequestKey("demo", STRANGER, "x"));
    expect(agentRequestKey("demo", WALLET, "x")).not.toBe(agentRequestKey("other", WALLET, "x"));
    // Separator tricks cannot shift parts between fields.
    expect(agentRequestKey("a:b", WALLET, "c")).not.toBe(agentRequestKey("a", WALLET, "b:c"));
    expect(agentConfirmKey(TX.toUpperCase().replace("0X", "0x"))).toBe(agentConfirmKey(TX));
  });

  it("an approval stored for one wallet is not found when confirmed as another", async () => {
    await approve("mine", DIRECT_USDC);
    mine({ to: USDC, input: DIRECT_USDC.data, from: STRANGER }, [transferLog(STRANGER, RECIPIENT, ONE)]);
    const r = await confirm("mine", { walletAddress: STRANGER });
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe("approval_not_found");
  });
});
