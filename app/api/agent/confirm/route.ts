import { NextRequest, NextResponse } from "next/server";
import { checkGuardrails, MAX_INPUT_LENGTH } from "@/lib/agent/brain";
import type { AgentResult, TraceEntry } from "@/lib/agent/types";
import { assessRisk, runValidation } from "@/lib/payment/engine";
import type { PaymentRequest } from "@/lib/payment/types";
import { isAddress } from "@/lib/payees/directory";
import { agentConfirmKey, agentRequestKey, claimRequest, completeRequest, peekRequestRecord, releaseRequest } from "@/lib/platform/idempotency";
import { createHash } from "node:crypto";
import type { ParsedIntent } from "@/lib/agent/types";


/**
 * POST /api/agent/confirm — settle a non-custodial agent payment.
 *
 * The connected wallet already signed and broadcast the transfer itself
 * (the platform never held a key for it). This endpoint settles ONLY against
 * the approval /api/agent stored under `requestId`: the mined transaction
 * must be the one that approval asked the wallet to sign (sender, target,
 * calldata, value), its receipt must have succeeded, and its events must back
 * it up (lib/payment/confirmPaths.ts, one verifier per supported payment
 * path). A txHash with no live stored approval is refused — the caller's
 * `rawText` is never re-parsed into a substitute, and a client reporting an
 * arbitrary txHash cannot fabricate an outcome the approval doesn't cover.
 *
 * A stored confirmation is replayed only to the caller it belongs to: the
 * same approval requestId, wallet and tenant (see ConfirmOwner). Knowing a
 * transaction hash — public on-chain — is not enough to read one back.
 *
 * Not addressed here (separate work): authenticating the caller (the
 * requestId is the only thing tying a retry to its approval, and it is not a
 * strong secret), approval ownership, and durable
 * one-confirmation-per-payment deduplication beyond the 24h txHash claim.
 */

/** Who a stored confirmation belongs to. The approval requestId is kept only
 *  as a hash; nothing here is returned to any caller. */
interface ConfirmOwner { approval: string; wallet: string; merchantId: string }
interface StoredConfirmation { owner: ConfirmOwner; body: Record<string, unknown> }

const hashId = (id: string) => createHash("sha256").update(`agent-confirm-owner:${id}`).digest("hex");

function ownsConfirmation(stored: unknown, caller: { requestId?: string; wallet: string; merchantId: string }): stored is StoredConfirmation {
  if (!stored || typeof stored !== "object") return false;
  const s = stored as Partial<StoredConfirmation>;
  if (!s.owner || !s.body || !caller.requestId) return false;
  return s.owner.approval === hashId(caller.requestId)
    && s.owner.wallet === caller.wallet.toLowerCase()
    && s.owner.merchantId === caller.merchantId;
}

/** Clock skew allowed between this server and the chain's block timestamps
 *  when checking that a transaction was mined after its approval existed. */
const APPROVAL_SKEW_MS = 120_000;
export async function POST(req: NextRequest) {
  const { rateLimited } = await import("@/lib/platform/ratelimit");
  const limited = await rateLimited(req, "agent");
  if (limited) return limited;

  let body: { rawText?: string; walletAddress?: string; txHash?: string; requestId?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const rawText = body.rawText?.trim();
  const walletAddress = body.walletAddress?.trim();
  const txHash = body.txHash?.trim();
  const approvalRequestId = body.requestId?.trim();
  if (!rawText || rawText.length > MAX_INPUT_LENGTH) {
    return NextResponse.json({ error: "rawText is required and must be within the length limit." }, { status: 400 });
  }
  if (!walletAddress || !isAddress(walletAddress)) {
    return NextResponse.json({ error: "A valid walletAddress is required." }, { status: 400 });
  }
  if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return NextResponse.json({ error: "A valid txHash is required." }, { status: 400 });
  }

  const { resolveTenantId } = await import("@/lib/platform/tenant");
  const merchantId = await resolveTenantId(req);

  // The on-chain txHash is itself a natural idempotency key here — this route
  // never moves funds (the wallet already did), but a retried confirm call
  // must not double-write the transaction log.
  // Server-owned key (agentConfirmKey): no client-chosen idempotency key can
  // name it, since /api/agent stores client keys in their own namespace.
  const confirmKey = agentConfirmKey(txHash);
  const claim = await claimRequest<StoredConfirmation>(confirmKey);
  if (!claim.claimed) {
    // Replay a finished confirmation only to the caller it belongs to — the
    // check comes BEFORE anything stored is returned. Anyone else learns only
    // that this transaction was already confirmed; never its intent, trace,
    // receipt or any other detail.
    if (claim.status === "done") {
      if (ownsConfirmation(claim.result, { requestId: approvalRequestId, wallet: walletAddress, merchantId })) {
        return NextResponse.json({ ...claim.result.body, replayed: true });
      }
      return NextResponse.json({ error: "This transaction has already been confirmed.", reason: "already_confirmed" }, { status: 409 });
    }
    return NextResponse.json({ error: "This confirmation is already being processed." }, { status: 409 });
  }

  // The approval is the source of truth: the exact intent (recipient already
  // resolved to a 0x address) and the exact transaction the wallet was asked
  // to sign. No approval, no settlement — `rawText` is never turned into one.
  const refuse = async (error: string, reason: string, status = 409) => {
    await releaseRequest(confirmKey);
    return NextResponse.json({ error, reason }, { status });
  };
  if (!approvalRequestId) {
    return refuse("This payment has no approval to settle against. Start the payment again.", "approval_required");
  }
  // Looked up where /api/agent stored it: its own namespace, for this tenant
  // and wallet (agentRequestKey) — never the raw requestId as a key.
  const approval = await peekRequestRecord<{ decision?: string; intent?: ParsedIntent; source?: string; unsignedTx?: unknown }>(
    agentRequestKey(merchantId, walletAddress, approvalRequestId),
  );
  const { readStoredTx } = await import("@/lib/payment/confirmPaths");
  const storedTx = approval ? readStoredTx(approval.result.unsignedTx) : null;
  if (!approval || approval.result.decision !== "ready_to_sign" || !approval.result.intent || !storedTx) {
    return refuse("The approval for this payment was not found or has expired. Start the payment again.", "approval_not_found");
  }
  const trace: TraceEntry[] = [];
  const intent = approval.result.intent;
  const source = (approval.result.source ?? "fallback") as AgentResult["source"];
  trace.push({ step: "intent", status: "ok", detail: `Approved intent: ${intent.action} · ${intent.amount ?? "?"} ${intent.token} → ${intent.recipient ?? "(none)"}.` });

  const guardrail = checkGuardrails(intent);
  if (!guardrail.allowed || intent.action !== "send_payment" || !intent.recipient || !isAddress(intent.recipient) || !intent.amount) {
    await releaseRequest(confirmKey);
    return NextResponse.json({ error: "This request is no longer valid for wallet settlement." }, { status: 409 });
  }
  trace.push({ step: "guardrails", status: "ok", detail: "Within agent limits." });

  const request: PaymentRequest = {
    action: intent.action, amount: intent.amount, token: intent.token,
    recipient: intent.recipient, purpose: intent.purpose, network: intent.network,
  };
  const { ensureSanctionsLoaded } = await import("@/lib/payment/sanctions");
  await ensureSanctionsLoaded();
  const compliance = runValidation(request);
  trace.push({ step: "compliance", status: compliance.status === "approved" ? "ok" : "blocked", detail: compliance.summary });
  const risk = assessRisk(request);
  trace.push({ step: "risk", status: risk.level === "low" ? "ok" : risk.level === "medium" ? "warn" : "blocked", detail: `Risk ${risk.score}/100 (${risk.level}).` });

  if (compliance.status === "rejected") {
    await releaseRequest(confirmKey);
    return NextResponse.json({ error: "This request no longer clears compliance for wallet settlement." }, { status: 409 });
  }

  const { getChain, getStablecoin, explorerTx, getTransport } = await import("@/lib/monad/config");
  const { createPublicClient } = await import("viem");
  const client = createPublicClient({ chain: getChain(), transport: getTransport() });

  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
  } catch (e) {
    const notMinedYet = e instanceof Error && /could not be found|not found/i.test(e.message);
    if (!notMinedYet) {
      await releaseRequest(confirmKey);
      return NextResponse.json({ error: "Could not reach the Monad network to verify this transaction. Please retry." }, { status: 503 });
    }
    receipt = null;
  }
  if (receipt && receipt.status === "reverted") {
    // Definitely mined AND definitely failed — this is not "try again later",
    // it already happened. No funds moved (gas was spent), so it's safe for
    // the user to retry with a fresh payment rather than wait indefinitely.
    await releaseRequest(confirmKey);
    return NextResponse.json({ error: "This transaction failed on-chain (reverted). No funds were transferred. You can safely try again.", reverted: true, txHash }, { status: 409 });
  }
  if (!receipt || receipt.status !== "success") {
    // Genuinely retryable — the tx may just not be mined yet. Release so the
    // client's "please retry" isn't silently swallowed by a stuck claim.
    await releaseRequest(confirmKey);
    return NextResponse.json({ error: "Transaction not found or not successful yet." }, { status: 409 });
  }
  if (receipt.from.toLowerCase() !== walletAddress.toLowerCase()) {
    await releaseRequest(confirmKey);
    return NextResponse.json({ error: "Transaction was not sent from the declared wallet." }, { status: 409 });
  }

  const { toBaseUnits, toParseableAmount } = await import("@/lib/monad/verify");
  const { classifyStoredTx, verifyDirectErc20, verifyDirectNative, verifyForwarded } = await import("@/lib/payment/confirmPaths");
  const recipient = intent.recipient as `0x${string}`;
  const isNative = intent.token === "MON";
  const usdc = getStablecoin();
  const decimals = isNative ? 18 : usdc.decimals;
  const amountUnits = isNative
    ? (await import("viem")).parseEther(toParseableAmount(intent.amount, 18))
    : toBaseUnits(intent.amount, usdc.decimals);
  const approved = { wallet: walletAddress as `0x${string}`, recipient, token: usdc.address as `0x${string}`, amountUnits };

  // The mined transaction itself (target, sender, calldata, value) and the
  // block it landed in. The receipt's logs alone cannot say what was called.
  let tx;
  let block;
  try {
    tx = await client.getTransaction({ hash: txHash as `0x${string}` });
    block = await client.getBlock({ blockNumber: receipt.blockNumber });
  } catch {
    await releaseRequest(confirmKey);
    return NextResponse.json({ error: "Could not reach the Monad network to verify this transaction. Please retry." }, { status: 503 });
  }
  // A payment cannot predate its own approval. The approval's timestamp is
  // when /api/agent stored it; allow for server/chain clock skew.
  if (Number(block.timestamp) * 1000 + APPROVAL_SKEW_MS < approval.createdAt) {
    return refuse("This transaction was mined before this payment was approved.", "mined_before_approval");
  }

  // What this transaction proves about the PayAI fee, for the receipt only —
  // never a configured rate, and never part of what is accepted below.
  // Unverified until a path establishes otherwise.
  let feeEvidence: import("@/lib/payment/feeMath").FeeEvidence = { kind: "unverified" };
  const evidence = await import("@/lib/payment/receiptEvidence");
  // Every PayAI fee contract this deployment knows: their logs (or PayAI fee
  // event signatures from anywhere) rule out a verified zero-fee transfer.
  const cfg = await import("@/lib/monad/config");
  const feeContracts = [cfg.getPayAIForwarder(), cfg.getPaymentExecutor(), cfg.getAutomationVault(), cfg.getPayAITradeExecutor(), cfg.getPayAITradeExecutorV2()];

  // Verify against the path the STORED approval is — the mined transaction
  // does not get to choose its own verifier. Anything that is not one of the
  // supported paths is refused; there is no generic "a Transfer to the
  // recipient exists" fallback.
  const path = classifyStoredTx(storedTx, approved, isNative);
  if (!path) return refuse("This approval is not a payment path that can be settled.", "unsupported_path");
  let verdict;
  switch (path) {
    case "forwarder-erc20":
    case "forwarder-native": {
      // The target is the forwarder the approval named (so a payment approved
      // before a forwarder rotation still verifies), never inferred from the
      // mined transaction.
      verdict = verifyForwarded(tx, receipt.logs, storedTx, approved, isNative);
      if (verdict.ok) {
        feeEvidence = evidence.feeEvidenceFromForward({ fee: verdict.fee, feeOnTop: verdict.feeOnTop, feeEvent: verdict.feeEvent, decimals });
      }
      break;
    }
    case "direct-native": {
      verdict = verifyDirectNative(tx, storedTx, approved);
      // The receipt reports what was actually sent (an overpayment is accepted).
      if (verdict.ok) feeEvidence = evidence.directNativeFeeEvidence({ txTo: tx.to, recipient, value: tx.value, logs: receipt.logs, feeContracts });
      break;
    }
    case "direct-erc20": {
      verdict = verifyDirectErc20(tx, receipt.logs, storedTx, approved);
      if (verdict.ok) {
        feeEvidence = evidence.directErc20FeeEvidence({
          txTo: receipt.to, token: usdc.address, decimals: usdc.decimals, wallet: walletAddress, recipient, minAmount: amountUnits, logs: receipt.logs, feeContracts,
        });
      }
      break;
    }
  }
  if (!verdict.ok) {
    return refuse(
      path.startsWith("forwarder")
        ? "This transaction does not match the approved PayAIForwarder payment — treated as invalid."
        : "Transaction does not match this payment (wrong token, recipient, or amount).",
      verdict.reason,
    );
  }
  if (path.startsWith("forwarder")) trace.push({ step: "traceability", status: "ok", detail: "Verified via PayAIForwarder's PaymentForwarded event." });

  trace.push({ step: "execution", status: "ok", detail: "Confirmed on-chain — sent from the connected wallet." });
  trace.push({ step: "decision", status: "ok", detail: "Executed." });

  const explorerUrl = explorerTx(txHash);

  // The gas this payment actually cost, straight off the receipt. It was
  // being reported as null, so the receipt card silently dropped its "Gas
  // fee" line and the total read as the payment amount alone — understating
  // what the payment cost the user, on the one screen meant to account for it.
  const { formatEther } = await import("viem");
  const gasUnits = receipt.gasUsed ?? 0n;
  const gasPrice = (receipt as { effectiveGasPrice?: bigint }).effectiveGasPrice ?? 0n;
  const gasFee = gasUnits > 0n && gasPrice > 0n ? formatEther(gasUnits * gasPrice) : null;
  const { recordTx } = await import("@/lib/platform/store");
  await recordTx(merchantId, {
    decision: "executed",
    action: intent.action,
    feature: "payment",
    amount: intent.amount,
    token: intent.token,
    recipient: intent.recipient,
    domain: intent.domain ?? null,
    // Verified on-chain: receipt.from === walletAddress was checked above.
    sender: walletAddress,
    riskScore: risk.score,
    compliance: compliance.status,
    txHash,
    explorerUrl,
    summary: `${intent.summary} (signed by connected wallet).`,
  });

  // Real receipt, computed server-side (feeEngine.ts is server-only — see
  // its doc comment for why this must never be recomputed client-side).
  const { buildReceipt } = await import("@/lib/payment/feeEngine");
  const paymentReceipt = intent.amount != null
    ? buildReceipt({
        feature: "send_payment", amount: intent.amount, token: intent.token,
        gasFee: gasFee ?? undefined, status: "executed", txHash, explorerUrl,
        feeEvidence,
      })
    : undefined;

  const result: AgentResult = {
    decision: "executed",
    intent, source, guardrail, compliance, risk,
    confidence: intent.confidence,
    riskScore: risk.score,
    trace,
    transaction: {
      status: "settled",
      mode: "monad",
      network: intent.network,
      amount: intent.amount,
      token: intent.token,
      recipient: intent.recipient,
      txHash,
      explorerUrl,
      blockNumber: Number(receipt.blockNumber),
      blockTimestamp: Number(block.timestamp) * 1000,
      sender: receipt.from,
      gasFee: gasFee ?? undefined,
      detail: "Sent directly from your connected wallet.",
    },
    receipt: paymentReceipt,
  };

  const responseBody = {
    ...result,
    success: true,
    transactionHash: txHash,
    explorerUrl,
    gasFee,
    blockNumber: Number(receipt.blockNumber),
    blockTimestamp: Number(block.timestamp) * 1000,
    sender: receipt.from,
  };
  const stored: StoredConfirmation = {
    owner: { approval: hashId(approvalRequestId), wallet: walletAddress.toLowerCase(), merchantId },
    body: responseBody as unknown as Record<string, unknown>,
  };
  await completeRequest(confirmKey, stored);
  return NextResponse.json(responseBody);
}
