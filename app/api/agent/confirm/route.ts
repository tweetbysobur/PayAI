import { NextRequest, NextResponse } from "next/server";
import { checkGuardrails, MAX_INPUT_LENGTH, parseIntent } from "@/lib/agent/brain";
import type { AgentResult, TraceEntry } from "@/lib/agent/types";
import { assessRisk, runValidation } from "@/lib/payment/engine";
import type { PaymentRequest } from "@/lib/payment/types";
import { isAddress, resolvePayee } from "@/lib/payees/directory";
import { isDomainName, extractDomain, resolveDomain } from "@/lib/monad/domain-resolver";
import { claimRequest, completeRequest, peekRequest, releaseRequest } from "@/lib/platform/idempotency";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

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
  const compliance = runValidation(request);
  trace.push({ step: "compliance", status: compliance.status === "approved" ? "ok" : "blocked", detail: compliance.summary });
  const risk = assessRisk(request);
  trace.push({ step: "risk", status: risk.level === "low" ? "ok" : risk.level === "medium" ? "warn" : "blocked", detail: `Risk ${risk.score}/100 (${risk.level}).` });

  if (compliance.status !== "approved" || risk.level === "high") {
    await releaseRequest(confirmKey);
    return NextResponse.json({ error: "This request no longer clears compliance/risk for wallet settlement." }, { status: 409 });
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

  const recipient = intent.recipient.toLowerCase();
  let matched = false;
  if (intent.token === "MON") {
    // Native transfer: the recipient is the tx's `to` and the amount is the
    // tx `value` (18-decimal wei) — neither lives in a receipt log, so read
    // the transaction itself. parseEther matches what the build path encoded.
    const { parseEther } = await import("viem");
    const wanted = parseEther(String(intent.amount));
    try {
      const tx = await client.getTransaction({ hash: txHash as `0x${string}` });
      matched = tx.to?.toLowerCase() === recipient && tx.value >= wanted;
    } catch {
      matched = false;
    }
  } else {
    const usdc = getStablecoin();
    const wanted = BigInt(Math.round(intent.amount * 10 ** usdc.decimals));
    matched = receipt.logs.some((log) => {
      if (log.address.toLowerCase() !== usdc.address.toLowerCase()) return false;
      if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) return false;
      const to = log.topics[2] ? `0x${log.topics[2].slice(-40)}`.toLowerCase() : "";
      if (to !== recipient) return false;
      return BigInt(log.data) >= wanted;
    });
  }
  if (!matched) {
    await releaseRequest(confirmKey);
    return NextResponse.json({ error: "Transaction does not match this payment (wrong token, recipient, or amount)." }, { status: 409 });
  }

  trace.push({ step: "execution", status: "ok", detail: "Confirmed on-chain — sent from the connected wallet." });
  trace.push({ step: "decision", status: "ok", detail: "Executed." });

  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  const explorerUrl = explorerTx(txHash);
  const { recordTx } = await import("@/lib/platform/store");
  await recordTx(merchantId, {
    decision: "executed",
    action: intent.action,
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
      detail: "Sent directly from your connected wallet.",
    },
  };

  const responseBody = {
    ...result,
    success: true,
    transactionHash: txHash,
    explorerUrl,
    gasFee: null,
    blockNumber: Number(receipt.blockNumber),
    blockTimestamp: Number(block.timestamp) * 1000,
    sender: receipt.from,
  };
  await completeRequest(confirmKey, responseBody);
  return NextResponse.json(responseBody);
}
