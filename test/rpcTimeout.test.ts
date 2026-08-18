import { describe, it, expect, vi, afterEach } from "vitest";
import { withTimeout } from "@/lib/monad/rpcTimeout";

// This is the actual bug: a provider that accepts an unbounded getLogs
// range instead of rejecting it can just take a very long time to answer,
// which no try/catch around the call will ever see since nothing throws.
// withTimeout is what makes that fail open in bounded time instead.

describe("withTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with the real value when the promise settles before the timeout", async () => {
    const result = await withTimeout(Promise.resolve("real data"), 5000, "fallback");
    expect(result).toBe("real data");
  });

  it("regression: a promise that never resolves (the live symptom — an RPC call that hangs instead of erroring) falls back once the timeout elapses, instead of hanging forever", async () => {
    vi.useFakeTimers();
    const neverResolves = new Promise<string>(() => {});
    const promise = withTimeout(neverResolves, 5000, "fallback");

    // Not yet — the real call could still come back before the deadline.
    await vi.advanceTimersByTimeAsync(4999);

    // Past the deadline — this is what turns a would-be multi-minute hang
    // (the reported bug: pasting a token CA took minutes to answer) into a
    // bounded, predictable wait.
    await vi.advanceTimersByTimeAsync(2);
    await expect(promise).resolves.toBe("fallback");
  });

  it("does not leave a dangling timer after the real promise wins the race", async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(global, "clearTimeout");
    await withTimeout(Promise.resolve("fast"), 5000, "fallback");
    expect(clearSpy).toHaveBeenCalled();
  });
});
