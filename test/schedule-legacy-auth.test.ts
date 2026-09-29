import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { POST, PATCH, DELETE } from "@/app/api/schedule/route";
import { createSchedule, getSchedule, listSchedules } from "@/lib/platform/schedules";

/**
 * /api/schedule is the legacy automation endpoint. It writes the same records
 * /api/automations does, and the cron executes them — but unlike
 * /api/automations it never asked for a wallet signature.
 *
 * Two things followed from that, both with a live agent signer:
 *   - POST created an automation with no fundingMode, which settles from the
 *     server agent wallet's OWN balance. Anyone could schedule PayAI's agent
 *     wallet to pay any address, every day, up to the caps.
 *   - PATCH / DELETE edited or cancelled anyone's automation given its id and
 *     the owner's (public) address.
 *
 * With a live signer these writes now require the operator API key, the same
 * gate /api/agent uses. Real users create and manage automations through
 * /api/automations, which proves wallet ownership per action.
 */
const VICTIM = "0x1111111111111111111111111111111111111111";
const ATTACKER = "0x2222222222222222222222222222222222222222";
const OPERATOR_KEY = "operator-test-key";

const saved: Record<string, string | undefined> = {};
const ENV = ["PAYAI_MODE", "MONAD_AGENT_PRIVATE_KEY", "VERIPAYAI_API_KEY"] as const;

function req(method: string, url: string, body?: unknown, apiKey?: string): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers["x-api-key"] = apiKey;
  return new NextRequest(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

async function victimSchedule() {
  return createSchedule("demo", {
    amount: 5, token: "USDC", recipient: VICTIM, cadence: "monthly",
    nextRun: Date.now() + 86_400_000, sender: VICTIM, fundingMode: "wallet",
  });
}

describe("legacy /api/schedule writes with a live agent signer", () => {
  beforeEach(() => {
    for (const k of ENV) saved[k] = process.env[k];
    process.env.PAYAI_MODE = "monad";
    process.env.MONAD_AGENT_PRIVATE_KEY = "0x" + "11".repeat(32);
    process.env.VERIPAYAI_API_KEY = OPERATOR_KEY;
    const g = globalThis as unknown as { __veripaySchedules?: Map<string, unknown>; __veripayRL?: Map<string, unknown> };
    g.__veripaySchedules?.clear();
    g.__veripayRL?.clear();
  });
  afterEach(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("refuses to create an agent-funded automation without the operator key", async () => {
    const res = await POST(req("POST", "https://usepayai.xyz/api/schedule", {
      walletAddress: VICTIM, amount: 5, token: "USDC", recipient: ATTACKER,
      cadence: "daily", startAt: Date.now() + 120_000,
    }));
    expect(res.status).toBe(401);
    expect(await listSchedules("demo"), "nothing may be scheduled against the agent wallet").toHaveLength(0);
  });

  it("refuses to edit someone else's automation without the operator key", async () => {
    const row = await victimSchedule();
    const res = await PATCH(req("PATCH", `https://usepayai.xyz/api/schedule?id=${row.id}`, { walletAddress: VICTIM, amount: 999 }));
    expect(res.status).toBe(401);
    expect((await getSchedule(row.id))?.amount).toBe(5);
  });

  it("refuses to cancel someone else's automation without the operator key", async () => {
    const row = await victimSchedule();
    const res = await DELETE(req("DELETE", `https://usepayai.xyz/api/schedule?id=${row.id}&wallet=${VICTIM}`));
    expect(res.status).toBe(401);
    expect((await getSchedule(row.id))?.status).toBe(row.status);
  });

  it("a wrong key is refused the same way", async () => {
    const row = await victimSchedule();
    const res = await DELETE(req("DELETE", `https://usepayai.xyz/api/schedule?id=${row.id}&wallet=${VICTIM}`, undefined, "not-the-key"));
    expect(res.status).toBe(401);
    expect((await getSchedule(row.id))?.status).toBe(row.status);
  });

  it("the operator key still works", async () => {
    const row = await victimSchedule();
    const res = await DELETE(req("DELETE", `https://usepayai.xyz/api/schedule?id=${row.id}&wallet=${VICTIM}`, undefined, OPERATOR_KEY));
    expect(res.status).toBe(200);
    expect((await getSchedule(row.id))?.status).toBe("cancelled");
  });
});
