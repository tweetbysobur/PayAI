/**
 * Monad payment executor — the real on-chain execution layer.
 *
 * Replaces mocked settlement with actual USDC (ERC-20) transfers on Monad:
 *   estimateGas()      — dry-run fee estimate before spending anything.
 *   executeTransfer()  — build → sign → broadcast → wait for receipt.
 *
 * Designed for production use: typed throughout, retry on transient RPC faults,
 * and human-readable error mapping. The agent's wallet signs (see ./wallet).
 *
 * Server-only.
 */
import "server-only";
import { formatEther, parseEther, parseUnits, type Hash } from "viem";
import { explorerTx, getChain, getStablecoin } from "./config";
import { getAgentAccount, getPublicClient, getWalletClient } from "./wallet";
import { toParseableAmount } from "./verify";

/** Minimal ERC-20 ABI — transfer + reads we need. */
export const ERC20_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export interface TransferInput {
  to: `0x${string}`;
  amount: number;
  /** Override the token this transfer settles in; defaults to the configured stablecoin when absent (legacy behavior). */
  tokenAddress?: `0x${string}`;
  tokenDecimals?: number;
  tokenSymbol?: string;
}

export interface GasEstimate {
  gasLimit: string;
  gasPriceWei: string;
  feeWei: string;
  /** Human-readable native fee, e.g. "0.00042". */
  feeMon: string;
  symbol: string;
}

export interface MonadTxResult {
  status: "settled" | "failed";
  txHash: Hash;
  explorerUrl: string;
  gasFee: string; // e.g. "0.00042 MON"
  blockNumber?: number;
  amount: number;
  token: string;
  recipient: string;
  network: string;
}

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/** Retry a transient operation with exponential backoff. */
async function withRetry<T>(
  fn: () => Promise<T>,
  { attempts = 3, baseDelayMs = 400 } = {},
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isTransient(e) || i === attempts - 1) break;
      await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** i));
    }
  }
  throw lastErr;
}

function isTransient(e: unknown): boolean {
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return (
    m.includes("timeout") ||
    m.includes("network") ||
    m.includes("fetch failed") ||
    m.includes("econn") ||
    m.includes("rate limit") ||
    m.includes("503") ||
    m.includes("502")
  );
}

/** Map raw RPC/chain errors to clear, actionable messages. */
export function explainError(e: unknown): string {
  const raw = (e instanceof Error ? e.message : String(e)).toLowerCase();
  if (raw.includes("insufficient funds") || raw.includes("gas required exceeds"))
    return "Agent wallet has insufficient MON for gas. Fund it from the Monad faucet.";
  if (raw.includes("transfer amount exceeds balance") || raw.includes("erc20"))
    return "Insufficient USDC balance in the agent wallet for this transfer.";
  if (raw.includes("revert")) return "Transfer reverted on-chain.";
  if (raw.includes("no monad signer"))
    return "No Monad signer configured (set MONAD_AGENT_PRIVATE_KEY).";
  return e instanceof Error ? e.message : "Monad execution failed.";
}

/** Estimate the gas fee for a USDC transfer without sending it. */
export async function estimateGas(input: TransferInput): Promise<GasEstimate> {
  const account = getAgentAccount();
  if (!account) throw new Error("No Monad signer configured.");
  if (!ADDR_RE.test(input.to)) throw new Error(`Invalid recipient address: ${input.to}`);

  const token = input.tokenAddress ? { address: input.tokenAddress, decimals: input.tokenDecimals ?? 18 } : getStablecoin();
  const chain = getChain();
  const client = getPublicClient();
  // toParseableAmount, not .toString() — a sub-1-unit amount below the
  // token's own precision floor stringifies to exponential notation, which
  // parseUnits rejects outright.
  const value = parseUnits(toParseableAmount(input.amount, token.decimals), token.decimals);

  const [gasLimit, gasPriceWei] = await withRetry(() =>
    Promise.all([
      client.estimateContractGas({
        account,
        address: token.address,
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [input.to, value],
      }),
      client.getGasPrice(),
    ]),
  );

  const feeWei = gasLimit * gasPriceWei;
  return {
    gasLimit: gasLimit.toString(),
    gasPriceWei: gasPriceWei.toString(),
    feeWei: feeWei.toString(),
    feeMon: formatEther(feeWei),
    symbol: chain.nativeCurrency.symbol,
  };
}

/**
 * Execute a USDC transfer on Monad: build the ERC-20 transfer, sign with the
 * agent wallet, broadcast, and wait for the receipt. Returns the tx hash,
 * explorer URL, and actual gas fee. Throws an explained error on failure.
 */
export async function executeTransfer(input: TransferInput): Promise<MonadTxResult> {
  if (!ADDR_RE.test(input.to)) throw new Error(`Invalid recipient address: ${input.to}`);

  const token = input.tokenAddress ? { address: input.tokenAddress, decimals: input.tokenDecimals ?? 18, symbol: input.tokenSymbol ?? "TOKEN" } : getStablecoin();
  const chain = getChain();
  const account = getAgentAccount();
  if (!account) throw new Error("No Monad signer configured.");

  const wallet = getWalletClient();
  const client = getPublicClient();
  // toParseableAmount, not .toString() — a sub-1-unit amount below the
  // token's own precision floor stringifies to exponential notation, which
  // parseUnits rejects outright.
  const value = parseUnits(toParseableAmount(input.amount, token.decimals), token.decimals);

  try {
    // Simulate first so a doomed transfer fails before broadcasting (no gas spent).
    const { request } = await withRetry(() =>
      client.simulateContract({
        account,
        address: token.address,
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [input.to, value],
      }),
    );

    const txHash = await wallet.writeContract(request);

    // Broadcast succeeded; wait for inclusion (retry only the read, not the send).
    const receipt = await withRetry(() =>
      client.waitForTransactionReceipt({ hash: txHash, timeout: 90_000 }),
    );

    const feeWei = receipt.gasUsed * receipt.effectiveGasPrice;
    const gasFee = `${formatEther(feeWei)} ${chain.nativeCurrency.symbol}`;

    return {
      status: receipt.status === "success" ? "settled" : "failed",
      txHash,
      explorerUrl: explorerTx(txHash),
      gasFee,
      blockNumber: Number(receipt.blockNumber),
      amount: input.amount,
      token: token.symbol,
      recipient: input.to,
      network: chain.name,
    };
  } catch (e) {
    throw new Error(explainError(e));
  }
}

/** Estimate the gas fee for a native MON transfer without sending it. */
export async function estimateNativeGas(input: { to: `0x${string}`; amount: number }): Promise<GasEstimate> {
  const account = getAgentAccount();
  if (!account) throw new Error("No Monad signer configured.");
  if (!ADDR_RE.test(input.to)) throw new Error(`Invalid recipient address: ${input.to}`);

  const chain = getChain();
  const client = getPublicClient();
  // toParseableAmount, not .toString() — see the parseUnits call above.
  const value = parseEther(toParseableAmount(input.amount, 18));

  const [gasLimit, gasPriceWei] = await withRetry(() =>
    Promise.all([
      client.estimateGas({ account, to: input.to, value }),
      client.getGasPrice(),
    ]),
  );

  const feeWei = gasLimit * gasPriceWei;
  return {
    gasLimit: gasLimit.toString(),
    gasPriceWei: gasPriceWei.toString(),
    feeWei: feeWei.toString(),
    feeMon: formatEther(feeWei),
    symbol: chain.nativeCurrency.symbol,
  };
}

/**
 * Execute a native MON transfer: build, sign with the agent wallet, broadcast,
 * and wait for the receipt. Mirrors executeTransfer's USDC flow exactly so MON
 * payments go through the same gas-estimate → simulate-first → retry shape.
 */
export async function executeNativeTransfer(input: { to: `0x${string}`; amount: number }): Promise<MonadTxResult> {
  if (!ADDR_RE.test(input.to)) throw new Error(`Invalid recipient address: ${input.to}`);

  const chain = getChain();
  const account = getAgentAccount();
  if (!account) throw new Error("No Monad signer configured.");

  const wallet = getWalletClient();
  const client = getPublicClient();
  // toParseableAmount, not .toString() — see the parseUnits call above.
  const value = parseEther(toParseableAmount(input.amount, 18));

  try {
    // Not retried: a transient failure here might mean the broadcast actually
    // went through and only the response was lost — blindly retrying could
    // double-send. This fallback path has no on-chain idempotency guard (that
    // only exists via PaymentExecutor), so an ambiguous failure must surface
    // as such rather than risk a second transfer. Only the receipt wait retries.
    const txHash = await wallet.sendTransaction({ account, chain, to: input.to, value });
    const receipt = await withRetry(() => client.waitForTransactionReceipt({ hash: txHash, timeout: 90_000 }));

    const feeWei = receipt.gasUsed * receipt.effectiveGasPrice;
    const gasFee = `${formatEther(feeWei)} ${chain.nativeCurrency.symbol}`;

    return {
      status: receipt.status === "success" ? "settled" : "failed",
      txHash,
      explorerUrl: explorerTx(txHash),
      gasFee,
      blockNumber: Number(receipt.blockNumber),
      amount: input.amount,
      token: chain.nativeCurrency.symbol,
      recipient: input.to,
      network: chain.name,
    };
  } catch (e) {
    throw new Error(explainError(e));
  }
}
