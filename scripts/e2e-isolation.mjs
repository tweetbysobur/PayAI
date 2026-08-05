#!/usr/bin/env node
/**
 * End-to-end privacy isolation test — hits the REAL running API (not the store
 * directly) with two different wallets and asserts that one wallet can never
 * see or cancel another's scheduled payments or payment links on the shared
 * demo tenant. This is the automated counterpart to the manual two-wallet
 * check, exercising the actual routes + tenant scoping + sentinel logic.
 *
 * Usage: BASE=http://localhost:3101 node scripts/e2e-isolation.mjs
 *        (defaults to http://localhost:3101)
 */
const BASE = process.env.BASE || "http://localhost:3101";
const A = "0xAAaAAAaAaaAaAAAaaAAaAaAaaaAAAaAaAAaAaaAA";
const B = "0xBbBBbbBBbBBBbBBBBbbBbbbBBbBBBBbBbbBbbBbB";

let failures = 0;
function check(name, cond) {
  console.log(`${cond ? "✅" : "❌"} ${name}`);
  if (!cond) failures++;
}
const post = (path, body) => fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const get = (path) => fetch(`${BASE}${path}`).then((r) => r.json());
const del = (path) => fetch(`${BASE}${path}`, { method: "DELETE" }).then((r) => r.json());

async function main() {
  console.log(`\nIsolation E2E against ${BASE}\n`);

  // Wallet A creates a schedule and a payment link.
  //
  // Describing an automation no longer creates one: /api/agent answers with an
  // `automation_prefill` that the user confirms, and the confirmation is what
  // POSTs to /api/schedule. This script used to read `schedule.id` off the
  // agent response, which stopped existing when that confirmation step went
  // in — so A never created a schedule, and the three checks that matter
  // ("B sees NONE of A's schedules", "B cannot cancel A's schedule") were
  // passing against a schedule that did not exist. A privacy test that passes
  // because there is nothing to leak is worse than no test. It now walks the
  // same two steps the UI does.
  const proposal = await post("/api/agent", { intent: `schedule 5 USDC to ${B} every friday`, walletAddress: A });
  const prefill = proposal?.prefill;
  check("A's intent produced an automation proposal", proposal?.decision === "automation_prefill" && !!prefill);

  const sched = prefill
    ? await post("/api/schedule", {
        walletAddress: A,
        amount: prefill.amount,
        token: prefill.token,
        recipient: prefill.domain || prefill.recipient,
        cadence: prefill.cadence,
        startAt: prefill.nextRun,
      })
    : {};
  const schedId = sched?.schedule?.id;
  check("A confirmed the proposal into a schedule", !!schedId);

  const link = await post("/api/links", { amount: 12.5, token: "USDC", walletAddress: A });
  const linkId = link?.link?.id;
  check("A created a payment link", !!linkId);

  // A sees its own.
  const aSched = (await get(`/api/schedule?wallet=${A}`)).schedules ?? [];
  const aLinks = (await get(`/api/links?wallet=${A}`)).links ?? [];
  check("A sees its own schedule", aSched.some((s) => s.id === schedId));
  check("A sees its own link", aLinks.some((l) => l.id === linkId));

  // B sees NONE of A's data.
  const bSched = (await get(`/api/schedule?wallet=${B}`)).schedules ?? [];
  const bLinks = (await get(`/api/links?wallet=${B}`)).links ?? [];
  check("B sees NONE of A's schedules", !bSched.some((s) => s.id === schedId));
  check("B sees NONE of A's links", !bLinks.some((l) => l.id === linkId));

  // No wallet on the shared tenant returns nothing.
  const anonSched = (await get(`/api/schedule`)).schedules ?? [];
  const anonLinks = (await get(`/api/links`)).links ?? [];
  check("Anonymous (no wallet) sees no schedules", anonSched.length === 0);
  check("Anonymous (no wallet) sees no links", anonLinks.length === 0);

  // B cannot cancel A's schedule.
  if (schedId) {
    // Compare against the status the row actually had a moment ago rather than
    // a hardcoded one. A new schedule reports "active" now, not "upcoming",
    // and the old literal made this fail as though isolation had broken when
    // only a label had changed — the kind of false alarm that gets a privacy
    // test ignored. What matters is that B's delete changed nothing.
    const before = ((await get(`/api/schedule?wallet=${A}`)).schedules ?? []).find((s) => s.id === schedId);
    await del(`/api/schedule?id=${schedId}&wallet=${B}`);
    const row = ((await get(`/api/schedule?wallet=${A}`)).schedules ?? []).find((s) => s.id === schedId);
    check(
      `B cannot cancel A's schedule (still ${before?.status})`,
      !!row && row.status === before?.status && row.status !== "cancelled",
    );

    // A can cancel its own (also cleans up the test row).
    await del(`/api/schedule?id=${schedId}&wallet=${A}`);
    const afterA = (await get(`/api/schedule?wallet=${A}`)).schedules ?? [];
    check("A can cancel its own schedule", afterA.find((s) => s.id === schedId)?.status === "cancelled");
  }

  console.log(`\n${failures === 0 ? "ALL ISOLATION CHECKS PASSED" : `${failures} CHECK(S) FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("E2E error:", e.message); process.exit(1); });
