/**
 * Storage preflight (Phase 2C, Stage 5C-2a): can this browser actually keep
 * the plan journal? Checked before a new signing run starts — a plan must not
 * sign anything it couldn't journal.
 *
 *   probeStorage(storage) → { ok: true } | { ok: false, reason }
 *
 * write a unique value under a unique key → read it back → compare exactly →
 * remove it → confirm it's gone. Each step that fails gives its own reason:
 *
 *   unavailable        no usable storage object (or obtaining it threw)
 *   write_failed       setItem threw (quota, blocked, private mode, …)
 *   readback_mismatch  getItem threw or didn't return exactly what was written
 *   remove_failed      removeItem threw, or the probe value is still there
 *
 * Ordinary storage failures are reported, not thrown. A failed probe means no
 * new execution; this module only reports it. There is no recovery-only mode.
 *
 * Storage is injected (an object, or a function returning one, for browsers
 * where merely reading `localStorage` can throw): no browser global is read.
 */

export interface ProbeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type StorageProbeResult =
  | { ok: true }
  | { ok: false; reason: "unavailable" | "write_failed" | "readback_mismatch" | "remove_failed" };

export const PROBE_KEY_PREFIX = "payai_plan_journal_probe:";

let probeSeq = 0;

/** A fresh, unguessable-enough id per probe (uniqueness, not secrecy). */
function defaultProbeId(): string {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex}-${(++probeSeq).toString(36)}`;
}

const usable = (s: unknown): s is ProbeStorage =>
  !!s && typeof s === "object"
  && typeof (s as ProbeStorage).getItem === "function"
  && typeof (s as ProbeStorage).setItem === "function"
  && typeof (s as ProbeStorage).removeItem === "function";

/** Run one storage step; false when it threw. */
function attempt(step: () => void): boolean {
  try {
    step();
    return true;
  } catch {
    return false;
  }
}

export function probeStorage(
  source: ProbeStorage | null | undefined | (() => ProbeStorage | null | undefined),
  opts: { probeId?: () => string } = {},
): StorageProbeResult {
  let storage: unknown = source;
  if (typeof source === "function" && !attempt(() => { storage = source(); })) return { ok: false, reason: "unavailable" };
  if (!usable(storage)) return { ok: false, reason: "unavailable" };
  const s = storage;

  const id = (opts.probeId ?? defaultProbeId)();
  const key = `${PROBE_KEY_PREFIX}${id}`;
  const value = `probe:${id}`;

  if (!attempt(() => s.setItem(key, value))) {
    attempt(() => s.removeItem(key)); // tidy up a partial write; the failure is still reported
    return { ok: false, reason: "write_failed" };
  }

  let read: unknown = null;
  if (!attempt(() => { read = s.getItem(key); }) || read !== value) {
    attempt(() => s.removeItem(key)); // tidy up; the failure is still reported
    return { ok: false, reason: "readback_mismatch" };
  }

  let after: unknown = value;
  if (!attempt(() => s.removeItem(key)) || !attempt(() => { after = s.getItem(key); }) || after !== null) {
    return { ok: false, reason: "remove_failed" };
  }
  return { ok: true };
}
