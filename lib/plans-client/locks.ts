/**
 * Cross-tab execution lock (Phase 2C, Stage 5C-2b): the Web Locks
 * implementation of the runner's ExecutionLock port (lib/plans-client/runner.ts).
 *
 *   createWebExecutionLock(locks) → ExecutionLock
 *
 * One exclusive lock per wallet + plan:
 *
 *   payai_plan_run:<lowercase wallet>:<planId>
 *
 * requested with ifAvailable, so it never waits: a lock held by another tab,
 * window or worker of this origin (or another runner in this tab) is reported
 * at once as "held". The lock is held for exactly as long as the task's
 * promise is pending and released by the browser when it settles — or when
 * the holding tab closes or crashes. Nothing is ever stolen.
 *
 * This is a client-side guard within ONE browser profile. Other devices,
 * browsers and profiles are not covered; the Plan Service's own guards are.
 *
 * Fail closed: no lock manager, a bad wallet or plan id, or a request that
 * fails before the task starts → "unavailable", and the task never runs. A
 * task that runs and throws rejects with its own error. The task runs at
 * most once.
 *
 * The LockManager is injected (an object, or a function returning one): no
 * browser global is read here.
 */
import { ADDR_RE, PLAN_ID_RE } from "./journal";
import type { ExecutionLock, ExecutionLockResult } from "./runner";

export type { ExecutionLock, ExecutionLockResult } from "./runner";

/** The subset of the Web Locks LockManager this uses. */
export interface LockManagerLike {
  request(
    name: string,
    options: { mode: "exclusive"; ifAvailable: true },
    callback: (lock: unknown) => Promise<unknown>,
  ): Promise<unknown>;
}

export const LOCK_NAME_PREFIX = "payai_plan_run:";

/** The lock name for a wallet + plan, or null when either is malformed. */
export function planLockName(wallet: unknown, planId: unknown): string | null {
  if (typeof wallet !== "string" || !ADDR_RE.test(wallet)) return null;
  if (typeof planId !== "string" || !PLAN_ID_RE.test(planId)) return null;
  return `${LOCK_NAME_PREFIX}${wallet.toLowerCase()}:${planId}`;
}

const usable = (m: unknown): m is LockManagerLike =>
  !!m && typeof m === "object" && typeof (m as LockManagerLike).request === "function";

export function createWebExecutionLock(
  source: LockManagerLike | null | undefined | (() => LockManagerLike | null | undefined),
): ExecutionLock {
  /** The manager, or null when there's none usable (a throwing getter included). */
  const manager = (): LockManagerLike | null => {
    if (typeof source !== "function") return usable(source) ? source : null;
    try {
      const m = source();
      return usable(m) ? m : null;
    } catch {
      return null;
    }
  };

  return {
    async runExclusive<T>(scope: { wallet: string; planId: string }, task: () => Promise<T>): Promise<ExecutionLockResult<T>> {
      const unavailable: ExecutionLockResult<T> = { status: "unavailable" };
      const name = planLockName(scope?.wallet, scope?.planId);
      if (name === null) return unavailable;
      const m = manager();
      if (!m) return unavailable;

      let entered = false;
      let held = false;
      let done = false;
      let value: T | undefined;
      try {
        await m.request(name, { mode: "exclusive", ifAvailable: true }, async (lock) => {
          if (entered) return; // a misbehaving manager calling back twice: never run twice
          entered = true;
          if (lock === null) {
            held = true;
            return;
          }
          // Awaited inside the callback: the lock is held until the task settles.
          value = await task();
          done = true;
        });
      } catch (error) {
        if (done) return { status: "ran", value: value as T }; // a finished task's result is never hidden
        if (held) return { status: "held" };
        if (entered) throw error; // the task's own failure
        return unavailable; // the lock couldn't be established
      }
      if (!entered) return unavailable;
      if (held) return { status: "held" };
      return { status: "ran", value: value as T };
    },
  };
}
