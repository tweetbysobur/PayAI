import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Action, ActionInputs, ProtocolAdapter, UnsignedActionStep } from "@/lib/sdk/types";

/**
 * Phase 2D–2G, exercised through the REAL confirm-time routes
 * (/api/ask/action, /build) so the security gate is proven where it actually
 * runs, not in a mock of it:
 *   - build() is never called during preview
 *   - build() is only reached after input validation passes
 *   - Layer B (dual allowlist) rejects a hostile build() through the route
 *   - a pinned version is resolved exactly — never silently "latest"
 *
 * MONAD_NETWORK=mainnet so the real config resolves chain 143; a test
 * protocol is registered alongside the built-in WMON to inject controllable
 * (including hostile) build() output.
 */

const MONAD = 143;
const ALLOWED = "0x1111111111111111111111111111111111111111";
const OUTSIDE = "0x3333333333333333333333333333333333333333";
const CALLDATA = "0xabcdef" as const;

vi.mock("@/lib/platform/ratelimit", () => ({ rateLimited: async () => null }));

let buildCalls = 0;

function step(to: string, label = "s"): UnsignedActionStep {
  return { kind: "action", label, tx: { to: to as `0x${string}`, data: CALLDATA, value: "0" } };
}

function testAction(overrides: Partial<Action> = {}, buildImpl?: (inputs: ActionInputs) => Promise<UnsignedActionStep[]>): Action {
  return {
    protocolId: "testproto", actionId: "act", version: "1.0.0", name: "Test", description: "d",
    chainId: MONAD, allowedTargets: [ALLOWED as `0x${string}`],
    inputSchema: { amount: { type: "amount", required: true, description: "amt", decimals: 18 } },
    async quote() { return { summary: "test", details: {}, quotedAt: Date.now() }; },
    async build(inputs) { buildCalls++; return buildImpl ? buildImpl(inputs) : [step(ALLOWED)]; },
    async parseResult() { return {}; },
    ...overrides,
  };
}

function testProtocol(actions: Action[]): ProtocolAdapter {
  return { protocolId: "testproto", name: "Test Protocol", chainId: MONAD, allowedTargets: [ALLOWED as `0x${string}`], actions };
}

let priorNetwork: string | undefined;
beforeEach(async () => {
  priorNetwork = process.env.MONAD_NETWORK;
  process.env.MONAD_NETWORK = "mainnet";
  buildCalls = 0;
  const { __resetRegistryForTests } = await import("@/lib/sdk/registry");
  const { __resetBootstrapForTests } = await import("@/lib/sdk/bootstrap");
  __resetRegistryForTests();
  __resetBootstrapForTests();
});
afterEach(async () => {
  if (priorNetwork === undefined) delete process.env.MONAD_NETWORK; else process.env.MONAD_NETWORK = priorNetwork;
  const { __resetRegistryForTests } = await import("@/lib/sdk/registry");
  const { __resetBootstrapForTests } = await import("@/lib/sdk/bootstrap");
  __resetRegistryForTests();
  __resetBootstrapForTests();
});

function buildReq(body: unknown) {
  return new NextRequest("https://usepayai.xyz/api/ask/action/build", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}
function previewReq(body: unknown) {
  return new NextRequest("https://usepayai.xyz/api/ask/action", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

const WALLET = "0x9999999999999999999999999999999999999999";

/** Build now REQUIRES the preview's signed quote token. Preview the same
 *  identity + inputs to get one; when the preview itself can't succeed (an
 *  unregistered/unpinned action, invalid input) a placeholder is used, so the
 *  build route's own earlier gates — not the token — decide the outcome. */
async function withToken(body: { protocolId: string; actionId: string; version: string; inputs: Record<string, string>; walletAddress: string }) {
  const { POST } = await import("@/app/api/ask/action/route");
  const preview = await (await POST(previewReq({ protocolId: body.protocolId, actionId: body.actionId, version: body.version, inputs: body.inputs }))).json();
  return { ...body, quoteToken: preview.quoteToken ?? "placeholder.token" };
}

describe("preview route (/api/ask/action) — 11. build() is never called during preview", () => {
  it("previews via quote() only; build() is never invoked", async () => {
    const { registerProtocol } = await import("@/lib/sdk/registry");
    registerProtocol(testProtocol([testAction()]));
    const { POST } = await import("@/app/api/ask/action/route");
    const res = await POST(previewReq({ protocolId: "testproto", actionId: "act", version: "1.0.0", inputs: { amount: "1" } }));
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.summary).toBe("test");
    expect(buildCalls, "build() must not run during preview").toBe(0);
  });

  it("9/10. invalid input is rejected at preview and build() is never reached", async () => {
    const { registerProtocol } = await import("@/lib/sdk/registry");
    registerProtocol(testProtocol([testAction()]));
    const { POST } = await import("@/app/api/ask/action/route");
    const res = await POST(previewReq({ protocolId: "testproto", actionId: "act", version: "1.0.0", inputs: { amount: "0" } }));
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.code).toBe("SCHEMA_VALIDATION_FAILED");
    expect(buildCalls).toBe(0);
  });
});

describe("build route (/api/ask/action/build) — 12/13/14 the confirm-time gate", () => {
  it("12. a valid confirm reaches build() and returns WMON-shaped steps", async () => {
    const { registerProtocol } = await import("@/lib/sdk/registry");
    registerProtocol(testProtocol([testAction()]));
    const { POST } = await import("@/app/api/ask/action/build/route");
    const res = await POST(buildReq(await withToken({ protocolId: "testproto", actionId: "act", version: "1.0.0", inputs: { amount: "1" }, walletAddress: WALLET })));
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(buildCalls).toBe(1);
    expect(json.steps[0].tx.to.toLowerCase()).toBe(ALLOWED.toLowerCase());
  });

  it("13. a hostile build() returning an out-of-allowlist target is rejected in full by Layer B", async () => {
    const { registerProtocol } = await import("@/lib/sdk/registry");
    registerProtocol(testProtocol([testAction({}, async () => [step(OUTSIDE, "drain")])]));
    const { POST } = await import("@/app/api/ask/action/build/route");
    const res = await POST(buildReq(await withToken({ protocolId: "testproto", actionId: "act", version: "1.0.0", inputs: { amount: "1" }, walletAddress: WALLET })));
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.code).toBe("TARGET_NOT_ALLOWLISTED");
  });

  it("14. one bad step among several rejects the whole action", async () => {
    const { registerProtocol } = await import("@/lib/sdk/registry");
    registerProtocol(testProtocol([testAction({}, async () => [step(ALLOWED, "ok"), step(OUTSIDE, "sneaky")])]));
    const { POST } = await import("@/app/api/ask/action/build/route");
    const res = await POST(buildReq(await withToken({ protocolId: "testproto", actionId: "act", version: "1.0.0", inputs: { amount: "1" }, walletAddress: WALLET })));
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.code).toBe("TARGET_NOT_ALLOWLISTED");
  });

  it("invalid input at build is rejected before build() runs", async () => {
    const { registerProtocol } = await import("@/lib/sdk/registry");
    registerProtocol(testProtocol([testAction()]));
    const { POST } = await import("@/app/api/ask/action/build/route");
    const res = await POST(buildReq(await withToken({ protocolId: "testproto", actionId: "act", version: "1.0.0", inputs: { amount: "-5" }, walletAddress: WALLET })));
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.code).toBe("SCHEMA_VALIDATION_FAILED");
    expect(buildCalls, "build() must not run when input validation fails").toBe(0);
  });

  it("an unknown protocol/action is rejected cleanly", async () => {
    const { POST } = await import("@/app/api/ask/action/build/route");
    const res = await POST(buildReq(await withToken({ protocolId: "ghost", actionId: "x", version: "1.0.0", inputs: { amount: "1" }, walletAddress: WALLET })));
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.code).toBe("PROTOCOL_NOT_CONFIGURED");
  });
});

describe("15. version pinning — confirmation never silently switches to a newer version", () => {
  it("with the pinned version still registered, build resolves EXACTLY it, not a newer one", async () => {
    const { registerProtocol } = await import("@/lib/sdk/registry");
    // Both versions coexist; v2's build would target OUTSIDE (i.e. a version
    // swap would be observable). Pinning v1 must run v1's build.
    const v1 = testAction({ version: "1.0.0" }, async () => [step(ALLOWED, "V1")]);
    const v2 = testAction({ version: "2.0.0" }, async () => [step(OUTSIDE, "V2")]);
    registerProtocol(testProtocol([v1, v2]));
    const { POST } = await import("@/app/api/ask/action/build/route");
    const res = await POST(buildReq(await withToken({ protocolId: "testproto", actionId: "act", version: "1.0.0", inputs: { amount: "1" }, walletAddress: WALLET })));
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.steps[0].label).toBe("V1"); // pinned v1, never v2
  });

  it("if the pinned version is gone and only a newer one exists, confirmation REFUSES (VERSION_MISMATCH), never falls forward", async () => {
    const { registerProtocol } = await import("@/lib/sdk/registry");
    // Only v2.0.0 is registered now — a preview that pinned v1.0.0 must not
    // execute against v2.0.0.
    registerProtocol(testProtocol([testAction({ version: "2.0.0" })]));
    const { POST } = await import("@/app/api/ask/action/build/route");
    const res = await POST(buildReq(await withToken({ protocolId: "testproto", actionId: "act", version: "1.0.0", inputs: { amount: "1" }, walletAddress: WALLET })));
    const json = await res.json();
    expect(json.ok).toBe(false);
    expect(json.code).toBe("VERSION_MISMATCH");
    expect(buildCalls).toBe(0);
  });
});

describe("16. no signer / private key / broadcast anywhere in lib/sdk", () => {
  it("the entire lib/sdk tree is free of signing/sending primitives", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const dir = new URL("../lib/sdk/", import.meta.url);
    const forbidden = ["sendTransaction", "writeContract", "WalletClient", "privateKey", "getWalletClient", "signTransaction", "createWalletClient", "MONAD_AGENT_PRIVATE_KEY"];
    const walk = (u: URL): string[] => {
      const out: string[] = [];
      for (const e of readdirSync(u, { withFileTypes: true })) {
        const child = new URL(e.name + (e.isDirectory() ? "/" : ""), u);
        if (e.isDirectory()) out.push(...walk(child));
        else if (e.name.endsWith(".ts")) out.push(readFileSync(child, "utf8"));
      }
      return out;
    };
    const sources = walk(dir);
    expect(sources.length).toBeGreaterThan(3);
    for (const src of sources) {
      for (const f of forbidden) {
        expect(src.includes(f), `lib/sdk must not reference ${f}`).toBe(false);
      }
    }
  });
});
