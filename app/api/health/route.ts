import { NextResponse } from "next/server";
import { agentConfig } from "@/lib/agent/brain";
import { checkVeriGate, getMode } from "@/lib/verigate/client";

/**
 * GET /api/health — liveness + dependency status. Public, unauthenticated.
 *
 * Reports the agent, the Cleanverse intent engine, the active model, and the
 * VeriGate/execution connection. The Agent Wallet's address and live balance
 * are deliberately NOT included — this is a public endpoint, and that wallet
 * is an internal settlement signer, not user-facing data. Only whether a
 * signer is configured (a boolean) plus the active network are exposed —
 * enough for the UI's "settlement available" checks, nothing sensitive.
 */
export async function GET() {
  const verigate = await checkVeriGate();
  const { getChain } = await import("@/lib/monad/config");
  const chain = getChain();

  let wallet: { configured: boolean; network: string; chainId: number } | null = null;
  if (getMode() === "monad") {
    const { isSignerConfigured } = await import("@/lib/monad/wallet");
    wallet = { configured: isSignerConfigured(), network: chain.name, chainId: chain.id };
  }

  const { getNnsContractAddress } = await import("@/lib/monad/domain-resolver");

  return NextResponse.json({
    service: "veripay-ai",
    status: "ok",
    agent: { status: "ready" },
    cleanverse: { status: "connected", engine: agentConfig.intentEngine },
    model: agentConfig.model,
    verigate: {
      mode: verigate.mode,
      connected: verigate.connected,
      detail: verigate.detail,
    },
    wallet,
    domains: {
      tld: ".nad",
      acceptedSuffixes: [".nad", ".nads"],
      registry: getNnsContractAddress(),
      network: getChain().name,
      note: "Real Nad Name Service (nad.domains) integration. Not yet deployed on Monad Testnet as of this writing — resolution will return 'Unable to resolve domain' until NNS reaches testnet or the app targets mainnet.",
    },
  });
}
