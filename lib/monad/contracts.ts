/**
 * On-chain client for the PayAI execution suite (PaymentExecutor +
 * MerchantRegistry) on Monad. Minimal hand-written ABIs cover exactly the
 * functions the app calls — writes (executePayment) and reads (payments,
 * merchants, analytics) — so the app has no dependency on the Hardhat build.
 *
 * Server-only.
 */
import "server-only";
import { decodeEventLog, keccak256, stringToHex, toHex, type Hash } from "viem";
import { explorerTx, getAutomationVault, getMerchantRegistry, getPaymentExecutor, getStablecoin } from "./config";
import { getAgentAccount, getPublicClient, getWalletClient } from "./wallet";
import { AUTOMATION_VAULT_ABI, MERCHANT_REGISTRY_ABI, PAYMENT_EXECUTOR_ABI } from "./abi";
import { toBaseUnits } from "./verify";
import { grossForNet, MAX_FEE_BPS } from "@/lib/payment/feeOnTop";

export { MERCHANT_REGISTRY_ABI, PAYMENT_EXECUTOR_ABI };

export function vaultEnabled(): boolean {
  return getAutomationVault() !== null;
}

const ERC20_APPROVE_ABI = [
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "o", type: "address" }, { name: "s", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "s", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

export function executorEnabled(): boolean {
  return getPaymentExecutor() !== null;
}

/* ── Hashing helpers ────────────────────────────────────────────────────── */
function hash32(s?: string | null): `0x${string}` {
  if (!s) return `0x${"0".repeat(64)}`;
  return keccak256(stringToHex(s));
}
function ref32(s?: string | null): `0x${string}` {
  if (!s) return `0x${"0".repeat(64)}`;
  return `0x${toHex(s).slice(2).slice(0, 64).padEnd(64, "0")}`;
}

/** Deterministic bytes32 idempotency key from an app-level request id string. */
export function requestId32(id: string): `0x${string}` {
  return keccak256(stringToHex(id));
}

export interface ExecuteInput {
  merchant: `0x${string}`;
  amount: number;
  riskScore: number;
  /** Free-form AI decision metadata, hashed on-chain. */
  decisionMeta?: string | null;
  ref?: string | null;
  /** App-level idempotency key — required, hashed to bytes32 on-chain. */
  requestId: string;
  /** Settle in this ERC-20 instead of the configured stablecoin — any Monad token works, PaymentExecutor takes an arbitrary token address. */
  tokenAddress?: `0x${string}`;
  tokenDecimals?: number;
  /**
   * Use THIS PaymentExecutor deployment instead of whatever is currently
   * configured globally. An automation stamps the executor address that was
   * actually live when it was created, so a later contract redeploy (a new
   * address in MONAD_MAINNET_PAYMENT_EXECUTOR) affects only NEW automations
   * — an existing one keeps executing against the exact contract its
   * Wallet Automation ERC-20 approval was granted to, forever, with no
   * forced re-approval. Falls back to getPaymentExecutor() when absent, so
   * every caller that predates this field (or isn't automation-scoped at
   * all, e.g. the AI chat's instant-payment path) behaves exactly as before.
   */
  executorAddress?: `0x${string}` | null;
}

export interface ExecuteResult {
  txHash: Hash;
  explorerUrl: string;
  gasFee: string;
  blockNumber: number;
  blockTimestamp: number;
  sender: string;
  paymentId?: number;
  event?: { name: string; paymentId: number; args: Record<string, string | number> };
  /** PaymentExecutorV2's own FeeCollected for this payment (it emits one for
   *  every payment, including a zero fee). Absent when none was found. */
  feeCollected?: { feeUnits: string; token: string };
}

/** Build the full audit trail (block timestamp + decoded event) from a settled receipt. */
async function buildAuditTrail(
  receipt: Awaited<ReturnType<ReturnType<typeof getPublicClient>["waitForTransactionReceipt"]>>,
  executor?: `0x${string}`,
): Promise<{ blockTimestamp: number; sender: string; event?: ExecuteResult["event"]; feeCollected?: ExecuteResult["feeCollected"] }> {
  const pub = getPublicClient();
  const block = await pub.getBlock({ blockNumber: receipt.blockNumber });

  let event: ExecuteResult["event"] | undefined;
  for (const log of receipt.logs) {
    // Only the executor's own PaymentExecuted establishes this payment's id —
    // never a matching event from another contract in the same transaction.
    if (executor && log.address.toLowerCase() !== executor.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: PAYMENT_EXECUTOR_ABI, data: log.data, topics: log.topics });
      if (decoded.eventName === "PaymentExecuted") {
        const a = decoded.args as unknown as { id: bigint; agent: string; merchant: string; token: string; amount: bigint; riskScore: number; ref: string; requestId: string };
        event = {
          name: "PaymentExecuted",
          paymentId: Number(a.id),
          args: {
            agent: a.agent, merchant: a.merchant, token: a.token,
            amount: a.amount.toString(), riskScore: a.riskScore,
            ref: a.ref, requestId: a.requestId,
          },
        };
        break;
      }
    } catch {
      /* not a PaymentExecuted log (e.g. ERC-20 Transfer/Approval) — skip */
    }
  }

  // The fee this payment actually paid: FeeCollected emitted BY the executor
  // for this payment id (same event signature as the forwarder's). Read-only
  // decoding of a settled receipt — never affects the payment itself.
  let feeCollected: ExecuteResult["feeCollected"] | undefined;
  if (executor && event) {
    try {
      const { decodeFeeCollected } = await import("./forwarder");
      const fc = decodeFeeCollected(receipt.logs, executor, BigInt(event.paymentId));
      if (fc) feeCollected = { feeUnits: fc.feeAmount.toString(), token: fc.token };
    } catch {
      /* undecodable — leave the fee unverified rather than guess */
    }
  }

  return { blockTimestamp: Number(block.timestamp) * 1000, sender: receipt.from, event, feeCollected };
}

/** Test-only handle on the audit-trail decoder (read-only log decoding). */
export { buildAuditTrail as __buildAuditTrailForTests };

/**
 * Execute a payment through the PaymentExecutor contract: ensure the agent has
 * approved the executor for the token, then call executePayment (which pulls the
 * USDC, forwards it to the merchant, and records the AI/compliance metadata
 * on-chain in one transaction). Throws an explained error on failure.
 *
 * `requestId` is the idempotency key: the contract rejects a second call with
 * the same id (API retry, UI double-click), regardless of server state.
 */
export async function executeViaExecutor(input: ExecuteInput): Promise<ExecuteResult> {
  const executor = input.executorAddress ?? getPaymentExecutor();
  const account = getAgentAccount();
  if (!executor) throw new Error("PaymentExecutor not configured (MONAD_MAINNET_PAYMENT_EXECUTOR).");
  if (!account) throw new Error("No Monad signer configured.");
  if (!input.requestId) throw new Error("requestId is required for idempotent execution.");

  const token = input.tokenAddress ? { address: input.tokenAddress, decimals: input.tokenDecimals ?? 18 } : getStablecoin();
  const pub = getPublicClient();
  const wallet = getWalletClient();
  const value = toBaseUnits(input.amount, token.decimals);
  const reqIdBytes = requestId32(input.requestId);

  // Defense-in-depth: check on-chain before spending gas on a doomed retry.
  const already = (await pub.readContract({
    address: executor, abi: PAYMENT_EXECUTOR_ABI, functionName: "isRequestProcessed", args: [reqIdBytes],
  })) as boolean;
  if (already) throw new Error("DUPLICATE_REQUEST: this payment was already executed.");

  // 1. Ensure allowance: approve the executor to pull `value` if needed.
  const allowance = (await pub.readContract({
    address: token.address, abi: ERC20_APPROVE_ABI, functionName: "allowance",
    args: [account.address, executor],
  })) as bigint;
  if (allowance < value) {
    const approveHash = await wallet.writeContract({
      address: token.address, abi: ERC20_APPROVE_ABI, functionName: "approve",
      args: [executor, value], // exact-amount approval — no standing allowance left behind
      account, chain: getPublicClient().chain,
    });
    await pub.waitForTransactionReceipt({ hash: approveHash, timeout: 90_000 });
  }

  // 2. executePayment — transfers + records on-chain, guarded by requestId.
  const { request } = await pub.simulateContract({
    account, address: executor, abi: PAYMENT_EXECUTOR_ABI, functionName: "executePayment",
    args: [input.merchant, token.address, value, Math.max(0, Math.min(100, Math.round(input.riskScore))), hash32(input.decisionMeta), ref32(input.ref), reqIdBytes],
  });
  const txHash = await wallet.writeContract(request);
  const receipt = await pub.waitForTransactionReceipt({ hash: txHash, timeout: 90_000 });
  if (receipt.status !== "success") throw new Error("executePayment reverted on-chain.");

  const feeWei = receipt.gasUsed * receipt.effectiveGasPrice;
  const { formatEther } = await import("viem");
  const trail = await buildAuditTrail(receipt, executor);
  return {
    txHash,
    explorerUrl: explorerTx(txHash),
    gasFee: `${formatEther(feeWei)} MON`,
    blockNumber: Number(receipt.blockNumber),
    blockTimestamp: trail.blockTimestamp,
    sender: trail.sender,
    paymentId: trail.event?.paymentId,
    event: trail.event,
    feeCollected: trail.feeCollected,
  };
}

/** Native-MON counterpart of executeViaExecutor — same idempotency/limit guarantees. */
export async function executeNativeViaExecutor(input: Omit<ExecuteInput, "amount"> & { amountWei: bigint }): Promise<ExecuteResult> {
  const executor = input.executorAddress ?? getPaymentExecutor();
  const account = getAgentAccount();
  if (!executor) throw new Error("PaymentExecutor not configured (MONAD_MAINNET_PAYMENT_EXECUTOR).");
  if (!account) throw new Error("No Monad signer configured.");
  if (!input.requestId) throw new Error("requestId is required for idempotent execution.");

  const pub = getPublicClient();
  const wallet = getWalletClient();
  const reqIdBytes = requestId32(input.requestId);

  const already = (await pub.readContract({
    address: executor, abi: PAYMENT_EXECUTOR_ABI, functionName: "isRequestProcessed", args: [reqIdBytes],
  })) as boolean;
  if (already) throw new Error("DUPLICATE_REQUEST: this payment was already executed.");

  const { request } = await pub.simulateContract({
    account, address: executor, abi: PAYMENT_EXECUTOR_ABI, functionName: "executePaymentNative",
    args: [input.merchant, Math.max(0, Math.min(100, Math.round(input.riskScore))), hash32(input.decisionMeta), ref32(input.ref), reqIdBytes],
    value: input.amountWei,
  });
  const txHash = await wallet.writeContract(request);
  const receipt = await pub.waitForTransactionReceipt({ hash: txHash, timeout: 90_000 });
  if (receipt.status !== "success") throw new Error("executePaymentNative reverted on-chain.");

  const feeWei = receipt.gasUsed * receipt.effectiveGasPrice;
  const { formatEther } = await import("viem");
  const trail = await buildAuditTrail(receipt, executor);
  return {
    txHash,
    explorerUrl: explorerTx(txHash),
    gasFee: `${formatEther(feeWei)} MON`,
    blockNumber: Number(receipt.blockNumber),
    blockTimestamp: trail.blockTimestamp,
    sender: trail.sender,
    paymentId: trail.event?.paymentId,
    event: trail.event,
    feeCollected: trail.feeCollected,
  };
}

/* ── Wallet Automation: pull a pre-approved ERC-20 from the user ─────────── */

/**
 * Non-custodial execution. The user has already `approve`d the executor to
 * spend `token` up to some limit (done in their browser at creation). The
 * AGENT signs this tx (pays gas) but funds are pulled from `from` (the user)
 * straight to the merchant — the agent never holds the money. Native MON is
 * NOT supported here (no ERC-20 allowance for a native coin); the caller must
 * pass a wrapped-native (WMON) token address for MON automations.
 */
export async function executePaymentFromViaExecutor(
  input: ExecuteInput & { from: `0x${string}`; token: `0x${string}`; tokenDecimals?: number; feeOnTop?: boolean },
): Promise<ExecuteResult> {
  const executor = input.executorAddress ?? getPaymentExecutor();
  const account = getAgentAccount();
  if (!executor) throw new Error("PaymentExecutor not configured (MONAD_MAINNET_PAYMENT_EXECUTOR).");
  if (!account) throw new Error("No Monad signer configured.");
  if (!input.requestId) throw new Error("requestId is required for idempotent execution.");

  const pub = getPublicClient();
  const wallet = getWalletClient();
  const reqIdBytes = requestId32(input.requestId);
  // Must scale by the ACTUAL token's decimals, not the configured stablecoin's
  // — Wallet Automation now pulls any ERC-20 the user approved, and a wrong
  // decimals count here would pull a wildly wrong amount (too little for a
  // higher-decimal token, too much for a lower-decimal one).
  const decimals = input.tokenDecimals ?? getStablecoin().decimals;
  // With the fee on top, the executor pulls the gross so the merchant
  // receives `amount` in full (the executor's fee comes out of the gross).
  const net = toBaseUnits(input.amount, decimals);
  const value = input.feeOnTop ? await grossWithFeeOnTop(executor, net) : net;

  const already = (await pub.readContract({
    address: executor, abi: PAYMENT_EXECUTOR_ABI, functionName: "isRequestProcessed", args: [reqIdBytes],
  })) as boolean;
  if (already) throw new Error("DUPLICATE_REQUEST: this payment was already executed.");

  // Pre-flight: the user must still have enough allowance to the executor.
  const allowance = (await pub.readContract({
    address: input.token, abi: ERC20_APPROVE_ABI, functionName: "allowance", args: [input.from, executor],
  })) as bigint;
  if (allowance < value) {
    throw new Error("WALLET_AUTHORIZATION_UNAVAILABLE: approval was revoked or is insufficient. Re-authorize this automation.");
  }

  const { request } = await pub.simulateContract({
    account, address: executor, abi: PAYMENT_EXECUTOR_ABI, functionName: "executePaymentFrom",
    args: [input.from, input.merchant, input.token, value, Math.max(0, Math.min(100, Math.round(input.riskScore))), hash32(input.decisionMeta), ref32(input.ref), reqIdBytes],
  });
  const txHash = await wallet.writeContract(request);
  const receipt = await pub.waitForTransactionReceipt({ hash: txHash, timeout: 90_000 });
  if (receipt.status !== "success") throw new Error("executePaymentFrom reverted on-chain.");

  const feeWei = receipt.gasUsed * receipt.effectiveGasPrice;
  const { formatEther } = await import("viem");
  const trail = await buildAuditTrail(receipt, executor);
  return {
    txHash, explorerUrl: explorerTx(txHash), gasFee: `${formatEther(feeWei)} MON`,
    blockNumber: Number(receipt.blockNumber), blockTimestamp: trail.blockTimestamp,
    sender: trail.sender, paymentId: trail.event?.paymentId, event: trail.event, feeCollected: trail.feeCollected,
  };
}

/* ── PayAI fee on top (automations) ─────────────────────────────────────── */

const FEE_BPS_ABI = [{ type: "function", name: "feeBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] }] as const;

/** The live fee rate of a PayAI fee contract (PaymentExecutorV2 /
 *  AutomationVaultV2). Fails closed: an unreadable or out-of-range rate
 *  throws — a run never proceeds on a guessed fee. */
export async function contractFeeBps(address: `0x${string}`): Promise<number> {
  let raw: unknown;
  try {
    raw = await getPublicClient().readContract({ address, abi: FEE_BPS_ABI, functionName: "feeBps" });
  } catch {
    throw new Error("FEE_UNAVAILABLE: PayAI's fee rate couldn't be read, so nothing was sent.");
  }
  const bps = Number(raw);
  if (!Number.isInteger(bps) || bps < 0 || bps > MAX_FEE_BPS) throw new Error("FEE_UNAVAILABLE: PayAI's fee rate is out of range, so nothing was sent.");
  return bps;
}

/** What `contract` must be handed so the recipient receives exactly `net`
 *  with PayAI's fee on top (lib/payment/feeOnTop.ts). */
export async function grossWithFeeOnTop(contract: `0x${string}`, net: bigint): Promise<bigint> {
  return grossForNet(net, await contractFeeBps(contract));
}

/* ── Reserved Funds: release from the AutomationVault ────────────────────── */

/**
 * Release `amount` of the funds the user pre-reserved under `automationId` to
 * the recipient they locked in at reserve time. Agent-triggered (pays gas),
 * idempotent by requestId, and bounded on-chain by the reserved balance — the
 * agent can neither exceed the reservation nor redirect it.
 */
export async function releaseFromVault(
  input: {
    automationId: string; amount: number; tokenDecimals: number; requestId: string; vaultAddress?: string | null;
    /** The recipient receives `amount` in full; the vault's fee comes out of
     *  the reservation on top (automations created with the fee on top). */
    feeOnTop?: boolean;
  },
): Promise<ExecuteResult> {
  // Use the exact vault this automation reserved into — see ExecuteInput's
  // executorAddress doc comment for why: a later AutomationVault redeploy
  // must not orphan an existing reservation's release/refund path.
  const vault = (input.vaultAddress as `0x${string}` | undefined) ?? getAutomationVault();
  const account = getAgentAccount();
  if (!vault) throw new Error("AutomationVault not configured (MONAD_MAINNET_AUTOMATION_VAULT).");
  if (!account) throw new Error("No Monad signer configured.");
  if (!input.requestId) throw new Error("requestId is required for idempotent execution.");

  const pub = getPublicClient();
  const wallet = getWalletClient();
  const autoIdBytes = requestId32(input.automationId);
  const reqIdBytes = requestId32(input.requestId);
  const net = toBaseUnits(input.amount, input.tokenDecimals);
  const value = input.feeOnTop ? await grossWithFeeOnTop(vault, net) : net;

  const already = (await pub.readContract({
    address: vault, abi: AUTOMATION_VAULT_ABI, functionName: "isReleaseProcessed", args: [reqIdBytes],
  })) as boolean;
  if (already) throw new Error("DUPLICATE_REQUEST: this release was already processed.");

  const reserved = (await pub.readContract({
    address: vault, abi: AUTOMATION_VAULT_ABI, functionName: "reservedBalance", args: [autoIdBytes],
  })) as bigint;
  if (reserved < value) throw new Error(input.feeOnTop && reserved >= net
    ? "INSUFFICIENT_RESERVED_FUNDS: the reserved balance covers this payment but not PayAI's fee on top."
    : "INSUFFICIENT_RESERVED_FUNDS: reserved balance is below this payment.");

  const { request } = await pub.simulateContract({
    account, address: vault, abi: AUTOMATION_VAULT_ABI, functionName: "release",
    args: [autoIdBytes, value, reqIdBytes],
  });
  const txHash = await wallet.writeContract(request);
  const receipt = await pub.waitForTransactionReceipt({ hash: txHash, timeout: 90_000 });
  if (receipt.status !== "success") throw new Error("vault.release reverted on-chain.");

  const feeWei = receipt.gasUsed * receipt.effectiveGasPrice;
  const { formatEther } = await import("viem");
  const block = await pub.getBlock({ blockNumber: receipt.blockNumber });
  return {
    txHash, explorerUrl: explorerTx(txHash), gasFee: `${formatEther(feeWei)} MON`,
    blockNumber: Number(receipt.blockNumber), blockTimestamp: Number(block.timestamp) * 1000,
    sender: account.address,
  };
}

/* ── Reads (dashboard / analytics / API) ────────────────────────────────── */

export interface OnchainStats {
  payments: number; volume: number; approved: number; rejected: number; requests: number;
}

export async function getOnchainStats(): Promise<OnchainStats | null> {
  const executor = getPaymentExecutor();
  if (!executor) return null;
  const pub = getPublicClient();
  const s = (await pub.readContract({ address: executor, abi: PAYMENT_EXECUTOR_ABI, functionName: "stats" })) as readonly [bigint, bigint, bigint, bigint, bigint];
  return {
    payments: Number(s[0]),
    // totalVolume accrues the raw `amount` of every payment. Native-MON
    // payments (executePaymentNative) dominate and are denominated in 18-dp
    // wei, so this figure is MON-denominated — dividing by the stablecoin's
    // 6 decimals produced a nonsensical quadrillion. (A USDC direct payment's
    // 6-dp base units are negligible against MON wei, so this stays accurate.)
    volume: Number(s[1]) / 1e18,
    approved: Number(s[2]),
    rejected: Number(s[3]),
    requests: Number(s[4]),
  };
}

export interface OnchainPayment {
  id: number; agent: string; merchant: string; token: string;
  amount: number; riskScore: number; compliance: number; timestamp: number;
  explorerUrlRef?: string;
}

/** Recent on-chain payments (newest first, capped). */
export async function getOnchainPayments(limit = 20): Promise<OnchainPayment[]> {
  const executor = getPaymentExecutor();
  if (!executor) return [];
  const pub = getPublicClient();
  const token = getStablecoin();
  const count = Number(await pub.readContract({ address: executor, abi: PAYMENT_EXECUTOR_ABI, functionName: "paymentsCount" }));
  const start = Math.max(0, count - limit);
  const ids = Array.from({ length: count - start }, (_, i) => start + i);
  const rows = await Promise.all(
    ids.map(async (id) => {
      const p = (await pub.readContract({ address: executor, abi: PAYMENT_EXECUTOR_ABI, functionName: "getPayment", args: [BigInt(id)] })) as {
        agent: string; merchant: string; token: string; amount: bigint; riskScore: number; compliance: number; timestamp: bigint;
      };
      // Native MON (token = zero address) is 18-dp wei; the stablecoin is its
      // own decimals. Using the stablecoin's decimals for a MON payment
      // under-scaled it by 1e12 — decimals must follow the token.
      const isNative = /^0x0+$/.test(p.token);
      return {
        id, agent: p.agent, merchant: p.merchant, token: p.token,
        amount: Number(p.amount) / 10 ** (isNative ? 18 : token.decimals),
        riskScore: Number(p.riskScore), compliance: Number(p.compliance),
        timestamp: Number(p.timestamp),
      };
    }),
  );
  return rows.reverse();
}

export interface OnchainMerchant {
  wallet: string; name: string; active: boolean; volume: number; paymentCount: number; registeredAt: number;
}

export async function getOnchainMerchants(): Promise<OnchainMerchant[]> {
  const registry = getMerchantRegistry();
  if (!registry) return [];
  const pub = getPublicClient();
  const token = getStablecoin();
  const addrs = (await pub.readContract({ address: registry, abi: MERCHANT_REGISTRY_ABI, functionName: "allMerchants" })) as readonly `0x${string}`[];
  return Promise.all(
    addrs.map(async (w) => {
      const m = (await pub.readContract({ address: registry, abi: MERCHANT_REGISTRY_ABI, functionName: "getMerchant", args: [w] })) as {
        wallet: string; name: string; active: boolean; volume: bigint; paymentCount: bigint; registeredAt: bigint;
      };
      return {
        wallet: m.wallet, name: m.name, active: m.active,
        volume: Number(m.volume) / 10 ** token.decimals,
        paymentCount: Number(m.paymentCount), registeredAt: Number(m.registeredAt),
      };
    }),
  );
}

/* ── Payment requests (invoices) ────────────────────────────────────────── */

export interface OnchainRequest {
  id: number; merchant: string; amount: number; paid: boolean; paymentId: number; createdAt: number;
}

export async function getOnchainRequests(): Promise<OnchainRequest[]> {
  const executor = getPaymentExecutor();
  if (!executor) return [];
  const pub = getPublicClient();
  const token = getStablecoin();
  const count = Number(await pub.readContract({ address: executor, abi: PAYMENT_EXECUTOR_ABI, functionName: "requestsCount" }));
  const ids = Array.from({ length: count }, (_, i) => i);
  const rows = await Promise.all(
    ids.map(async (id) => {
      const r = (await pub.readContract({ address: executor, abi: PAYMENT_EXECUTOR_ABI, functionName: "getRequest", args: [BigInt(id)] })) as {
        merchant: string; amount: bigint; paid: boolean; paymentId: bigint; createdAt: bigint;
      };
      return {
        id, merchant: r.merchant, amount: Number(r.amount) / 10 ** token.decimals,
        paid: r.paid, paymentId: Number(r.paymentId), createdAt: Number(r.createdAt),
      };
    }),
  );
  return rows.reverse();
}

/** Create an on-chain payment request (invoice). */
export async function createPaymentRequest(merchant: `0x${string}`, amount: number, ref?: string | null): Promise<{ txHash: Hash; explorerUrl: string }> {
  const executor = getPaymentExecutor();
  const account = getAgentAccount();
  if (!executor) throw new Error("PaymentExecutor not configured.");
  if (!account) throw new Error("No Monad signer configured.");
  const token = getStablecoin();
  const pub = getPublicClient();
  const wallet = getWalletClient();
  const value = toBaseUnits(amount, token.decimals);
  const { request } = await pub.simulateContract({
    account, address: executor, abi: PAYMENT_EXECUTOR_ABI, functionName: "createPaymentRequest",
    args: [merchant, token.address, value, ref32(ref)],
  });
  const txHash = await wallet.writeContract(request);
  await pub.waitForTransactionReceipt({ hash: txHash, timeout: 90_000 });
  return { txHash, explorerUrl: explorerTx(txHash) };
}

/** Pay an existing on-chain payment request (auto-approves the token if needed). */
export async function payRequest(requestId: number, riskScore: number, decisionMeta: string | null | undefined, idempotencyRequestId: string): Promise<{ txHash: Hash; explorerUrl: string; gasFee: string }> {
  const executor = getPaymentExecutor();
  const account = getAgentAccount();
  if (!executor) throw new Error("PaymentExecutor not configured.");
  if (!account) throw new Error("No Monad signer configured.");
  const token = getStablecoin();
  const pub = getPublicClient();
  const wallet = getWalletClient();

  // Ensure allowance covers the request amount.
  const r = (await pub.readContract({ address: executor, abi: PAYMENT_EXECUTOR_ABI, functionName: "getRequest", args: [BigInt(requestId)] })) as { amount: bigint };
  const allowance = (await pub.readContract({ address: token.address, abi: ERC20_APPROVE_ABI, functionName: "allowance", args: [account.address, executor] })) as bigint;
  if (allowance < r.amount) {
    const approveHash = await wallet.writeContract({
      address: token.address, abi: ERC20_APPROVE_ABI, functionName: "approve",
      args: [executor, r.amount], account, chain: getPublicClient().chain,
    });
    await pub.waitForTransactionReceipt({ hash: approveHash, timeout: 90_000 });
  }

  const { request } = await pub.simulateContract({
    account, address: executor, abi: PAYMENT_EXECUTOR_ABI, functionName: "payRequest",
    args: [BigInt(requestId), Math.max(0, Math.min(100, Math.round(riskScore))), hash32(decisionMeta), requestId32(idempotencyRequestId)],
  });
  const txHash = await wallet.writeContract(request);
  const receipt = await pub.waitForTransactionReceipt({ hash: txHash, timeout: 90_000 });
  if (receipt.status !== "success") throw new Error("payRequest reverted on-chain.");
  const { formatEther } = await import("viem");
  return { txHash, explorerUrl: explorerTx(txHash), gasFee: `${formatEther(receipt.gasUsed * receipt.effectiveGasPrice)} MON` };
}

/** Register a merchant on-chain (agent/owner only). */
export async function registerMerchant(wallet: `0x${string}`, name: string): Promise<{ txHash: Hash; explorerUrl: string }> {
  const registry = getMerchantRegistry();
  const account = getAgentAccount();
  if (!registry) throw new Error("MerchantRegistry not configured.");
  if (!account) throw new Error("No Monad signer configured.");
  const pub = getPublicClient();
  const wallet_ = getWalletClient();
  const { request } = await pub.simulateContract({
    account, address: registry, abi: MERCHANT_REGISTRY_ABI, functionName: "registerMerchant", args: [wallet, name],
  });
  const txHash = await wallet_.writeContract(request);
  await pub.waitForTransactionReceipt({ hash: txHash, timeout: 90_000 });
  return { txHash, explorerUrl: explorerTx(txHash) };
}

/**
 * Refund a Reserved Funds reservation back to the wallet that deposited it.
 *
 * Agent-triggered, and safe to be: AutomationVault.refund() authorizes
 * `msg.sender == r.depositor || isAgent[msg.sender]`, but ALWAYS pays out to
 * `r.depositor`. The agent can therefore return a user's money but can never
 * redirect it anywhere — the destination is fixed on-chain, not passed in.
 *
 * Never throws (every caller is a cleanup path attached to something more
 * important: cancelling an automation must still succeed even if the refund
 * leg fails, or the user would be unable to cancel at all). A failed refund
 * leaves the reservation intact and retryable, so nothing is lost.
 *
 * The three-way return (rather than a plain T | null) exists specifically so
 * callers can tell "nothing was ever owed back" apart from "something IS
 * owed back and this attempt didn't land" — collapsing both into null was
 * exactly the ambiguity that let a stuck reservation look identical to a
 * fully-settled one in lib/platform/schedules.ts's persisted row (see
 * PaymentAutomation.reserveRefundStatus in lib/platform/types.ts).
 */
export async function refundReservationViaAgent(
  automationId: string,
  vaultAddress?: string | null,
): Promise<
  | { outcome: "refunded"; txHash: Hash; explorerUrl: string; amountRaw: bigint }
  | { outcome: "none" }
  | { outcome: "failed" }
> {
  // Same per-automation vault override as releaseFromVault.
  const vault = (vaultAddress as `0x${string}` | undefined) ?? getAutomationVault();
  const account = getAgentAccount();
  if (!vault || !account) return { outcome: "failed" }; // can't even check — not "none"

  const pub = getPublicClient();
  const autoIdBytes = requestId32(automationId);

  try {
    // Nothing reserved (never funded, already refunded, or fully released) —
    // refund() would revert with "nothing to refund", so skip quietly. This
    // also makes the whole operation naturally idempotent.
    const reserved = (await pub.readContract({
      address: vault, abi: AUTOMATION_VAULT_ABI, functionName: "reservedBalance", args: [autoIdBytes],
    })) as bigint;
    if (reserved === 0n) return { outcome: "none" };

    const { request } = await pub.simulateContract({
      account, address: vault, abi: AUTOMATION_VAULT_ABI, functionName: "refund", args: [autoIdBytes],
    });
    const wallet = getWalletClient();
    const txHash = await wallet.writeContract(request);
    const receipt = await pub.waitForTransactionReceipt({ hash: txHash, timeout: 90_000 });
    if (receipt.status !== "success") return { outcome: "failed" };
    return { outcome: "refunded", txHash, explorerUrl: explorerTx(txHash), amountRaw: reserved };
  } catch {
    // Reservation stays intact and can be refunded again later.
    return { outcome: "failed" };
  }
}
