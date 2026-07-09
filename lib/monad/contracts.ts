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
}

/** Build the full audit trail (block timestamp + decoded event) from a settled receipt. */
async function buildAuditTrail(
  receipt: Awaited<ReturnType<ReturnType<typeof getPublicClient>["waitForTransactionReceipt"]>>,
): Promise<{ blockTimestamp: number; sender: string; event?: ExecuteResult["event"] }> {
  const pub = getPublicClient();
  const block = await pub.getBlock({ blockNumber: receipt.blockNumber });

  let event: ExecuteResult["event"] | undefined;
  for (const log of receipt.logs) {
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

  return { blockTimestamp: Number(block.timestamp) * 1000, sender: receipt.from, event };
}

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
  const executor = getPaymentExecutor();
  const account = getAgentAccount();
  if (!executor) throw new Error("PaymentExecutor not configured (MONAD_MAINNET_PAYMENT_EXECUTOR).");
  if (!account) throw new Error("No Monad signer configured.");
  if (!input.requestId) throw new Error("requestId is required for idempotent execution.");

  const token = getStablecoin();
  const pub = getPublicClient();
  const wallet = getWalletClient();
  const value = BigInt(Math.round(input.amount * 10 ** token.decimals));
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
  const trail = await buildAuditTrail(receipt);
  return {
    txHash,
    explorerUrl: explorerTx(txHash),
    gasFee: `${formatEther(feeWei)} MON`,
    blockNumber: Number(receipt.blockNumber),
    blockTimestamp: trail.blockTimestamp,
    sender: trail.sender,
    paymentId: trail.event?.paymentId,
    event: trail.event,
  };
}

/** Native-MON counterpart of executeViaExecutor — same idempotency/limit guarantees. */
export async function executeNativeViaExecutor(input: Omit<ExecuteInput, "amount"> & { amountWei: bigint }): Promise<ExecuteResult> {
  const executor = getPaymentExecutor();
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
  const trail = await buildAuditTrail(receipt);
  return {
    txHash,
    explorerUrl: explorerTx(txHash),
    gasFee: `${formatEther(feeWei)} MON`,
    blockNumber: Number(receipt.blockNumber),
    blockTimestamp: trail.blockTimestamp,
    sender: trail.sender,
    paymentId: trail.event?.paymentId,
    event: trail.event,
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
  input: ExecuteInput & { from: `0x${string}`; token: `0x${string}` },
): Promise<ExecuteResult> {
  const executor = getPaymentExecutor();
  const account = getAgentAccount();
  if (!executor) throw new Error("PaymentExecutor not configured (MONAD_MAINNET_PAYMENT_EXECUTOR).");
  if (!account) throw new Error("No Monad signer configured.");
  if (!input.requestId) throw new Error("requestId is required for idempotent execution.");

  const pub = getPublicClient();
  const wallet = getWalletClient();
  const reqIdBytes = requestId32(input.requestId);
  const value = BigInt(Math.round(input.amount * 10 ** getStablecoin().decimals));

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
  const trail = await buildAuditTrail(receipt);
  return {
    txHash, explorerUrl: explorerTx(txHash), gasFee: `${formatEther(feeWei)} MON`,
    blockNumber: Number(receipt.blockNumber), blockTimestamp: trail.blockTimestamp,
    sender: trail.sender, paymentId: trail.event?.paymentId, event: trail.event,
  };
}

/* ── Reserved Funds: release from the AutomationVault ────────────────────── */

/**
 * Release `amount` of the funds the user pre-reserved under `automationId` to
 * the recipient they locked in at reserve time. Agent-triggered (pays gas),
 * idempotent by requestId, and bounded on-chain by the reserved balance — the
 * agent can neither exceed the reservation nor redirect it.
 */
export async function releaseFromVault(
  input: { automationId: string; amount: number; tokenDecimals: number; requestId: string },
): Promise<ExecuteResult> {
  const vault = getAutomationVault();
  const account = getAgentAccount();
  if (!vault) throw new Error("AutomationVault not configured (MONAD_MAINNET_AUTOMATION_VAULT).");
  if (!account) throw new Error("No Monad signer configured.");
  if (!input.requestId) throw new Error("requestId is required for idempotent execution.");

  const pub = getPublicClient();
  const wallet = getWalletClient();
  const autoIdBytes = requestId32(input.automationId);
  const reqIdBytes = requestId32(input.requestId);
  const value = BigInt(Math.round(input.amount * 10 ** input.tokenDecimals));

  const already = (await pub.readContract({
    address: vault, abi: AUTOMATION_VAULT_ABI, functionName: "isReleaseProcessed", args: [reqIdBytes],
  })) as boolean;
  if (already) throw new Error("DUPLICATE_REQUEST: this release was already processed.");

  const reserved = (await pub.readContract({
    address: vault, abi: AUTOMATION_VAULT_ABI, functionName: "reservedBalance", args: [autoIdBytes],
  })) as bigint;
  if (reserved < value) throw new Error("INSUFFICIENT_RESERVED_FUNDS: reserved balance is below this payment.");

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
  const token = getStablecoin();
  const s = (await pub.readContract({ address: executor, abi: PAYMENT_EXECUTOR_ABI, functionName: "stats" })) as readonly [bigint, bigint, bigint, bigint, bigint];
  return {
    payments: Number(s[0]),
    volume: Number(s[1]) / 10 ** token.decimals,
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
      return {
        id, agent: p.agent, merchant: p.merchant, token: p.token,
        amount: Number(p.amount) / 10 ** token.decimals,
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
  const value = BigInt(Math.round(amount * 10 ** token.decimals));
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
