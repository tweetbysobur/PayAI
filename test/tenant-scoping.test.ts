import { describe, it, expect } from "vitest";
import { createSchedule, listSchedules, cancelSchedule } from "@/lib/platform/schedules";
import { createLink, listLinks } from "@/lib/platform/store";

// Regression coverage for a real privacy bug: on the shared demo tenant, every
// wallet-only user (no merchant account) resolves to the SAME merchantId, so
// scheduled payments and payment links must be scoped by the creating wallet
// or one user can see/cancel another user's real data. No KV env is set in
// the test runner, so these exercise the in-memory fallback path.

const TENANT = "demo";
const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";

describe("scheduled payments — wallet scoping on the shared tenant", () => {
  it("a wallet only sees its own schedules, not another wallet's", async () => {
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

  it("a wallet cannot cancel another wallet's schedule", async () => {
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
