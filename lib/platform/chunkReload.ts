/**
 * A tab opened before a deploy asks for code files that the new deploy no
 * longer serves ("ChunkLoadError"). Re-rendering can't fix that — only a full
 * reload fetches the new version. Pure helpers; the error boundary does the
 * reload, at most once a minute so a genuinely broken file can't loop.
 */

export const CHUNK_RELOAD_KEY = "payai_chunk_reload_at";
export const CHUNK_RELOAD_WINDOW_MS = 60_000;

export function isChunkLoadError(error: { name?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return error.name === "ChunkLoadError"
    || /Failed to load chunk|Loading chunk [\w-]+ failed|Failed to fetch dynamically imported module|error loading dynamically imported module/i.test(error.message ?? "");
}

/** True when no automatic reload happened in the last minute. */
export function mayAutoReload(lastReloadAt: number | null, now: number): boolean {
  return lastReloadAt == null || !Number.isFinite(lastReloadAt) || now - lastReloadAt > CHUNK_RELOAD_WINDOW_MS;
}
