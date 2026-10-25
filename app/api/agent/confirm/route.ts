import { NextRequest, NextResponse } from "next/server";
import { checkGuardrails, MAX_INPUT_LENGTH } from "@/lib/agent/brain";
import type { AgentResult, TraceEntry } from "@/lib/agent/types";
import { assessRisk, runValidation } from "@/lib/payment/engine";
import type { PaymentRequest } from "@/lib/payment/types";
import { isAddress } from "@/lib/payees/directory";
import { agentConfirmKey, agentRequestKey, claimRequest, completeRequest, peekRequestRecord, releaseRequest } from "@/lib/platform/idempotency";
import { createHash } from "node:crypto";
import type { ParsedIntent } from "@/lib/agent/types";
import { TransactionReceiptNotFoundError } from "viem";
import { StorageUnavailableError } from "@/lib/platform/kv";
import { requestHasWalletGrant } from "@/lib/auth/walletGrant";


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

/**
 * Lifetime of an in-progress confirmation claim (a lease). If the request
 * holding it dies — an exception the handler can't catch, a platform timeout
 * — the claim lapses after this, instead of blocking every retry for 24h.
 *
 * It must outlive the longest the request itself can run: this route's
 * maxDuration (below) stops it after 90s. With a 150s lease, the request that
 * holds the claim has always finished (or been stopped) before the lease can
 * lapse, so no other request can hold the key
 * while this one still runs — which is what makes this route's unconditional
 * release safe. The storage adapter (lib/platform/kv.ts RedisLike) has no
 * compare-and-delete / EVAL, so an ownership-token check could only be a
 * racy read-then-delete; the time bound is the guarantee instead.
 */
const CONFIRM_LEASE_SECONDS = 150;

/** A confirmation is a handful of reads; one that hasn't finished in 90s is
 *  stuck on a slow RPC. Stopping it there (instead of the platform's 300s)
 *  lets the person's retry go through within a few minutes. Must stay below
 *  CONFIRM_LEASE_SECONDS. */
export const maxDuration = 90;

/** Approvals, confirmation claims/results and the payment's log row must be
 *  in SHARED storage: in production a missing or broken KV fails closed
 *  (StorageUnavailableError → store_unavailable), never per-instance memory. */
const DURABLE = { durable: true } as const;

/** Every response says which of these it is. */
type ConfirmState =
  | "confirmed"          // verified against its approval and recorded
  | "pending"            // not mined yet (the node has no receipt)
  | "reverted"           // mined and reverted: nothing moved
  | "settled_unmatched"  // mined successfully from this wallet, no usable approval
  | "mismatch"           // mined, but not the approved payment (or not from this wallet)
  | "policy_hold"        // the approved payment settled; a policy check now fails
  | "rpc_unavailable"    // the chain couldn't be read
  | "store_unavailable"  // PayAI's own storage couldn't be read or written
  | "in_progress"        // another confirmation of this tx is running
  | "already_confirmed" // confirmed already, for another caller
  | "wallet_grant_required"; // the caller hasn't proven it controls the wallet

/** Shown whenever the payment may already have settled. */
const DONT_RESEND = "Don't send it again";

/** A dependency failed: the payment's status is unknown, not "failed". */
function unavailable(state: "rpc_unavailable" | "store_unavailable", txHash: string): NextResponse {
  const what = state === "rpc_unavailable" ? "check the Monad network" : "reach PayAI's records";
  return NextResponse.json(
    { error: `We couldn't ${what} to confirm this payment right now. ${DONT_RESEND} — we'll keep checking.`, state, txHash },
    { status: 503 },
  );
}

/** Which storage failure an error is (not_configured / client_unavailable /
 *  operation_failed), or null for any other error. Server logs only — never
 *  sent to the client. */
function storageFailureOf(e: unknown): string | null {
  return e instanceof StorageUnavailableError ? e.failure : null;
}
function logStorageFailure(step: string, txHash: string, e: unknown): void {
  console.error(JSON.stringify({ event: "payai.confirm.storage_unavailable", step, txHash, storage: storageFailureOf(e) ?? "unknown", message: e instanceof Error ? e.message : String(e) }));
}

/** Whether this request carries a valid wallet grant for `address`: "ok",
 *  "missing", or "unavailable" when the grant can't be checked at all (e.g.
 *  AUTH_SESSION_SECRET unset in production) — never treated as proof. */
function walletGrantStatus(req: NextRequest, address: string): "ok" | "missing" | "unavailable" {
  try {
    return requestHasWalletGrant(req, address) ? "ok" : "missing";
  } catch {
    return "unavailable";
  }
}

/** viem's own "the node returned no receipt" error (not mined yet, or an
 *  unknown hash) — matched by type, never by message text. Anything else
 *  thrown while reading the receipt means the chain couldn't be read. */
function isReceiptNotFound(e: unknown): boolean {
  return e instanceof TransactionReceiptNotFoundError || (e instanceof Error && e.name === "TransactionReceiptNotFoundError");
}
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
  // Wallet ownership, before anything is read or claimed: only a caller that
  // has proven control of `walletAddress` (its signed wallet grant) may
  // confirm a payment for it or read a stored confirmation back. A wallet
  // address and a public tx hash are not proof; the approval requestId is
  // not a strong secret. Refusal never suggests paying again — if the wallet
  // already sent the payment, it is safe on-chain and confirms once unlocked.
  const grant = walletGrantStatus(req, walletAddress);
  if (grant !== "ok") {
    return grant === "missing"
      ? NextResponse.json(
          { error: `Unlock your wallet to confirm this payment. ${DONT_RESEND} — if your wallet sent it, it's safe on-chain and will be confirmed once your wallet is unlocked.`, state: "wallet_grant_required", txHash },
          { status: 401 },
        )
      : unavailable("store_unavailable", txHash);
  }

  const confirmKey = agentConfirmKey(txHash);
  let claim: Awaited<ReturnType<typeof claimRequest<StoredConfirmation>>>;
  try {
    // A LEASE, not a 24h hold: if this request dies (crash, platform
    // timeout) the claim lapses on its own and a retry can confirm. See
    // CONFIRM_LEASE_SECONDS for why it is safe to release unconditionally.
    claim = await claimRequest<StoredConfirmation>(confirmKey, { ttlSeconds: CONFIRM_LEASE_SECONDS, ...DURABLE });
  } catch (e) {
    // Storage failed before anything was claimed: nothing to release.
    logStorageFailure("claim", txHash, e);
    return unavailable("store_unavailable", txHash);
  }
  if (!claim.claimed) {
    // Replay a finished confirmation only to the caller it belongs to — the
    // check comes BEFORE anything stored is returned. Anyone else learns only
    // that this transaction was already confirmed; never its intent, trace,
    // receipt or any other detail.
    if (claim.status === "done") {
      if (ownsConfirmation(claim.result, { requestId: approvalRequestId, wallet: walletAddress, merchantId })) {
        return NextResponse.json({ ...claim.result.body, replayed: true });
      }
      return NextResponse.json({ error: "This transaction has already been confirmed.", reason: "already_confirmed", state: "already_confirmed" }, { status: 409 });
    }
    return NextResponse.json(
      { error: `This confirmation is already in progress. ${DONT_RESEND}.`, state: "in_progress", txHash },
      { status: 409 },
    );
  }

  // From here this request holds the claim. Every outcome either completes
  // it (confirmed) or releases it — including an unexpected exception — so a
  // retry is never blocked. The one exception: once the payment is in the
  // transaction log, the claim is NOT released on a later failure, so a
  // retry cannot write it twice (the lease still lapses on its own).
  let recorded = false;
  const release = () => releaseRequest(confirmKey, DURABLE).catch(() => {});
  const settle = async (): Promise<NextResponse> => {
    const refuse = async (error: string, reason: string, state: ConfirmState, extra: Record<string, unknown> = {}) => {
      await release();
      return NextResponse.json({ error, reason, state, txHash, ...extra }, { status: 409 });
    };

    // The approval is the source of truth: the exact intent (recipient already
    // resolved to a 0x address) and the exact transaction the wallet was asked
    // to sign. It is READ here but not yet judged: a missing approval does not
    // mean the payment didn't happen, so the chain is read first. `rawText` is
    // never turned into an approval.
    let approval: { result: { decision?: string; intent?: ParsedIntent; source?: string; unsignedTx?: unknown }; createdAt: number } | null = null;
    if (approvalRequestId) {
      try {
        // Looked up where /api/agent stored it: its own namespace, for this
        // tenant and wallet (agentRequestKey) — never the raw requestId.
        approval = await peekRequestRecord<{ decision?: string; intent?: ParsedIntent; source?: string; unsignedTx?: unknown }>(
          agentRequestKey(merchantId, walletAddress, approvalRequestId),
          DURABLE,
        );
      } catch (e) {
        // A storage FAILURE is not a missing approval.
        logStorageFailure("approval_lookup", txHash, e);
        await release();
        return unavailable("store_unavailable", txHash);
      }
    }
    const { readStoredTx } = await import("@/lib/payment/confirmPaths");
    const storedTx = approval ? readStoredTx(approval.result.unsignedTx) : null;
    const approvedIntent = approval?.result.decision === "ready_to_sign" ? approval.result.intent : undefined;
    const usableIntent =
      approvedIntent && storedTx && approvedIntent.action === "send_payment" && approvedIntent.recipient && isAddress(approvedIntent.recipient) && approvedIntent.amount
        ? approvedIntent
        : undefined;
    const unmatchedReason = !approvalRequestId ? "approval_required" : !approval ? "approval_not_found" : !usableIntent ? "approval_invalid" : null;

    const { getChain, getStablecoin, explorerTx, getTransport } = await import("@/lib/monad/config");
    const { createPublicClient } = await import("viem");
    const client = createPublicClient({ chain: getChain(), transport: getTransport() });
    const explorerUrl = explorerTx(txHash);

    // 1. Where is the transaction? Decided from the chain, never from our own
    //    records. "Not mined" is only viem's own not-found error type; any
    //    other failure means we could not find out.
    let receipt;
    try {
      receipt = await client.getTransactionReceipt({ hash: txHash as `0x${string}` });
    } catch (e) {
      await release();
      if (isReceiptNotFound(e)) {
        return NextResponse.json(
          { error: `This transaction isn't confirmed on-chain yet. ${DONT_RESEND} — we'll keep checking.`, state: "pending", txHash, explorerUrl },
          { status: 409 },
        );
      }
      return unavailable("rpc_unavailable", txHash);
    }
    if (receipt.status === "reverted") {
      // Definitely mined AND definitely failed — this is not "try again later",
      // it already happened. No funds moved (gas was spent), so it's safe for
      // the user to retry with a fresh payment rather than wait indefinitely.
      await release();
      return NextResponse.json({ error: "This transaction failed on-chain (reverted). No funds were transferred. You can safely try again.", reverted: true, state: "reverted", txHash, explorerUrl }, { status: 409 });
    }
    if (receipt.status !== "success") {
      await release();
      return unavailable("rpc_unavailable", txHash);
    }
    if (receipt.from.toLowerCase() !== walletAddress.toLowerCase()) {
      return refuse("This transaction wasn't sent from the connected wallet, so it can't be confirmed as this payment.", "sender_mismatch", "mismatch", { explorerUrl });
    }

    // 2. It settled, from this wallet. Without a usable approval there is
    //    nothing to verify it against: report it as settled-but-unmatched with
    //    its evidence, record nothing as a verified payment, and never tell the
    //    user to pay again. The client keeps its pending record; the server log
    //    line below is the reconciliation breadcrumb (a durable unmatched store
    //    is separate work).
    const settlement = { txHash, blockNumber: Number(receipt.blockNumber), from: receipt.from, to: receipt.to, status: receipt.status };
    if (unmatchedReason) {
      console.warn(JSON.stringify({ event: "payai.confirm.settled_unmatched", reason: unmatchedReason, merchantId, wallet: walletAddress.toLowerCase(), ...settlement }));
      return refuse(
        `This transaction is confirmed on-chain, but we couldn't match it to its payment approval (it may have expired), so it hasn't been recorded in PayAI yet. ${DONT_RESEND} — you can check it on the explorer.`,
        unmatchedReason,
        "settled_unmatched",
        { explorerUrl, settlement },
      );
    }
    // usableIntent was checked above: a send_payment with an amount and a 0x
    // recipient, from a ready_to_sign approval with a readable unsignedTx.
    const intent = usableIntent as ParsedIntent & { amount: number; recipient: string };
    const requestId = approvalRequestId as string;
    const approvedTx = storedTx!;
    const approvalCreatedAt = approval!.createdAt;
    const trace: TraceEntry[] = [];
    const source = (approval!.result.source ?? "fallback") as AgentResult["source"];
    trace.push({ step: "intent", status: "ok", detail: `Approved intent: ${intent.action} · ${intent.amount ?? "?"} ${intent.token} → ${intent.recipient ?? "(none)"}.` });

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
      await release();
      return unavailable("rpc_unavailable", txHash);
    }
    // A payment cannot predate its own approval. The approval's timestamp is
    // when /api/agent stored it; allow for server/chain clock skew.
    if (Number(block.timestamp) * 1000 + APPROVAL_SKEW_MS < approvalCreatedAt) {
      return refuse("This transaction was mined before this payment was approved, so it can't be confirmed as this payment.", "mined_before_approval", "mismatch", { explorerUrl, settlement });
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
    const path = classifyStoredTx(approvedTx, approved, isNative);
    if (!path) return refuse("This approval is not a payment path that can be settled.", "unsupported_path", "mismatch", { explorerUrl, settlement });
    let verdict;
    switch (path) {
      case "forwarder-erc20":
      case "forwarder-native": {
        // The target is the forwarder the approval named (so a payment approved
        // before a forwarder rotation still verifies), never inferred from the
        // mined transaction.
        verdict = verifyForwarded(tx, receipt.logs, approvedTx, approved, isNative);
        if (verdict.ok) {
          feeEvidence = evidence.feeEvidenceFromForward({ fee: verdict.fee, feeOnTop: verdict.feeOnTop, feeEvent: verdict.feeEvent, decimals });
        }
        break;
      }
      case "direct-native": {
        verdict = verifyDirectNative(tx, approvedTx, approved);
        // The receipt reports what was actually sent (an overpayment is accepted).
        if (verdict.ok) feeEvidence = evidence.directNativeFeeEvidence({ txTo: tx.to, recipient, value: tx.value, logs: receipt.logs, feeContracts });
        break;
      }
      case "direct-erc20": {
        verdict = verifyDirectErc20(tx, receipt.logs, approvedTx, approved);
        if (verdict.ok) {
          feeEvidence = evidence.directErc20FeeEvidence({
            txTo: receipt.to, token: usdc.address, decimals: usdc.decimals, wallet: walletAddress, recipient, minAmount: amountUnits, logs: receipt.logs, feeContracts,
          });
        }
        break;
      }
    }
    if (!verdict.ok) {
      // A transaction from this wallet settled but is NOT the approved payment.
      // Its evidence is returned; nothing is recorded as verified.
      console.warn(JSON.stringify({ event: "payai.confirm.mismatch", reason: verdict.reason, merchantId, wallet: walletAddress.toLowerCase(), ...settlement }));
      return refuse(
        path.startsWith("forwarder")
          ? "This transaction does not match the approved PayAIForwarder payment — treated as invalid."
          : "Transaction does not match this payment (wrong token, recipient, or amount).",
        verdict.reason,
        "mismatch",
        { explorerUrl, settlement },
      );
    }
    if (path.startsWith("forwarder")) trace.push({ step: "traceability", status: "ok", detail: "Verified via PayAIForwarder's PaymentForwarded event." });

    // 3. Policy, AFTER the chain: the payment has already settled, so a
    //    guardrail or compliance failure cannot un-send it. It is held for
    //    review — evidence returned, not recorded as a verified payment — and
    //    is never presented as unsubmitted. Acceptance (above) and policy
    //    (here) stay separate decisions.
    const guardrail = checkGuardrails(intent);
    trace.push({ step: "guardrails", status: guardrail.allowed ? "ok" : "blocked", detail: guardrail.allowed ? "Within agent limits." : guardrail.violations.join(" ") });
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
    if (!guardrail.allowed || compliance.status === "rejected") {
      const reason = !guardrail.allowed ? "guardrail" : "compliance";
      console.warn(JSON.stringify({ event: "payai.confirm.policy_hold", reason, merchantId, wallet: walletAddress.toLowerCase(), ...settlement }));
      return refuse(
        `This payment is confirmed on-chain but needs a review before PayAI records it. ${DONT_RESEND} — you can check it on the explorer.`,
        reason,
        "policy_hold",
        { explorerUrl, settlement },
      );
    }

    trace.push({ step: "execution", status: "ok", detail: "Confirmed on-chain — sent from the connected wallet." });
    trace.push({ step: "decision", status: "ok", detail: "Executed." });

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
    }, DURABLE);
    // In the log now: from here a failure must not release the claim (see the
    // catch below), or a retry would record this payment twice.
    recorded = true;

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
      state: "confirmed" as const,
      transactionHash: txHash,
      explorerUrl,
      gasFee,
      blockNumber: Number(receipt.blockNumber),
      blockTimestamp: Number(block.timestamp) * 1000,
      sender: receipt.from,
    };
    const stored: StoredConfirmation = {
      owner: { approval: hashId(requestId), wallet: walletAddress.toLowerCase(), merchantId },
      body: responseBody as unknown as Record<string, unknown>,
    };
    await completeRequest(confirmKey, stored, DURABLE);
    return NextResponse.json(responseBody);
  };

  try {
    return await settle();
  } catch (e) {
    if (!recorded) await release();
    console.error(JSON.stringify({ event: "payai.confirm.error", txHash, recorded, storage: storageFailureOf(e), message: e instanceof Error ? e.message : String(e) }));
    return recorded
      ? NextResponse.json(
          { error: `This payment is confirmed and recorded, but we couldn't finish saving the confirmation. ${DONT_RESEND} — refresh to see it.`, state: "store_unavailable", txHash },
          { status: 503 },
        )
      : unavailable("store_unavailable", txHash);
  }
}
