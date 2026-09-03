/**
 * /withdraw — sends MON or an ERC-20 token out of a Telegram user's own
 * custodial wallet to an address they name.
 *
 * A small, local equivalent of lib/monad/executor.ts's transfer logic,
 * deliberately NOT built by adding a parameter to that shared file: it
 * signs with the single agent account real production Payment Automations
 * depend on (getWalletClient() reads MONAD_AGENT_PRIVATE_KEY directly), and
 * this feature has no reason to touch code that live automations execute
 * through. Same underlying viem primitives, parameterized by whichever
 * account lib/telegram/wallets.ts's getTelegramWalletAccount() hands in.
 *
 * Server-only.
 */
import "server-only";
import { createWalletClient, parseUnits, type Address, type PrivateKeyAccount } from "viem";
import { getChain, getTransport, explorerTx } from "@/lib/monad/config";
import { getPublicClient } from "@/lib/monad/wallet";
import { ERC20_ABI, explainError } from "@/lib/monad/executor";
import { resolveToken, NATIVE_TOKEN_ADDRESS } from "@/lib/monad/tokenRegistry";
import { isAddress } from "@/lib/payees/directory";
import { toParseableAmount } from "@/lib/monad/verify";

export type WithdrawResult =
  | { ok: true; txHash: string; explorerUrl: string; amount: string; symbol: string }
  | { ok: false; message: string };

/**
 * `tokenInput` is either "MON" (native) or a contract address — never a
 * bare arbitrary symbol, same contract-address-is-truth rule
 * lib/monad/tokenIntelligence.ts documents, since a withdrawal is real,
 * irreversible fund movement and a misresolved symbol here is a much worse
 * failure than in a read-only lookup.
 */
export async function executeWithdraw(
  account: PrivateKeyAccount, tokenInput: string, amount: string, toAddress: string,
): Promise<WithdrawResult> {
  if (!isAddress(toAddress)) return { ok: false, message: `"${toAddress}" doesn't look like a valid address.` };

  const amountNum = Number(amount);
  if (!Number.isFinite(amountNum) || amountNum <= 0) return { ok: false, message: "That doesn't look like a valid amount." };

  const isNative = tokenInput.trim().toUpperCase() === "MON";
  let decimals = 18;
  let symbol = "MON";
  let tokenAddress: Address = NATIVE_TOKEN_ADDRESS as Address;
  if (!isNative) {
    try {
      const info = await resolveToken(tokenInput.trim());
      decimals = info.decimals;
      symbol = info.symbol;
      tokenAddress = info.address as Address;
    } catch {
      return { ok: false, message: `I couldn't identify "${tokenInput}" as a token.` };
    }
  }

  const chain = getChain();
  const wallet = createWalletClient({ account, chain, transport: getTransport() });
  const pub = getPublicClient();
  // toParseableAmount, not the raw string: a sub-1-unit amount below the
  // token's own precision floor can stringify to exponential notation
  // (e.g. "1e-7"), which parseUnits rejects outright — same fix already
  // applied at lib/monad/executor.ts's own transfer calls.
  const parsedAmount = toParseableAmount(Number(amount), isNative ? 18 : decimals);

  let hash: `0x${string}`;
  try {
    if (isNative) {
      // Not simulated first: a plain native transfer has no revert
      // condition to catch beyond insufficient balance, which the broadcast
      // itself surfaces just as clearly — matches executeNativeTransfer's
      // own precedent in lib/monad/executor.ts.
      hash = await wallet.sendTransaction({ account, chain, to: toAddress as Address, value: parseUnits(parsedAmount, 18) });
    } else {
      // Simulate first so a doomed transfer (insufficient balance, a token
      // that reverts on transfer) fails before broadcasting and spending gas
      // — matches executeTransfer's own precedent in lib/monad/executor.ts.
      const { request } = await pub.simulateContract({
        account, address: tokenAddress, abi: ERC20_ABI, functionName: "transfer",
        args: [toAddress as Address, parseUnits(parsedAmount, decimals)],
      });
      hash = await wallet.writeContract(request);
    }
  } catch (e) {
    return { ok: false, message: explainError(e) };
  }

  try {
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
    if (receipt.status !== "success") {
      return { ok: false, message: `The withdrawal reverted on-chain. No funds moved. ${explorerTx(hash)}` };
    }
  } catch {
    // Broadcast succeeded but confirmation timed out -- real money already
    // left the signing step, so this is reported as pending-with-a-real-hash,
    // never as a failure that might invite a retry and a double-send.
    return { ok: true, txHash: hash, explorerUrl: explorerTx(hash), amount, symbol };
  }

  return { ok: true, txHash: hash, explorerUrl: explorerTx(hash), amount, symbol };
}
