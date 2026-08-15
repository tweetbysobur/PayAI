/**
 * PayAI payment engine — the validation and execution layer.
 *
 * Three responsibilities, all operating on a normalized PaymentRequest:
 *   1. runValidation() — deterministic validation checks (sanctions, KYC posture,
 *      travel-rule documentation, asset/network support).
 *   2. assessRisk()    — weighted 0–100 risk score with explainable factors.
 *   3. execute()       — performs the action through a PaymentProvider.
 *
 * Execution is provider-based: a SimulationProvider (default) simulates settlement
 * so the whole product is demoable offline. Swap is controlled by PAYAI_MODE
 * with zero changes to callers.
 *
 * Server-only.
 */
import "server-only";
import type {
  ComplianceCheck,
  ComplianceResult,
  ExecutionMode,
  Network,
  PaymentRequest,
  RiskAssessment,
  RiskFactor,
  TransactionResult,
} from "./types";
import { NATIVE_TOKENS, SUPPORTED_NETWORKS, SUPPORTED_TOKENS } from "./types";
import { isSanctionedAddress, sanctionsListLoaded } from "./sanctions";

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
/** Above this amount, travel-rule documentation (a purpose) is expected. */
const TRAVEL_RULE_THRESHOLD = Number(process.env.PAYAI_TRAVEL_RULE_THRESHOLD || "10000000");
/** Name-substring denylist — catches obvious tells before address screening. */
const DENYLIST = (process.env.PAYAI_DENYLIST || "sanctioned,blocked,ofac")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

export function getMode(): ExecutionMode {
  const m = process.env.PAYAI_MODE;
  return m === "monad" ? "monad" : "simulation";
}

/* ── Validation engine ──────────────────────────────────────────────────── */

export function runValidation(req: PaymentRequest): ComplianceResult {
  const checks: ComplianceCheck[] = [];
  const isTransfer = req.action === "send_payment" || req.action === "pay_invoice";
  const recipientText = (req.recipient || "").toLowerCase();

  // 1. Sanctions screen (hard). The resolved 0x recipient is checked against the
  // OFAC SDN sanctioned-address list (+ env denylist) via lib/payment/sanctions;
  // a name-substring rule catches obvious tells before an address resolves. The
  // remote list is refreshed out-of-band; call ensureSanctionsLoaded() in the
  // route before validating so it's warm.
  const nameHit = DENYLIST.some((d) => recipientText.includes(d));
  const addrHit = isSanctionedAddress(recipientText);
  const sanctioned = nameHit || addrHit;
  checks.push({
    id: "sanctions",
    label: "Sanctions screen",
    passed: !sanctioned,
    severity: "hard",
    detail: sanctioned
      ? addrHit
        ? "Recipient is on the OFAC sanctions list."
        : "Recipient matched a screening rule."
      : sanctionsListLoaded()
        ? "Cleared against the OFAC sanctions address list."
        : "Cleared against screening rules.",
  });

  // 2. Asset support (hard). A request carrying a resolved tokenAddress was
  // already confirmed as a real on-chain token at creation time (see
  // lib/monad/tokenRegistry.ts), so it's supported regardless of symbol —
  // only a bare legacy symbol (no address) falls back to the fixed list.
  const tokenOk = !!req.tokenAddress || SUPPORTED_TOKENS.includes(req.token);
  checks.push({
    id: "asset",
    label: "Asset supported",
    passed: tokenOk,
    severity: "hard",
    detail: tokenOk ? `${req.token} is supported.` : `${req.token} not supported.`,
  });

  // 3. Network support (hard).
  const netOk = SUPPORTED_NETWORKS.includes(req.network);
  checks.push({
    id: "network",
    label: "Network supported",
    passed: netOk,
    severity: "hard",
    detail: netOk ? `${req.network} is enabled.` : `${req.network} not enabled.`,
  });

  // 4. Recipient resolvable (hard, transfers only).
  if (isTransfer) {
    const hasRecipient = !!req.recipient;
    checks.push({
      id: "recipient",
      label: "Recipient resolvable",
      passed: hasRecipient,
      severity: "hard",
      detail: hasRecipient
        ? ADDR_RE.test(req.recipient!)
          ? "Valid wallet address."
          : `Named payee "${req.recipient}" (resolved via directory).`
        : "No recipient provided.",
    });
  }

  // 5. Travel-rule documentation (soft) — large transfers should state a purpose.
  if (isTransfer && (req.amount ?? 0) >= TRAVEL_RULE_THRESHOLD) {
    const documented = !!req.purpose;
    checks.push({
      id: "travel_rule",
      label: "Travel-rule documentation",
      passed: documented,
      severity: "soft",
      detail: documented
        ? "Purpose recorded for the transfer."
        : `Transfers ≥ ${TRAVEL_RULE_THRESHOLD} should state a purpose.`,
    });
  }

  const hardFail = checks.some((c) => !c.passed && c.severity === "hard");
  const softFail = checks.some((c) => !c.passed && c.severity === "soft");
  const status: ComplianceResult["status"] = hardFail
    ? "rejected"
    : softFail
      ? "review"
      : "approved";

  return {
    status,
    checks,
    summary: hardFail
      ? "Failed a mandatory validation check."
      : softFail
        ? "Passed mandatory checks; flagged for review."
        : "All validation checks passed.",
  };
}

/* ── Risk engine ────────────────────────────────────────────────────────── */

export function assessRisk(req: PaymentRequest): RiskAssessment {
  const factors: RiskFactor[] = [];
  const amount = req.amount ?? 0;

  if (amount > 500)
    factors.push({ id: "amt_high", label: "High amount", points: 35, detail: `${amount} > 500` });
  else if (amount > 100)
    factors.push({ id: "amt_mid", label: "Moderate amount", points: 15, detail: `${amount} > 100` });
  else
    factors.push({ id: "amt_low", label: "Low amount", points: 3, detail: `${amount} ≤ 100` });

  if (req.action === "send_payment" || req.action === "pay_invoice") {
    if (req.recipient && ADDR_RE.test(req.recipient))
      factors.push({ id: "raw_addr", label: "Raw address payee", points: 18, detail: "Unnamed wallet recipient." });
    else if (!req.recipient)
      factors.push({ id: "no_recipient", label: "Missing recipient", points: 25, detail: "No payee resolved." });
    else
      factors.push({ id: "named", label: "Named payee", points: 6, detail: `"${req.recipient}"` });
  } else {
    // Links don't move funds on creation → inherently lower risk.
    factors.push({ id: "link", label: "Link creation", points: 2, detail: "No immediate fund movement." });
  }

  if ((req.action === "send_payment" || req.action === "pay_invoice") && !req.purpose && amount >= TRAVEL_RULE_THRESHOLD)
    factors.push({ id: "undocumented", label: "Undocumented purpose", points: 12, detail: "Large transfer without a stated purpose." });

  const score = Math.min(100, factors.reduce((s, f) => s + f.points, 0));
  const level = score >= 60 ? "high" : score >= 30 ? "medium" : "low";
  return { score, level, factors };
}

/* ── Execution providers ────────────────────────────────────────────────── */

interface PaymentProvider {
  mode: ExecutionMode;
  execute(req: PaymentRequest): Promise<TransactionResult>;
}

function fakeTxHash(): string {
  const hex = "0123456789abcdef";
  let h = "0x";
  for (let i = 0; i < 64; i++) h += hex[Math.floor(Math.random() * 16)];
  return h;
}

function explorer(network: Network, txHash: string): string {
  const bases: Record<Network, string> = {
    monad: "https://explorer.monad.xyz/tx/",
    base: "https://basescan.org/tx/",
    polygon: "https://polygonscan.com/tx/",
    ethereum: "https://etherscan.io/tx/",
  };
  return bases[network] + txHash;
}

/** Default provider — deterministic, offline-safe simulation. */
const simulationProvider: PaymentProvider = {
  mode: "simulation",
  async execute(req) {
    const base = { network: req.network, mode: "simulation" as const, amount: req.amount ?? undefined, token: req.token };
    switch (req.action) {
      case "send_payment": {
        const txHash = fakeTxHash();
        return { ...base, status: "settled", txHash, explorerUrl: explorer(req.network, txHash), recipient: req.recipient ?? undefined, detail: `Sent ${req.amount} ${req.token} to ${req.recipient}.` };
      }
      case "pay_invoice": {
        const txHash = fakeTxHash();
        return { ...base, status: "settled", txHash, explorerUrl: explorer(req.network, txHash), detail: `Paid invoice ${req.invoiceRef ?? "current"} (${req.amount} ${req.token}).` };
      }
      case "create_payment_link": {
        const link = `https://pay.payai.app/l/${Math.random().toString(36).slice(2, 10)}`;
        return { ...base, status: "settled", link, detail: `Payment link for ${req.amount} ${req.token} created.` };
      }
      case "create_checkout_link": {
        const link = `https://pay.payai.app/checkout/${Math.random().toString(36).slice(2, 10)}`;
        return { ...base, status: "settled", link, detail: `Checkout link for ${req.amount} ${req.token} created.` };
      }
    }
  },
};

/**
 * Monad provider — real on-chain settlement (USDC/USDT ERC-20, or native MON).
 * Transfers and invoice payments go on-chain (require a resolvable address);
 * link actions have no on-chain action and are simulated. The executor is
 * dynamically imported so simulation-mode builds never load viem/signing code.
 *
 * Every execution requires `req.requestId` (the idempotency key) — this
 * provider never moves funds without one, since that key is what makes a
 * retry of this exact call safe instead of a silent double-payment.
 */
const monadProvider: PaymentProvider = {
  mode: "monad",
  async execute(req) {
    const isTransfer = req.action === "send_payment" || req.action === "pay_invoice";
    if (!isTransfer) {
      const sim = await simulationProvider.execute(req);
      return { ...sim, mode: "monad", detail: `${sim.detail} (off-chain — links are not on-chain).` };
    }
    if (!req.recipient || !/^0x[0-9a-fA-F]{40}$/.test(req.recipient)) {
      return {
        status: "failed",
        mode: "monad",
        network: req.network,
        amount: req.amount ?? undefined,
        token: req.token,
        recipient: req.recipient ?? undefined,
        detail: "On-chain transfer needs a valid 0x recipient address (named payees require directory resolution).",
      };
    }
    if (!req.requestId) {
      return {
        status: "failed",
        mode: "monad",
        network: req.network,
        amount: req.amount ?? undefined,
        token: req.token,
        recipient: req.recipient ?? undefined,
        detail: "Missing idempotency requestId — refusing to execute without one.",
      };
    }

    const to = req.recipient as `0x${string}`;
    const amount = req.amount ?? 0;
    // A resolved tokenAddress (set by the automation engine / Bulk Payments)
    // is the source of truth; only a bare legacy symbol falls back to the
    // fixed MON check, which is what today's un-migrated AI chat path uses.
    const isNative = req.tokenAddress
      ? req.tokenAddress.toLowerCase() === "0x0000000000000000000000000000000000000000"
      : NATIVE_TOKENS.includes(req.token);

    const decisionMeta = JSON.stringify({
      action: req.action,
      amount,
      token: req.token,
      recipient: to,
      purpose: req.purpose ?? null,
      riskScore: req.riskScore ?? 0,
      compliance: "approved",
    });

    // ── Reserved Funds mode: release from the AutomationVault ──────────────
    // Funds were pre-reserved by the user at creation; the agent only triggers
    // the payout to the locked-in recipient. Works for both MON and USDC.
    if (req.fundingMode === "reserved") {
      const { releaseFromVault } = await import("../monad/contracts");
      const { getStablecoin } = await import("../monad/config");
      try {
        const tokenDecimals = isNative ? 18 : (req.tokenDecimals ?? getStablecoin().decimals);
        const r = await releaseFromVault({
          automationId: req.automationId ?? "", amount, tokenDecimals,
          requestId: req.requestId, vaultAddress: req.vaultAddress,
        });
        return {
          status: "settled", mode: "monad", network: req.network, txHash: r.txHash, explorerUrl: r.explorerUrl,
          amount, token: req.token, recipient: to, gasFee: r.gasFee, blockNumber: r.blockNumber,
          blockTimestamp: r.blockTimestamp, sender: r.sender, requestId: req.requestId,
          detail: `Released ${amount} ${req.token} from your reserved balance to ${to}.`,
        };
      } catch (e) {
        return {
          status: "failed", mode: "monad", network: req.network, amount, token: req.token, recipient: to,
          requestId: req.requestId, detail: e instanceof Error ? e.message : "Vault release failed.",
        };
      }
    }

    // ── Wallet Automation mode: pull the user's pre-approved ERC-20 ─────────
    // Non-custodial. Native MON can't be pulled via allowance, so it must be a
    // wrapped-native (WMON) token; the creation flow guarantees `token` here is
    // ERC-20 and `fromWallet` is set.
    if (req.fundingMode === "wallet") {
      const { executePaymentFromViaExecutor } = await import("../monad/contracts");
      const { getWrappedNative, getStablecoin } = await import("../monad/config");
      try {
        // Native MON has no ERC-20 allowance, so it pulls WMON instead; any
        // other token pulls its own real address — no longer forced to the
        // single hardcoded stablecoin.
        const erc20 = isNative ? getWrappedNative() : (req.tokenAddress ?? getStablecoin().address);
        if (!erc20) throw new Error("WALLET_MODE_TOKEN_UNAVAILABLE: this token can't be used for non-custodial pulls yet.");
        if (!req.fromWallet) throw new Error("WALLET_MODE_NO_SOURCE: missing the authorizing wallet.");
        // WMON mirrors native MON's 18 decimals; any other token uses its own
        // resolved decimals — never the unrelated configured stablecoin's.
        const tokenDecimals = isNative ? 18 : (req.tokenDecimals ?? getStablecoin().decimals);
        const r = await executePaymentFromViaExecutor({
          from: req.fromWallet as `0x${string}`, token: erc20 as `0x${string}`, tokenDecimals, merchant: to,
          amount, riskScore: req.riskScore ?? 0, decisionMeta,
          ref: req.invoiceRef ?? req.purpose ?? null, requestId: req.requestId,
          executorAddress: req.executorAddress as `0x${string}` | null | undefined,
        });
        return {
          status: "settled", mode: "monad", network: req.network, txHash: r.txHash, explorerUrl: r.explorerUrl,
          amount, token: req.token, recipient: to, gasFee: r.gasFee, blockNumber: r.blockNumber,
          blockTimestamp: r.blockTimestamp, sender: r.sender, requestId: req.requestId, event: r.event,
          detail: `Sent ${amount} ${req.token} directly from your wallet to ${to}.`,
        };
      } catch (e) {
        return {
          status: "failed", mode: "monad", network: req.network, amount, token: req.token, recipient: to,
          requestId: req.requestId, detail: e instanceof Error ? e.message : "Wallet-funded execution failed.",
        };
      }
    }

    // Preferred path: the PaymentExecutor contract settles AND records the
    // payment (agent, merchant, amount, risk score, AI decision hash,
    // compliance, requestId) on-chain in a single transaction — the canonical
    // on-chain execution layer, with idempotency enforced by the contract.
    const { executorEnabled } = await import("../monad/contracts");
    // An automation's own pinned executorAddress counts as "available" even
    // if a later redeploy changed the global config to a different address —
    // this automation still has a real, working executor to settle against.
    if (executorEnabled() || req.executorAddress) {
      try {
        if (isNative) {
          const { executeNativeViaExecutor } = await import("../monad/contracts");
          const { parseEther } = await import("viem");
          const r = await executeNativeViaExecutor({
            merchant: to,
            amountWei: parseEther(amount.toString()),
            riskScore: req.riskScore ?? 0,
            decisionMeta,
            ref: req.invoiceRef ?? req.purpose ?? null,
            requestId: req.requestId,
            executorAddress: req.executorAddress as `0x${string}` | null | undefined,
          });
          return {
            status: "settled", mode: "monad", network: req.network,
            txHash: r.txHash, explorerUrl: r.explorerUrl,
            amount, token: req.token, recipient: to,
            gasFee: r.gasFee, blockNumber: r.blockNumber,
            blockTimestamp: r.blockTimestamp, sender: r.sender, requestId: req.requestId, event: r.event,
            detail: `Executed ${amount} MON via PaymentExecutor — native transfer + on-chain audit record in one tx.`,
          };
        }
        const { executeViaExecutor } = await import("../monad/contracts");
        const r = await executeViaExecutor({
          merchant: to, amount, riskScore: req.riskScore ?? 0, decisionMeta,
          ref: req.invoiceRef ?? req.purpose ?? null, requestId: req.requestId,
          // Any resolved token address settles through this same call — no
          // separate "generic ERC-20 executor," just a parameter.
          tokenAddress: req.tokenAddress as `0x${string}` | undefined,
          tokenDecimals: req.tokenDecimals ?? undefined,
          executorAddress: req.executorAddress as `0x${string}` | null | undefined,
        });
        return {
          status: "settled", mode: "monad", network: req.network,
          txHash: r.txHash, explorerUrl: r.explorerUrl,
          amount, token: req.token, recipient: to,
          gasFee: r.gasFee, blockNumber: r.blockNumber,
          blockTimestamp: r.blockTimestamp, sender: r.sender, requestId: req.requestId, event: r.event,
          detail: `Executed ${amount} ${req.token} via PaymentExecutor — transfer + on-chain audit record in one tx.`,
        };
      } catch (e) {
        return {
          status: "failed", mode: "monad", network: req.network,
          amount, token: req.token, recipient: to, requestId: req.requestId,
          detail: e instanceof Error ? e.message : "PaymentExecutor execution failed.",
        };
      }
    }

    // Fallback (no PaymentExecutor configured): direct transfer — ERC-20 for
    // stablecoins, native send for MON — then a best-effort anchor to the
    // VeriPayRegistry (stablecoins only; native has no anchor here).
    if (isNative) {
      const { estimateNativeGas, executeNativeTransfer } = await import("../monad/executor");
      let gasEstimate: string | undefined;
      try {
        const est = await estimateNativeGas({ to, amount });
        gasEstimate = `${est.feeMon} ${est.symbol}`;
      } catch {
        /* estimate is best-effort; proceed to execute */
      }
      const result = await executeNativeTransfer({ to, amount });
      return {
        status: result.status, mode: "monad", network: req.network,
        txHash: result.txHash, explorerUrl: result.explorerUrl,
        amount: result.amount, token: req.token, recipient: result.recipient,
        gasFee: result.gasFee, gasEstimate, blockNumber: result.blockNumber, requestId: req.requestId,
        detail: `Transferred ${result.amount} MON on ${result.network} (no on-chain audit anchor for native MON without PaymentExecutor).`,
      };
    }

    const { estimateGas, executeTransfer } = await import("../monad/executor");
    const tokenOverride = req.tokenAddress ? { tokenAddress: req.tokenAddress as `0x${string}`, tokenDecimals: req.tokenDecimals ?? undefined, tokenSymbol: req.token } : undefined;

    // Estimate first so the gas cost is known even if the send later fails.
    let gasEstimate: string | undefined;
    try {
      const est = await estimateGas({ to, amount, ...tokenOverride });
      gasEstimate = `${est.feeMon} ${est.symbol}`;
    } catch {
      /* estimate is best-effort; proceed to execute */
    }

    const result = await executeTransfer({ to, amount, ...tokenOverride });

    // Anchor the settled payment to the VeriPayRegistry contract (best-effort;
    // a failed anchor never undoes a settled transfer). No-op if no registry.
    let registryTxHash: string | undefined;
    let registryExplorerUrl: string | undefined;
    if (result.status === "settled") {
      const { anchorPayment } = await import("../monad/registry");
      const { getStablecoin } = await import("../monad/config");
      const anchorToken = (req.tokenAddress ?? getStablecoin().address) as `0x${string}`;
      const anchorDecimals = req.tokenDecimals ?? getStablecoin().decimals;
      const anchor = await anchorPayment({
        recipient: to,
        token: anchorToken,
        amount: BigInt(Math.round(amount * 10 ** anchorDecimals)),
        riskScore: req.riskScore ?? 0,
        purpose: req.purpose,
        ref: req.invoiceRef ?? undefined,
      });
      if (anchor) {
        registryTxHash = anchor.txHash;
        registryExplorerUrl = anchor.explorerUrl;
      }
    }

    return {
      status: result.status,
      mode: "monad",
      network: req.network,
      txHash: result.txHash,
      explorerUrl: result.explorerUrl,
      amount: result.amount,
      token: req.token,
      recipient: result.recipient,
      gasFee: result.gasFee,
      gasEstimate,
      blockNumber: result.blockNumber,
      requestId: req.requestId,
      registryTxHash,
      registryExplorerUrl,
      detail: `Transferred ${result.amount} ${req.token} on ${result.network}.${registryTxHash ? " Anchored on-chain." : ""}`,
    };
  },
};

function getProvider(): PaymentProvider {
  const mode = getMode();
  if (mode === "monad") return monadProvider;
  return simulationProvider;
}

export async function execute(req: PaymentRequest): Promise<TransactionResult> {
  return getProvider().execute(req);
}

/* ── Health ─────────────────────────────────────────────────────────────── */

/** Report PayAI payment engine connectivity for /api/health (never throws). */
export async function checkPaymentEngine(): Promise<{ engine: string; connected: boolean; detail: string }> {
  const mode = getMode();
  if (mode === "simulation") {
    return { engine: "simulation", connected: true, detail: "Simulation mode — no external calls." };
  }
  // monad
  try {
    const { getPublicClient } = await import("../monad/wallet");
    const block = await getPublicClient().getBlockNumber();
    return { engine: "monad", connected: true, detail: `Monad RPC reachable (block ${block}).` };
  } catch (e) {
    return { engine: "monad", connected: false, detail: e instanceof Error ? e.message : "Monad RPC unreachable." };
  }
}
