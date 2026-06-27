import { NextResponse } from "next/server";
import { agentConfig } from "@/lib/agent/brain";
import { checkVeriGate, getMode } from "@/lib/verigate/client";

/**
 * GET /api/health — liveness + dependency status.
 * Reports the agent, the Cleanverse intent engine, the active model, the
 * VeriGate/execution connection, and — in Monad mode — the agent wallet.
 */
export async function GET() {
  const verigate = await checkVeriGate();

  let wallet:
    | Awaited<ReturnType<typeof import("@/lib/monad/wallet").getWalletInfo>>
    | null = null;
  if (getMode() === "monad") {
    const { getWalletInfo } = await import("@/lib/monad/wallet");
    wallet = await getWalletInfo();
  }

  const { getNnsContractAddress } = await import("@/lib/monad/domain-resolver");
  const { getChain } = await import("@/lib/monad/config");

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
