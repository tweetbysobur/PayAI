/**
 * Server-side real-balance reads for any address — used to pre-validate a
 * payment (does the sender actually have enough MON/USDC) before building an
 * unsigned tx or spending the agent wallet's gas, and to answer "show my
 * wallet balance" queries. Read-only, no signer required.
 *
 * Server-only.
 */
import "server-only";
import { formatEther } from "viem";
import { getPublicClient } from "./wallet";
import { getStablecoin } from "./config";

const ERC20_BALANCE_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "o", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

export interface WalletBalance {
  mon: number;
  usdc: number;
}

/** Real on-chain MON + USDC balance for any address. Never fabricated; throws on RPC failure. */
export async function getWalletBalance(address: `0x${string}`): Promise<WalletBalance> {
  const pub = getPublicClient();
  const usdcToken = getStablecoin();
  const [monRaw, usdcRaw] = await Promise.all([
    pub.getBalance({ address }),
    usdcToken.address !== "0x0000000000000000000000000000000000000000"
      ? (pub.readContract({ address: usdcToken.address, abi: ERC20_BALANCE_ABI, functionName: "balanceOf", args: [address] }) as Promise<bigint>)
      : Promise.resolve(0n),
  ]);
  return {
    mon: Number(formatEther(monRaw)),
    usdc: Number(usdcRaw) / 10 ** usdcToken.decimals,
  };
}

/**
 * Checks whether `address` can cover `amount` of `token`, leaving a small MON
 * reserve for gas when the token itself is MON. Returns null when sufficient,
 * or a user-facing reason string when not.
 */
export async function insufficientBalanceReason(
  address: `0x${string}`,
  token: string,
  amount: number,
): Promise<string | null> {
  const GAS_RESERVE_MON = 0.01;
  try {
    const balance = await getWalletBalance(address);
    if (token === "MON") {
      const needed = amount + GAS_RESERVE_MON;
      if (balance.mon < needed) {
        return `Insufficient MON balance. You have ${balance.mon.toFixed(4)} MON but need ${amount} plus ~${GAS_RESERVE_MON} for gas.`;
      }
    } else if (token === "USDC") {
      if (balance.usdc < amount) {
        return `Insufficient USDC balance. You have ${balance.usdc.toFixed(2)} USDC but need ${amount}.`;
      }
      if (balance.mon < GAS_RESERVE_MON) {
        return `Insufficient MON for gas. You need a small amount of MON (~${GAS_RESERVE_MON}) to pay network fees.`;
      }
    }
    return null;
  } catch {
    // Can't verify — don't block the payment on an RPC hiccup; the wallet
    // and on-chain contract will still correctly reject if funds are short.
    return null;
  }
}
