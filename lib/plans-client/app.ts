/**
 * The app's one way to EXECUTE a plan: wires the existing Plan Runner to the
 * browser for one wallet + plan, runs it, and classifies the outcome.
 *
 *   storage probe → journal (localStorage, bound to wallet + plan)
 *   → Web Locks execution lock → same-origin HTTP transports (grant cookie)
 *   → createPlanRunner(...).run(planId) → classifyOutcome
 *
 * Everything that makes execution safe lives in the runner and the server —
 * the lock, the journal, signing-intent ordering, the single send, /tx,
 * confirm, settle, and the no-rebroadcast / no-restart classification. This
 * file only supplies the browser's capabilities to it. UI code calls
 * runPlanInApp and nothing else to execute: it never signs, sends, or talks
 * to /tx, intent, release, build or confirm itself.
 *
 * Browser-safe: imports only lib/plans-client. The storage, lock manager,
 * HTTP and clock parameters exist so tests can supply them; in the app they
 * default to the browser's own.
 */
import {
  createHttpTransports, createPlanRunner, systemClock,
  type Clock, type HttpFn, type QuoteDecision, type QuoteProjection, type RunOutcome, type RunOutcomeKind,
  type RunnerEvent, type RunnerWallet,
} from "./runner";
import { ADDR_RE, createLocalJournal, PLAN_ID_RE, type JournalStorage } from "./journal";
import { createWebExecutionLock, type LockManagerLike } from "./locks";
import { probeStorage } from "./storage";
import { classifyOutcome, classifyRunError, type OutcomeClass } from "./outcomes";

export interface AppRunOptions {
  planId: string;
  /** The wallet as it is NOW, read afresh by the runner at every check. */
  wallet: () => RunnerWallet | null;
  /** The chain every signature must happen on. */
  chainId: number;
  /** Shown each bound quote before anything is built; only "continue" proceeds. */
  confirmQuote?: (quote: QuoteProjection) => Promise<QuoteDecision>;
  onEvent?: (event: RunnerEvent) => void;
  signal?: AbortSignal;
  /** Defaults to window.localStorage. */
  storage?: JournalStorage | null | (() => JournalStorage | null | undefined);
  /** Defaults to navigator.locks. */
  locks?: LockManagerLike | null | (() => LockManagerLike | null | undefined);
  http?: HttpFn;
  baseUrl?: string;
  clock?: Clock;
}

export interface AppRunResult {
  outcome: RunOutcome;
  cls: OutcomeClass;
}

/** The same wording the runner uses for these kinds, for the stops that
 *  happen here before the runner is created. */
const BEFORE: Partial<Record<RunOutcomeKind, string>> = {
  wallet_locked: "Connect or unlock your wallet to continue.",
  journal_unavailable: "Couldn't read this browser's record of sent transactions, so nothing was signed.",
  not_found: "This plan or step wasn't found.",
  invalid_response: "PayAI returned something unexpected, so nothing further was done.",
};

function before(planId: string, kind: RunOutcomeKind, code: string | null): RunOutcome {
  return {
    kind, planId, message: BEFORE[kind] ?? "", nodeId: null, quoteId: null, txHash: null,
    approvalTxHashes: [], code, status: null, journaled: null, plan: null,
  };
}

const settled = (outcome: RunOutcome): AppRunResult => ({ outcome, cls: classifyOutcome(outcome) });

function defaultStorage(): JournalStorage | null {
  try {
    return (globalThis as { localStorage?: JournalStorage }).localStorage ?? null;
  } catch {
    return null; // a blocked storage getter is "no storage"
  }
}

function defaultLocks(): LockManagerLike | null {
  try {
    return (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks ?? null;
  } catch {
    return null;
  }
}

function resolve<T>(source: T | null | undefined | (() => T | null | undefined)): T | null {
  try {
    const v = typeof source === "function" ? (source as () => T | null | undefined)() : source;
    return v ?? null;
  } catch {
    return null;
  }
}

/**
 * Run one plan through the existing runner. Resolves with the runner's own
 * outcome and its classification; never throws. Stops BEFORE creating a
 * runner (and so before any request) when there is no usable wallet, the
 * plan id is malformed, or this browser can't keep the transaction journal.
 */
export async function runPlanInApp(opts: AppRunOptions): Promise<AppRunResult> {
  const planId = opts.planId;
  if (typeof planId !== "string" || !PLAN_ID_RE.test(planId)) return settled(before(String(planId), "not_found", "INVALID_PLAN_ID"));

  let wallet: RunnerWallet | null;
  try {
    wallet = opts.wallet();
  } catch {
    wallet = null;
  }
  const address = wallet && typeof wallet.address === "string" && ADDR_RE.test(wallet.address) ? wallet.address : null;
  if (!address) return settled(before(planId, "wallet_locked", null));

  // The journal is the record of a sent transaction: if this browser can't
  // keep it reliably, nothing may be signed.
  const storage = opts.storage === undefined ? defaultStorage() : resolve(opts.storage);
  if (!storage || !probeStorage(storage).ok) return settled(before(planId, "journal_unavailable", "STORAGE_UNAVAILABLE"));
  let journal: ReturnType<typeof createLocalJournal>;
  try {
    journal = createLocalJournal({ storage, wallet: address, planId });
  } catch {
    return settled(before(planId, "journal_unavailable", "STORAGE_UNAVAILABLE"));
  }

  const lockSource = opts.locks === undefined ? defaultLocks : () => resolve(opts.locks);
  const transports = createHttpTransports({ ...(opts.http ? { http: opts.http } : {}), ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}) });

  try {
    const runner = createPlanRunner({
      wallet: opts.wallet,
      plans: transports.plans,
      sdk: transports.sdk,
      grant: transports.grant,
      clock: opts.clock ?? systemClock,
      journal,
      lock: createWebExecutionLock(lockSource),
      chainId: opts.chainId,
      ...(opts.confirmQuote ? { confirmQuote: opts.confirmQuote } : {}),
      ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
    });
    return settled(await runner.run(planId, opts.signal ? { signal: opts.signal } : undefined));
  } catch (e) {
    // A configuration error or an unexpected throw: nothing is known about
    // what happened, so the classification is the fail-closed one.
    return { outcome: before(planId, "invalid_response", "RUN_ERROR"), cls: classifyRunError(e) };
  }
}
