import { NextRequest, NextResponse } from "next/server";
import { checkGuardrails, MAX_INPUT_LENGTH, parseIntent } from "@/lib/agent/brain";
import type { AgentResult, TraceEntry } from "@/lib/agent/types";
import { assessRisk, runValidation } from "@/lib/payment/engine";
import type { PaymentRequest } from "@/lib/payment/types";
import { isAddress, resolvePayee } from "@/lib/payees/directory";
import { isDomainName, extractDomain, resolveDomain } from "@/lib/monad/domain-resolver";
import { claimRequest, completeRequest, peekRequest, releaseRequest } from "@/lib/platform/idempotency";


/**
 * POST /api/agent/confirm — settle a non-custodial agent payment.
 *
 * The connected wallet already signed and broadcast the transfer itself
 * (the platform never held a key for it); this endpoint independently
 * re-derives the approved request from the same text and verifies the
 * on-chain receipt actually matches it before recording the payment as
 * executed. A client reporting an arbitrary txHash cannot fabricate an
 * outcome the chain doesn't back up.
 */
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
  const confirmKey = `confirm:${txHash}`;
  const claim = await claimRequest<Record<string, unknown>>(confirmKey);
  if (!claim.claimed) {
    if (claim.status === "done" && claim.result) return NextResponse.json({ ...claim.result, replayed: true });
    return NextResponse.json({ error: "This confirmation is already being processed." }, { status: 409 });
  }

  const trace: TraceEntry[] = [];

  // Prefer replaying the EXACT intent that was approved (persisted under the
  // approval's requestId at /api/agent time, with its recipient already
  // resolved to a 0x address). This is drift-proof: the payment we verify and
  // record is byte-for-byte what was approved, not a fresh re-parse of the
  // text that could diverge if the intent engine changes between approval and
  // confirm. Fall back to re-deriving from text only when the stored record
  // isn't available (cold start, no KV, or TTL expiry).
  type ParsedIntentT = Awaited<ReturnType<typeof parseIntent>>["intent"];
  type IntentSourceT = Awaited<ReturnType<typeof parseIntent>>["source"];
  let intent: ParsedIntentT | undefined;
  let source: IntentSourceT = "fallback";
  if (approvalRequestId) {
    const stored = await peekRequest<{ intent?: ParsedIntentT; source?: IntentSourceT }>(approvalRequestId);
    if (stored?.intent) {
      intent = stored.intent;
      source = stored.source ?? source;
      trace.push({ step: "intent", status: "ok", detail: `Replayed approved intent: ${intent.action} · ${intent.amount ?? "?"} ${intent.token} → ${intent.recipient ?? "(none)"}.` });
    }
  }

  if (!intent) {
    // Fallback: re-derive the approved request server-side — never trust the
    // client for amount/recipient, only for "this is the text that was approved."
    const parsed = await parseIntent(rawText);
    intent = parsed.intent;
    source = parsed.source;
    trace.push({ step: "intent", status: "ok", detail: `Re-derived via ${source}: ${intent.action} · ${intent.amount ?? "?"} ${intent.token} → ${intent.recipient ?? "(none)"}.` });

    // Replay the same recipient resolution the original approval used, so a
    // .nad/.nads domain that resolved cleanly the first time resolves again
    // here (not re-treated as an unresolved name and rejected).
    if (intent.recipient && !isAddress(intent.recipient)) {
      if (isDomainName(intent.recipient)) {
        const domain = extractDomain(intent.recipient) ?? intent.recipient;
        const resolution = await resolveDomain(domain);
        if (!resolution.resolvedAddress) {
          await releaseRequest(confirmKey);
          return NextResponse.json({ error: resolution.error ?? "Unable to resolve domain" }, { status: 422 });
        }
        intent.domain = resolution.domain;
        intent.recipient = resolution.resolvedAddress;
        trace.push({ step: "domain", status: "ok", detail: `Resolved ${resolution.domain} → ${resolution.resolvedAddress}${resolution.cached ? " (cached)" : ""}` });
      } else {
        const payee = resolvePayee(intent.recipient);
        if (payee) {
          intent.payeeName = payee.name;
          intent.recipient = payee.address;
          trace.push({ step: "directory", status: "ok", detail: `Resolved payee "${payee.name}" → ${payee.address}` });
        }
      }
    }
  }

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

  const { hasErc20TransferTo, isNativeTransferTo, toBaseUnits, toParseableAmount } = await import("@/lib/monad/verify");
  const recipient = intent.recipient;
  let matched = false;
  // What this transaction proves about the PayAI fee, for the receipt only —
  // never a configured rate, and never part of what is accepted below.
  // Unverified until a branch establishes otherwise.
  let feeEvidence: import("@/lib/payment/feeMath").FeeEvidence = { kind: "unverified" };
  const evidence = await import("@/lib/payment/receiptEvidence");
  // Every PayAI fee contract this deployment knows: their logs (or PayAI fee
  // event signatures from anywhere) rule out a verified zero-fee transfer.
  const cfg = await import("@/lib/monad/config");
  const feeContracts = [cfg.getPayAIForwarder(), cfg.getPaymentExecutor(), cfg.getAutomationVault(), cfg.getPayAITradeExecutor(), cfg.getPayAITradeExecutorV2()];

  // If this payment was routed through PayAIForwarder, the tx target is the
  // forwarder (not the recipient), so the raw to/value check below wouldn't
  // match. Verify against the canonical PaymentForwarded EVENT instead — the
  // on-chain source of truth (never client-reported amounts): the event must
  // exist, be emitted by the configured forwarder, and its payer/recipient/
  // token/amount must all equal the approved intent. A tx sent to the
  // forwarder that lacks a valid matching event is rejected as invalid, per
  // the Step 8.1 result-verification requirement.
  const { getPayAIForwarder } = await import("@/lib/monad/config");
  const forwarderAddr = getPayAIForwarder();
  const routedThroughForwarder =
    forwarderAddr != null && receipt.to != null && receipt.to.toLowerCase() === forwarderAddr.toLowerCase();
  if (routedThroughForwarder) {
    const { decodePaymentForwarded, decodeFeeCollected, verifyForwardedNet } = await import("@/lib/monad/forwarder");
    const ev = decodePaymentForwarded(receipt.logs, forwarderAddr);
    if (ev) {
      const wantAmount =
        intent.token === "MON"
          ? (await import("viem")).parseEther(toParseableAmount(intent.amount, 18))
          : toBaseUnits(intent.amount, getStablecoin().decimals);
      const wantToken =
        intent.token === "MON" ? "0x0000000000000000000000000000000000000000" : getStablecoin().address;
      // PayAI's fee is on top: the recipient's NET (gross − FeeCollected) must
      // be exactly the approved amount. A payment built before the fee moved
      // on top (gross == amount) is still the payment the user approved and
      // signed, so it verifies too — never anything else.
      const fc = decodeFeeCollected(receipt.logs, forwarderAddr, ev.id);
      const verdict = verifyForwardedNet(ev, fc, {
        payer: walletAddress as `0x${string}`,
        recipient: recipient as `0x${string}`,
        token: wantToken as `0x${string}`,
        amountUnits: wantAmount,
      });
      matched = verdict !== null;
      if (verdict) {
        const decimals = intent.token === "MON" ? 18 : getStablecoin().decimals;
        feeEvidence = evidence.feeEvidenceFromForward({ ...verdict, decimals });
      }
    }
    if (!matched) {
      await releaseRequest(confirmKey);
      return NextResponse.json(
        { error: "This transaction targeted PayAIForwarder but has no matching PaymentForwarded event — treated as invalid." },
        { status: 409 },
      );
    }
    trace.push({ step: "traceability", status: "ok", detail: "Verified via PayAIForwarder's PaymentForwarded event." });
  } else if (intent.token === "MON") {
    // Native transfer: recipient/amount live on the tx itself (to/value), not
    // in a receipt log. parseEther matches what the build path encoded.
    // toParseableAmount, not String()/.toString() — those switch to
    // exponential notation below 1e-6 and parseEther throws on it, which
    // (being outside this branch's own try/catch, below) would otherwise
    // crash the request after the on-chain payment had already settled.
    const { parseEther } = await import("viem");
    const wanted = parseEther(toParseableAmount(intent.amount, 18));
    try {
      const tx = await client.getTransaction({ hash: txHash as `0x${string}` });
      matched = isNativeTransferTo(tx, recipient, wanted);
      // The receipt reports what was actually sent (an overpayment is accepted).
      if (matched) feeEvidence = evidence.directNativeFeeEvidence({ txTo: tx.to, recipient, value: tx.value, logs: receipt.logs, feeContracts });
    } catch {
      matched = false;
    }
  } else {
    const usdc = getStablecoin();
    const wanted = toBaseUnits(intent.amount, usdc.decimals);
    matched = hasErc20TransferTo(receipt.logs, usdc.address, recipient, wanted);
    // Acceptance is unchanged; the receipt calls the fee a verified zero only
    // for a plain token transfer from this wallet with no PayAI fee contract
    // anywhere in it — a forwarded payment reaching this branch (forwarder
    // unset or rotated) stays unverified.
    if (matched) {
      feeEvidence = evidence.directErc20FeeEvidence({
        txTo: receipt.to, token: usdc.address, decimals: usdc.decimals, wallet: walletAddress, recipient, minAmount: wanted, logs: receipt.logs, feeContracts,
      });
    }
  }
  if (!matched) {
    await releaseRequest(confirmKey);
    return NextResponse.json({ error: "Transaction does not match this payment (wrong token, recipient, or amount)." }, { status: 409 });
  }

  trace.push({ step: "execution", status: "ok", detail: "Confirmed on-chain — sent from the connected wallet." });
  trace.push({ step: "decision", status: "ok", detail: "Executed." });

  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
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
  await completeRequest(confirmKey, responseBody);
  return NextResponse.json(responseBody);
}
