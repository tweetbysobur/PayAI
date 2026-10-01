import { describe, expect, it } from "vitest";
import { canonicalInputs, inputsHash, issueQuoteToken, termsHash, verifyQuoteToken } from "@/lib/sdk/quoteToken";

/**
 * lib/sdk/quoteToken.ts — the signed preview → build binding. The route-level
 * behavior is covered in sdk-split-payment-route.test.ts; this pins the
 * primitive: what the token binds, and that every change to it fails closed.
 */

const ID = { protocolId: "payai-settlement", actionId: "split_payment", version: "2.0.0", chainId: 143 };
const A = "0x5e0d39b4c1a2f3e4d5c6b7a8f9e0d1c2b3a4f5e6";
const B = "0x7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b";
const INPUTS = { recipients: [{ recipient: A, amount: "1" }, { recipient: B, amount: "2" }] };

describe("canonical inputs", () => {
  it("is independent of key order, at the top level and inside list items", () => {
    expect(canonicalInputs({ token: "0x1", recipients: [{ recipient: A, amount: "1" }] }))
      .toBe(canonicalInputs({ recipients: [{ amount: "1", recipient: A }], token: "0x1" }));
  });
  it("is sensitive to list order, values, and added keys", () => {
    const base = inputsHash(INPUTS);
    expect(inputsHash({ recipients: [INPUTS.recipients[1], INPUTS.recipients[0]] })).not.toBe(base);
    expect(inputsHash({ recipients: [{ recipient: A, amount: "1" }, { recipient: B, amount: "3" }] })).not.toBe(base);
    expect(inputsHash({ ...INPUTS, token: "0x0000000000000000000000000000000000000000" })).not.toBe(base);
  });
});

describe("issue / verify", () => {
  it("round-trips, returning quotedAt, quoteId and the terms hash from the TOKEN", () => {
    const { quoteToken, quoteId } = issueQuoteToken(ID, INPUTS, 1_700_000_000_000);
    const r = verifyQuoteToken(quoteToken, ID, INPUTS);
    expect(r).toEqual({ ok: true, quotedAt: 1_700_000_000_000, quoteId, termsHash: termsHash(undefined) });
  });
  it("binds the quote's terms: the hash in the token is the hash of exactly those terms", () => {
    const terms = { feeBps: "25", treasury: "0xa282833b52b1b66d58bd2007081dcc037798c0b0", fee: "250000" };
    const { quoteToken } = issueQuoteToken(ID, INPUTS, 1, terms);
    const r = verifyQuoteToken(quoteToken, ID, INPUTS);
    if (!r.ok) throw new Error("expected ok");
    expect(r.termsHash).toBe(termsHash({ fee: "250000", feeBps: "25", treasury: terms.treasury })); // key order irrelevant
    expect(r.termsHash).not.toBe(termsHash({ ...terms, feeBps: "30" }));
    expect(r.termsHash).not.toBe(termsHash({ ...terms, treasury: "0x1d2c3b4a5f6e7d8c9b0a1f2e3d4c5b6a7f8e9d0c" }));
    expect(termsHash(undefined)).toBe(termsHash({}));
  });
  it("every quote gets a distinct quoteId", () => {
    const ids = new Set(Array.from({ length: 20 }, () => issueQuoteToken(ID, INPUTS, 1).quoteId));
    expect(ids.size).toBe(20);
  });
  it("fails closed on: missing, non-string, malformed, forged signature, edited payload", () => {
    const { quoteToken } = issueQuoteToken(ID, INPUTS, 1);
    const [payload, sig] = quoteToken.split(".");
    const edited = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), t: Date.now() })).toString("base64url");
    for (const t of [undefined, null, 42, "", "nodot", "a.b.c", `${payload}.x${sig}`, `${edited}.${sig}`]) {
      expect(verifyQuoteToken(t, ID, INPUTS).ok, String(t)).toBe(false);
    }
  });
  it("fails closed when the action, version, chain, or inputs differ from what was quoted", () => {
    const { quoteToken } = issueQuoteToken(ID, INPUTS, 1);
    expect(verifyQuoteToken(quoteToken, { ...ID, actionId: "other" }, INPUTS).ok).toBe(false);
    expect(verifyQuoteToken(quoteToken, { ...ID, version: "1.0.0" }, INPUTS).ok).toBe(false);
    expect(verifyQuoteToken(quoteToken, { ...ID, chainId: 10143 }, INPUTS).ok).toBe(false);
    expect(verifyQuoteToken(quoteToken, ID, { recipients: [{ recipient: A, amount: "1" }, { recipient: B, amount: "20" }] }).ok).toBe(false);
  });
  it("a token signed with a different secret is refused", () => {
    const prior = process.env.AUTH_SESSION_SECRET;
    process.env.AUTH_SESSION_SECRET = "secret-one";
    const { quoteToken } = issueQuoteToken(ID, INPUTS, 1);
    process.env.AUTH_SESSION_SECRET = "secret-two";
    try {
      expect(verifyQuoteToken(quoteToken, ID, INPUTS).ok).toBe(false);
    } finally {
      if (prior === undefined) delete process.env.AUTH_SESSION_SECRET; else process.env.AUTH_SESSION_SECRET = prior;
    }
  });
});
