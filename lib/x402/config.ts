/**
 * PayAI's self-hosted x402 facilitator: configuration.
 *
 * The facilitator verifies EIP-3009 `transferWithAuthorization` signatures and
 * broadcasts them on Monad, paying the gas. It is OFF unless explicitly
 * enabled, and it signs with its OWN key, never the automation agent key:
 *
 *   MONAD_AGENT_PRIVATE_KEY      capped automation payouts (PaymentExecutor)
 *   X402_FACILITATOR_PRIVATE_KEY gas-only relayer for x402 settlement
 *
 * The facilitator key never holds or moves user funds. A transferWithAuthorization
 * moves tokens from the signer of the authorization to its `to`, so a
 * compromised facilitator key can burn its own MON on gas and nothing more.
 * Keeping it separate means that blast radius never includes the automation
 * wallet's balance or its on-chain spend caps.
 *
 * Env:
 *   X402_FACILITATOR_ENABLED=true          turn the routes on
 *   X402_FACILITATOR_PRIVATE_KEY=0x...     gas wallet (fund it with a little MON)
 *   X402_USDC_ADDRESS=0x...                optional override of the accepted asset
 *   X402_MAX_AMOUNT_ATOMIC=100000000       optional per-payment cap (6-decimal units)
 *
 * The network follows MONAD_NETWORK, like the rest of the app.
 */
import { getNetwork, type MonadNetwork } from "@/lib/monad/config";

/** Circle USDC per Monad network, as published in Monad's x402 guide. Mainnet
 *  matches MAINNET.md. Testnet is Circle's faucet USDC, which is NOT the
 *  sandbox aUSDC that MONAD_TESTNET_USDC defaults to: aUSDC has no EIP-3009. */
export const X402_USDC: Record<MonadNetwork, `0x${string}`> = {
  mainnet: "0x754704Bc059F8C67012fEd69BC8A327a5aafb603",
  testnet: "0x534b2f3A21130d7a60830c2Df862319e593943A3",
};

export const X402_NETWORK: Record<MonadNetwork, `eip155:${number}`> = {
  mainnet: "eip155:143",
  testnet: "eip155:10143",
};

/** 100 USDC. A facilitator that relays any amount is a liability magnet; a
 *  merchant who needs more raises the cap deliberately. */
export const DEFAULT_MAX_AMOUNT_ATOMIC = 100_000_000n;

export interface FacilitatorConfig {
  network: `eip155:${number}`;
  asset: `0x${string}`;
  maxAmountAtomic: bigint;
  privateKey: `0x${string}`;
}

export type FacilitatorConfigResult =
  | { ok: true; config: FacilitatorConfig }
  | { ok: false; reason: "disabled" | "no_key" | "bad_key" | "shared_key" | "bad_asset" | "bad_cap" };

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const KEY_RE = /^0x[0-9a-fA-F]{64}$/;

function normalizeKey(raw: string | undefined): string {
  const k = (raw ?? "").trim();
  if (!k) return "";
  return (k.startsWith("0x") ? k : `0x${k}`).toLowerCase();
}

/** Reads env every call (cheap) so tests and redeploys see changes. Fails
 *  closed: anything missing or malformed means the facilitator is off. */
export function readFacilitatorConfig(env: NodeJS.ProcessEnv = process.env): FacilitatorConfigResult {
  if (env.X402_FACILITATOR_ENABLED?.trim().toLowerCase() !== "true") return { ok: false, reason: "disabled" };

  const key = normalizeKey(env.X402_FACILITATOR_PRIVATE_KEY);
  if (!key) return { ok: false, reason: "no_key" };
  if (!KEY_RE.test(key)) return { ok: false, reason: "bad_key" };
  // Reusing the automation key would put the automation wallet's balance and
  // caps inside the relayer's blast radius. Refuse rather than warn.
  if (key === normalizeKey(env.MONAD_AGENT_PRIVATE_KEY)) return { ok: false, reason: "shared_key" };

  const network = getNetwork();
  const assetRaw = env.X402_USDC_ADDRESS?.trim() || X402_USDC[network];
  if (!ADDR_RE.test(assetRaw)) return { ok: false, reason: "bad_asset" };

  let maxAmountAtomic = DEFAULT_MAX_AMOUNT_ATOMIC;
  const capRaw = env.X402_MAX_AMOUNT_ATOMIC?.trim();
  if (capRaw) {
    if (!/^\d+$/.test(capRaw) || BigInt(capRaw) <= 0n) return { ok: false, reason: "bad_cap" };
    maxAmountAtomic = BigInt(capRaw);
  }

  return {
    ok: true,
    config: {
      network: X402_NETWORK[network],
      asset: assetRaw as `0x${string}`,
      maxAmountAtomic,
      privateKey: key as `0x${string}`,
    },
  };
}
