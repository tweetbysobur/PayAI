import { NextRequest, NextResponse } from "next/server";
import { agentConfig, checkGuardrails, detectQueryIntent, detectSwapIntent, MAX_INPUT_LENGTH, parseIntent, parseScheduleIntent, sanitizeInput } from "@/lib/agent/brain";
import type { AgentResult, TraceEntry } from "@/lib/agent/types";
import { assessRisk, execute, runValidation } from "@/lib/payment/engine";
import type { PaymentRequest } from "@/lib/payment/types";
import { isAddress, resolvePayee } from "@/lib/payees/directory";
import { isDomainName, extractDomain } from "@/lib/monad/domain-resolver";
import { recordTx } from "@/lib/platform/store";
import { authError } from "@/lib/platform/auth";
import { claimRequest, completeRequest, computeRequestId, releaseRequest } from "@/lib/platform/idempotency";

/**
 * POST /api/agent — the full PayAI pipeline.
 *
 *   understand (intent engine)       →  parsed intent + confidence
 *   guardrails (PayAI)              →  allow / refuse
 *   validation (PayAI engine)       →  approved / review / rejected
 *   risk       (PayAI engine)       →  0–100 score
 *   execution  (PayAI provider)     →  tx / link result   (only if cleared)
 *
 * Every stage appends to a reasoning trace, returned alongside the structured
 * decision so the dashboard can show exactly how the agent reasoned.
 */
export async function POST(req: NextRequest) {
  // authError() is checked just before on-chain execution below (step 6), not
  // here — it gates real-money movement only. Read-only queries, malformed
  // input, guardrail refusals, and compliance blocks never touch the signer
  // and must not require the platform API key.
  const { rateLimited } = await import("@/lib/platform/ratelimit");
  const limited = await rateLimited(req, "agent");
  if (limited) return limited;

  const { resolveTenantId } = await import("@/lib/platform/tenant");
  const merchantId = await resolveTenantId(req);

  let body: { intent?: string; walletAddress?: string; idempotencyKey?: string; skipLLMRefinement?: boolean };
  try {
    body = (await req.json()) as { intent?: string; walletAddress?: string; idempotencyKey?: string; skipLLMRefinement?: boolean };
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  // If present, must be a real address — never trusted for anything beyond
  // "sign with this account"; the on-chain receipt is what's actually verified.
  const walletAddress = body.walletAddress && isAddress(body.walletAddress) ? body.walletAddress : null;

  // How to scope read-only history/compliance so users stay private:
  //   - merchant account (its own tenant) → full view (sender = null)
  //   - shared demo tenant + connected wallet → only that wallet's entries
  //   - shared demo tenant + NO wallet → nothing (connect to see your history)
  const { DEMO_TENANT } = await import("@/lib/platform/merchants");
  const senderScope = merchantId === DEMO_TENANT ? (walletAddress ?? "__none__") : null;

  const rawInput = body.intent?.trim();
  if (!rawInput) {
    return NextResponse.json({ error: "intent is required" }, { status: 400 });
  }
  if (rawInput.length > MAX_INPUT_LENGTH) {
    return NextResponse.json({ error: `intent must be ${MAX_INPUT_LENGTH} characters or fewer.` }, { status: 400 });
  }
  const text = sanitizeInput(rawInput);

  // 0. Read-only commands ("show my transaction history", "check compliance
  // status") never touch the payment pipeline — answer them directly from
  // real stored data and stop.
  const query = detectQueryIntent(text);
  // Only treat as the "manage/cancel" info case when it isn't a parseable
  // create request — otherwise the automation-create branch below handles it.
  if (query === "scheduled_payment" && !parseScheduleIntent(text)) {
    return NextResponse.json({
      decision: "info",
      query: "scheduled_payment",
      error: "To manage or cancel an automation, open Payment Automations in your dashboard. The assistant can help draft one, but the dashboard is the primary creation path.",
      success: false,
    }, { status: 200 });
  }
  if (query === "show_history") {
    const { listTx } = await import("@/lib/platform/store");
    // Scope to the connected wallet so a user only ever sees their own history.
    const rows = await listTx(merchantId, { sender: senderScope });
    return NextResponse.json({
      decision: "info",
      query: "show_history",
      count: rows.length,
      history: rows.slice(0, 20),
      success: true,
    });
  }
  if (query === "check_compliance") {
    const { listTx } = await import("@/lib/platform/store");
    const { computeCompliance } = await import("@/lib/platform/analytics");
    const rows = await listTx(merchantId, { sender: senderScope });
    return NextResponse.json({
      decision: "info",
      query: "check_compliance",
      compliance: computeCompliance(rows),
      success: true,
    });
  }
  if (query === "show_balance") {
    if (!walletAddress) {
      return NextResponse.json({ decision: "info", query: "show_balance", error: "Connect your wallet to check your balance.", success: false }, { status: 400 });
    }
    try {
      const { getWalletBalance } = await import("@/lib/monad/balance");
      const balance = await getWalletBalance(walletAddress as `0x${string}`);
      return NextResponse.json({ decision: "info", query: "show_balance", balance, success: true });
    } catch {
      return NextResponse.json({ decision: "info", query: "show_balance", error: "Couldn't reach Monad to read your balance. Try again.", success: false }, { status: 502 });
    }
  }

  // 0a. Token swap ("swap 1 MON to USDC") — a DEX action, not a payment, so it
  // never enters the compliance/settlement pipeline. PayAI reads a live quote
  // and hands back unsigned steps; the user's own wallet signs (non-custodial).
  const swap = detectSwapIntent(text);
  if (swap) {
    if (swap.amount == null || swap.amount <= 0) {
      return NextResponse.json({ decision: "swap_error", error: "Tell me how much to swap, e.g. \"swap 1 MON to USDC\".", success: false }, { status: 400 });
    }
    if (swap.amount > agentConfig.maxAmount) {
      return NextResponse.json({ decision: "swap_error", error: `Amount ${swap.amount} exceeds the agent cap of ${agentConfig.maxAmount}.`, success: false }, { status: 422 });
    }
    const { getSwapProvider } = await import("@/lib/monad/swap");
    const provider = getSwapProvider();
    if (!provider.isConfigured()) {
      return NextResponse.json({ decision: "swap_error", error: "Swaps are only available on Monad mainnet.", success: false }, { status: 501 });
    }
    if (!walletAddress) {
      return NextResponse.json({ decision: "swap_error", error: "Connect your wallet to swap.", success: false }, { status: 400 });
    }
    // Real balance check before building a quote nobody can actually afford
    // to execute — same helper the payment path uses, so "insufficient
    // balance" is one honest, consistent message across the whole app.
    // Only covers MON/USDC (the two assets this task scopes balance
    // validation to); an unrecognized fromToken symbol returns null (no
    // block) exactly like the payment path does, and the wallet/contract
    // still correctly reject on-chain if funds are short.
    const { insufficientBalanceReason } = await import("@/lib/monad/balance");
    const balanceIssue = await insufficientBalanceReason(walletAddress as `0x${string}`, swap.fromToken, swap.amount);
    if (balanceIssue) {
      return NextResponse.json({ decision: "swap_error", error: balanceIssue, success: false }, { status: 422 });
    }
    try {
      const plan = await provider.buildPlan(swap.fromToken, swap.toToken, swap.amount, walletAddress as `0x${string}`);
      return NextResponse.json({
        decision: "swap_ready",
        provider: provider.name,
        swap: plan,
        confirmRawText: text,
        success: false,
      });
    } catch (e) {
      return NextResponse.json({ decision: "swap_error", error: e instanceof Error ? e.message : "Couldn't build the swap.", success: false }, { status: 502 });
    }
  }

  // 0a-bis. Payment Automation draft ("automate 10 USDC to a .nad domain
  // every friday"). Creates a real automation that the cron runner fires through
  // the custodial agent path when due — it is NOT settled now. Validated up
  // front (amount cap, resolvable recipient) so a bad schedule never persists.
  const sched = parseScheduleIntent(text);
  if (sched) {
    if (sched.amount == null || sched.amount <= 0) {
      return NextResponse.json({ decision: "schedule_error", error: "Tell me the amount for this automation, e.g. \"automate 10 USDC to a .nad domain every Friday\".", success: false }, { status: 400 });
    }
    if (sched.amount > agentConfig.maxAmount) {
      return NextResponse.json({ decision: "schedule_error", error: `Amount ${sched.amount} exceeds the agent cap of ${agentConfig.maxAmount}.`, success: false }, { status: 422 });
    }
    if (!sched.recipient) {
      return NextResponse.json({ decision: "schedule_error", error: "Who should this automation pay? Add a recipient — a wallet address or a .nad domain.", success: false }, { status: 400 });
    }
    if (sched.needsTime || sched.nextRun == null) {
      return NextResponse.json({ decision: "schedule_error", error: "When should it run? Add a time, e.g. \"every Friday\", \"tomorrow\", \"on 2026-07-01\", or \"in 3 days\".", success: false }, { status: 400 });
    }
    // Resolve the recipient to a real address (domain → payee → 0x), same rules
    // as an instant payment, so an automation can never fire to an unresolved name.
    let recipient = sched.recipient;
    let domain: string | null = null;
    if (!isAddress(recipient)) {
      if (isDomainName(recipient)) {
        const { resolveDomain } = await import("@/lib/monad/domain-resolver");
        const dom = extractDomain(recipient) ?? recipient;
        const resolution = await resolveDomain(dom);
        if (!resolution.resolvedAddress) {
          return NextResponse.json({ decision: "schedule_error", error: `Couldn't resolve ${dom}. Check the name and try again.`, success: false }, { status: 422 });
        }
        domain = resolution.domain;
        recipient = resolution.resolvedAddress;
      } else {
        const payee = resolvePayee(recipient);
        if (!payee) {
          return NextResponse.json({ decision: "schedule_error", error: `"${recipient}" isn't a valid address, .nad domain, or known payee.`, success: false }, { status: 422 });
        }
        recipient = payee.address;
      }
    }
    // The AI never creates an automation directly — Payment Automations move
    // money on a recurring basis, and every one of them requires a wallet
    // signature (see /api/automations POST) before it goes live, the same
    // hard rule the dashboard's own creator enforces. Hand back the fully
    // resolved, validated fields as a PREFILL: the client opens the real
    // Automations creator with these values already filled in, still one
    // wallet signature away from actually being created.
    return NextResponse.json({
      decision: "automation_prefill",
      prefill: { amount: sched.amount, token: sched.token, recipient, domain, cadence: sched.cadence, nextRun: sched.nextRun },
      success: false,
    });
  }

  // 0b. Idempotency claim — every decision-producing path below (refused,
  // blocked, needs_review, ready_to_sign, executed, error) is covered. A
  // client-supplied idempotencyKey is preferred (the UI generates one per
  // submit and resends it on retry); without one, an identical request from
  // the same merchant/wallet/text within the TTL window still collides. This
  // is the app-level layer only — the authoritative guard for actual fund
  // movement is the on-chain requestId check in PaymentExecutor.sol.
  const requestId = body.idempotencyKey?.trim() || computeRequestId({ merchantId, walletAddress, text });
  const claim = await claimRequest<Record<string, unknown>>(requestId);
  if (!claim.claimed) {
    if (claim.status === "done" && claim.result) {
      return NextResponse.json({ ...claim.result, replayed: true });
    }
    return NextResponse.json({ error: "This request is already being processed. Please wait before retrying." }, { status: 409 });
  }

  const trace: TraceEntry[] = [];

  // 1. Understand. skipLLMRefinement is set by Ask PayAI's own dispatch
  // functions for text they built themselves (already-classified, canonical
  // "Send 50 USDC to 0x..." reconstructions) — refining an unambiguous,
  // machine-generated string would just be a second paid Anthropic call for
  // an understanding Ask PayAI's semantic layer already reached once.
  const { intent, source } = await parseIntent(text, { skipLLM: body.skipLLMRefinement === true });
  trace.push({
    step: "intent",
    status: "ok",
    detail: `Parsed via ${source}: ${intent.action} · ${intent.amount ?? "?"} ${intent.token} → ${intent.recipient ?? "(none)"} (${Math.round(intent.confidence * 100)}% confidence)`,
  });

  // "info" and "ready_to_sign" decisions short-circuit above/below and never reach this helper.
  const base = (decision: Exclude<AgentResult["decision"], "info" | "ready_to_sign">, extra: Partial<AgentResult> = {}): AgentResult => ({
    decision,
    intent,
    source,
    guardrail: { allowed: true, violations: [] },
    compliance: null,
    risk: null,
    transaction: null,
    confidence: intent.confidence,
    riskScore: null,
    trace,
    ...extra,
  });

  /** Serialize with the flat, spec-required convenience fields on top. */
  const respond = async (result: AgentResult, init?: { status?: number }) => {
    // Record every outcome (incl. failures) into the merchant transaction log.
    await recordTx(merchantId, {
      decision: result.decision as Exclude<AgentResult["decision"], "info" | "ready_to_sign">,
      action: result.intent.action,
      feature: "payment",
      amount: result.intent.amount,
      token: result.intent.token,
      recipient: result.intent.recipient,
      domain: result.intent.domain ?? null,
      sender: walletAddress,
      riskScore: result.riskScore,
      compliance: result.compliance?.status ?? null,
      txHash: result.transaction?.txHash,
      explorerUrl: result.transaction?.explorerUrl,
      summary: result.intent.summary,
    });
    const body = {
      // Full structured payload (dashboard reads this) — includes decision,
      // confidence, riskScore, intent, compliance, risk, transaction, trace.
      ...result,
      // Flat, spec-required convenience fields layered on top.
      success: result.decision === "executed",
      transactionHash: result.transaction?.txHash ?? null,
      explorerUrl: result.transaction?.explorerUrl ?? null,
      gasFee: result.transaction?.gasFee ?? result.transaction?.gasEstimate ?? null,
      requestId,
    };
    // Persist under the idempotency key so a retry/double-click replays this
    // exact outcome instead of re-running the pipeline (or, worse, re-executing).
    await completeRequest(requestId, body as unknown as Record<string, unknown>);
    return NextResponse.json(body, init);
  };

  // 1b. Recipient resolution — Monad domain (.nad / .nads) first, since it's
  // the canonical on-chain identity; fall back to the static payee directory
  // for plain names. Compliance and execution only ever see a real address.
  if (intent.recipient && !isAddress(intent.recipient)) {
    if (isDomainName(intent.recipient)) {
      const { resolveDomain } = await import("@/lib/monad/domain-resolver");
      const domain = extractDomain(intent.recipient) ?? intent.recipient;
      const resolution = await resolveDomain(domain);
      if (!resolution.resolvedAddress) {
        trace.push({ step: "domain", status: "blocked", detail: `${resolution.error ?? "Unable to resolve domain"}: ${resolution.domain}` });
        return respond(base("refused", { guardrail: { allowed: false, violations: ["Unable to resolve domain"] } }), { status: 422 });
      }
      intent.domain = resolution.domain;
      intent.recipient = resolution.resolvedAddress;
      trace.push({
        step: "domain",
        status: "ok",
        detail: `Resolved ${resolution.domain} → ${resolution.resolvedAddress}${resolution.cached ? " (cached)" : ""}`,
      });
    } else {
      const payee = resolvePayee(intent.recipient);
      if (payee) {
        intent.payeeName = payee.name;
        intent.recipient = payee.address;
        trace.push({ step: "directory", status: "ok", detail: `Resolved payee "${payee.name}" → ${payee.address}` });
      } else {
        // Not a domain, not a known payee name, and not a valid 0x address —
        // this is malformed input (e.g. a typo'd address). Reject it here,
        // with a clear reason, instead of letting it silently ride through
        // guardrails/compliance (which only check for a *present* recipient,
        // not a *valid* one) and fail opaquely at the signer.
        trace.push({ step: "recipient", status: "blocked", detail: `"${intent.recipient}" is not a valid wallet address, .nad domain, or known payee.` });
        return respond(base("refused", { guardrail: { allowed: false, violations: [`"${intent.recipient}" is not a valid wallet address, .nad domain, or known payee.`] } }), { status: 422 });
      }
    }
  }

  // 2. Guardrails.
  const guardrail = checkGuardrails(intent);
  if (!guardrail.allowed) {
    trace.push({ step: "guardrails", status: "blocked", detail: guardrail.violations.join(" ") });
    return respond(base("refused", { guardrail }));
  }
  trace.push({ step: "guardrails", status: "ok", detail: "Within agent limits." });

  // Normalize into the payment-layer view.
  const request: PaymentRequest = {
    action: intent.action,
    amount: intent.amount,
    token: intent.token,
    recipient: intent.recipient,
    purpose: intent.purpose,
    network: intent.network,
    invoiceRef: intent.action === "pay_invoice" ? "current" : null,
  };

  try {
    // 3. Validation. Warm the OFAC sanctions list (cached, non-blocking-ish) so
    // the address screen inside runValidation sees the latest entries.
    const { ensureSanctionsLoaded } = await import("@/lib/payment/sanctions");
    await ensureSanctionsLoaded();
    const compliance = runValidation(request);
    trace.push({
      step: "compliance",
      status: compliance.status === "approved" ? "ok" : compliance.status === "review" ? "warn" : "blocked",
      detail: compliance.summary,
    });

    // 4. Risk.
    const risk = assessRisk(request);
    trace.push({
      step: "risk",
      status: risk.level === "low" ? "ok" : risk.level === "medium" ? "warn" : "blocked",
      detail: `Risk ${risk.score}/100 (${risk.level}).`,
    });

    // 5. Gate execution. Only an approved + non-high-risk request executes.
    if (compliance.status === "rejected") {
      trace.push({ step: "decision", status: "blocked", detail: "Blocked by compliance." });
      return respond(base("blocked", { guardrail, compliance, risk, riskScore: risk.score }));
    }
    trace.push({ step: "decision", status: "ok", detail: "Cleared for execution." });

    // 6a. A connected wallet signs its own payment — non-custodial path. The
    // platform never touches a key here; it only approves and hands back an
    // unsigned tx for the wallet to sign. Only applies to direct sends to a
    // resolved address (link/invoice creation has nothing for a wallet to sign).
    if (walletAddress && intent.action === "send_payment" && intent.recipient && isAddress(intent.recipient) && intent.amount) {
      const { insufficientBalanceReason } = await import("@/lib/monad/balance");
      const reason = await insufficientBalanceReason(walletAddress as `0x${string}`, intent.token, intent.amount);
      if (reason) {
        trace.push({ step: "execution", status: "blocked", detail: reason });
        return respond(base("refused", { guardrail: { allowed: false, violations: [reason] }, compliance, risk, riskScore: risk.score }), { status: 422 });
      }
      // Native MON and ERC-20 USDC are settled with fundamentally different
      // transactions: MON is a plain value transfer to the recipient (no
      // calldata), USDC is a transfer() call to the token contract (recipient
      // + amount encoded in calldata, zero value). Building the wrong one
      // silently moves the wrong asset — so branch explicitly on the token.
      const { parseEther, parseUnits, encodeFunctionData } = await import("viem");
      let unsignedTx: { to: string; data: string; value: string; from: string };
      if (intent.token === "MON") {
        unsignedTx = {
          to: intent.recipient,
          data: "0x",
          value: `0x${parseEther(String(intent.amount)).toString(16)}`,
          from: walletAddress,
        };
      } else {
        const { getStablecoin } = await import("@/lib/monad/config");
        const usdc = getStablecoin();
        const data = encodeFunctionData({
          abi: [{ name: "transfer", type: "function", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] }],
          functionName: "transfer",
          args: [intent.recipient as `0x${string}`, parseUnits(String(intent.amount), usdc.decimals)],
        });
        unsignedTx = { to: usdc.address, data, value: "0x0", from: walletAddress };
      }
      trace.push({ step: "execution", status: "info", detail: "Approved — sign with your connected wallet to settle." });
      const readyBody = {
        decision: "ready_to_sign",
        intent, source, guardrail, compliance, risk, riskScore: risk.score, trace,
        unsignedTx,
        confirmRawText: text,
        requestId,
        success: false,
      };
      await completeRequest(requestId, readyBody);
      return NextResponse.json(readyBody);
    }

    // 6b. Otherwise the platform's own agent wallet executes (custodial path).
    // The signer is only ever touched from here on — gate it here, not earlier.
    const denied = authError(req);
    if (denied) {
      // Auth failure isn't a pipeline outcome — release the claim so the
      // caller can retry the same idempotencyKey once authorized correctly,
      // instead of it being stuck "in_progress" until the TTL expires.
      await releaseRequest(requestId);
      return denied;
    }

    // Carry the risk score (anchored in the registry) and the idempotency key
    // (enforced by PaymentExecutor.sol — this is what makes a retry safe).
    request.riskScore = risk.score;
    request.requestId = requestId;
    const transaction = await execute(request);
    if (transaction.gasEstimate)
      trace.push({ step: "gas", status: "info", detail: `Estimated fee ${transaction.gasEstimate}.` });

    // An on-chain transfer can come back failed without throwing.
    if (transaction.status === "failed") {
      trace.push({ step: "execution", status: "blocked", detail: transaction.detail });
      return respond(
        base("error", { guardrail, compliance, risk, riskScore: risk.score, transaction, error: transaction.detail }),
        { status: 502 },
      );
    }

    trace.push({ step: "execution", status: "ok", detail: `${transaction.detail}${transaction.gasFee ? ` Gas ${transaction.gasFee}.` : ""}` });
    trace.push({ step: "decision", status: "ok", detail: "Executed." });
    return respond(base("executed", { guardrail, compliance, risk, riskScore: risk.score, transaction }));
  } catch (err) {
    const detail = err instanceof Error ? err.message : "Pipeline error";
    trace.push({ step: "error", status: "blocked", detail });
    return respond(base("error", { guardrail, error: detail }), { status: 502 });
  }
}
