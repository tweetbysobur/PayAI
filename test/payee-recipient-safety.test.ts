import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * Phase 0 — no fabricated recipients.
 *
 * lib/payees/directory.ts used to ship a built-in table of payee names mapped
 * to unowned placeholder addresses, active in EVERY mode including Monad
 * mainnet — "send 20 USDC to Alice" could build a real, irreversible transfer
 * to an address nobody owns. And neither LLM layer checked that a recipient it
 * returned was actually something the user said.
 *
 * These tests pin the fixed behavior:
 *   - a name resolves only if explicitly configured (VERIPAYAI_PAYEES) —
 *     PayAI ships no built-in payees in any mode;
 *   - .nad names go through the existing resolver;
 *   - an LLM-returned recipient that isn't in the user's own text is dropped.
 */

vi.setConfig({ testTimeout: 20_000 });

type CreateFn = (...args: unknown[]) => unknown;
let mockCreate: ReturnType<typeof vi.fn<CreateFn>>;

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function AnthropicMock() {
    return { messages: { create: (...args: unknown[]) => mockCreate(...args) } };
  }),
}));

const resolveDomainMock = vi.fn();
vi.mock("@/lib/monad/domain-resolver", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/monad/domain-resolver")>();
  return { ...actual, resolveDomain: (d: string) => resolveDomainMock(d) };
});

/** Repeated-digit placeholder addresses — the shape the removed built-in
 *  table used. No name may ever resolve to one. */
const PLACEHOLDER_RE = /0x(1{40}|2{40}|3{40}|4{40})/i;
const REAL_ALICE = "0x9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";
const USER_ADDR = "0x1234567890abcdef1234567890abcdef12345678";
const OTHER_ADDR = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const NAD_ADDR = "0x3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f";

const ENV_KEYS = ["PAYAI_MODE", "VERIPAYAI_PAYEES", "ANTHROPIC_API_KEY"] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  mockCreate = vi.fn<CreateFn>();
  resolveDomainMock.mockReset();
  vi.resetModules();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function post(path: string, body: unknown) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` },
    body: JSON.stringify(body),
  });
}

describe("payee directory — Monad/production mode", () => {
  it("1. an unknown name resolves to nothing (no fallback address)", async () => {
    process.env.PAYAI_MODE = "monad";
    const { resolvePayee, listPayees } = await import("@/lib/payees/directory");
    for (const name of ["Alice", "bob", "CAROL", "acme", "someone"]) {
      expect(resolvePayee(name)).toBeNull();
    }
    expect(listPayees()).toEqual([]);
  });

  it("2. a configured payee name resolves to its configured address", async () => {
    process.env.PAYAI_MODE = "monad";
    process.env.VERIPAYAI_PAYEES = `alice:${REAL_ALICE}`;
    const { resolvePayee } = await import("@/lib/payees/directory");
    expect(resolvePayee("Alice")).toEqual({ name: "Alice", address: REAL_ALICE });
    expect(resolvePayee("bob")).toBeNull();
  });

  it("7. with nothing configured, no name resolves in ANY mode (no shipped payees)", async () => {
    for (const mode of ["monad", "simulation", undefined]) {
      if (mode) process.env.PAYAI_MODE = mode; else delete process.env.PAYAI_MODE;
      const { resolvePayee, listPayees } = await import("@/lib/payees/directory");
      for (const name of ["alice", "bob", "carol", "acme", "Alice", "ACME"]) expect(resolvePayee(name)).toBeNull();
      expect(listPayees()).toEqual([]);
    }
  });

  it("7b. the directory module exports no demo mechanism", async () => {
    const mod = (await import("@/lib/payees/directory")) as Record<string, unknown>;
    expect(Object.keys(mod).sort()).toEqual(["isAddress", "listPayees", "recipientAppearsIn", "resolvePayee"]);
  });

  it("configured entries with an invalid address are ignored, not half-resolved", async () => {
    process.env.VERIPAYAI_PAYEES = `alice:0x123, bob:${REAL_ALICE}`;
    const { resolvePayee } = await import("@/lib/payees/directory");
    expect(resolvePayee("alice")).toBeNull();
    expect(resolvePayee("bob")?.address).toBe(REAL_ALICE);
  });

  it("prototype keys never resolve", async () => {
    const { resolvePayee } = await import("@/lib/payees/directory");
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(resolvePayee(name)).toBeNull();
    }
  });
});

describe("routes that consume the payee directory (Monad mode)", () => {
  it("1+7. /api/agent refuses 'send 20 USDC to Alice' instead of building a transfer", async () => {
    process.env.PAYAI_MODE = "monad";
    const { POST } = await import("@/app/api/agent/route");
    const res = await POST(post("/api/agent", { intent: "Send 20 USDC to Alice", walletAddress: USER_ADDR, idempotencyKey: `t-${Math.random()}` }));
    const json = await res.json();
    expect(res.status).toBe(422);
    expect(json.decision).toBe("refused");
    expect(JSON.stringify(json)).not.toMatch(PLACEHOLDER_RE);
    expect(json.unsignedTx).toBeUndefined();
  });

  it("2. /api/agent uses a configured payee's real address", async () => {
    process.env.PAYAI_MODE = "monad";
    process.env.VERIPAYAI_PAYEES = `alice:${REAL_ALICE}`;
    const { POST } = await import("@/app/api/agent/route");
    const res = await POST(post("/api/agent", { intent: "Send 20 USDC to Alice", walletAddress: USER_ADDR, idempotencyKey: `t-${Math.random()}` }));
    const json = await res.json();
    // The request may still stop later (e.g. the test wallet's balance); what
    // matters here is that the directory step resolved to the REAL address.
    const directory = (json.trace as { step: string; status: string; detail: string }[]).find((t) => t.step === "directory");
    expect(directory?.status).toBe("ok");
    expect(directory?.detail).toContain(REAL_ALICE);
    expect(JSON.stringify(json)).not.toMatch(PLACEHOLDER_RE);
  });

  it("1+7. /api/compliance/check rejects an unknown name", async () => {
    process.env.PAYAI_MODE = "monad";
    const { POST } = await import("@/app/api/compliance/check/route");
    const res = await POST(post("/api/compliance/check", { recipient: "alice" }));
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).not.toMatch(PLACEHOLDER_RE);
  });

  it("3. a .nad recipient resolves through the existing domain resolver", async () => {
    process.env.PAYAI_MODE = "monad";
    resolveDomainMock.mockResolvedValue({ domain: "alice.nad", resolvedAddress: NAD_ADDR, cached: false });
    const { POST } = await import("@/app/api/compliance/check/route");
    const res = await POST(post("/api/compliance/check", { recipient: "alice.nad" }));
    const json = await res.json();
    expect(resolveDomainMock).toHaveBeenCalledWith("alice.nad");
    expect(json.recipient).toBe(NAD_ADDR);
    expect(json.domain).toBe("alice.nad");
  });

  it("3b. an unresolvable .nad name is refused, never substituted", async () => {
    process.env.PAYAI_MODE = "monad";
    resolveDomainMock.mockResolvedValue({ domain: "nobody.nad", resolvedAddress: null, cached: false, error: "Unable to resolve domain" });
    const { POST } = await import("@/app/api/agent/route");
    const res = await POST(post("/api/agent", { intent: "Send 5 USDC to nobody.nad", walletAddress: USER_ADDR, idempotencyKey: `t-${Math.random()}` }));
    expect(res.status).toBe(422);
    expect((await res.json()).unsignedTx).toBeUndefined();
  });
});

describe("every other route that accepts a recipient name (Monad mode)", () => {
  const TX = `0x${"ab".repeat(32)}`;

  it("/api/agent (automation draft) refuses an unknown name", async () => {
    process.env.PAYAI_MODE = "monad";
    const { POST } = await import("@/app/api/agent/route");
    const res = await POST(post("/api/agent", { intent: "automate 10 USDC to Alice every Friday", walletAddress: USER_ADDR, idempotencyKey: `t-${Math.random()}` }));
    const json = await res.json();
    expect(res.status).toBe(422);
    expect(json.decision).toBe("schedule_error");
    expect(JSON.stringify(json)).not.toMatch(PLACEHOLDER_RE);
  });

  it("/api/agent/confirm never settles a re-derived unknown name", async () => {
    process.env.PAYAI_MODE = "monad";
    const { POST } = await import("@/app/api/agent/confirm/route");
    const res = await POST(post("/api/agent/confirm", { rawText: "Send 20 USDC to Alice", walletAddress: USER_ADDR, txHash: TX }));
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).not.toMatch(PLACEHOLDER_RE);
  });

  it("/api/schedule refuses an unknown name", async () => {
    process.env.PAYAI_MODE = "monad";
    const { POST } = await import("@/app/api/schedule/route");
    const res = await POST(post("/api/schedule", { walletAddress: USER_ADDR, amount: 10, token: "USDC", recipient: "alice", cadence: "weekly", startAt: Date.now() + 86_400_000 }));
    const json = await res.json();
    expect(res.status).toBe(422);
    expect(json.error).toMatch(/isn't a valid address, \.nad domain, or known payee/);
  });

  it("/api/automations recipient check: unknown name refused, configured name and .nad resolve", async () => {
    process.env.PAYAI_MODE = "monad";
    process.env.VERIPAYAI_PAYEES = `treasury:${REAL_ALICE}`;
    resolveDomainMock.mockResolvedValue({ domain: "alice.nad", resolvedAddress: NAD_ADDR, cached: false });
    const { GET } = await import("@/app/api/automations/route");
    const get = (q: string) => GET(new NextRequest(`http://localhost/api/automations?resolve=${encodeURIComponent(q)}`));

    const unknown = await get("alice");
    expect(unknown.status).toBe(422);
    expect(JSON.stringify(await unknown.json())).not.toMatch(PLACEHOLDER_RE);

    expect((await (await get("Treasury")).json()).recipient).toBe(REAL_ALICE);
    expect((await (await get("alice.nad")).json()).recipient).toBe(NAD_ADDR);
  });

  it("/api/ask/understand: an LLM-supplied address that isn't in the message never comes back", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockCreate.mockResolvedValue({ content: [{ type: "tool_use", id: "t1", name: "submit_understanding", input: { kind: "send_payment", outcome: "complete", slots: { amount: "20", asset: "USDC", recipient: OTHER_ADDR } } }] });
    const { POST } = await import("@/app/api/ask/understand/route");
    const res = await POST(post("/api/ask/understand", { text: "send 20 USDC to Alice", history: [], pending: null }));
    const json = await res.json();
    expect(json.outcome).toBe("incomplete");
    expect(JSON.stringify(json)).not.toContain(OTHER_ADDR);
  });
});

describe("LLM recipient provenance — Ask classifier (classify.ts)", () => {
  function tool(input: Record<string, unknown>) {
    return { content: [{ type: "tool_use", id: "t1", name: "submit_understanding", input }] };
  }

  it("4. an explicit 0x recipient present in the user's text is accepted", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockCreate.mockResolvedValue(tool({ kind: "send_payment", outcome: "complete", slots: { amount: "20", asset: "USDC", recipient: USER_ADDR } }));
    const { understand } = await import("@/lib/ask/intent/classify");
    const u = await understand(`please send 20 USDC to ${USER_ADDR.toUpperCase().replace("0X", "0x")}`, [], null);
    expect(u.outcome).toBe("complete");
    if (u.outcome === "complete") expect(u.slots.recipient).toBe(USER_ADDR);
  });

  it("5. an LLM address that does NOT appear in the user's text is dropped and the user is asked", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockCreate.mockResolvedValue(tool({ kind: "send_payment", outcome: "complete", slots: { amount: "20", asset: "USDC", recipient: OTHER_ADDR } }));
    const { understand } = await import("@/lib/ask/intent/classify");
    const u = await understand(`please send 20 USDC to ${USER_ADDR}`, [], null);
    expect(u.outcome).toBe("incomplete");
    if (u.outcome === "incomplete") {
      expect(u.slots.recipient).toBeNull();
      expect(u.question).toMatch(/who should receive/i);
    }
  });

  it("5b. an LLM-invented name is dropped too", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockCreate.mockResolvedValue(tool({ kind: "send_payment", outcome: "complete", slots: { amount: "20", asset: "USDC", recipient: "Alice" } }));
    const { understand } = await import("@/lib/ask/intent/classify");
    const u = await understand("pay my landlord 20 USDC", [], null);
    expect(u.outcome).toBe("incomplete");
  });

  it("a name the user typed is kept as a phrase for server-side resolution", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockCreate.mockResolvedValue(tool({ kind: "send_payment", outcome: "complete", slots: { amount: "20", asset: "USDC", recipient: "Alice" } }));
    const { understand } = await import("@/lib/ask/intent/classify");
    const u = await understand("send 20 usdc to alice please", [], null);
    expect(u.outcome).toBe("complete");
  });

  it("a recipient from an earlier USER turn is accepted; one only in an assistant turn is not", async () => {
    const { enforceRecipientProvenance } = await import("@/lib/ask/intent/classify");
    const u = { kind: "send_payment" as const, outcome: "complete" as const, slots: { amount: "30", asset: "USDC", recipient: USER_ADDR } as never };
    expect(enforceRecipientProvenance(u, "actually make it 30", [{ role: "user", content: `send 20 USDC to ${USER_ADDR}` }], null).outcome).toBe("complete");
    expect(enforceRecipientProvenance(u, "actually make it 30", [{ role: "assistant", content: `Sending to ${USER_ADDR}` }], null).outcome).toBe("incomplete");
  });

  it("a partial address match does not count", async () => {
    const { recipientAppearsIn } = await import("@/lib/payees/directory");
    expect(recipientAppearsIn(USER_ADDR, [`send to ${USER_ADDR}ff`])).toBe(false);
    expect(recipientAppearsIn("al", ["send to alice"])).toBe(false);
    expect(recipientAppearsIn("alice.nad", ["send 5 MON to Alice.nad."])).toBe(true);
  });
});

describe("LLM recipient provenance — /api/agent refinement (brain.ts)", () => {
  function tool(recipient: string) {
    return { content: [{ type: "tool_use", id: "t1", name: "submit_intent", input: { action: "send_payment", amount: 20, token: "USDC", recipient, purpose: null, network: "monad", confidence: 0.99 } }] };
  }

  it("5. a refined recipient that isn't in the text is replaced by the deterministic parse", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockCreate.mockResolvedValue(tool(OTHER_ADDR));
    const { parseIntent } = await import("@/lib/agent/brain");
    const { intent } = await parseIntent(`send 20 USDC to ${USER_ADDR}`);
    expect(intent.recipient).toBe(USER_ADDR);
  });

  it("4. a refined recipient that IS in the text is kept", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockCreate.mockResolvedValue(tool(USER_ADDR));
    const { parseIntent } = await import("@/lib/agent/brain");
    const { intent } = await parseIntent(`send 20 USDC to ${USER_ADDR}`);
    expect(intent.recipient).toBe(USER_ADDR);
  });

  it("5b. an invented recipient with nothing in the text leaves no recipient at all", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockCreate.mockResolvedValue(tool(OTHER_ADDR));
    const { parseIntent } = await import("@/lib/agent/brain");
    const { intent } = await parseIntent("send 20 USDC");
    expect(intent.recipient).not.toBe(OTHER_ADDR);
  });
});
