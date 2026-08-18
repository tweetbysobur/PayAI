import { describe, it, expect } from "vitest";
import {
  computeRequestId,
  hashSignature,
  claimRequest,
  completeRequest,
  peekRequest,
  releaseRequest,
} from "@/lib/platform/idempotency";

// No KV_REST_API_* env in the test runner, so these exercise the in-memory path.

describe("computeRequestId", () => {
  it("is deterministic and order-independent", () => {
    const a = computeRequestId({ merchantId: "m1", walletAddress: "0xabc", text: "pay 5" });
    const b = computeRequestId({ text: "pay 5", walletAddress: "0xabc", merchantId: "m1" });
    expect(a).toBe(b);
  });
  it("differs when content differs", () => {
    const a = computeRequestId({ text: "pay 5" });
    const b = computeRequestId({ text: "pay 6" });
    expect(a).not.toBe(b);
  });
});

describe("hashSignature", () => {
  it("is deterministic for the same signature", () => {
    expect(hashSignature("0xdeadbeef")).toBe(hashSignature("0xdeadbeef"));
  });
  it("differs for a different signature", () => {
    expect(hashSignature("0xdeadbeef")).not.toBe(hashSignature("0xfeedface"));
  });

  // Regression coverage for the automations "Execute Now" bug: the
  // requestId used to be `sch:${id}:manual:${Date.now()}`, which is never
  // deterministic and gave claimRequest() nothing real to collide on — a
  // duplicate delivery of the same signed request could execute a live
  // automation twice. app/api/automations/route.ts now builds that key as
  // `sch:${id}:manual:${hashSignature(body.signature)}`; these tests drive
  // the exact same claimRequest/completeRequest primitives the route uses,
  // against keys built the same way, to prove the fix actually dedupes.
  describe("manual-execute idempotency key (regression)", () => {
    const automationId = "auto_123";
    const keyFor = (signature: string) => `sch:${automationId}:manual:${hashSignature(signature)}`;

    it("a retried request with the SAME signature collides on the same key and is rejected while the first is in flight", async () => {
      const signature = "0xsame-signed-proof";
      const key = keyFor(signature);
      const first = await claimRequest<{ outcome: string }>(key);
      expect(first.claimed).toBe(true);

      // Simulates a duplicate delivery of the identical signed request
      // (client retry, network-level redelivery) arriving before the first
      // attempt has finished — this is exactly the double-execution the bug
      // allowed, since Date.now() gave every delivery its own unique key.
      const duplicate = await claimRequest<{ outcome: string }>(keyFor(signature));
      expect(duplicate.claimed).toBe(false);
      if (!duplicate.claimed) expect(duplicate.status).toBe("in_progress");

      await completeRequest(key, { outcome: "executed" });
      await releaseRequest(key); // test cleanup, not part of the route's own flow
    });

    it("a genuinely new manual trigger (a fresh wallet signature) gets its own key and is never blocked by a prior run", async () => {
      const firstSignature = "0xfirst-manual-trigger";
      const secondSignature = "0xsecond-manual-trigger-minutes-later";

      const first = await claimRequest<{ outcome: string }>(keyFor(firstSignature));
      expect(first.claimed).toBe(true);
      await completeRequest(keyFor(firstSignature), { outcome: "executed" });

      // A real second "Execute Now" click re-signs (see signMutation in
      // automations/page.tsx), so it always produces a different signature
      // — this must be claimable even though the automation already ran.
      const second = await claimRequest<{ outcome: string }>(keyFor(secondSignature));
      expect(second.claimed).toBe(true);
      await completeRequest(keyFor(secondSignature), { outcome: "executed" });
    });
  });
});

describe("claim / complete / peek / release", () => {
  it("claims once, then blocks a concurrent claim", async () => {
    const id = `test-claim-${Math.random()}`;
    const first = await claimRequest(id);
    expect(first.claimed).toBe(true);

    const second = await claimRequest(id);
    expect(second.claimed).toBe(false);
    if (!second.claimed) expect(second.status).toBe("in_progress");
  });

  it("replays a completed result instead of re-running", async () => {
    const id = `test-done-${Math.random()}`;
    await claimRequest(id);
    await completeRequest(id, { ok: true, value: 42 });

    const again = await claimRequest<{ ok: boolean; value: number }>(id);
    expect(again.claimed).toBe(false);
    if (!again.claimed) {
      expect(again.status).toBe("done");
      expect(again.result).toEqual({ ok: true, value: 42 });
    }
  });

  it("peek returns the stored result only once done", async () => {
    const id = `test-peek-${Math.random()}`;
    await claimRequest(id);
    expect(await peekRequest(id)).toBeNull(); // in_progress → null
    await completeRequest(id, { hello: "world" });
    expect(await peekRequest(id)).toEqual({ hello: "world" });
  });

  it("release frees a claim so a genuine retry can proceed", async () => {
    const id = `test-release-${Math.random()}`;
    await claimRequest(id);
    await releaseRequest(id);
    const retry = await claimRequest(id);
    expect(retry.claimed).toBe(true);
  });
});
