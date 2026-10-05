import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, expectTypeOf, it } from "vitest";
import { classifyOutcome, classifyRunError, KIND_CATEGORY, type OutcomeClass } from "@/lib/plans-client/outcomes";
import type { RunOutcome, RunOutcomeKind } from "@/lib/plans-client/runner";

/**
 * Phase 2C Stage 5C-2c — the pure run-outcome classifier
 * (lib/plans-client/outcomes.ts). Outcomes are built directly; the runner
 * tests prove the runner produces them.
 */

const PLAN = `plan_${"a".repeat(32)}`;
const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const QID = "0".repeat(31) + "1";

const out = (kind: RunOutcomeKind, o: Partial<RunOutcome> = {}): RunOutcome => ({
  kind, planId: PLAN, message: "runner text that must never matter", nodeId: null, quoteId: null, txHash: null,
  approvalTxHashes: [], code: null, status: null, journaled: null, plan: null, ...o,
});
const c = (kind: RunOutcomeKind, o: Partial<RunOutcome> = {}) => classifyOutcome(out(kind, o));

/** The RunOutcomeKind union, read from the runner's source. */
const KINDS: RunOutcomeKind[] = (() => {
  const src = readFileSync(join(__dirname, "..", "lib", "plans-client", "runner.ts"), "utf8");
  const union = src.slice(src.indexOf("export type RunOutcomeKind ="), src.indexOf(";", src.indexOf("export type RunOutcomeKind =")));
  return [...union.matchAll(/"([a-z_]+)"/g)].map((m) => m[1] as RunOutcomeKind);
})();

/** Every outcome shape the runner can produce (kind × code × facts). */
const CASES: [string, RunOutcome][] = [
  ["completed", out("completed")],
  ["already_running same instance", out("already_running")],
  ["already_running LOCK_HELD", out("already_running", { code: "LOCK_HELD" })],
  ["lock_unavailable", out("lock_unavailable", { code: "LOCK_UNAVAILABLE" })],
  ["lock_unavailable reentered", out("lock_unavailable", { code: "LOCK_REENTERED" })],
  ["signature_unresolved", out("signature_unresolved", { code: "SIGNATURE_UNRESOLVED", nodeId: "n1", quoteId: QID })],
  ["signature_unresolved, quote unknown", out("signature_unresolved", { code: "SIGNATURE_UNRESOLVED", nodeId: "n1" })],
  ["aborted before signing", out("aborted", { nodeId: "n1", quoteId: QID })],
  ["aborted after approvals", out("aborted", { nodeId: "n1", approvalTxHashes: [H(5)] })],
  ["aborted while settling", out("aborted", { nodeId: "n1", quoteId: QID, txHash: H(1) })],
  ["grant_required", out("grant_required")],
  ["grant_required while settling", out("grant_required", { status: 401, txHash: H(1), quoteId: QID })],
  ["wallet_locked", out("wallet_locked")],
  ["wallet_mismatch", out("wallet_mismatch")],
  ["wrong_network", out("wrong_network")],
  ["journal_unavailable", out("journal_unavailable")],
  ["not_approved", out("not_approved", { code: "NOT_APPROVED" })],
  ["expired", out("expired", { code: "EXPIRED", status: 410 })],
  ["expired while settling", out("expired", { code: "EXPIRED", status: 410, txHash: H(1), quoteId: QID })],
  ["abandoned", out("abandoned")],
  ["not_found", out("not_found", { code: "NOT_FOUND", status: 404 })],
  ["not_found WALLET_MISMATCH", out("not_found", { code: "WALLET_MISMATCH", status: 403 })],
  ["step_not_ready", out("step_not_ready", { code: "STEP_NOT_READY" })],
  ["quote_refused", out("quote_refused", { code: "QUOTE_REFUSED", status: 422 })],
  ["conflict server", out("conflict", { code: "CONFLICT", status: 409 })],
  ["conflict TX_ALREADY_RECORDED", out("conflict", { code: "TX_ALREADY_RECORDED" })],
  ["conflict QUOTE_SUPERSEDED", out("conflict", { code: "QUOTE_SUPERSEDED" })],
  ["conflict JOURNAL_CONFLICT", out("conflict", { code: "JOURNAL_CONFLICT", txHash: H(9), quoteId: QID })],
  ["bind_failed EXPIRED", out("bind_failed", { code: "EXPIRED" })],
  ["bind_failed QUOTE_MISMATCH", out("bind_failed", { code: "QUOTE_MISMATCH" })],
  ["quote_declined DECLINED", out("quote_declined", { code: "DECLINED" })],
  ["quote_declined NO_DECISION", out("quote_declined", { code: "NO_DECISION" })],
  ["quote_declined CONFIRMATION_ERROR", out("quote_declined", { code: "CONFIRMATION_ERROR" })],
  ...["QUOTE_STALE", "QUOTE_CHANGED", "FEE_TERMS_CHANGED", "QUOTE_REQUIRED", "ALREADY_BUILT", "POLICY_BLOCKED", "TARGET_NOT_ALLOWLISTED", "INVALID_INPUT", "SOMETHING_NEW", null]
    .map((code): [string, RunOutcome] => [`build_refused ${code}`, out("build_refused", { code })]),
  ["build_invalid QUOTE_MISMATCH", out("build_invalid", { code: "QUOTE_MISMATCH" })],
  ["build_invalid MALFORMED_STEPS", out("build_invalid", { code: "MALFORMED_STEPS" })],
  ["wallet_rejected REJECTED_CODE", out("wallet_rejected", { code: "REJECTED_CODE" })],
  ["wallet_rejected REJECTED_CODE after approvals", out("wallet_rejected", { code: "REJECTED_CODE", approvalTxHashes: [H(5)] })],
  ["wallet_rejected REJECTED_TEXT", out("wallet_rejected", { code: "REJECTED_TEXT" })],
  ["wallet_rejected no code", out("wallet_rejected")],
  ["wallet_error APPROVAL_SEND_FAILED", out("wallet_error", { code: "APPROVAL_SEND_FAILED" })],
  ["wallet_error APPROVAL_HASH_INVALID", out("wallet_error", { code: "APPROVAL_HASH_INVALID" })],
  ["wallet_error ACTION_SEND_FAILED", out("wallet_error", { code: "ACTION_SEND_FAILED", approvalTxHashes: [H(5)] })],
  ["wallet_error ACTION_HASH_MISSING", out("wallet_error", { code: "ACTION_HASH_MISSING" })],
  ["wallet_error no code", out("wallet_error")],
  ["approval_failed APPROVAL_REVERTED", out("approval_failed", { code: "APPROVAL_REVERTED", approvalTxHashes: [H(5)] })],
  ["approval_failed APPROVAL_TIMEOUT", out("approval_failed", { code: "APPROVAL_TIMEOUT", approvalTxHashes: [H(5)] })],
  ["approval_failed unknown", out("approval_failed")],
  ["tx_unrecorded journaled", out("tx_unrecorded", { journaled: true, txHash: H(1), quoteId: QID, status: 502 })],
  ["tx_unrecorded journaled NOT_FOUND", out("tx_unrecorded", { journaled: true, txHash: H(1), quoteId: QID, status: 404, code: "NOT_FOUND" })],
  ...["EXPIRED", "INVALID_PLAN", "INVALID_NODE", "CORRUPT"].map((code): [string, RunOutcome] =>
    [`tx_unrecorded journaled ${code}`, out("tx_unrecorded", { journaled: true, txHash: H(1), quoteId: QID, nodeId: "n1", code })]),
  ["tx_unrecorded not journaled", out("tx_unrecorded", { journaled: false, txHash: H(1), quoteId: QID })],
  ["tx_unrecorded not journaled, malformed hash", out("tx_unrecorded", { journaled: false, txHash: "0xnot-a-hash" })],
  ["confirm_rejected", out("confirm_rejected", { status: 400, txHash: H(1) })],
  ["reverted", out("reverted", { txHash: H(1) })],
  ["unverified", out("unverified", { txHash: H(1) })],
  ["stalled", out("stalled", { txHash: H(1), quoteId: QID })],
  ["rate_limited", out("rate_limited", { status: 429 })],
  ["unavailable", out("unavailable", { code: "UNAVAILABLE", status: 503 })],
  ["server_error", out("server_error", { code: "CORRUPT", status: 500 })],
  ["server_error while settling", out("server_error", { code: "CORRUPT", status: 500, txHash: H(1), quoteId: QID })],
  ["network_error", out("network_error", { status: 0 })],
  ["plan_error", out("plan_error", { code: "OUTPUT_NOT_CONFIRMED", status: 409 })],
  ["plan_error while settling", out("plan_error", { code: "OUTPUT_NOT_CONFIRMED", status: 409, txHash: H(1) })],
  ["invalid_response", out("invalid_response")],
  ["invalid_response with hash", out("invalid_response", { txHash: H(1) })],
];

describe("exhaustive", () => {
  it("the source union is what the classifier covers, kind for kind", () => {
    expect(KINDS.length).toBeGreaterThanOrEqual(34);
    expect(new Set(KINDS).size).toBe(KINDS.length);
    expect(Object.keys(KIND_CATEGORY).sort()).toEqual([...KINDS].sort());
    expectTypeOf<keyof typeof KIND_CATEGORY>().toEqualTypeOf<RunOutcomeKind>();
  });
  it("every kind classifies, keeping its kind and the category", () => {
    for (const kind of KINDS) {
      const r = c(kind);
      expect(r.kind).toBe(kind);
      expect(["success", "lock", "wallet", "quote", "build", "execution", "settlement", "recovery", "storage", "plan", "network", "internal"]).toContain(r.category);
    }
  });
  it("every case is covered by the case table", () => {
    const covered = new Set(CASES.map(([, o]) => o.kind));
    for (const kind of KINDS) expect(covered.has(kind), kind).toBe(true);
  });
  it("an unknown or malformed outcome fails closed", () => {
    for (const bad of [null, undefined, 1, "completed", {}, { kind: "new_kind" }, { kind: "toString" }, { kind: "__proto__" }]) {
      expect(classifyOutcome(bad as never)).toEqual({
        kind: "invalid_response", code: "MALFORMED_OUTCOME", txHash: null, category: "internal", tx: "uncertain",
        retry: "UNKNOWN_TRANSACTION_STATE", action: "check_wallet_activity", resumeScope: "none", terminal: true,
      });
    }
  });
  it("produces only the documented fields (no copy)", () => {
    for (const [, o] of CASES) {
      expect(Object.keys(classifyOutcome(o)).sort()).toEqual(["action", "category", "code", "kind", "resumeScope", "retry", "terminal", "tx", "txHash"]);
    }
  });
  it("never reads the runner's message", () => {
    for (const [, o] of CASES) expect(classifyOutcome({ ...o, message: "something else entirely" })).toEqual(classifyOutcome(o));
  });
});

describe("hard safety invariants", () => {
  it("anything carrying a hash is never SAFE_TO_RETRY", () => {
    for (const [name, o] of CASES) if (o.txHash !== null) expect(classifyOutcome(o).retry, name).not.toBe("SAFE_TO_RETRY");
  });
  it("an uncertain, unrecorded, journaled or recorded transaction is never SAFE_TO_RETRY", () => {
    for (const [name, o] of CASES) {
      const r = classifyOutcome(o);
      if (r.tx !== "none" && r.tx !== "approvals_only") expect(r.retry, name).not.toBe("SAFE_TO_RETRY");
    }
  });
  it("adding ANY hash (even malformed) to an otherwise retryable outcome removes SAFE_TO_RETRY", () => {
    for (const [name, o] of CASES) {
      if (classifyOutcome(o).retry !== "SAFE_TO_RETRY") continue;
      for (const txHash of [H(1), "0xbad", ""]) expect(classifyOutcome({ ...o, txHash }).retry, `${name} + ${txHash}`).not.toBe("SAFE_TO_RETRY");
    }
  });
  it("UNKNOWN and DO_NOT_RETRY never offer a resume", () => {
    for (const [name, o] of CASES) {
      const r = classifyOutcome(o);
      if (r.retry === "UNKNOWN_TRANSACTION_STATE" || r.retry === "DO_NOT_RETRY") expect(r.resumeScope, name).toBe("none");
    }
  });
  it("a malformed hash is never exposed", () => {
    for (const txHash of ["0xnot-a-hash", "0x", H(1).slice(0, 65), `${H(1)}0`, ` ${H(1)}`, 5 as unknown as string]) {
      expect(c("stalled", { txHash }).txHash).toBeNull();
      expect(c("tx_unrecorded", { journaled: false, txHash }).txHash).toBeNull();
    }
    expect(c("stalled", { txHash: H(1) }).txHash).toBe(H(1));
  });
  it("WALLET_MISMATCH never surfaces: it reads exactly like NOT_FOUND", () => {
    const a = c("not_found", { code: "WALLET_MISMATCH", status: 403 });
    const b = c("not_found", { code: "NOT_FOUND", status: 403 });
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).not.toMatch(/WALLET_MISMATCH/);
    for (const [, o] of CASES) expect(JSON.stringify(classifyOutcome(o))).not.toMatch(/WALLET_MISMATCH/);
  });
  it("classifyRunError: always unknown, never exposes the error", () => {
    for (const e of [new Error("secret 0xdeadbeef"), "boom", null, undefined, { code: 4001 }]) {
      const r = classifyRunError(e);
      expect(r).toEqual({
        kind: "invalid_response", code: "RUN_ERROR", txHash: null, category: "internal", tx: "uncertain",
        retry: "UNKNOWN_TRANSACTION_STATE", action: "check_wallet_activity", resumeScope: "none", terminal: true,
      });
      expect(JSON.stringify(r)).not.toMatch(/secret|deadbeef|boom/);
    }
  });
});

describe("classifications", () => {
  const pick = (r: OutcomeClass) => ({ category: r.category, tx: r.tx, retry: r.retry, action: r.action, resumeScope: r.resumeScope, terminal: r.terminal });
  const expectClass = (name: string, want: Partial<OutcomeClass>) => {
    const o = CASES.find(([n]) => n === name)?.[1];
    expect(o, name).toBeDefined();
    expect(pick(classifyOutcome(o!)), name).toMatchObject(want);
  };

  it("completed: success, recorded, nothing to run again", () => {
    expectClass("completed", { category: "success", tx: "recorded", retry: "DO_NOT_RETRY", action: "none", terminal: true });
  });
  it("locks: same instance waits; another tab owns it; no lock support is not an execution failure", () => {
    expectClass("already_running same instance", { category: "lock", tx: "none", retry: "USER_ACTION_REQUIRED", action: "wait", resumeScope: "none" });
    expectClass("already_running LOCK_HELD", { category: "lock", tx: "none", retry: "USER_ACTION_REQUIRED", action: "use_other_tab", resumeScope: "none" });
    for (const n of ["lock_unavailable", "lock_unavailable reentered"]) {
      expectClass(n, { category: "lock", tx: "none", retry: "DO_NOT_RETRY", action: "unsupported_browser", resumeScope: "none", terminal: true });
    }
  });
  it("aborted: with a hash resumes; without one is before the final signature", () => {
    expectClass("aborted while settling", { category: "settlement", tx: "recorded", retry: "SAFE_TO_RESUME", resumeScope: "any" });
    expectClass("aborted before signing", { tx: "none", retry: "SAFE_TO_RETRY", resumeScope: "any", terminal: false });
    expectClass("aborted after approvals", { tx: "approvals_only", retry: "SAFE_TO_RETRY" });
    expect(c("aborted", { txHash: H(1) }).txHash).toBe(H(1));
  });
  it("wallet and grant problems need the user", () => {
    expectClass("wallet_locked", { retry: "USER_ACTION_REQUIRED", action: "unlock_wallet" });
    expectClass("wallet_mismatch", { retry: "USER_ACTION_REQUIRED", action: "switch_wallet" });
    expectClass("wrong_network", { retry: "USER_ACTION_REQUIRED", action: "switch_network" });
    expectClass("grant_required", { retry: "USER_ACTION_REQUIRED", action: "reconnect_grant", tx: "none" });
  });
  it("journal unavailable: storage, a sent transaction can't be ruled out, only resumable here", () => {
    expectClass("journal_unavailable", { category: "storage", tx: "uncertain", retry: "USER_ACTION_REQUIRED", action: "fix_storage", resumeScope: "this_browser" });
  });
  it("plan state before signing", () => {
    expectClass("not_approved", { retry: "USER_ACTION_REQUIRED", action: "approve_plan" });
    for (const n of ["expired", "abandoned", "not_found", "quote_refused"]) expectClass(n, { tx: "none", retry: "DO_NOT_RETRY", action: "new_plan", terminal: true });
    expectClass("step_not_ready", { retry: "SAFE_TO_RETRY", action: "wait", terminal: false });
  });
  it("settlement errors after a recorded transaction resume — never a fresh retry — and keep the hash", () => {
    expectClass("expired while settling", { category: "settlement", tx: "recorded", retry: "SAFE_TO_RESUME", action: "contact_support", resumeScope: "any" });
    expectClass("grant_required while settling", { category: "settlement", tx: "recorded", retry: "SAFE_TO_RESUME", action: "reconnect_grant" });
    expectClass("server_error while settling", { category: "settlement", tx: "recorded", retry: "SAFE_TO_RESUME", action: "wait" });
    expectClass("plan_error while settling", { category: "settlement", tx: "recorded", retry: "SAFE_TO_RESUME" });
    expect(c("expired", { txHash: H(1) }).txHash).toBe(H(1));
    for (const kind of ["network_error", "rate_limited", "unavailable", "not_approved", "step_not_ready", "quote_refused", "conflict", "not_found"] as const) {
      expect(c(kind, { txHash: H(1) }), kind).toMatchObject({ category: "settlement", tx: "recorded", retry: "SAFE_TO_RESUME" });
    }
  });
  it("conflicts", () => {
    expectClass("conflict TX_ALREADY_RECORDED", { tx: "recorded", retry: "SAFE_TO_RESUME", resumeScope: "any" });
    expectClass("conflict QUOTE_SUPERSEDED", { retry: "USER_ACTION_REQUIRED", action: "check_wallet_activity", resumeScope: "none" });
    expectClass("conflict server", { retry: "USER_ACTION_REQUIRED", action: "check_wallet_activity", resumeScope: "none" });
    expectClass("conflict JOURNAL_CONFLICT", { category: "recovery", tx: "uncertain", retry: "UNKNOWN_TRANSACTION_STATE", action: "check_wallet_activity", resumeScope: "none", terminal: true });
    expect(c("conflict", { code: "JOURNAL_CONFLICT", txHash: H(9) }).txHash).toBe(H(9));
  });
  it("quotes and builds", () => {
    for (const n of ["bind_failed EXPIRED", "bind_failed QUOTE_MISMATCH", "quote_declined DECLINED", "quote_declined NO_DECISION", "quote_declined CONFIRMATION_ERROR"]) {
      expectClass(n, { category: "quote", tx: "none", retry: "SAFE_TO_RETRY", action: "review_again" });
    }
    for (const n of ["QUOTE_STALE", "QUOTE_CHANGED", "FEE_TERMS_CHANGED", "QUOTE_REQUIRED"]) expectClass(`build_refused ${n}`, { retry: "SAFE_TO_RETRY", action: "review_again" });
    expectClass("build_refused ALREADY_BUILT", { retry: "USER_ACTION_REQUIRED", action: "check_wallet_activity", resumeScope: "none" });
    for (const n of ["POLICY_BLOCKED", "TARGET_NOT_ALLOWLISTED", "INVALID_INPUT"]) expectClass(`build_refused ${n}`, { retry: "DO_NOT_RETRY", action: "new_plan" });
    for (const n of ["SOMETHING_NEW", "null"]) expectClass(`build_refused ${n}`, { retry: "DO_NOT_RETRY", action: "contact_support" });
    for (const n of ["build_invalid QUOTE_MISMATCH", "build_invalid MALFORMED_STEPS"]) expectClass(n, { retry: "DO_NOT_RETRY", action: "contact_support" });
  });
  it("wallet rejection: only a rejection CODE proves nothing was sent", () => {
    expectClass("wallet_rejected REJECTED_CODE", { category: "wallet", tx: "none", retry: "SAFE_TO_RETRY" });
    expectClass("wallet_rejected REJECTED_CODE after approvals", { tx: "approvals_only", retry: "SAFE_TO_RETRY" });
    for (const n of ["wallet_rejected REJECTED_TEXT", "wallet_rejected no code"]) {
      expectClass(n, { tx: "uncertain", retry: "USER_ACTION_REQUIRED", action: "check_wallet_activity", resumeScope: "none" });
    }
  });
  it("wallet errors: an approval failure is not a final-action failure", () => {
    for (const n of ["wallet_error APPROVAL_SEND_FAILED", "wallet_error APPROVAL_HASH_INVALID"]) {
      expectClass(n, { category: "wallet", tx: "approvals_only", retry: "USER_ACTION_REQUIRED", action: "check_wallet_activity" });
    }
    for (const n of ["wallet_error ACTION_SEND_FAILED", "wallet_error ACTION_HASH_MISSING", "wallet_error no code"]) {
      expectClass(n, { category: "execution", tx: "uncertain", retry: "UNKNOWN_TRANSACTION_STATE", action: "check_wallet_activity", resumeScope: "none", terminal: true });
    }
  });
  it("approval failures", () => {
    expectClass("approval_failed APPROVAL_REVERTED", { tx: "approvals_only", retry: "SAFE_TO_RETRY" });
    expectClass("approval_failed APPROVAL_TIMEOUT", { tx: "approvals_only", retry: "USER_ACTION_REQUIRED", action: "wait_for_approval" });
    expectClass("approval_failed unknown", { tx: "approvals_only", retry: "USER_ACTION_REQUIRED", action: "check_wallet_activity", resumeScope: "none" });
  });
  it("signature_unresolved (5C-2d): a final signature may have been sent — unknown, never resumable or retryable", () => {
    for (const n of ["signature_unresolved", "signature_unresolved, quote unknown"]) {
      expectClass(n, { category: "recovery", tx: "uncertain", retry: "UNKNOWN_TRANSACTION_STATE", action: "check_wallet_activity", resumeScope: "none", terminal: true });
    }
    expect(c("signature_unresolved").code).toBeNull();
    expect(c("signature_unresolved", { code: "SIGNATURE_UNRESOLVED" }).code).toBe("SIGNATURE_UNRESOLVED");
  });
  it("tx_unrecorded journaled + NOT_FOUND (S3): resuming can't record it — check the wallet, in this browser (5C-2f action)", () => {
    expectClass("tx_unrecorded journaled NOT_FOUND", { tx: "journaled", retry: "USER_ACTION_REQUIRED", action: "check_wallet_activity", resumeScope: "this_browser", terminal: false });
    expect(c("tx_unrecorded", { journaled: true, txHash: H(1), code: "NOT_FOUND" }).txHash).toBe(H(1));
    // Other /tx failure codes still resume.
    expect(c("tx_unrecorded", { journaled: true, txHash: H(1), code: "CONFLICT" }).retry).toBe("SAFE_TO_RESUME");
  });
  it("tx_unrecorded: journaled resumes in this browser only; unjournaled must never run again", () => {
    expectClass("tx_unrecorded journaled", { category: "recovery", tx: "journaled", retry: "SAFE_TO_RESUME", resumeScope: "this_browser", terminal: false });
    expectClass("tx_unrecorded not journaled", { category: "execution", tx: "sent_unrecorded", retry: "DO_NOT_RETRY", action: "check_wallet_activity", resumeScope: "none", terminal: true });
    expectClass("tx_unrecorded not journaled, malformed hash", { tx: "sent_unrecorded", retry: "DO_NOT_RETRY", resumeScope: "none" });
    expect(c("tx_unrecorded", { journaled: false, txHash: H(1) }).txHash).toBe(H(1));
    // journaled null / missing is treated as NOT journaled
    expect(c("tx_unrecorded", { txHash: H(1) })).toMatchObject({ tx: "sent_unrecorded", retry: "DO_NOT_RETRY" });
  });
  it("settlement verdicts", () => {
    expectClass("confirm_rejected", { category: "settlement", tx: "recorded", retry: "DO_NOT_RETRY", action: "contact_support", terminal: true });
    expectClass("reverted", { tx: "recorded", retry: "DO_NOT_RETRY", action: "new_plan", terminal: true });
    expectClass("unverified", { tx: "recorded", retry: "DO_NOT_RETRY", action: "contact_support", terminal: true });
    expectClass("stalled", { category: "settlement", tx: "recorded", retry: "SAFE_TO_RESUME", action: "wait", resumeScope: "any", terminal: false });
  });
  it("transient problems before signing wait and retry", () => {
    for (const n of ["rate_limited", "unavailable", "server_error", "network_error"]) expectClass(n, { category: "network", tx: "none", retry: "SAFE_TO_RETRY", action: "wait" });
    expectClass("plan_error", { retry: "DO_NOT_RETRY", action: "contact_support" });
  });
  it("invalid_response: the state can't be established", () => {
    for (const n of ["invalid_response", "invalid_response with hash"]) {
      expectClass(n, { category: "internal", tx: "uncertain", retry: "UNKNOWN_TRANSACTION_STATE", action: "contact_support", resumeScope: "none" });
    }
  });
  it("server codes are kept as given (except WALLET_MISMATCH)", () => {
    expect(c("server_error", { code: "CORRUPT" }).code).toBe("CORRUPT");
    expect(c("build_refused", { code: "POLICY_BLOCKED" }).code).toBe("POLICY_BLOCKED");
    expect(c("aborted").code).toBeNull();
  });
});

/* ══ Source boundary ═══════════════════════════════════════════════════════ */

describe("source boundary: outcomes.ts", () => {
  const raw = readFileSync(join(__dirname, "..", "lib", "plans-client", "outcomes.ts"), "utf8");
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  it("imports only HASH_RE from the journal and types from the runner", () => {
    const specs = [...raw.matchAll(/^\s*import\s+(type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']/gm)].map((m) => `${m[1] ?? ""}${m[2]} ${m[3]}`);
    expect(specs).toEqual(["{ HASH_RE } ./journal", "type { RunOutcome, RunOutcomeKind } ./runner"]);
    expect(raw).not.toMatch(/require\(|import\(/);
  });
  it("no network, signing, broadcasting, RPC, React, app, Ask, Telegram, automation or server-only", () => {
    for (const re of [
      /\bfetch\b/, /sendTransaction|signMessage|signTypedData|signTransaction|eth_send|personal_sign|privateKey/i,
      /getPublicClient|createPublicClient|\brpc\b/i, /react/i, /@\/app|lib\/ask|telegram|automation|server-only/i,
    ]) {
      expect(src).not.toMatch(re);
    }
  });
  it("no browser globals or I/O", () => {
    expect(src).not.toMatch(/\b(localStorage|sessionStorage|window|navigator|document|globalThis|console|process)\b/);
    expect(src).not.toMatch(/setTimeout|setInterval|Date\.now|Math\.random|\bawait\b|\basync\b/);
  });
  it("builds no UI copy: never reads or writes a message", () => {
    expect(src).not.toMatch(/\.message\b|\bmessage\s*:/);
    expect(src).not.toMatch(/\btitle\b|\blabel\b|\bdescription\b/);
  });
});

/* ══ Stage 5C-2f — a sent transaction is never hidden behind a dead plan ═══ */

describe("5C-2f — tx_unrecorded (journaled) with a permanent plan failure", () => {
  const PERMANENT = ["EXPIRED", "NOT_FOUND", "INVALID_PLAN", "INVALID_NODE", "CORRUPT"];
  it("each permanent code → USER_ACTION_REQUIRED / check_wallet_activity / this_browser; hash and quote kept; never resume, retry or new_plan", () => {
    for (const code of PERMANENT) {
      const r = c("tx_unrecorded", { journaled: true, txHash: H(1), quoteId: QID, nodeId: "n1", code });
      expect(r, code).toMatchObject({
        kind: "tx_unrecorded", code, category: "recovery", tx: "journaled", txHash: H(1),
        retry: "USER_ACTION_REQUIRED", action: "check_wallet_activity", resumeScope: "this_browser", terminal: false,
      });
      expect(r.action).not.toBe("new_plan");
    }
  });
  it("other journaled codes keep resuming; unjournaled keeps DO_NOT_RETRY", () => {
    for (const code of [null, "CONFLICT", "UNAVAILABLE", "INTERNAL_ERROR", "RATE_LIMITED", "expired", "Not_Found"]) {
      expect(c("tx_unrecorded", { journaled: true, txHash: H(1), code }).retry, String(code)).toBe("SAFE_TO_RESUME");
    }
    for (const code of [null, ...PERMANENT]) {
      expect(c("tx_unrecorded", { journaled: false, txHash: H(1), code })).toMatchObject({ tx: "sent_unrecorded", retry: "DO_NOT_RETRY", action: "check_wallet_activity", resumeScope: "none" });
    }
  });
  it("sweep: no journaled tx_unrecorded with a permanent code is ever SAFE_TO_RESUME, SAFE_TO_RETRY or new_plan", () => {
    for (const code of PERMANENT) for (const status of [null, 404, 410, 500]) for (const txHash of [H(1), "0xbad"]) {
      const r = c("tx_unrecorded", { journaled: true, code, status, txHash });
      expect(["SAFE_TO_RESUME", "SAFE_TO_RETRY"]).not.toContain(r.retry);
      expect(r.action).not.toBe("new_plan");
      expect(r.resumeScope).toBe("this_browser");
    }
    for (const [name, o] of CASES) {
      const r = classifyOutcome(o);
      if (o.kind === "tx_unrecorded" && o.journaled === true && o.code && PERMANENT.includes(o.code)) expect(r.retry, name).toBe("USER_ACTION_REQUIRED");
    }
  });
});
