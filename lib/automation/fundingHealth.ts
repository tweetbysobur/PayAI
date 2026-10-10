/**
 * Real, on-chain funding-health checks for an automation's NEXT payment —
 * Wallet Automation reads the funding wallet's live balance; Reserved Funds
 * reads the AutomationVault's actual reservedBalance. No estimate, no cache
 * — every call is a live read against the same contracts execution itself
 * settles against.
 *
 * Server-only.
 */
import "server-only";
import type { ScheduledPayment } from "@/lib/platform/types";
import { toBaseUnits } from "@/lib/monad/verify";

const NATIVE_TOKEN_ADDRESS = "0x0000000000000000000000000000000000000000";

const ERC20_BALANCE_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

export interface FundingHealth {
  sufficient: boolean;
  available: number;
  needed: number;
}

/**
 * Null means "not checkable" (legacy agent-funded automation, or the
 * relevant contract isn't configured) — never a false "sufficient".
 */
export async function checkFundingHealth(s: ScheduledPayment): Promise<FundingHealth | null> {
  const decimals = s.tokenDecimals ?? 18;
  const netUnits = toBaseUnits(s.amount, decimals);
  // With PayAI's fee on top, the next run needs the payment PLUS the fee —
  // read from the exact contract that run will call.
  const withFee = async (contract: `0x${string}` | null | undefined): Promise<bigint> => {
    if (!s.feeOnTop || !contract) return netUnits;
    const { grossWithFeeOnTop } = await import("@/lib/monad/contracts");
    return grossWithFeeOnTop(contract, netUnits);
  };

  if (s.fundingMode === "reserved") {
    // A reservation is only ever released/refunded against the vault it was
    // actually deposited into (see lib/platform/schedules.ts,
    // lib/automation/execute.ts). If the global vault config has since been
    // rotated, the CURRENT vault has nothing to do with this reservation --
    // its health must be read from the pinned vaultAddress, falling back to
    // the current config only for older rows that predate per-row pinning.
    const { getAutomationVault } = await import("@/lib/monad/config");
    const vault = (s.vaultAddress as `0x${string}` | undefined) ?? getAutomationVault();
    if (!vault) return null;
    const neededUnits = await withFee(vault);
    const needed = Number(neededUnits) / 10 ** decimals;
    const { getPublicClient } = await import("@/lib/monad/wallet");
    const { requestId32 } = await import("@/lib/monad/contracts");
    const { AUTOMATION_VAULT_ABI } = await import("@/lib/monad/abi");
    const reserved = (await getPublicClient().readContract({
      address: vault, abi: AUTOMATION_VAULT_ABI, functionName: "reservedBalance", args: [requestId32(s.id)],
    })) as bigint;
    return { sufficient: reserved >= neededUnits, available: Number(reserved) / 10 ** decimals, needed };
  }

  if (s.fundingMode === "wallet" && s.sender) {
    const { getPaymentExecutor } = await import("@/lib/monad/config");
    const neededUnits = await withFee((s.executorAddress as `0x${string}` | null | undefined) ?? getPaymentExecutor());
    const needed = Number(neededUnits) / 10 ** decimals;
    const { getPublicClient } = await import("@/lib/monad/wallet");
    const pub = getPublicClient();
    const tokenAddress = s.tokenAddress ?? NATIVE_TOKEN_ADDRESS;
    const isNative = tokenAddress.toLowerCase() === NATIVE_TOKEN_ADDRESS;
    const balance = isNative
      ? await pub.getBalance({ address: s.sender as `0x${string}` })
      : ((await pub.readContract({
          address: tokenAddress as `0x${string}`, abi: ERC20_BALANCE_ABI, functionName: "balanceOf", args: [s.sender as `0x${string}`],
        })) as bigint);
    return { sufficient: balance >= neededUnits, available: Number(balance) / 10 ** decimals, needed };
  }

  return null;
}
