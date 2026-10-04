import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ADDR_RE, createLocalJournal, HASH_RE, journalKey, NODE_ID_RE, PLAN_ID_RE, PlanJournalError, QUOTE_ID_RE,
  type JournalStorage,
} from "@/lib/plans-client/journal";
import { journalEntriesFor, type JournalEntry } from "@/lib/plans-client/runner";

/**
 * Phase 2C Stage 5C-2a — the localStorage-backed TxJournal adapter
 * (lib/plans-client/journal.ts), against an in-memory fake Storage. No DOM.
 */

const WALLET = "0x6b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c";
const WALLET_MIXED = "0x6B1C2d3E4f5A6b7C8d9E0f1A2b3C4d5E6f7A8b9C";
const OTHER = "0x3f2e1d0c9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f4e";
const PLAN = `plan_${"a".repeat(32)}`;
const PLAN2 = `plan_${"b".repeat(32)}`;
const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const QID = (n: number) => n.toString(16).padStart(32, "0");
const KEY = `payai_plan_journal:${WALLET}:${PLAN}`;
const entry = (o: Partial<JournalEntry> = {}): JournalEntry => ({ planId: PLAN, nodeId: "n1", quoteId: QID(1), txHash: H(1), ...o });

/** In-memory Storage with switchable failures. */
class FakeStorage implements JournalStorage {
  map = new Map<string, string>();
  writes: [string, string][] = [];
  failGet = false;
  failSet = false;
  failRemove = false;
  /** Readback returns this instead of the stored value (write not durable). */
  lie: string | null | undefined = undefined;
  getItem(k: string): string | null {
    if (this.failGet) throw new Error("SecurityError: read blocked");
    if (this.lie !== undefined && this.map.has(k)) return this.lie;
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    if (this.failSet) throw new Error("QuotaExceededError");
    this.writes.push([k, v]);
    this.map.set(k, String(v));
  }
  removeItem(k: string): void {
    if (this.failRemove) throw new Error("remove blocked");
    this.map.delete(k);
  }
}

const setup = (wallet = WALLET, planId = PLAN) => {
  const storage = new FakeStorage();
  return { storage, journal: createLocalJournal({ storage, wallet, planId }) };
};
const stored = (s: FakeStorage, key = KEY) => JSON.parse(s.map.get(key)!);

describe("key", () => {
  it("is payai_plan_journal:<lowercase wallet>:<planId>", () => {
    expect(journalKey(WALLET, PLAN)).toBe(KEY);
    expect(journalKey(WALLET_MIXED, PLAN)).toBe(KEY);
  });
  it("an invalid wallet throws — no silent normalising", () => {
    for (const w of ["", "0x123", `0X${WALLET.slice(2)}`, ` ${WALLET}`, `${WALLET} `, `${WALLET}00`, `0x${"g".repeat(40)}`, `${WALLET.slice(0, 41)}:`, null, undefined, 42]) {
      expect(() => journalKey(w as string, PLAN)).toThrow(PlanJournalError);
      expect(() => createLocalJournal({ storage: new FakeStorage(), wallet: w as string, planId: PLAN })).toThrow(PlanJournalError);
    }
  });
  it("an invalid plan id throws", () => {
    for (const p of ["", "plan_", `plan_${"A".repeat(32)}`, `plan_${"a".repeat(31)}`, `plan_${"a".repeat(33)}`, `plan_${"a".repeat(31)}:`, `PLAN_${"a".repeat(32)}`, ` ${PLAN}`, null, 7]) {
      expect(() => journalKey(WALLET, p as string)).toThrow(PlanJournalError);
      expect(() => createLocalJournal({ storage: new FakeStorage(), wallet: WALLET, planId: p as string })).toThrow(PlanJournalError);
    }
  });
  it("a missing storage object throws", () => {
    for (const s of [null, undefined, {}, { getItem() { return null; } }]) {
      expect(() => createLocalJournal({ storage: s as unknown as JournalStorage, wallet: WALLET, planId: PLAN })).toThrow(PlanJournalError);
    }
  });
  it("the formats match the runner's own (which keeps its copies private)", () => {
    const runner = readFileSync(join(__dirname, "..", "lib", "plans-client", "runner.ts"), "utf8");
    for (const [name, re] of [["ADDR_RE", ADDR_RE], ["HASH_RE", HASH_RE], ["QUOTE_ID_RE", QUOTE_ID_RE]] as const) {
      expect(runner).toContain(`const ${name} = ${re.toString()};`);
    }
    const store = readFileSync(join(__dirname, "..", "lib", "plan", "store.ts"), "utf8");
    expect(store).toContain(`const NODE_ID_RE = ${NODE_ID_RE.toString()};`);
    expect(PLAN_ID_RE.toString()).toBe("/^plan_[0-9a-f]{32}$/");
  });
});

describe("load", () => {
  it("a missing key → []", () => {
    const { journal } = setup();
    expect(journal.load(PLAN)).toEqual([]);
  });
  it("corrupt JSON throws — never [] for a value it can't read", () => {
    for (const raw of ["{", "not json", "", "[{]"]) {
      const { storage, journal } = setup();
      storage.map.set(KEY, raw);
      expect(() => journal.load(PLAN)).toThrow();
    }
  });
  it("valid JSON that isn't an array throws", () => {
    for (const raw of ["{}", "null", "1", '"x"', "true", JSON.stringify({ 0: entry() })]) {
      const { storage, journal } = setup();
      storage.map.set(KEY, raw);
      expect(() => journal.load(PLAN)).toThrow(PlanJournalError);
    }
  });
  it("returns entries as stored; the runner's journalEntriesFor rejects malformed ones", () => {
    const { storage, journal } = setup();
    storage.map.set(KEY, JSON.stringify([entry(), { ...entry({ nodeId: "n2" }), txHash: "0xbad" }]));
    const loaded = journal.load(PLAN);
    expect(loaded).toHaveLength(2);
    expect(journalEntriesFor(PLAN, loaded)).toBeNull();
  });
  it("another plan id is refused (the journal is bound to its plan)", () => {
    const { journal } = setup();
    expect(() => journal.load(PLAN2)).toThrow(PlanJournalError);
    expect(() => journal.load("nope")).toThrow(PlanJournalError);
  });
  it("storage read errors propagate", () => {
    const { storage, journal } = setup();
    storage.failGet = true;
    expect(() => journal.load(PLAN)).toThrow(/read blocked/);
  });
});

describe("save", () => {
  it("round trip: save → load gives exactly the entry, which the runner accepts", () => {
    const { storage, journal } = setup();
    journal.save(entry());
    expect(stored(storage)).toEqual([entry()]);
    expect(journal.load(PLAN)).toEqual([entry()]);
    expect(journalEntriesFor(PLAN, journal.load(PLAN))).toEqual([entry()]);
  });
  it("stores exactly { planId, nodeId, quoteId, txHash } — extra fields are dropped", () => {
    const { storage, journal } = setup();
    journal.save({ ...entry(), wallet: WALLET, quoteToken: "tok", calldata: "0x00", at: 1 } as JournalEntry);
    expect(Object.keys(stored(storage)[0])).toEqual(["planId", "nodeId", "quoteId", "txHash"]);
    expect(storage.map.get(KEY)).not.toMatch(/wallet|tok|calldata/);
  });
  it("a plan mismatch is rejected and nothing is written", () => {
    const { storage, journal } = setup();
    for (const planId of [PLAN2, "plan_x", "", undefined]) {
      expect(() => journal.save(entry({ planId: planId as string }))).toThrow(PlanJournalError);
    }
    expect(storage.writes).toEqual([]);
  });
  it("a malformed nodeId is rejected and nothing is written", () => {
    const { storage, journal } = setup();
    for (const nodeId of ["", "N1", "1n", "n".repeat(17), "n1:x", " n1", undefined, 3]) {
      expect(() => journal.save(entry({ nodeId: nodeId as string }))).toThrow(PlanJournalError);
    }
    expect(storage.writes).toEqual([]);
  });
  it("a malformed quoteId is rejected and nothing is written", () => {
    const { storage, journal } = setup();
    for (const quoteId of ["", QID(1).toUpperCase().replace(/0/g, "A"), QID(1).slice(1), `${QID(1)}0`, `0x${QID(1)}`, undefined]) {
      expect(() => journal.save(entry({ quoteId: quoteId as string }))).toThrow(PlanJournalError);
    }
    expect(storage.writes).toEqual([]);
  });
  it("a malformed txHash throws — not stored, repaired, truncated or ignored", () => {
    const bad = ["x", "0x", "0xabc", H(1).slice(0, 65), `${H(1)}0`, `0X${H(1).slice(2)}`, ` ${H(1)}`, `0x${"z".repeat(64)}`, H(1).slice(2), null, 5];
    for (const txHash of bad) {
      const { storage, journal } = setup();
      expect(() => journal.save(entry({ txHash: txHash as string }))).toThrow(PlanJournalError);
      expect(storage.writes).toEqual([]);
      expect(storage.map.size).toBe(0);
    }
  });
  it("a malformed txHash never reaches storage even when a journal already exists", () => {
    const { storage, journal } = setup();
    journal.save(entry());
    const before = storage.map.get(KEY);
    expect(() => journal.save(entry({ nodeId: "n2", txHash: "0xdeadbeef" }))).toThrow(PlanJournalError);
    expect(storage.writes).toHaveLength(1);
    expect(storage.map.get(KEY)).toBe(before);
  });
  it("the same transaction for the same step replaces its entry (no duplicates)", () => {
    const { storage, journal } = setup();
    journal.save(entry());
    journal.save(entry({ quoteId: QID(9), txHash: H(1).toUpperCase().replace("0X", "0x") }));
    expect(stored(storage)).toEqual([entry({ quoteId: QID(9), txHash: H(1).toUpperCase().replace("0X", "0x") })]);
  });
  it("different hashes for the same step are BOTH kept — the runner's recovery sees the conflict", () => {
    const { storage, journal } = setup();
    journal.save(entry());
    journal.save(entry({ quoteId: QID(2), txHash: H(2) }));
    expect(stored(storage)).toEqual([entry(), entry({ quoteId: QID(2), txHash: H(2) })]);
  });
  it("an existing malformed entry for the same step is kept as-is (the runner will refuse it), never replaced", () => {
    const { storage, journal } = setup();
    const junk = { planId: PLAN, nodeId: "n1", quoteId: QID(1) };
    storage.map.set(KEY, JSON.stringify([junk]));
    journal.save(entry());
    expect(stored(storage)).toEqual([junk, entry()]);
    expect(journalEntriesFor(PLAN, journal.load(PLAN))).toBeNull();
  });
  it("other steps are appended and preserved", () => {
    const { storage, journal } = setup();
    journal.save(entry());
    journal.save(entry({ nodeId: "n2", quoteId: QID(2), txHash: H(2) }));
    expect(stored(storage)).toEqual([entry(), entry({ nodeId: "n2", quoteId: QID(2), txHash: H(2) })]);
  });
  it("an unreadable existing journal is not overwritten — save throws", () => {
    for (const raw of ["{", "{}"]) {
      const { storage, journal } = setup();
      storage.map.set(KEY, raw);
      expect(() => journal.save(entry())).toThrow();
      expect(storage.map.get(KEY)).toBe(raw);
    }
  });
  it("storage write errors propagate", () => {
    const { storage, journal } = setup();
    storage.failSet = true;
    expect(() => journal.save(entry())).toThrow(/QuotaExceededError/);
  });
  it("storage read errors propagate", () => {
    const { storage, journal } = setup();
    storage.failGet = true;
    expect(() => journal.save(entry())).toThrow(/read blocked/);
  });
  it("a readback that doesn't match the write throws", () => {
    for (const lie of [null, "[]", "x"]) {
      const { storage, journal } = setup();
      storage.lie = lie;
      expect(() => journal.save(entry())).toThrow(PlanJournalError);
    }
  });
  it("a readback that throws propagates", () => {
    const { storage, journal } = setup();
    const orig = storage.setItem.bind(storage);
    storage.setItem = (k, v) => { orig(k, v); storage.failGet = true; };
    expect(() => journal.save(entry())).toThrow(/read blocked/);
  });
});

describe("clear", () => {
  it("removes only the requested step", () => {
    const { storage, journal } = setup();
    journal.save(entry());
    journal.save(entry({ quoteId: QID(2), txHash: H(2) }));
    journal.save(entry({ nodeId: "n2", quoteId: QID(3), txHash: H(3) }));
    journal.clear(PLAN, "n1");
    expect(stored(storage)).toEqual([entry({ nodeId: "n2", quoteId: QID(3), txHash: H(3) })]);
  });
  it("an emptied journal removes the key", () => {
    const { storage, journal } = setup();
    journal.save(entry());
    journal.clear(PLAN, "n1");
    expect(storage.map.has(KEY)).toBe(false);
    expect(journal.load(PLAN)).toEqual([]);
  });
  it("clearing a step with no entry changes nothing (no write)", () => {
    const { storage, journal } = setup();
    journal.clear(PLAN, "n1");
    journal.save(entry());
    const writes = storage.writes.length;
    journal.clear(PLAN, "n9");
    expect(storage.writes).toHaveLength(writes);
    expect(stored(storage)).toEqual([entry()]);
  });
  it("validates the plan and the step id", () => {
    const { journal } = setup();
    expect(() => journal.clear(PLAN2, "n1")).toThrow(PlanJournalError);
    expect(() => journal.clear(PLAN, "N1")).toThrow(PlanJournalError);
  });
  it("storage errors propagate (the runner decides what to do with them)", () => {
    const a = setup();
    a.journal.save(entry());
    a.storage.failRemove = true;
    expect(() => a.journal.clear(PLAN, "n1")).toThrow(/remove blocked/);
    expect(a.storage.map.has(KEY)).toBe(true);

    const b = setup();
    b.journal.save(entry());
    b.journal.save(entry({ nodeId: "n2", quoteId: QID(2), txHash: H(2) }));
    b.storage.failSet = true;
    expect(() => b.journal.clear(PLAN, "n1")).toThrow(/QuotaExceededError/);

    const c = setup();
    c.journal.save(entry());
    c.storage.failGet = true;
    expect(() => c.journal.clear(PLAN, "n1")).toThrow(/read blocked/);

    const d = setup();
    d.storage.map.set(KEY, "{");
    expect(() => d.journal.clear(PLAN, "n1")).toThrow();
    expect(d.storage.map.get(KEY)).toBe("{");
  });
});

describe("isolation", () => {
  it("wallets are isolated", () => {
    const storage = new FakeStorage();
    const a = createLocalJournal({ storage, wallet: WALLET, planId: PLAN });
    const b = createLocalJournal({ storage, wallet: OTHER, planId: PLAN });
    a.save(entry());
    expect(b.load(PLAN)).toEqual([]);
    b.save(entry({ txHash: H(2) }));
    expect(a.load(PLAN)).toEqual([entry()]);
    b.clear(PLAN, "n1");
    expect(a.load(PLAN)).toEqual([entry()]);
    expect([...storage.map.keys()]).toEqual([KEY]);
  });
  it("plans are isolated", () => {
    const storage = new FakeStorage();
    const a = createLocalJournal({ storage, wallet: WALLET, planId: PLAN });
    const b = createLocalJournal({ storage, wallet: WALLET, planId: PLAN2 });
    a.save(entry());
    b.save(entry({ planId: PLAN2, txHash: H(2) }));
    expect(a.load(PLAN)).toEqual([entry()]);
    expect(b.load(PLAN2)).toEqual([entry({ planId: PLAN2, txHash: H(2) })]);
    a.clear(PLAN, "n1");
    expect(b.load(PLAN2)).toHaveLength(1);
  });
  it("mixed-case spellings of one wallet share one key", () => {
    const storage = new FakeStorage();
    createLocalJournal({ storage, wallet: WALLET_MIXED, planId: PLAN }).save(entry());
    expect(createLocalJournal({ storage, wallet: WALLET.toUpperCase().replace("0X", "0x"), planId: PLAN }).load(PLAN)).toEqual([entry()]);
    expect([...storage.map.keys()]).toEqual([KEY]);
  });
  it("never touches keys other than its own", () => {
    const storage = new FakeStorage();
    storage.map.set("payai_pending_settlement", "keep");
    storage.map.set(`payai_plan_journal:${WALLET}:${PLAN2}`, "[]");
    const j = createLocalJournal({ storage, wallet: WALLET, planId: PLAN });
    j.save(entry());
    j.clear(PLAN, "n1");
    expect(storage.map.get("payai_pending_settlement")).toBe("keep");
    expect(storage.map.get(`payai_plan_journal:${WALLET}:${PLAN2}`)).toBe("[]");
  });
});

/* ══ Source boundary ═══════════════════════════════════════════════════════ */

/** Source with comments removed, so prose can't satisfy or trip a guard. */
function code(path: string): string {
  return readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

describe("source boundary: journal.ts", () => {
  const path = join(__dirname, "..", "lib", "plans-client", "journal.ts");
  const raw = readFileSync(path, "utf8");
  const src = code(path);
  it("imports only runner types", () => {
    const specs = [...raw.matchAll(/^\s*import\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => [m[1] ?? "", m[2]]);
    expect(specs).toEqual([["type ", "./runner"]]);
    expect(raw).not.toMatch(/require\(|import\(/);
  });
  it("no network, signing, Plan API, React, app, Ask, pendingSettlement or server-only", () => {
    for (const re of [/\bfetch\b/, /sendTransaction|signMessage|signTypedData|waitForReceipt/, /createPlanRunner|plans\.|\/api\//, /react/i, /@\/app|lib\/ask|pendingSettlement|server-only/]) {
      expect(src).not.toMatch(re);
    }
  });
  it("no browser globals", () => {
    expect(src).not.toMatch(/\b(localStorage|sessionStorage|window|navigator|document|globalThis)\b/);
  });
  it("swallows nothing: no try/catch, no .catch", () => {
    expect(src).not.toMatch(/\bcatch\b/);
    expect(src).not.toMatch(/\btry\b/);
  });
});
