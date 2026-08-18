/**
 * Bounds a slow-but-eventually-answering RPC call — distinct from retrying a
 * call that errors out. A provider that accepts an unbounded `getLogs` range
 * (fromBlock: "earliest") instead of rejecting it outright can simply take a
 * very long time to answer on a chain with millions of blocks; a try/catch
 * around the call does nothing for that case, since nothing ever throws.
 *
 * The underlying work is abandoned, not cancelled, when the timeout wins —
 * it can still finish and populate a cache harmlessly in the background,
 * which is why every caller here only ever uses this for read-only,
 * idempotent lookups that are safe to let finish late or not at all.
 *
 * Dependency-free (no viem) — safe to import from any lib/monad module.
 */
export async function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
