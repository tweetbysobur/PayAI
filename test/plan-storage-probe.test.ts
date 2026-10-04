import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROBE_KEY_PREFIX, probeStorage, type ProbeStorage } from "@/lib/plans-client/storage";

/**
 * Phase 2C Stage 5C-2a — the storage preflight (lib/plans-client/storage.ts),
 * against an in-memory fake Storage. No DOM.
 */

type Fail = "get" | "set" | "remove";
class FakeStorage implements ProbeStorage {
  map = new Map<string, string>();
  keys: string[] = [];
  fail = new Set<Fail>();
  /** getItem returns this for any key that is present. */
  lie: string | undefined = undefined;
  /** removeItem silently does nothing. */
  sticky = false;
  getItem(k: string) {
    if (this.fail.has("get")) throw new Error("read blocked");
    if (!this.map.has(k)) return null;
    return this.lie ?? this.map.get(k)!;
  }
  setItem(k: string, v: string) {
    this.keys.push(k);
    if (this.fail.has("set")) throw new Error("QuotaExceededError");
    this.map.set(k, v);
  }
  removeItem(k: string) {
    if (this.fail.has("remove")) throw new Error("remove blocked");
    if (!this.sticky) this.map.delete(k);
  }
}

describe("probeStorage", () => {
  it("working storage → ok, and the probe key is gone afterwards", () => {
    const s = new FakeStorage();
    s.map.set("other", "keep");
    expect(probeStorage(s)).toEqual({ ok: true });
    expect([...s.map.entries()]).toEqual([["other", "keep"]]);
    expect(s.keys).toHaveLength(1);
    expect(s.keys[0].startsWith(PROBE_KEY_PREFIX)).toBe(true);
  });
  it("accepts a getter; a getter that throws or returns nothing → unavailable", () => {
    expect(probeStorage(() => new FakeStorage())).toEqual({ ok: true });
    expect(probeStorage(() => { throw new Error("SecurityError"); })).toEqual({ ok: false, reason: "unavailable" });
    expect(probeStorage(() => null)).toEqual({ ok: false, reason: "unavailable" });
  });
  it("no usable storage object → unavailable", () => {
    for (const s of [null, undefined, {}, { getItem() { return null; }, setItem() {} }, "localStorage", 1]) {
      expect(probeStorage(s as unknown as ProbeStorage)).toEqual({ ok: false, reason: "unavailable" });
    }
  });
  it("write failure → write_failed, nothing left behind", () => {
    const s = new FakeStorage();
    s.fail.add("set");
    expect(probeStorage(s)).toEqual({ ok: false, reason: "write_failed" });
    expect(s.map.size).toBe(0);
  });
  it("read failure → readback_mismatch, and the probe value is removed", () => {
    const s = new FakeStorage();
    s.fail.add("get");
    expect(probeStorage(s)).toEqual({ ok: false, reason: "readback_mismatch" });
    expect(s.map.size).toBe(0);
  });
  it("a different value read back → readback_mismatch, and the probe value is removed", () => {
    for (const lie of ["", "probe:other", "x"]) {
      const s = new FakeStorage();
      s.lie = lie;
      expect(probeStorage(s)).toEqual({ ok: false, reason: "readback_mismatch" });
      expect(s.map.size).toBe(0);
    }
  });
  it("a write that doesn't persist (read gives null) → readback_mismatch", () => {
    const s = new FakeStorage();
    s.setItem = (k) => { s.keys.push(k); };
    expect(probeStorage(s)).toEqual({ ok: false, reason: "readback_mismatch" });
  });
  it("remove throwing → remove_failed", () => {
    const s = new FakeStorage();
    s.fail.add("remove");
    expect(probeStorage(s)).toEqual({ ok: false, reason: "remove_failed" });
  });
  it("remove not taking effect → remove_failed", () => {
    const s = new FakeStorage();
    s.sticky = true;
    expect(probeStorage(s)).toEqual({ ok: false, reason: "remove_failed" });
  });
  it("the check after remove throwing → remove_failed", () => {
    const s = new FakeStorage();
    const remove = s.removeItem.bind(s);
    s.removeItem = (k) => { remove(k); s.fail.add("get"); };
    expect(probeStorage(s)).toEqual({ ok: false, reason: "remove_failed" });
  });
  it("never throws for storage failures, whatever kind of value is thrown", () => {
    for (const thrown of [new Error("x"), "string", null, undefined, { code: 22 }]) {
      for (const method of ["getItem", "setItem", "removeItem"] as const) {
        const s = new FakeStorage();
        s[method] = () => { throw thrown; };
        expect(() => probeStorage(s)).not.toThrow();
        expect(probeStorage(s).ok).toBe(false);
      }
    }
  });
  it("each probe uses its own key and value", () => {
    const s = new FakeStorage();
    const values: string[] = [];
    const set = s.setItem.bind(s);
    s.setItem = (k, v) => { values.push(v); set(k, v); };
    for (let i = 0; i < 50; i++) expect(probeStorage(s)).toEqual({ ok: true });
    expect(new Set(s.keys).size).toBe(50);
    expect(new Set(values).size).toBe(50);
    expect(s.map.size).toBe(0);
  });
  it("keys stay unique even if the random source is broken", () => {
    const real = globalThis.crypto;
    Object.defineProperty(globalThis, "crypto", { value: { getRandomValues: (a: Uint8Array) => a }, configurable: true });
    try {
      const s = new FakeStorage();
      probeStorage(s);
      probeStorage(s);
      expect(new Set(s.keys).size).toBe(2);
    } finally {
      Object.defineProperty(globalThis, "crypto", { value: real, configurable: true });
    }
  });
  it("an injected probe id is used for the key", () => {
    const s = new FakeStorage();
    expect(probeStorage(s, { probeId: () => "fixed" })).toEqual({ ok: true });
    expect(s.keys).toEqual([`${PROBE_KEY_PREFIX}fixed`]);
  });
  it("never touches the plan journal or other keys", () => {
    const s = new FakeStorage();
    s.map.set(`payai_plan_journal:0x${"1".repeat(40)}:plan_${"a".repeat(32)}`, "[]");
    expect(probeStorage(s)).toEqual({ ok: true });
    expect(s.map.size).toBe(1);
    expect(PROBE_KEY_PREFIX.startsWith("payai_plan_journal:")).toBe(false);
  });
  it("runs in Node with no browser globals", () => {
    const g = globalThis as Record<string, unknown>;
    expect(g.localStorage).toBeUndefined();
    expect(g.window).toBeUndefined();
    expect(probeStorage(new FakeStorage())).toEqual({ ok: true });
  });
});

/* ══ Source boundary ═══════════════════════════════════════════════════════ */

describe("source boundary: storage.ts", () => {
  const path = join(__dirname, "..", "lib", "plans-client", "storage.ts");
  const raw = readFileSync(path, "utf8");
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  it("imports nothing", () => {
    expect(raw).not.toMatch(/^\s*import\s/m);
    expect(raw).not.toMatch(/require\(|import\(/);
  });
  it("no network, signing, Plan API or React", () => {
    for (const re of [/\bfetch\b/, /sendTransaction|signMessage|signTypedData|waitForReceipt/, /createPlanRunner|plans\.|\/api\//, /react/i]) {
      expect(src).not.toMatch(re);
    }
  });
  it("no browser storage or DOM globals", () => {
    expect(src).not.toMatch(/\b(localStorage|sessionStorage|window|navigator|document)\b/);
  });
  it("swallows nothing: the one catch turns a failure into false, and every false is reported", () => {
    expect(src.match(/\bcatch\b/g)).toHaveLength(1);
    expect(src).toMatch(/catch\s*\{\s*return false;\s*\}/);
    expect(src).not.toMatch(/catch\s*(\([^)]*\))?\s*\{\s*\}/);
    expect(src).not.toMatch(/\.catch\(/);
  });
});
