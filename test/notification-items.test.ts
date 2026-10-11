import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dedupeByTx, historyTitle, txHref } from "@/lib/hooks/notificationItems";

/**
 * Every completed activity is in the bell, says what it was, and opens the
 * exact transaction in History:
 *  - a swap/trade row said "Payment sent";
 *  - every row opened History in general, not the transaction;
 *  - a swap via /api/swap/confirm produced two bell items (its history row
 *    and its swap_completed wallet event) for one transaction.
 */
const H = `0x${"ab".repeat(32)}`;

describe("titles say what happened", () => {
  it.each([
    [{ decision: "executed", feature: "payment", action: "send_payment" }, "Payment sent"],
    [{ decision: "executed", feature: "trade", action: "swap" }, "Swap completed"],
    [{ decision: "executed", action: "swap" }, "Swap completed"],
    [{ decision: "executed", feature: "protocol", action: "wrap", summary: "Wrapped 1 MON into WMON" }, "Wrapped 1 MON into WMON"],
    [{ decision: "error", feature: "trade", action: "swap" }, "Swap failed"],
    [{ decision: "error", feature: "payment" }, "Payment failed"],
    [{ decision: "blocked" }, "Payment blocked"],
    [{ decision: "needs_review" }, "Payment stopped — nothing was sent"],
  ])("%j → %s", (row, want) => {
    expect(historyTitle(row as never)).toBe(want);
  });
  it("unknown decisions aren't notifications", () => {
    expect(historyTitle({ decision: "info" } as never)).toBeNull();
  });
});

describe("links open the exact transaction", () => {
  it("goes to the Activity view filtered to that hash", () => {
    expect(txHref(H)).toBe(`/dashboard/transactions?tab=activity&tx=${H}`);
  });
  it("encodes nothing unexpected into the URL", () => {
    expect(txHref("0xabc&tab=x")).toBeNull();
  });
});

describe("one transaction, one notification", () => {
  it("keeps the first item for a hash (history before wallet events) and leaves hashless items alone", () => {
    const items = [
      { id: "h1", txHash: H, title: "Swap completed" },
      { id: "w1", txHash: H.toUpperCase().replace("0X", "0x"), title: "Swap completed (wallet)" },
      { id: "t1", title: "Support ticket submitted" },
      { id: "t2", title: "Wallet connected" },
    ];
    expect(dedupeByTx(items).map((i) => i.id)).toEqual(["h1", "t1", "t2"]);
  });
});

describe("the bell and the History page are wired to it", () => {
  const code = (p: string) => readFileSync(join(__dirname, "..", p), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  it("the bell uses these helpers for every source", () => {
    const src = code("lib/hooks/useNotifications.ts");
    expect(src).toMatch(/historyTitle\(/);
    expect(src).toMatch(/dedupeByTx\(/);
    expect((src.match(/txHref\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
  it("the Activity view honours ?tx=", () => {
    expect(code("components/dashboard/ActivityTabContent.tsx")).toMatch(/searchParams\.get\("tx"\)/);
  });
});
