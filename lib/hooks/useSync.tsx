"use client";

/**
 * One refresh for the whole dashboard.
 *
 * Every surface used to own its own polling: balances on one timer, the
 * notification feed on another, the overview's five fetches on a third. Which
 * meant "is what I'm looking at current?" had no answer — parts of the screen
 * were seconds old and parts were minutes old, with nothing to say which.
 *
 * Anything that reads live state registers a refresher here. A single sync
 * runs all of them together and reports when it finished, so the page has one
 * freshness, one spinner, and one moment where everything becomes true at
 * once.
 *
 * It is also what makes "you never need to refresh after a swap" real: the
 * swap flow calls `sync()` on completion and every registered surface —
 * balances, portfolio, history, notifications — updates itself. No surface has
 * to know a swap exists.
 */
import {
  createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode,
} from "react";

type Refresher = () => void | Promise<unknown>;

interface SyncState {
  /** Run every registered refresher. Concurrent calls collapse into the
   *  in-flight one rather than stacking. */
  sync: () => Promise<void>;
  /** True while a sync is running — drives the spinner and disables the
   *  button, so a user cannot queue five syncs by tapping five times. */
  syncing: boolean;
  /** When the last sync finished, or null before the first one. */
  lastSyncedAt: number | null;
  /** Register a refresher for the lifetime of the calling component.
   *  Returns an unregister function. */
  register: (fn: Refresher) => () => void;
}

const SyncContext = createContext<SyncState | null>(null);

/** How often the dashboard refreshes itself without being asked. */
const AUTO_SYNC_MS = 20_000;
const TX_EVENT = "payai:transaction";
const TX_FOLLOW_UP_MS = 5_000;

/**
 * Tells the dashboard a transaction just confirmed, so balances, history and
 * notifications refresh now instead of on the next 20 s tick. Fire-and-forget;
 * a no-op outside the browser.
 */
export function announceTransaction(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(TX_EVENT));
}

export function SyncProvider({ children }: { children: ReactNode }) {
  // A ref, not state: registering must not re-render every consumer, and a
  // refresher registered during render has to be visible to a sync that
  // starts immediately afterwards.
  const refreshers = useRef(new Set<Refresher>());
  const inFlight = useRef<Promise<void> | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);

  const register = useCallback((fn: Refresher) => {
    refreshers.current.add(fn);
    return () => { refreshers.current.delete(fn); };
  }, []);

  const sync = useCallback(async () => {
    // Collapse rather than queue. Tapping refresh three times should mean one
    // sync, not three rounds of the same requests fighting each other.
    if (inFlight.current) return inFlight.current;

    setSyncing(true);
    const run = (async () => {
      // allSettled: one dead endpoint must not stop every other surface from
      // updating, and a sync that half-worked is still better than none.
      await Promise.allSettled([...refreshers.current].map((fn) => fn()));
    })()
      .catch(() => {})
      .finally(() => {
        setLastSyncedAt(Date.now());
        setSyncing(false);
        inFlight.current = null;
      });

    inFlight.current = run;
    return run;
  }, []);

  // Keep the background cadence the individual surfaces used to run
  // themselves, but as one heartbeat. Paused while the tab is hidden —
  // background polling drains a phone battery for a screen nobody is looking
  // at — and fired on return so coming back shows current data.
  useEffect(() => {
    void sync();
    const timer = setInterval(() => { if (!document.hidden) void sync(); }, AUTO_SYNC_MS);
    const onVisible = () => { if (!document.hidden) void sync(); };
    document.addEventListener("visibilitychange", onVisible);
    // A transaction confirmed somewhere in the app: refresh now so it shows
    // (and pops up) straight away, and once more shortly after for records
    // the server writes a moment after the receipt.
    let followUp: ReturnType<typeof setTimeout> | undefined;
    const onTransaction = () => {
      void sync();
      clearTimeout(followUp);
      followUp = setTimeout(() => void sync(), TX_FOLLOW_UP_MS);
    };
    window.addEventListener(TX_EVENT, onTransaction);
    return () => {
      clearInterval(timer);
      clearTimeout(followUp);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener(TX_EVENT, onTransaction);
    };
  }, [sync]);

  return (
    <SyncContext.Provider value={{ sync, syncing, lastSyncedAt, register }}>
      {children}
    </SyncContext.Provider>
  );
}

/**
 * The dashboard's shared refresh. Safe to call outside the provider — it
 * degrades to a no-op rather than throwing, so a component can be rendered in
 * isolation (or on a page without the provider) without special-casing.
 */
export function useSync(): SyncState {
  return useContext(SyncContext) ?? FALLBACK;
}

const FALLBACK: SyncState = {
  sync: async () => {},
  syncing: false,
  lastSyncedAt: null,
  register: () => () => {},
};

/**
 * Registers `fn` as part of the global sync for as long as the component is
 * mounted. The callback is held in a ref, so a refresher that closes over
 * changing values stays current without re-registering on every render.
 */
export function useSyncRefresher(fn: Refresher): void {
  const { register } = useSync();
  const latest = useRef(fn);
  // Updated in an effect, not during render: writing a ref while rendering is
  // a side effect, and React is entitled to render without committing.
  useEffect(() => { latest.current = fn; });
  useEffect(() => register(() => latest.current()), [register]);
}

/** "just now", "12s ago", "3m ago" — the freshness line under the button. */
export function syncAgo(at: number | null, now: number = Date.now()): string {
  if (at == null) return "Syncing…";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 5) return "Last synced: just now";
  if (seconds < 60) return `Last synced: ${seconds} seconds ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Last synced: ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  return `Last synced: ${hours} hour${hours === 1 ? "" : "s"} ago`;
}
