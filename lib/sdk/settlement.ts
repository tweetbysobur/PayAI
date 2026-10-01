/**
 * Shared shapes between the SDK build and confirm routes.
 *
 * build stores a BuildRecord under `sdk-build:<quoteId>` (lib/platform/
 * idempotency.ts's KV, with its in-memory fallback). confirm reads it back
 * and uses matchesBuiltTx() to prove a confirmed transaction is exactly the
 * one PayAI built for that quote — same wallet, same target, same calldata
 * (which for split_payment includes the per-build random `ref`), same value.
 *
 * What this does NOT give: exactly-once execution on-chain. If the user signs
 * the same built transaction twice, both land (the deployed contracts don't
 * enforce `ref` uniqueness); confirm records each real settlement once, by tx
 * hash. See app/api/ask/action/confirm/route.ts.
 */

export interface BuildRecord {
  protocolId: string;
  actionId: string;
  version: string;
  /** Lowercased signer the steps were built for. */
  wallet: string;
  /** The final (settlement) step — the transaction confirm must match. */
  finalTx: { to: string; data: string; value: string };
  riskScore: number | null;
  compliance: string | null;
  builtAt: number;
}

export const buildKey = (quoteId: string) => `sdk-build:${quoteId}`;
export const settleKey = (txHash: string) => `sdk-settle:${txHash.toLowerCase()}`;

/** True only when the mined transaction is byte-for-byte the built one. */
export function matchesBuiltTx(
  record: BuildRecord,
  tx: { from: string; to: string | null; input: string; value: bigint },
): boolean {
  if (!tx.to) return false;
  let builtValue: bigint;
  try {
    builtValue = BigInt(record.finalTx.value);
  } catch {
    return false;
  }
  return (
    tx.from.toLowerCase() === record.wallet &&
    tx.to.toLowerCase() === record.finalTx.to.toLowerCase() &&
    tx.input.toLowerCase() === record.finalTx.data.toLowerCase() &&
    tx.value === builtValue
  );
}
