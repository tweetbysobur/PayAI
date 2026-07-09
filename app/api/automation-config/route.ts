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
  const stable = getStablecoin();
  return NextResponse.json({
    chainId: getChain().id,
    executor: getPaymentExecutor(),
    vault: getAutomationVault(),
    wmon: getWrappedNative(),
    usdc: { address: stable.address, decimals: stable.decimals },
    walletModeAvailable: getPaymentExecutor() !== null,
    reservedModeAvailable: getAutomationVault() !== null,
  });
}
