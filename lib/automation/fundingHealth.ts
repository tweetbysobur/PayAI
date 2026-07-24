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
  const needed = s.amount;
  const neededUnits = BigInt(Math.round(needed * 10 ** decimals));

  if (s.fundingMode === "reserved") {
    const { getAutomationVault } = await import("@/lib/monad/config");
    const vault = getAutomationVault();
    if (!vault) return null;
    const { getPublicClient } = await import("@/lib/monad/wallet");
    const { requestId32 } = await import("@/lib/monad/contracts");
    const { AUTOMATION_VAULT_ABI } = await import("@/lib/monad/abi");
    const reserved = (await getPublicClient().readContract({
      address: vault, abi: AUTOMATION_VAULT_ABI, functionName: "reservedBalance", args: [requestId32(s.id)],
    })) as bigint;
    return { sufficient: reserved >= neededUnits, available: Number(reserved) / 10 ** decimals, needed };
  }

  if (s.fundingMode === "wallet" && s.sender) {
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
