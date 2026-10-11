import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The bell's feed is four requests per load (including a transaction-history
 * read from storage). The dashboard's SyncProvider already refreshes every
 * registered surface every 20 s (and on return to the tab), and useNotifications
 * registers with it. A second 20 s timer of its own made every load run twice
 * per cycle. The shared heartbeat is the only poller.
 */
const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("notifications are polled once, by the shared heartbeat", () => {
  const hook = code(read("lib/hooks/useNotifications.ts"));
  it("registers with the shared sync", () => {
    expect(hook).toMatch(/useSyncRefresher\(/);
  });
  it("sets no timer of its own", () => {
    expect(hook).not.toMatch(/setInterval\s*\(/);
  });
  it("still loads once when the wallet appears or changes, and skips hidden tabs", () => {
    expect(hook).toMatch(/\bload\(\);/);
    expect(hook).toMatch(/document\.hidden/);
  });
  it("the only caller sits under SyncProvider, so the heartbeat always reaches it", () => {
    const layout = code(read("app/dashboard/layout.tsx"));
    expect(layout).toMatch(/<SyncProvider>[\s\S]*<DashboardChrome>/);
    expect(layout).toMatch(/useNotifications\(/);
  });
  it("the heartbeat itself polls on an interval and pauses when hidden", () => {
    const sync = code(read("lib/hooks/useSync.tsx"));
    expect(sync).toMatch(/setInterval\(/);
    expect(sync).toMatch(/document\.hidden/);
  });
});
