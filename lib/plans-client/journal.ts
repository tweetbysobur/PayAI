/**
 * Plan transaction journal (Phase 2C, Stage 5C-2a): the localStorage-backed
 * implementation of the runner's TxJournal port (lib/plans-client/runner.ts).
 *
 *   createLocalJournal({ storage, wallet, planId }) → TxJournal
 *
 * The journal is the runner's only record of a transaction that was sent but
 * not yet recorded by the Plan API. Losing or corrupting it can hide a sent
 * transaction, so this adapter fails LOUDLY: every storage error, unreadable
 * value or invalid entry throws, and the runner decides what that means
 * (journal_unavailable on load, tx_unrecorded with journaled:false on save).
 * Nothing here returns [] for a value it can't read, and nothing here catches.
 *
 * One journal is bound to one wallet and one plan:
 *
 *   payai_plan_journal:<lowercase wallet>:<planId>
 *
 * Both parts are validated before any key is built (neither can contain ":"),
 * and a call for any other plan throws. The stored value is exactly an array
 * of { planId, nodeId, quoteId, txHash } — nothing else.
 *
 * Storage is injected (a Storage-like object): no browser global is read, so
 * the module is usable in Node and tests.
 */
import type { JournalEntry, TxJournal } from "./runner";

/** The subset of the Web Storage API the journal uses. */
export interface JournalStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

// The same formats the runner and the Plan Service use (the runner keeps its
// copies private; test/plan-journal.test.ts checks these stay identical).
export const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
export const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
export const QUOTE_ID_RE = /^[0-9a-f]{32}$/;
export const NODE_ID_RE = /^[a-z][a-z0-9_-]{0,15}$/;
export const PLAN_ID_RE = /^plan_[0-9a-f]{32}$/;

export const JOURNAL_KEY_PREFIX = "payai_plan_journal:";

export class PlanJournalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanJournalError";
  }
}

const isStr = (v: unknown): v is string => typeof v === "string";

/** The storage key for a wallet's journal of one plan. Throws on a malformed
 *  wallet or plan id — a key is never built from either. */
export function journalKey(wallet: string, planId: string): string {
  if (!isStr(wallet) || !ADDR_RE.test(wallet)) throw new PlanJournalError("Invalid wallet address for the plan journal.");
  if (!isStr(planId) || !PLAN_ID_RE.test(planId)) throw new PlanJournalError("Invalid plan id for the plan journal.");
  return `${JOURNAL_KEY_PREFIX}${wallet.toLowerCase()}:${planId}`;
}

export function createLocalJournal(opts: { storage: JournalStorage; wallet: string; planId: string }): TxJournal {
  const { storage, wallet, planId: boundPlan } = opts;
  const key = journalKey(wallet, boundPlan);
  if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function" || typeof storage.removeItem !== "function") {
    throw new PlanJournalError("The plan journal needs a storage object.");
  }

  const ownPlan = (planId: unknown) => {
    if (!isStr(planId) || !PLAN_ID_RE.test(planId)) throw new PlanJournalError("Invalid plan id for the plan journal.");
    if (planId !== boundPlan) throw new PlanJournalError("This journal belongs to a different plan.");
  };

  /** The stored array, as stored; [] only when there is no value at all. */
  const read = (): unknown[] => {
    const raw = storage.getItem(key);
    if (raw === null) return [];
    if (!isStr(raw)) throw new PlanJournalError("The plan journal returned an unreadable value.");
    const parsed: unknown = JSON.parse(raw); // a SyntaxError propagates
    if (!Array.isArray(parsed)) throw new PlanJournalError("The plan journal is not a list.");
    return parsed;
  };

  /** Write, then read back: what's stored must be exactly what was written. */
  const write = (entries: unknown[]) => {
    const json = JSON.stringify(entries);
    storage.setItem(key, json);
    if (storage.getItem(key) !== json) throw new PlanJournalError("The plan journal write could not be verified.");
  };

  const nodeOf = (v: unknown): unknown => (v !== null && typeof v === "object" ? (v as { nodeId?: unknown }).nodeId : undefined);
  const hashOf = (v: unknown): unknown => (v !== null && typeof v === "object" ? (v as { txHash?: unknown }).txHash : undefined);

  return {
    load(planId: string): readonly JournalEntry[] {
      ownPlan(planId);
      // Entry-level validation is the runner's (journalEntriesFor): a
      // malformed entry makes the whole journal unusable there.
      return read() as JournalEntry[];
    },

    save(entry: JournalEntry): void {
      if (entry === null || typeof entry !== "object") throw new PlanJournalError("Invalid journal entry.");
      const { planId, nodeId, quoteId, txHash } = entry;
      ownPlan(planId);
      if (!isStr(nodeId) || !NODE_ID_RE.test(nodeId)) throw new PlanJournalError("Invalid step id for the plan journal.");
      if (!isStr(quoteId) || !QUOTE_ID_RE.test(quoteId)) throw new PlanJournalError("Invalid quote id for the plan journal.");
      if (!isStr(txHash) || !HASH_RE.test(txHash)) throw new PlanJournalError("Invalid transaction hash for the plan journal.");
      const clean: JournalEntry = { planId, nodeId, quoteId, txHash };

      const entries = read();
      // The same transaction again replaces its entry; a DIFFERENT
      // transaction for the same step is kept alongside, never overwritten,
      // so the runner's recovery sees both.
      const same = entries.findIndex((e) => nodeOf(e) === nodeId && isStr(hashOf(e)) && (hashOf(e) as string).toLowerCase() === txHash.toLowerCase());
      if (same >= 0) entries[same] = clean;
      else entries.push(clean);
      write(entries);
    },

    clear(planId: string, nodeId: string): void {
      ownPlan(planId);
      if (!isStr(nodeId) || !NODE_ID_RE.test(nodeId)) throw new PlanJournalError("Invalid step id for the plan journal.");
      const entries = read();
      const kept = entries.filter((e) => nodeOf(e) !== nodeId);
      if (kept.length === entries.length) return;
      if (kept.length === 0) {
        storage.removeItem(key);
        if (storage.getItem(key) !== null) throw new PlanJournalError("The plan journal could not be cleared.");
        return;
      }
      write(kept);
    },
  };
}
