"use client";

import { useState } from "react";
import { encodeFunctionData, createPublicClient, fallback, http, parseUnits } from "viem";
import { Button } from "@/components/ui";
import {
  MONAD_CHAIN_ID,
  MONAD_CHAIN_ID_HEX,
  MONAD_CHAIN_NAME,
  MONAD_RPC_URLS,
  MONAD_EXPLORER,
  MONAD_USDC,
  MONAD_USDC_DECIMALS,
} from "@/lib/monad/public";
import type { EthProvider } from "@/lib/wallet/provider";

const ERC20_TRANSFER_ABI = [
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

type Phase = "idle" | "connecting" | "switching" | "sending" | "confirming" | "verifying" | "paid" | "error";

export function PayWithWallet({ linkId, amount, recipient }: { linkId: string; amount: number; recipient: `0x${string}` }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [account, setAccount] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  async function ensureChain(eth: EthProvider) {
    const chainId = (await eth.request({ method: "eth_chainId" })) as string;
    if (chainId.toLowerCase() === MONAD_CHAIN_ID_HEX.toLowerCase()) return;
    setPhase("switching");
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: MONAD_CHAIN_ID_HEX }] });
    } catch (e) {
      const code = (e as { code?: number })?.code;
      if (code !== 4902) throw e;
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: MONAD_CHAIN_ID_HEX,
          chainName: MONAD_CHAIN_NAME,
          nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
          rpcUrls: MONAD_RPC_URLS,
          blockExplorerUrls: [MONAD_EXPLORER],
        }],
      });
    }
  }

  async function pay() {
    setError(null);
    const eth = window.ethereum;
    if (!eth) {
      setPhase("error");
      setError("No wallet found. Install MetaMask or another Monad-compatible wallet.");
      return;
    }
    try {
      setPhase("connecting");
      const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[];
      const from = accounts[0];
      setAccount(from);

      await ensureChain(eth);

      setPhase("sending");
      const data = encodeFunctionData({
        abi: ERC20_TRANSFER_ABI,
        functionName: "transfer",
        args: [recipient, parseUnits(String(amount), MONAD_USDC_DECIMALS)],
      });
      const hash = (await eth.request({
        method: "eth_sendTransaction",
        params: [{ from, to: MONAD_USDC, data }],
      })) as string;
      setTxHash(hash);

      setPhase("confirming");
      const client = createPublicClient({
        chain: { id: MONAD_CHAIN_ID, name: MONAD_CHAIN_NAME, nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 }, rpcUrls: { default: { http: MONAD_RPC_URLS } } },
        transport: MONAD_RPC_URLS.length > 1
          ? fallback(MONAD_RPC_URLS.map((u) => http(u, { retryCount: 3, retryDelay: 500, timeout: 12_000 })), { rank: false })
          : http(MONAD_RPC_URLS[0], { retryCount: 4, retryDelay: 500, timeout: 12_000 }),
      });
      await client.waitForTransactionReceipt({ hash: hash as `0x${string}` });

      setPhase("verifying");
      const r = await fetch(`/api/links/${linkId}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ txHash: hash }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "Could not verify the payment.");
      setPhase("paid");
    } catch (e) {
      setPhase("error");
      setError(e instanceof Error ? e.message : "Payment failed.");
    }
  }

  if (phase === "paid") {
    return <p className="text-center text-sm text-success">✓ Payment confirmed on-chain.</p>;
  }

  const label: Record<Phase, string> = {
    idle: "Pay with wallet",
    connecting: "Connecting wallet…",
    switching: "Switching network…",
    sending: "Confirm in your wallet…",
    confirming: "Waiting for confirmation…",
    verifying: "Verifying payment…",
    paid: "Paid",
    error: "Try again",
  };
  const busy = phase !== "idle" && phase !== "error";

  return (
    <div>
      <Button onClick={pay} disabled={busy} className="w-full justify-center">
        {label[phase]}
      </Button>
      {account && (
        <p className="mt-2 text-center text-xs text-muted-foreground">
          Connected: {account.slice(0, 6)}…{account.slice(-4)}
        </p>
      )}
      {txHash && (
        <a href={`${MONAD_EXPLORER}/tx/${txHash}`} target="_blank" rel="noreferrer" className="mt-1 block text-center text-xs text-primary hover:underline">
          View transaction ↗
        </a>
      )}
      {error && <p className="mt-2 text-center text-xs text-danger">{error}</p>}
    </div>
  );
}
