import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { declineScheduling, routeRequest, SCHEDULING_DECLINED_REPLY } from "@/lib/ask/intent/classify";
import type { Understanding } from "@/lib/ask/intent/types";

/** Ask PayAI politely declines scheduled and recurring requests (Oct 2026);
 *  automations stay in the backend and the dashboard. */
async function answer(text: string): Promise<Understanding> {
  const r = await routeRequest(text, null, []);
  return declineScheduling((r.understanding ?? r.fallback)!);
}

describe("scheduled and recurring requests in Ask PayAI", () => {
  for (const text of [
    "Send 20 USDC to bob.nad every Friday",
    "Send 200 USDC to john.nad tomorrow",
    "pay alice.nad 5 MON monthly",
    "send 10 USDC to bob.nad every friday and swap 5 MON to USDC",
  ]) {
    it(`declines: ${text}`, async () => {
      const u = await answer(text);
      expect(u).toMatchObject({ outcome: "unsupported", capability: "scheduling_unavailable", reply: SCHEDULING_DECLINED_REPLY });
    });
  }
  it("an incomplete schedule (still asking for a detail) is declined too, not continued", () => {
    const u = declineScheduling({ kind: "recurring_payment", outcome: "incomplete", slots: {}, missing: ["amount"], question: "How much?" } as unknown as Understanding);
    expect(u.outcome).toBe("unsupported");
  });
  it("ordinary requests are untouched", async () => {
    expect((await answer("What's my USDC balance?")).kind).toBe("token_balance");
    expect((await answer("Create a room for 100 USDC for 5 people")).kind).toBe("room");
  });
  it("applies to everything understand() returns — rule-based or the model's", () => {
    const src = readFileSync("lib/ask/intent/classify.ts", "utf8");
    expect(src).toMatch(/export async function understand\([^)]*\)[^{]*\{\s*return declineScheduling\(await understandWithScheduling\(text, history, pending\)\);\s*\}/);
    // The API route serves understand(), never the raw one.
    expect(readFileSync("app/api/ask/understand/route.ts", "utf8")).not.toMatch(/understandWithScheduling/);
  });
});

describe("Payments & Automations has no Swap tab", () => {
  it("the tab is gone and the old address goes to Ask PayAI", () => {
    expect(readFileSync("components/dashboard/Sidebar.tsx", "utf8")).not.toMatch(/label: "Swap"/);
    expect(readFileSync("app/dashboard/swap/page.tsx", "utf8")).toMatch(/redirect\("\/dashboard\/ask"\)/);
  });
});
