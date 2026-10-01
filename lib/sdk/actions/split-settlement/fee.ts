/**
 * Split's view of PayAI's platform fee terms. The reader itself is shared
 * with every SDK action that charges the platform fee — see lib/sdk/fees.ts
 * for where the terms come from and how they fail closed.
 *
 * Split's fee semantics (decided for the product, 2026-10-01):
 *   fee = floor(recipientTotal * feeBps / 10000)
 * charged ON TOP of the user's exact recipient amounts, as one extra
 * treasury leg in the same atomic SplitSettlement transaction.
 *
 * Server-only.
 */
import "server-only";
export {
  readPlatformFeeTerms as readSplitFeeTerms,
  platformFee as splitPlatformFee,
  PlatformFeeUnavailableError as SplitFeeUnavailableError,
  __resetPlatformFeeCacheForTests as __resetSplitFeeCacheForTests,
  type PlatformFeeTerms as SplitFeeTerms,
} from "@/lib/sdk/fees";
