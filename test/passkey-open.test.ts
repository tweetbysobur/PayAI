import { describe, expect, it } from "vitest";
import {
  classifyPasskeyFailure,
  runPasskeyOpen,
  WalletOpenError,
  type OpenContext,
  type OpenDeps,
} from "@/lib/wallet-service/passkey-plan";

const base: OpenContext = {
  mode: "auto",
  remembered: false,
  signedIn: false,
  serverHasWallet: false,
  immediate: true,
  serverAddress: "0x1111111111111111111111111111111111111111",
};

function harness(overrides?: {
  discovered?: string | Error;
  created?: string;
}) {
  const calls: string[] = [];
  const deps: OpenDeps<string> = {
    discover: async (mediation) => {
      calls.push(`discover:${mediation}`);
      const found = overrides?.discovered;
      if (found instanceof Error) throw found;
      if (!found) throw Object.assign(new Error("NotAllowedError"), { name: "NotAllowedError", code: "PASSKEY_OPERATION_FAILED" });
      return found;
    },
    create: async () => {
      calls.push("create");
      return overrides?.created ?? "new-wallet";
    },
    failureKind: classifyPasskeyFailure,
  };
  return { calls, deps };
}

describe("passkey open — never replace an existing wallet", () => {
  it("sign-in with a passkey on the device opens it and does not create", async () => {
    const { calls, deps } = harness({ discovered: "original" });
    const out = await runPasskeyOpen(base, deps);
    expect(out).toEqual({ value: "original", created: false });
    expect(calls).toEqual(["discover:immediate"]);
  });

  it("a remembered credential does not hide other passkeys at sign-in", async () => {
    const { calls, deps } = harness({ discovered: "original" });
    const out = await runPasskeyOpen({ ...base, remembered: true }, deps);
    expect(out.value).toBe("original");
    expect(calls).not.toContain("create");
  });

  it("a cancelled or empty lookup does not create, even when signed in", async () => {
    const { calls, deps } = harness();
    await expect(runPasskeyOpen({ ...base, signedIn: true }, deps)).rejects.toMatchObject({ code: "need-create" });
    expect(calls).toEqual(["discover:immediate"]);
  });

  it("an account that already has a wallet is refused a second one", async () => {
    const { calls, deps } = harness();
    await expect(runPasskeyOpen({
      ...base,
      signedIn: true,
      serverHasWallet: true,
    }, deps)).rejects.toBeInstanceOf(WalletOpenError);
    await expect(runPasskeyOpen({
      ...base,
      mode: "create",
      signedIn: true,
      serverHasWallet: true,
    }, deps)).rejects.toMatchObject({ code: "existing-account" });
    expect(calls).not.toContain("create");
  });

  it("explicit create still prefers a passkey the probe can see", async () => {
    const { calls, deps } = harness({ discovered: "original" });
    const out = await runPasskeyOpen({ ...base, mode: "create" }, deps);
    expect(out).toEqual({ value: "original", created: false });
    expect(calls).not.toContain("create");
  });

  it("explicit create mints a wallet only after the probe finds nothing", async () => {
    const { calls, deps } = harness({ created: "fresh" });
    const out = await runPasskeyOpen({ ...base, mode: "create" }, deps);
    expect(out).toEqual({ value: "fresh", created: true });
    expect(calls).toEqual(["discover:immediate", "create"]);
  });

  it("without immediate mediation, a shown sheet that fails does not create", async () => {
    const { calls, deps } = harness();
    await expect(runPasskeyOpen({ ...base, immediate: false, signedIn: true }, deps)).rejects.toMatchObject({
      code: "need-create",
    });
    expect(calls).toEqual(["discover:required"]);
  });

  it("dashboard unlock lists passkeys instead of reopening only the saved one", async () => {
    const { calls, deps } = harness({ discovered: "original" });
    const out = await runPasskeyOpen({ ...base, mode: "unlock", remembered: true, immediate: false }, deps);
    expect(out).toEqual({ value: "original", created: false });
    expect(calls).toEqual(["discover:required"]);
  });

  it("switching passkeys lists every credential and ignores the saved one", async () => {
    const { calls, deps } = harness({ discovered: "original" });
    const out = await runPasskeyOpen({ ...base, mode: "switch", remembered: true, immediate: false }, deps);
    expect(out.value).toBe("original");
    expect(calls).toEqual(["discover:required"]);
  });

  it("a hard crypto failure is not treated as an empty authenticator", async () => {
    const err = Object.assign(new Error("no prf"), { code: "PRF_UNAVAILABLE" });
    expect(classifyPasskeyFailure(err, "immediate")).toBe("other");
    const { calls, deps } = harness({ discovered: err });
    await expect(runPasskeyOpen({ ...base, mode: "auto" }, deps)).rejects.toBe(err);
    expect(calls).not.toContain("create");
  });
});
