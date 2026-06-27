/**
 * VeriPayRegistry client — anchors compliance-approved payments on-chain.
 *
 * After a USDC transfer settles, the executor calls recordPayment() so the
 * payment (payer, recipient, amount, risk score, purpose hash) is written to the
 * VeriPayRegistry contract as an immutable audit record. Anchoring is optional:
 * if MONAD_REGISTRY_ADDRESS is unset, this is a no-op and execution is unaffected.
 *
 * Server-only.
 */
import "server-only";
import { keccak256, stringToHex, toHex, type Hash } from "viem";
import { explorerTx, getRegistryAddress } from "./config";
import { getAgentAccount, getPublicClient, getWalletClient } from "./wallet";

/** Minimal ABI for the registry write we use. */
export const REGISTRY_ABI = [
  {
    type: "function",
    name: "recordPayment",
    stateMutability: "nonpayable",
    inputs: [
      { name: "recipient", type: "address" },
      { name: "token", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "riskScore", type: "uint16" },
      { name: "purposeHash", type: "bytes32" },
      { name: "ref", type: "bytes32" },
    ],
    outputs: [{ name: "id", type: "uint256" }],
  },
  {
    type: "function",
    name: "paymentsCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export interface AnchorInput {
  recipient: `0x${string}`;
  token: `0x${string}`;
  amount: bigint;
  riskScore: number;
  purpose?: string | null;
  ref?: string | null;
}

export interface AnchorResult {
  txHash: Hash;
  explorerUrl: string;
}

export function registryEnabled(): boolean {
  return getRegistryAddress() !== null;
}

/** keccak256 of a string, or the zero hash when empty. */
function hash32(s?: string | null): `0x${string}` {
  if (!s) return `0x${"0".repeat(64)}`;
  return keccak256(stringToHex(s));
}

/** A bytes32 reference from an off-chain id (truncated/padded). */
function ref32(s?: string | null): `0x${string}` {
  if (!s) return `0x${"0".repeat(64)}`;
  const hex = toHex(s).slice(2).slice(0, 64).padEnd(64, "0");
  return `0x${hex}`;
}

/**
 * Anchor a settled payment to the VeriPayRegistry. Best-effort: never throws —
 * a failed anchor must not undo a settled transfer. Returns null when disabled
 * or on failure (the reason is surfaced by the caller's trace if needed).
 */
export async function anchorPayment(input: AnchorInput): Promise<AnchorResult | null> {
  const registry = getRegistryAddress();
  const account = getAgentAccount();
  if (!registry || !account) return null;

  try {
    const wallet = getWalletClient();
    const client = getPublicClient();
    const { request } = await client.simulateContract({
      account,
      address: registry,
      abi: REGISTRY_ABI,
      functionName: "recordPayment",
      args: [
        input.recipient,
        input.token,
        input.amount,
        Math.max(0, Math.min(100, Math.round(input.riskScore))),
        hash32(input.purpose),
        ref32(input.ref),
      ],
    });
    const txHash = await wallet.writeContract(request);
    await client.waitForTransactionReceipt({ hash: txHash, timeout: 90_000 });
    return { txHash, explorerUrl: explorerTx(txHash) };
  } catch {
    return null; // audit anchor is best-effort; settlement already happened
  }
}
