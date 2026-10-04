import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createWebExecutionLock, LOCK_NAME_PREFIX, planLockName, type LockManagerLike } from "@/lib/plans-client/locks";

/**
 * Phase 2C Stage 5C-2b — the Web Locks execution lock
 * (lib/plans-client/locks.ts), against a fake LockManager that follows the
 * Web Locks rules this relies on: exclusive per name, `ifAvailable` calls
 * back with null instead of waiting, and the lock is released when the
 * callback's promise settles. No DOM.
 */

const WALLET = "0x6b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c";
const WALLET_MIXED = "0x6B1C2d3E4f5A6b7C8d9E0f1A2b3C4d5E6f7A8b9C";
const OTHER = "0x3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e";
const PLAN = `plan_${"a".repeat(32)}`;
const PLAN2 = `plan_${"b".repeat(32)}`;
const NAME = `payai_plan_run:${WALLET}:${PLAN}`;
const scope = (wallet = WALLET, planId = PLAN) => ({ wallet, planId });

class FakeLocks implements LockManagerLike {
  held = new Set<string>();
  requests: { name: string; options: Record<string, unknown> }[] = [];
  /** Reject before calling back (e.g. SecurityError in an opaque origin). */
  rejectBefore = false;
  async request(name: string, options: { mode: "exclusive"; ifAvailable: true }, cb: (lock: unknown) => Promise<unknown>): Promise<unknown> {
    this.requests.push({ name, options: { ...options } });
    if (this.rejectBefore) throw new DOMExceptionLike("SecurityError");
    if (this.held.has(name)) {
      if (options.ifAvailable) return cb(null);
      throw new Error("the fake never waits");
    }
    this.held.add(name);
    try {
      return await cb({ name, mode: options.mode });
    } finally {
      this.held.delete(name);
    }
  }
}
class DOMExceptionLike extends Error {}

const gate = () => {
  let open!: () => void;
  const wait = new Promise<void>((r) => { open = r; });
  return { wait, open };
};

describe("lock name", () => {
  it("is payai_plan_run:<lowercase wallet>:<planId>", () => {
    expect(planLockName(WALLET, PLAN)).toBe(NAME);
    expect(LOCK_NAME_PREFIX).toBe("payai_plan_run:");
  });
  it("mixed-case spellings of one wallet give one name", () => {
    expect(planLockName(WALLET_MIXED, PLAN)).toBe(NAME);
    expect(planLockName(WALLET.toUpperCase().replace("0X", "0x"), PLAN)).toBe(NAME);
  });
  it("different wallets or plans give different names", () => {
    expect(planLockName(OTHER, PLAN)).not.toBe(NAME);
    expect(planLockName(WALLET, PLAN2)).not.toBe(NAME);
    expect(planLockName(OTHER, PLAN2)).not.toBe(planLockName(OTHER, PLAN));
  });
  it("differs from the journal's key namespace", () => {
    expect(NAME.startsWith("payai_plan_journal:")).toBe(false);
  });
  it("a malformed wallet or plan id gives no name", () => {
    for (const w of ["", "0x123", `0X${WALLET.slice(2)}`, ` ${WALLET}`, `${WALLET}:`, null, 1]) expect(planLockName(w, PLAN)).toBeNull();
    for (const p of ["", `plan_${"A".repeat(32)}`, `plan_${"a".repeat(31)}`, `${PLAN}:x`, null, {}]) expect(planLockName(WALLET, p)).toBeNull();
  });
  it("uses the journal's own formats (no third copy)", () => {
    const src = readFileSync(join(__dirname, "..", "lib", "plans-client", "locks.ts"), "utf8");
    expect(src).toMatch(/import \{ ADDR_RE, PLAN_ID_RE \} from "\.\/journal";/);
    expect(src).not.toMatch(/=\s*\/\^/); // defines no regex literals of its own
  });
});

describe("runExclusive", () => {
  it("runs the task while holding exactly this name, with exclusive + ifAvailable and never steal", async () => {
    const m = new FakeLocks();
    const lock = createWebExecutionLock(m);
    let during: string[] = [];
    const r = await lock.runExclusive(scope(WALLET_MIXED), async () => { during = [...m.held]; return 42; });
    expect(r).toEqual({ status: "ran", value: 42 });
    expect(during).toEqual([NAME]);
    expect(m.requests).toEqual([{ name: NAME, options: { mode: "exclusive", ifAvailable: true } }]);
    expect("steal" in m.requests[0].options).toBe(false);
    expect("signal" in m.requests[0].options).toBe(false);
    expect(m.held.size).toBe(0);
  });
  it("an invalid wallet or plan → unavailable without asking the manager; the task never runs", async () => {
    const m = new FakeLocks();
    const lock = createWebExecutionLock(m);
    let ran = 0;
    for (const s of [scope("0x123"), scope(WALLET, "plan_x"), scope(`${WALLET}:x`), null, undefined, {}]) {
      expect(await lock.runExclusive(s as never, async () => { ran++; })).toEqual({ status: "unavailable" });
    }
    expect(ran).toBe(0);
    expect(m.requests).toEqual([]);
  });
  it("no manager, no request, or a getter that throws → unavailable; the task never runs", async () => {
    let ran = 0;
    const sources = [null, undefined, {}, { request: "no" }, "locks", () => null, () => ({}), () => { throw new Error("SecurityError"); }];
    for (const source of sources) {
      const r = await createWebExecutionLock(source as never).runExclusive(scope(), async () => { ran++; });
      expect(r).toEqual({ status: "unavailable" });
    }
    expect(ran).toBe(0);
  });
  it("a getter is called per run (the manager isn't captured at creation)", async () => {
    let calls = 0;
    const m = new FakeLocks();
    const lock = createWebExecutionLock(() => { calls++; return m; });
    expect(calls).toBe(0);
    await lock.runExclusive(scope(), async () => 1);
    await lock.runExclusive(scope(), async () => 1);
    expect(calls).toBe(2);
  });
  it("request rejecting before the callback → unavailable; the task never runs", async () => {
    const m = new FakeLocks();
    m.rejectBefore = true;
    let ran = 0;
    expect(await createWebExecutionLock(m).runExclusive(scope(), async () => { ran++; })).toEqual({ status: "unavailable" });
    expect(ran).toBe(0);
  });
  it("request throwing synchronously → unavailable", async () => {
    const m = { request() { throw new Error("boom"); } };
    expect(await createWebExecutionLock(m as never).runExclusive(scope(), async () => 1)).toEqual({ status: "unavailable" });
  });
  it("request resolving without ever calling back → unavailable", async () => {
    const m = { async request() { return undefined; } };
    expect(await createWebExecutionLock(m as never).runExclusive(scope(), async () => 1)).toEqual({ status: "unavailable" });
  });
  it("held by another run → held at once, and the task never runs", async () => {
    const m = new FakeLocks();
    const lock = createWebExecutionLock(m);
    const g = gate();
    const first = lock.runExclusive(scope(), async () => { await g.wait; return "first"; });
    let ran = 0;
    expect(await lock.runExclusive(scope(WALLET_MIXED), async () => { ran++; })).toEqual({ status: "held" });
    expect(await createWebExecutionLock(m).runExclusive(scope(), async () => { ran++; })).toEqual({ status: "held" }); // another adapter (tab)
    expect(ran).toBe(0);
    g.open();
    expect(await first).toEqual({ status: "ran", value: "first" });
  });
  it("a different plan or a different wallet runs while one is held", async () => {
    const m = new FakeLocks();
    const lock = createWebExecutionLock(m);
    const g = gate();
    const first = lock.runExclusive(scope(), async () => { await g.wait; });
    expect(await lock.runExclusive(scope(WALLET, PLAN2), async () => "p2")).toEqual({ status: "ran", value: "p2" });
    expect(await lock.runExclusive(scope(OTHER, PLAN), async () => "w2")).toEqual({ status: "ran", value: "w2" });
    g.open();
    await first;
  });
  it("released after success: the lock can be taken again", async () => {
    const m = new FakeLocks();
    const lock = createWebExecutionLock(m);
    expect(await lock.runExclusive(scope(), async () => 1)).toEqual({ status: "ran", value: 1 });
    expect(m.held.size).toBe(0);
    expect(await lock.runExclusive(scope(), async () => 2)).toEqual({ status: "ran", value: 2 });
  });
  it("a task that throws or rejects: its own error propagates (never 'unavailable'), and the lock is released", async () => {
    const m = new FakeLocks();
    const lock = createWebExecutionLock(m);
    const err = new Error("task failed");
    await expect(lock.runExclusive(scope(), async () => { throw err; })).rejects.toBe(err);
    expect(m.held.size).toBe(0);
    await expect(lock.runExclusive(scope(), () => Promise.reject(new TypeError("rejected")))).rejects.toThrow(TypeError);
    expect(m.held.size).toBe(0);
    expect(await lock.runExclusive(scope(), async () => "again")).toEqual({ status: "ran", value: "again" });
  });
  it("the lock is held until the task settles, not just until it starts", async () => {
    const m = new FakeLocks();
    const lock = createWebExecutionLock(m);
    const g = gate();
    const first = lock.runExclusive(scope(), async () => { await Promise.resolve(); await g.wait; });
    await Promise.resolve();
    expect(m.held.has(NAME)).toBe(true);
    expect((await lock.runExclusive(scope(), async () => 1)).status).toBe("held");
    g.open();
    await first;
    expect(m.held.size).toBe(0);
  });
  it("a manager calling back twice still runs the task once", async () => {
    let ran = 0;
    const m = { async request(_n: string, _o: unknown, cb: (l: unknown) => Promise<unknown>) { await cb({}); await cb({}); } };
    expect(await createWebExecutionLock(m).runExclusive(scope(), async () => ++ran)).toEqual({ status: "ran", value: 1 });
    expect(ran).toBe(1);
  });
  it("a manager failing AFTER the task finished doesn't hide the task's result", async () => {
    const m = { async request(_n: string, _o: unknown, cb: (l: unknown) => Promise<unknown>) { await cb({}); throw new Error("release failed"); } };
    expect(await createWebExecutionLock(m).runExclusive(scope(), async () => "done")).toEqual({ status: "ran", value: "done" });
  });
  it("a manager failing after reporting 'held' stays held (the task never ran)", async () => {
    let ran = 0;
    const m = { async request(_n: string, _o: unknown, cb: (l: unknown) => Promise<unknown>) { await cb(null); throw new Error("x"); } };
    expect(await createWebExecutionLock(m).runExclusive(scope(), async () => { ran++; })).toEqual({ status: "held" });
    expect(ran).toBe(0);
  });
  it("runs in Node with no browser globals", async () => {
    const g = globalThis as Record<string, unknown>;
    expect(g.window).toBeUndefined();
    expect((g.navigator as { locks?: unknown } | undefined)?.locks).toBeUndefined();
    expect(await createWebExecutionLock(new FakeLocks()).runExclusive(scope(), async () => 1)).toEqual({ status: "ran", value: 1 });
  });
});

/* ══ Source boundary ═══════════════════════════════════════════════════════ */

describe("source boundary: locks.ts", () => {
  const raw = readFileSync(join(__dirname, "..", "lib", "plans-client", "locks.ts"), "utf8");
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  it("imports only the journal's formats and the runner's types", () => {
    const specs = [...raw.matchAll(/^\s*(import|export)\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => `${m[1]} ${m[2] ?? ""}${m[3]}`);
    expect(specs).toEqual(["import ./journal", "import type ./runner", "export type ./runner"]);
    expect(raw).not.toMatch(/require\(|import\(/);
  });
  it("no network, signing, broadcasting, RPC, Plan Service, React, app, Ask, Telegram, automation or server-only", () => {
    for (const re of [
      /\bfetch\b/, /sendTransaction|signMessage|signTypedData|signTransaction|eth_send|personal_sign|privateKey|mnemonic/i,
      /getPublicClient|createPublicClient|rpc/i, /createPlanRunner|plans\.|\/api\/|lib\/plan\//, /react/i,
      /@\/app|lib\/ask|telegram|automation|server-only/i, /resolve(Recipient|Nad)/,
    ]) {
      expect(src).not.toMatch(re);
    }
  });
  it("no browser globals: the LockManager is injected", () => {
    expect(src).not.toMatch(/\b(localStorage|sessionStorage|window|navigator|document|globalThis)\b/);
  });
  it("never steals, never waits on a signal, never sets a timeout", () => {
    expect(src).not.toMatch(/\bsteal\b|\bsignal\b|setTimeout|setInterval/);
    expect(src).toMatch(/ifAvailable: true/);
    expect(src).toMatch(/mode: "exclusive"/);
  });
  it("no empty catch and no .catch", () => {
    expect(src).not.toMatch(/catch\s*(\([^)]*\))?\s*\{\s*\}/);
    expect(src).not.toMatch(/\.catch\(/);
  });
});
