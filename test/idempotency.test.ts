import { describe, it, expect } from "vitest";
import {
  computeRequestId,
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
