import "server-only";
import { calculateFeeFromConfig, buildReceiptFromConfig, type FeeFeature, type FeeConfig, type FeeBreakdown, type FeeEvidence, type Receipt } from "./feeMath";

/**
 * PayAI Fee Engine — the SERVER-ONLY half of the fee system: knowing the
 * CURRENT fee rate, which lives in process.env and therefore cannot exist in
 * a browser bundle. Every feature (Send Payment, Swap, Wallet Automation,
 * Reserved Funds) asks this module "what would this cost?" BEFORE
 * execution, purely to calculate and DISPLAY a number in the UI. Execution
 * itself (lib/payment/engine.ts, lib/monad/contracts.ts, the AutomationVault
 * calls) never imports this file and never has its money-moving logic
 * touched by it — that separation is deliberate: this module can never be
 * the thing that accidentally moves money, no matter what its config says.
 *
 * The actual math (`fee = amount * rate`) lives in lib/payment/feeMath.ts,
 * a plain, side-effect-free module with no env access at all — safe to
 * import from client code once it's been GIVEN a rate (see GET /api/fees).
 * This file exists specifically so nothing needs that split explained to it
 * twice: every EXISTING server call site keeps calling `calculateFee`/
 * `buildReceipt` with the exact same signature as before; only the internals
 * moved.
 *
 * This split exists because of a real bug: this whole file used to have no
 * server/client boundary enforced at all, and got pulled into at least one
 * client bundle via a direct import. Browsers polyfill `process.env` as an
 * empty object, so a DYNAMIC `process.env[key]` lookup (this file's
 * `readFeeConfig`, keyed by a template-literal env var name) silently
 * resolved to `undefined` -> `0` in the browser, no matter what the real
 * server-side rate was — the receipt UI kept showing "free" after the fee
 * went live in production. `import "server-only"` below turns that into a
 * build-time error instead of a silent wrong number: any client file that
 * still tries to import this module now fails to compile.
 *
 * The REAL fee — the transfer that actually happens on-chain — lives in the
 * contract each feature settles through, not here:
 *   - Trading (Uniswap/Kuru/Nad.Fun): PayAITradeExecutor/V2, live since
 *     2026-08-24, feeBps=25 (0.25%), Safe-controlled treasury. See
 *     contracts/LIVE_CONTRACTS.md.
 *   - Send Payment / Wallet Automation / Reserved Funds: PayAIForwarderV2 /
 *     PaymentExecutorV2 / AutomationVaultV2 (contracts/contracts/*V2.sol),
 *     same feeBps/treasury mechanism, mirroring the trade executor exactly.
 *     Live in production as of the 2026-09-06 cutover — see
 *     contracts/LIVE_CONTRACTS.md's fee-v2 suite entry.
 *
 * This file's job is narrower and purely honest-display: the bps/fixed
 * value configured here for a feature should always match what that
 * feature's live contract will actually charge, so a user never sees a
 * number before signing that turns out to be wrong. It is a config change,
 * synced to whichever contract is currently wired in — never a code change,
 * and never itself the thing doing the charging.
 */

export type { FeeFeature, FeeConfig, FeeBreakdown, FeeEvidence, Receipt };

/** One env var per feature so any of them can be priced independently,
 *  without redeploying the others.
 *    PAYAI_FEE_SEND_PAYMENT_BPS / _FIXED
 *    PAYAI_FEE_SWAP_BPS / _FIXED
 *    PAYAI_FEE_WALLET_AUTOMATION_BPS / _FIXED
 *    PAYAI_FEE_RESERVED_FUNDS_BPS / _FIXED
 *  If both a _BPS and _FIXED are set for the same feature, percentage wins
 *  (fixed is meant for a flat "$0.10 per swap"-style fee with no percentage set). */
function readFeeConfig(feature: FeeFeature): FeeConfig {
  const envKey = feature.toUpperCase();
  const bps = Number(process.env[`PAYAI_FEE_${envKey}_BPS`] ?? "0");
  if (bps > 0) return { kind: "percentage", value: bps };
  const fixed = Number(process.env[`PAYAI_FEE_${envKey}_FIXED`] ?? "0");
  if (fixed > 0) return { kind: "fixed", value: fixed };
  return { kind: "percentage", value: 0 };
}

export const FEE_CONFIG: Record<FeeFeature, FeeConfig> = {
  send_payment: readFeeConfig("send_payment"),
  swap: readFeeConfig("swap"),
  wallet_automation: readFeeConfig("wallet_automation"),
  reserved_funds: readFeeConfig("reserved_funds"),
};

/** Where the fee is sent, for display/audit purposes. */
export function getTreasuryAddress(): `0x${string}` | null {
  const addr = process.env.PAYAI_TREASURY_ADDRESS?.trim();
  return addr && /^0x[0-9a-fA-F]{40}$/.test(addr) ? (addr as `0x${string}`) : null;
}

export function calculateFee(feature: FeeFeature, amount: number): FeeBreakdown {
  return calculateFeeFromConfig(FEE_CONFIG[feature], feature, amount);
}

/** A single, consistent receipt shape for Send Payment, Swap, and every
 *  automation mode — payment amount, platform fee, gas fee, total cost,
 *  and status, so every "what did this cost me" screen agrees. */
export function buildReceipt(input: {
  feature: FeeFeature;
  amount: number;
  token: string;
  gasFee?: string | null;
  status: string;
  txHash?: string;
  explorerUrl?: string;
  /** What the settled transaction proves about the fee (lib/payment/
   *  receiptEvidence.ts). Absent = the configured rate, shown as an estimate. */
  feeEvidence?: FeeEvidence;
}): Receipt {
  return buildReceiptFromConfig(FEE_CONFIG[input.feature], input);
}
