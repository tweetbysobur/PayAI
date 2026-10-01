/**
 * PayAI SDK — core type contracts (Phase 1, Stage 1).
 *
 * These are the types a protocol capability is described in. They are
 * deliberately DATA-first: an Action declares what it is, what inputs it
 * takes, and — critically — the exact contract addresses it is ever allowed
 * to touch. PayAI enforces that declaration against whatever the action's
 * own build() actually returns (see lib/sdk/validate.ts), so an action's
 * code is never trusted on its own to decide where funds go.
 *
 * That split is the whole reason this file does not expose anything shaped
 * like `execute(to, data, value)`. An arbitrary-calldata entry point handed
 * to a protocol — under any name, including a `build()` whose output nobody
 * checks — is the failure mode the architecture spec (docs/sdk/
 * ARCHITECTURE_SPEC_v0.1.md §5, §16) exists to prevent.
 *
 * Signer-agnostic by construction: nothing here references a wallet, a
 * private key, an account, or a signing client. An Action's only output
 * toward execution is UnsignedActionStep[] — the same {to, data, value}
 * shape lib/monad/swap.ts's UnsignedStep already uses, which is already
 * driven by two independent signers in this codebase (the browser wallet
 * via lib/ask/intent/orchestrate.ts, and a server-held per-user key via
 * lib/telegram/tradeRunner.ts). Deliberately NOT imported from swap.ts:
 * that module is server-only and swap-specific, and the SDK surface is the
 * part intended to be extracted to packages/sdk at Stage 2. The
 * compile-time compatibility assertion at the bottom of this file is what
 * guarantees the two shapes can never silently drift apart.
 */
import type { Address } from "viem";
import type { UnsignedStep } from "@/lib/monad/swap";

/** Numeric EVM chain id. Monad mainnet is 143, testnet 10143 (see
 *  lib/monad/config.ts's monadMainnet/monadTestnet). Present so an action
 *  is always pinned to exactly one chain and can be refused when the app is
 *  pointed at a different one — NOT a claim that PayAI supports any chain
 *  beyond Monad today. */
export type ChainId = number;

/** The full, stable identity of one action. protocolId + actionId + version
 *  is the complete key: a version is part of the identity, not metadata
 *  attached to it, so "the action changed underneath a quote the user already
 *  saw" is detectable rather than silent (spec §18). */
export interface ActionIdentity {
  protocolId: string;
  actionId: string;
  /** Semver. Compared exactly — never range-matched, never auto-upgraded. */
  version: string;
}

export interface ActionMetadata extends ActionIdentity {
  /** Display name, e.g. "Wrap MON". */
  name: string;
  description: string;
  chainId: ChainId;
  /**
   * Every contract address this action is EVER permitted to send a
   * transaction to. Enforced by lib/sdk/validate.ts against the steps
   * build() actually returns — an action that returns a step targeting
   * anything outside this list is rejected in full, not partially executed.
   *
   * This mirrors, off-chain, what contracts/contracts/PayAITradeExecutor.sol
   * already does on-chain with its owner-gated Kuru market allowlist
   * (`setKuruMarket`): the executable target set is data an owner controls,
   * never something the calling code chooses for itself at request time.
   */
  allowedTargets: readonly Address[];
}

/** How one SCALAR input parameter is described. The `type` drives which
 *  validator runs in lib/sdk/validate.ts — there is no escape hatch type, and
 *  no `any`, deliberately: an unvalidatable parameter would be a hole straight
 *  through Layer A. */
export interface ScalarInputField {
  /**
   * "units" is an exact integer amount in the token's smallest unit, as a
   * decimal-digit string ("1500000" = 1.5 USDC). It is the only amount type
   * that never passes through floating point anywhere: Layer A checks it with
   * a regex and BigInt, and the action consumes it with BigInt. Prefer it for
   * anything that moves funds; "amount" (human decimal) remains for the
   * single-input actions that already use it.
   */
  type: "amount" | "units" | "token" | "address" | "string" | "number" | "boolean";
  required: boolean;
  description: string;
  /**
   * `amount` fields only. When present, the value is additionally checked
   * for real representability at this precision using the app's EXISTING
   * decimal helpers (lib/monad/verify.ts) rather than a second, parallel
   * amount parser. Absent means shape-only validation (positive, finite,
   * non-exponential) and the action is responsible for its own conversion.
   */
  decimals?: number;
  /** `string` fields only — hard cap so a free-text parameter can't be used
   *  to stash an unbounded blob. Defaults to 200 when absent. */
  maxLength?: number;
}

/**
 * A bounded list of flat records — e.g. split_payment's recipients. Each item
 * must have EXACTLY the declared keys (no extras), each validated by the
 * scalar rules above. Lists don't nest: an item field is always a scalar, so
 * Layer A stays a fixed-depth check with no recursion for an input to exploit.
 */
export interface ListInputField {
  type: "list";
  required: boolean;
  description: string;
  minItems: number;
  maxItems: number;
  items: Readonly<Record<string, ScalarInputField>>;
}

export type ActionInputField = ScalarInputField | ListInputField;

export interface ActionInputSchema {
  [paramName: string]: ActionInputField;
}

/** One item of a list input — a flat record of strings. */
export type ActionInputItem = Readonly<Record<string, string>>;

/** A scalar input is a string; a list input is an array of flat string
 *  records. Nothing else is representable. */
export type ActionInputValue = string | readonly ActionInputItem[];

/** Inputs always arrive as strings (or lists of string records) — they
 *  originate from natural-language slot-filling, so a "number" parameter is
 *  the string "5", not 5. The validators in lib/sdk/validate.ts are what turn
 *  that into a checked value; nothing downstream should re-parse a raw input
 *  itself. */
export type ActionInputs = Readonly<Record<string, ActionInputValue>>;

/**
 * Base class for errors an action throws because the USER's input can't be
 * used (a bad recipient, an unusable token, an amount below the token's
 * precision…). The routes show its message to the user; any other error is
 * treated as internal and replaced with a generic one.
 */
export class ActionInputError extends Error {}

/** A validated scalar input as a string. Absent → "". A list where a scalar
 *  was expected can't occur after Layer A (it rejects the type mismatch), but
 *  is treated as absent here rather than stringified. */
export function inputString(inputs: ActionInputs, key: string): string {
  const v = inputs[key];
  return typeof v === "string" ? v : "";
}

/** A validated list input. Absent (or a scalar, which Layer A rejects) → []. */
export function inputList(inputs: ActionInputs, key: string): readonly ActionInputItem[] {
  const v = inputs[key];
  return Array.isArray(v) ? (v as readonly ActionInputItem[]) : [];
}

/**
 * Funds leaving the user's wallet to a THIRD party — what lib/sdk/policy.ts
 * runs PayAI's payment compliance/risk engine against. Amounts are exact base
 * units. An action that only moves funds within the user's own position
 * (wrap/unwrap, supply/withdraw to self) declares none.
 */
export interface ActionOutflow {
  recipient: Address;
  amountUnits: bigint;
  /** Zero address for native MON. */
  token: Address;
  symbol: string;
  decimals: number;
}

/** The read-only result of asking an action "what would this do?".
 *  Producing one must never sign, broadcast, approve, or move anything —
 *  the same boundary lib/ask/types.ts's TradePreviewIntent already documents
 *  for trade previews. */
export interface ActionQuoteResult {
  /** One-line human summary for the preview card. */
  summary: string;
  /** Whatever else the action wants shown before approval, already
   *  formatted for display. Values are strings so nothing downstream has to
   *  guess at units or re-format a number. */
  details: Readonly<Record<string, string>>;
  /** Date.now() when this quote was produced. Staleness is checked before
   *  execution, mirroring lib/monad/tradeQuote.ts's own quotedAt handling. */
  quotedAt: number;
}

/**
 * One unsigned transaction the user's own wallet (or an existing PayAI
 * signer) will be asked to sign. Structurally identical to
 * lib/monad/swap.ts's UnsignedStep apart from the `kind` label — see
 * ASSERT_STEP_TX_SHAPE_MATCHES below.
 */
export interface UnsignedActionStep {
  /** "approve" for an ERC-20 allowance pre-step, "action" for the call the
   *  action actually exists to make. Same two-phase shape the existing swap
   *  path already produces, so a future orchestrator branch can drive these
   *  with the loop it already has. */
  kind: "approve" | "action";
  label: string;
  tx: { to: Address; data: `0x${string}`; value: string };
  /**
   * REQUIRED on an "approve" step, ignored on an "action" step. Declares the
   * intent of the allowance so Layer B (lib/sdk/validate.ts's
   * validateApprovalStep) can prove the step does exactly — and only — that:
   *   - `token`   — the ERC-20 the approval is sent to; must equal tx.to.
   *   - `spender` — who receives the allowance; must be an allowlisted target
   *     (a canonical PayAI contract), never an arbitrary or caller-controlled
   *     address. This is the theft-critical field.
   *   - `amount`  — the exact allowance, in base units; must be positive and
   *     must NOT be unlimited (uint256 max).
   * These are NEVER trusted on their own: Layer B decodes the real
   * approve(address,uint256) calldata and requires it to match this
   * declaration EXACTLY (selector, length, spender, amount) before the step is
   * allowed to reach a signer. An "approve" step that omits this, or whose
   * calldata diverges from it, is rejected in full.
   */
  approval?: { token: Address; spender: Address; amount: string };
}

export interface Action extends ActionMetadata {
  inputSchema: ActionInputSchema;
  /** Read-only preview. See ActionQuoteResult. */
  quote(inputs: ActionInputs): Promise<ActionQuoteResult>;
  /**
   * Builds the unsigned step(s). NOT trusted: every returned step's `tx.to`
   * is checked against this action's allowedTargets AND its protocol's
   * allowedTargets before anything reaches a signer. A build() that is
   * buggy, or outright malicious, cannot widen its own reach — the check
   * runs on its output, not on its promises.
   */
  build(inputs: ActionInputs, quote: ActionQuoteResult): Promise<UnsignedActionStep[]>;
  /**
   * Turns a CONFIRMED on-chain receipt into display fields. Read-only, and
   * only ever called after settlement has independently verified the receipt
   * (the same discipline app/api/swap/confirm/route.ts already applies: the
   * chain is the source of truth, never the caller's claim).
   */
  parseResult(receipt: ActionReceipt): Promise<Readonly<Record<string, string>>>;
  /**
   * OPTIONAL. Third-party outflows these validated inputs would cause. When
   * present, the preview and build routes run PayAI's payment policy
   * (sanctions, recipient, risk, caps — lib/sdk/policy.ts) against them, the
   * same engine the single-recipient send path uses. Read-only; never signs.
   */
  outflows?(inputs: ActionInputs): Promise<readonly ActionOutflow[]>;
  /**
   * OPTIONAL. The third-party outflows a CONFIRMED receipt actually settled,
   * decoded from canonical on-chain events only — never from inputs or a
   * quote. The confirm route records one history row per returned outflow.
   * Returns [] when the receipt carries no canonical settlement event. Never
   * throws.
   */
  settledOutflows?(receipt: ActionReceipt): Promise<readonly ActionOutflow[]>;
}

/** The minimum a result parser is given. Deliberately narrow — an action
 *  gets the outcome and its logs, not a client it could make further calls
 *  with. */
export interface ActionReceipt {
  status: "success" | "reverted";
  txHash: `0x${string}`;
  logs: readonly { address: Address; topics: readonly `0x${string}`[]; data: `0x${string}` }[];
}

export interface ProtocolAdapter {
  protocolId: string;
  name: string;
  chainId: ChainId;
  /** Real asset URL only. A fabricated or AI-generated logo standing in for
   *  a real protocol's identity would make the UI lie about who the user is
   *  transacting with. Absent is fine; invented is not. */
  logoUrl?: string;
  docsUrl?: string;
  actions: readonly Action[];
  /**
   * The ceiling on every address ANY action under this protocol may target.
   * Checked in addition to the per-action list, so an individual action can
   * only ever narrow the protocol's reach, never widen it.
   */
  allowedTargets: readonly Address[];
}

/**
 * What the (future) execution layer is handed once a user has approved.
 * Phase 1 produces this shape but does not wire it into Ask PayAI — that
 * is Phase 2 (see docs/sdk/PHASE2_UI_NOTES.md).
 *
 * `walletAddress` is the ONLY account this may ever execute against, and it
 * comes from the connected session — never from an action, an adapter, or
 * anything a protocol supplied.
 */
export interface ExecutionRequest {
  protocolId: string;
  actionId: string;
  /** The exact version the user's preview was quoted against. A mismatch
   *  against the live registry at execution time is refused, never silently
   *  upgraded (spec §18). */
  version: string;
  inputs: ActionInputs;
  walletAddress: Address;
  chainId: ChainId;
  /** Carried through so staleness can be judged at execution time. */
  quotedAt: number;
}

/**
 * Compile-time proof that UnsignedActionStep's transaction payload stays
 * structurally identical to the shape the existing execution loop already
 * consumes (lib/monad/swap.ts's UnsignedStep). If either side ever changes,
 * this stops compiling — which is the point: the SDK is supposed to feed
 * PayAI's existing execution path, not a parallel one, and a silent
 * divergence here is exactly how a second transaction system gets born by
 * accident.
 *
 * Type-only import, fully erased at build time — no runtime coupling to a
 * server-only module, so this file stays extractable to packages/sdk later.
 */
type AssertExtends<T extends U, U> = T;
export type ASSERT_STEP_TX_SHAPE_MATCHES = AssertExtends<UnsignedActionStep["tx"], UnsignedStep["tx"]>;
