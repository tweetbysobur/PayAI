import { describe, it, expect } from "vitest";
import { createSchedule, listSchedules, cancelSchedule } from "@/lib/platform/schedules";
import { createLink, listLinks, recordTx } from "@/lib/platform/store";
import { ask } from "@/lib/platform/assistant";

// Regression coverage for a real privacy bug: on the shared demo tenant, every
// wallet-only user (no merchant account) resolves to the SAME merchantId, so
// payment automations and payment links must be scoped by the creating wallet
// or one user can see/cancel another user's real data. No KV env is set in
// the test runner, so these exercise the in-memory fallback path.

const TENANT = "demo";
const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";

describe("payment automations — wallet scoping on the shared tenant", () => {
  it("a wallet only sees its own automations, not another wallet's", async () => {
    await createSchedule(TENANT, { amount: 10, token: "USDC", recipient: "0xabc", cadence: "weekly", nextRun: Date.now() + 1000, sender: ALICE });
    await createSchedule(TENANT, { amount: 20, token: "USDC", recipient: "0xdef", cadence: "weekly", nextRun: Date.now() + 1000, sender: BOB });

    const aliceView = await listSchedules(TENANT, { sender: ALICE });
    const bobView = await listSchedules(TENANT, { sender: BOB });

    expect(aliceView.every((s) => s.sender === ALICE)).toBe(true);
    expect(bobView.every((s) => s.sender === BOB)).toBe(true);
    expect(aliceView.some((s) => s.sender === BOB)).toBe(false);
  });

  it("no wallet given on the shared tenant returns nothing (never 'show everyone')", async () => {
    await createSchedule(TENANT, { amount: 5, token: "MON", recipient: "0xaaa", cadence: "once", nextRun: Date.now() + 1000, sender: ALICE });
    const anon = await listSchedules(TENANT, { sender: "__none__" });
    expect(anon).toHaveLength(0);
  });

  it("a wallet cannot cancel another wallet's automation", async () => {
    const row = await createSchedule(TENANT, { amount: 15, token: "USDC", recipient: "0xbbb", cadence: "monthly", nextRun: Date.now() + 1000, sender: ALICE });
    const asBob = await cancelSchedule(TENANT, row.id, { sender: BOB });
    expect(asBob).toBeNull();
    const asAlice = await cancelSchedule(TENANT, row.id, { sender: ALICE });
    expect(asAlice?.status).toBe("cancelled");
  });
});

describe("payment links — wallet scoping on the shared tenant", () => {
  it("a wallet only sees its own links, not another wallet's", async () => {
    await createLink(TENANT, { amount: 30, sender: ALICE });
    await createLink(TENANT, { amount: 40, sender: BOB });

    const aliceView = await listLinks(TENANT, { sender: ALICE });
    expect(aliceView.every((l) => l.sender === ALICE)).toBe(true);
    expect(aliceView.some((l) => l.sender === BOB)).toBe(false);
  });

  it("no wallet given on the shared tenant returns nothing", async () => {
    await createLink(TENANT, { amount: 50, sender: ALICE });
    const anon = await listLinks(TENANT, { sender: "__none__" });
    expect(anon).toHaveLength(0);
  });
});

describe("AI assistant — wallet scoping on the shared tenant", () => {
  // The assistant answers the same kinds of questions /api/agent does
  // ("show me recent transactions", "who are my customers") but read its
  // transactions UNSCOPED, so an anonymous caller got back every other
  // wallet's payments on the shared tenant — sender addresses, amounts and
  // counterparties included.
  const CAROL = "0x3333333333333333333333333333333333333333";
  const DAVE = "0x4444444444444444444444444444444444444444";

  async function seed(sender: string, amount: number, summary: string) {
    await recordTx(TENANT, {
      sender, summary, decision: "executed", amount, token: "USDC", action: "payment",
    } as Parameters<typeof recordTx>[1]);
  }

  // Every row gets a real crypto.randomUUID() id (see lib/platform/store.ts),
  // so asserting the bare literal "4242" never appears ANYWHERE in the
  // response is flaky by construction: a hex UUID can coincidentally contain
  // any 4-digit sequence (this genuinely happened in CI — a wholly unrelated
  // row's own random id contained "-4242-", not a leaked Carol amount).
  // Carol's summary text is the reliable fingerprint — a human-readable
  // string no random UUID will ever coincidentally reproduce.
  const CAROL_SUMMARY = "Carol's payment";

  it("does not reveal another wallet's transactions to an anonymous caller", async () => {
    await seed(CAROL, 4242, CAROL_SUMMARY);
    const answer = JSON.stringify(await ask(TENANT, "show me recent transactions", { sender: "__none__" }));
    expect(answer).not.toContain(CAROL);
    expect(answer).not.toContain(CAROL_SUMMARY);
  });

  it("shows a connected wallet its own transactions and nobody else's", async () => {
    await seed(CAROL, 4242, CAROL_SUMMARY);
    await seed(DAVE, 7777, "Dave's payment");
    const asDave = JSON.stringify(await ask(TENANT, "show me recent transactions", { sender: DAVE }));
    expect(asDave).toContain("7777");
    expect(asDave).not.toContain(CAROL);
    expect(asDave).not.toContain(CAROL_SUMMARY);
  });

  it("keeps derived answers scoped too, not just the raw transaction list", async () => {
    // Revenue/customers/compliance all read the same list — scoping the list
    // is what keeps every one of these from aggregating other people's money.
    await seed(CAROL, 4242, CAROL_SUMMARY);
    const revenue = JSON.stringify(await ask(TENANT, "how much revenue have I made?", { sender: "__none__" }));
    expect(revenue).not.toContain(CAROL_SUMMARY);
    const customers = JSON.stringify(await ask(TENANT, "who are my customers?", { sender: "__none__" }));
    expect(customers).not.toContain(CAROL);
  });
});
