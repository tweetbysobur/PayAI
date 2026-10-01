/**
 * PayAI's platform fee for split payments.
 *
 * The rate and the treasury are NOT configured here. They are read live from
 * the same on-chain, Safe-controlled fee configuration PayAI's send path is
 * already charged under — the wired PayAIForwarderV2's `feeBps()` and
 * `treasury()` (address from MONAD_*_PAYAI_FORWARDER via getPayAIForwarder).
 * There is no second rate, no second treasury, and no fee config in env:
 * PAYAI_TREASURY_ADDRESS, when set, is only a cross-check that must AGREE
 * with the chain.
 *
 * Fee semantics for split (decided for the product, 2026-10-01):
 *   fee = floor(recipientTotal * feeBps / 10000)
 * charged ON TOP of the user's exact recipient amounts, as one extra
 * treasury leg in the same atomic SplitSettlement transaction. It is the
 * same flooring integer math the fee contracts use (never overcharges). It
 * differs from a send in one deliberate way: a send's fee is taken out of the
 * amount sent; a split's is added on top, so every recipient receives exactly
 * what the user asked for.
 *
 * Everything here fails closed: an unconfigured forwarder, an unreadable or
 * out-of-range fee, a zero treasury, or a PAYAI_TREASURY_ADDRESS that
 * disagrees with the chain all refuse the split — it never proceeds on a
 * guessed fee.
 *
 * Server-only.
 */
import "server-only";
import { getAddress, isAddress, type Address } from "viem";
import { ActionInputError } from "@/lib/sdk/types";

/** The fee contracts' own MAX_FEE_BPS (1%). A higher on-chain value is
 *  impossible by contract; seeing one means the read is wrong — refuse. */
const MAX_FEE_BPS = 100;
const ZERO = "0x0000000000000000000000000000000000000000";
const TTL_MS = 60_000;

/** The split can't be priced right now — shown to the user as-is. */
export class SplitFeeUnavailableError extends ActionInputError {}

const FEE_CONFIG_ABI = [
  { type: "function", name: "feeBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { type: "function", name: "treasury", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

export interface SplitFeeTerms {
  feeBps: number;
  treasury: Address;
  /** The contract the terms were read from. */
  source: Address;
}

let cache: { terms: SplitFeeTerms; at: number } | null = null;

export function __resetSplitFeeCacheForTests(): void {
  cache = null;
}

/** floor(recipientTotal * feeBps / 10000) — integer only, never rounds up. */
export function splitPlatformFee(recipientTotal: bigint, feeBps: number): bigint {
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > MAX_FEE_BPS) throw new SplitFeeUnavailableError("PayAI's fee configuration is invalid.");
  return (recipientTotal * BigInt(feeBps)) / 10000n;
}

/** Live fee terms from the chain (cached briefly, like the trade executor's
 *  feeBps read). Fails closed on anything unexpected. */
export async function readSplitFeeTerms(): Promise<SplitFeeTerms> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return checkAgainstEnv(cache.terms);

  const { getPayAIForwarder } = await import("@/lib/monad/config");
  const source = getPayAIForwarder();
  const unavailable = () => new SplitFeeUnavailableError("Split payments are unavailable right now: PayAI's platform fee configuration couldn't be read.");
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
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > MAX_FEE_BPS) throw unavailable();
  if (typeof treasuryRaw !== "string" || !isAddress(treasuryRaw, { strict: false }) || treasuryRaw.toLowerCase() === ZERO) throw unavailable();

  const terms: SplitFeeTerms = { feeBps, treasury: getAddress(treasuryRaw), source: getAddress(source) };
  cache = { terms, at: now };
  return checkAgainstEnv(terms);
}

function checkAgainstEnv(terms: SplitFeeTerms): SplitFeeTerms {
  const configured = process.env.PAYAI_TREASURY_ADDRESS?.trim();
  if (configured && configured.toLowerCase() !== terms.treasury.toLowerCase()) {
    throw new SplitFeeUnavailableError("Split payments are unavailable right now: PayAI's configured treasury doesn't match the on-chain fee treasury.");
  }
  return terms;
}
