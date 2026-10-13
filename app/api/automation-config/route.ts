import { NextResponse } from "next/server";

/**
 * GET /api/automation-config — public on-chain addresses the browser needs to
 * build Wallet Automation (approve) and Reserved Funds (reserve) transactions.
 *
 * All values are public contract addresses — nothing secret. `wmon` is null
 * until MONAD_MAINNET_WMON is set, which is how the UI knows whether MON can
 * use Wallet Automation (via WMON) or must use Reserved Funds.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const { getPaymentExecutor, getAutomationVault, getWrappedNative, getStablecoin, getChain } = await import("@/lib/monad/config");
  let stable: ReturnType<typeof getStablecoin>;
  try {
    stable = getStablecoin();
  } catch {
    // A deployment without its stablecoin configured can't size any
    // automation — say so plainly instead of failing with a 500.
    return NextResponse.json({ error: "Automation settings are unavailable right now." }, { status: 503 });
  }
  // The live PayAI fee rates of the two automation contracts (public on-chain
  // values). The creator sizes approvals/reservations as amount + this fee on
  // top (lib/payment/feeOnTop.ts). Null when unreadable — the creator then
  // refuses to size a budget rather than guess one.
  const { contractFeeBps } = await import("@/lib/monad/contracts");
  const executor = getPaymentExecutor();
  const vault = getAutomationVault();
  const [executorFeeBps, vaultFeeBps] = await Promise.all([
    executor ? contractFeeBps(executor).catch(() => null) : Promise.resolve(null),
    vault ? contractFeeBps(vault).catch(() => null) : Promise.resolve(null),
  ]);
  return NextResponse.json({
    executorFeeBps,
    vaultFeeBps,
    chainId: getChain().id,
    executor: getPaymentExecutor(),
    vault: getAutomationVault(),
    wmon: getWrappedNative(),
    usdc: { address: stable.address, decimals: stable.decimals },
    walletModeAvailable: getPaymentExecutor() !== null,
    reservedModeAvailable: getAutomationVault() !== null,
  });
}
