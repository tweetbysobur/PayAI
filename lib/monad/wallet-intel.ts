/**
 * Wallet Intelligence — real on-chain data for a connected user wallet:
 * direct RPC reads (MON and USDC balance, nonce) plus the MON price.
 *
 * It no longer scans PaymentExecutor logs for payment history. Monad's RPC
 * caps eth_getLogs at a 100-block range, so the full-history and 50k-block
 * scans were always refused; they cost ~10s per request and returned zero
 * payments for every wallet, which wasn't true. PayAI's real activity comes
 * from the wallet's own history (Wallets page "PayAI transactions"), not here.
 */
import "server-only";
import { formatEther, formatUnits } from "viem";
import { getPublicClient } from "./wallet";
import { getStablecoin, explorerAddress, getChain } from "./config";

const ERC20_BALANCE_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "o", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

export interface WalletIntelligence {
  address: `0x${string}`;
  network: string;
  chainId: number;
  explorerAddressUrl: string;
  nativeBalance: string;
  usdcBalance: string;
  monPriceUsd: number | null;
  totalValueUsd: number | null;
  txCountSent: number;
}

async function fetchMonPriceUsd(): Promise<number | null> {
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=monad&vs_currencies=usd", {
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return typeof j?.monad?.usd === "number" ? j.monad.usd : null;
  } catch {
    return null;
  }
}

export async function getWalletIntelligence(address: `0x${string}`): Promise<WalletIntelligence> {
  const pub = getPublicClient();
  const chain = getChain();
  const token = getStablecoin();

  const [nativeBalanceWei, usdcBalanceRaw, txCountSent, monPriceUsd] = await Promise.all([
    pub.getBalance({ address }).catch(() => 0n),
    token.address !== "0x0000000000000000000000000000000000000000"
      ? (pub.readContract({ address: token.address, abi: ERC20_BALANCE_ABI, functionName: "balanceOf", args: [address] }) as Promise<bigint>).catch(() => 0n)
      : Promise.resolve(0n),
    pub.getTransactionCount({ address }).catch(() => 0),
    fetchMonPriceUsd(),
  ]);

  const nativeBalance = formatEther(nativeBalanceWei);
  const usdcBalance = formatUnits(usdcBalanceRaw, token.decimals);
  const totalValueUsd = monPriceUsd != null ? Number(nativeBalance) * monPriceUsd + Number(usdcBalance) : null;

  return {
    address, network: chain.name, chainId: chain.id, explorerAddressUrl: explorerAddress(address),
    nativeBalance, usdcBalance, monPriceUsd, totalValueUsd, txCountSent,
  };
}
