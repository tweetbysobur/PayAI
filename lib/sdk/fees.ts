/**
 * PayAI's platform fee terms for SDK actions — read, never configured here.
 *
 * The rate and treasury are the live, Safe-controlled configuration of the
 * PayAI forwarder that production payments already settle through
 * (PayAIForwarderV2's `feeBps()` / `treasury()`; address from
 * MONAD_*_PAYAI_FORWARDER via getPayAIForwarder). There is no second rate, no
 * second treasury, and no fee config in env: PAYAI_TREASURY_ADDRESS, when
 * set, is only a cross-check that must AGREE with the chain.
 *
 * Shared by:
 *   - payai-settlement/split_payment — fee added ON TOP of exact recipient
 *     amounts, paid as one treasury leg of the split (see that action);
 *   - payai/transfer — the forwarder itself takes the fee OUT of the amount
 *     sent, exactly as the existing send path does.
 * Both use the contracts' flooring math: floor(base * feeBps / 10000).
 *
 * Everything fails closed: an unconfigured forwarder, an unreadable or
 * out-of-range fee, a zero treasury, or a PAYAI_TREASURY_ADDRESS that
 * disagrees with the chain refuse the action — it never proceeds on a guessed
 * fee.
 *
 * Server-only.
 */
import "server-only";
import { getAddress, isAddress, type Address } from "viem";
import { ActionInputError } from "@/lib/sdk/types";

/** The fee contracts' own MAX_FEE_BPS (1%). A higher on-chain value is
 *  impossible by contract; seeing one means the read is wrong — refuse. */
export const MAX_PLATFORM_FEE_BPS = 100;
const ZERO = "0x0000000000000000000000000000000000000000";
const TTL_MS = 60_000;

/** The action can't be priced right now — shown to the user as-is. */
export class PlatformFeeUnavailableError extends ActionInputError {}

const FEE_CONFIG_ABI = [
  { type: "function", name: "feeBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { type: "function", name: "treasury", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

export interface PlatformFeeTerms {
  feeBps: number;
  treasury: Address;
  /** The contract the terms were read from (the forwarder). */
  source: Address;
}

let cache: { terms: PlatformFeeTerms; at: number } | null = null;

export function __resetPlatformFeeCacheForTests(): void {
  cache = null;
}

/** floor(base * feeBps / 10000) — integer only, never rounds up. */
export function platformFee(base: bigint, feeBps: number): bigint {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > MAX_PLATFORM_FEE_BPS) {
    throw new PlatformFeeUnavailableError("PayAI's fee configuration is invalid.");
  }
  return (base * BigInt(feeBps)) / 10000n;
}

/** Live fee terms from the chain (cached briefly, like the trade executor's
 *  feeBps read). Fails closed on anything unexpected. */
export async function readPlatformFeeTerms(): Promise<PlatformFeeTerms> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return checkAgainstEnv(cache.terms);

  const { getPayAIForwarder } = await import("@/lib/monad/config");
  const source = getPayAIForwarder();
  const unavailable = () => new PlatformFeeUnavailableError("This payment is unavailable right now: PayAI's platform fee configuration couldn't be read.");
  if (!source) throw unavailable();

  let bpsRaw: unknown;
  let treasuryRaw: unknown;
  try {
    const { getPublicClient } = await import("@/lib/monad/wallet");
    const pub = getPublicClient();
    [bpsRaw, treasuryRaw] = await Promise.all([
      pub.readContract({ address: source, abi: FEE_CONFIG_ABI, functionName: "feeBps" }),
      pub.readContract({ address: source, abi: FEE_CONFIG_ABI, functionName: "treasury" }),
    ]);
  } catch {
    throw unavailable();
  }
  const feeBps = Number(bpsRaw);
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > MAX_PLATFORM_FEE_BPS) throw unavailable();
  if (typeof treasuryRaw !== "string" || !isAddress(treasuryRaw, { strict: false }) || treasuryRaw.toLowerCase() === ZERO) throw unavailable();

  const terms: PlatformFeeTerms = { feeBps, treasury: getAddress(treasuryRaw), source: getAddress(source) };
  cache = { terms, at: now };
  return checkAgainstEnv(terms);
}

function checkAgainstEnv(terms: PlatformFeeTerms): PlatformFeeTerms {
  const configured = process.env.PAYAI_TREASURY_ADDRESS?.trim();
  if (configured && configured.toLowerCase() !== terms.treasury.toLowerCase()) {
    throw new PlatformFeeUnavailableError("This payment is unavailable right now: PayAI's configured treasury doesn't match the on-chain fee treasury.");
  }
  return terms;
}
