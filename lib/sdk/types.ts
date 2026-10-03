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
  /**
   * OPTIONAL. The economic terms this quote was priced on that the build must
   * reproduce EXACTLY — e.g. split's platform fee rate, treasury and fee
   * amount, read live from the chain. Bound into the signed quote token
   * (lib/sdk/quoteToken.ts): if the build-time quote's terms differ from the
   * previewed ones, the build is refused (FEE_TERMS_CHANGED), never silently
   * executed on new terms. Strings only, canonicalized by key.
   */
  terms?: Readonly<Record<string, string>>;
  /**
   * OPTIONAL. What the user was SHOWN that isn't a fixed term but must not
   * move materially before the build — e.g. a swap's expected output and
   * route provider. Signed into the quote token (lib/sdk/quoteToken.ts) and
   * handed back to build() VERIFIED as ActionBuildContext.preview, so the
   * build compares a fresh quote against exactly what was previewed — never
   * against a value the client sends. Short strings only.
   */
  snapshot?: Readonly<Record<string, string>>;
}

/** What the build route knows beyond the inputs: the session wallet the
 *  steps are being built for (read-only — e.g. to check an existing
 *  allowance). Never an input a client controls. */
export interface ActionBuildContext {
  wallet: Address;
  /** The previewed quote's snapshot, recovered from the VERIFIED quote token
   *  (absent when the preview carried none). */
  preview?: Readonly<Record<string, string>>;
}

/** What the confirm route knows beyond the receipt itself: the terms the
 *  confirmed transaction was BUILT on, and the wallet it was built for (both
 *  from the server's build record — never from the request). */
export interface ActionResultContext {
  terms?: Readonly<Record<string, string>>;
  /** Lowercased wallet the build was made for. */
  wallet?: string;
}

/**
 * Thrown by build() when a fresh quote moved materially from the previewed
 * snapshot (route/provider change, or output drift beyond the slippage the
 * user accepted). The build route answers QUOTE_CHANGED and consumes the
 * quote — a fresh preview is required; nothing is built on the new numbers.
 */
export class ActionQuoteChangedError extends Error {}

/**
 * A swap a CONFIRMED receipt actually executed, decoded from the canonical
 * on-chain trade event only (never from inputs, a quote or the client) and
 * checked against the build's terms. Amounts are exact base units.
 */
export interface SettledTrade {
  tokenIn: Address;
  tokenOut: Address;
  /** Gross amount the user paid in, fee included. */
  amountIn: bigint;
  /** What the user received. */
  amountOut: bigint;
  /** PayAI fee, in tokenIn. */
  fee: bigint;
  symbolIn: string;
  symbolOut: string;
  decimalsIn: number;
  decimalsOut: number;
  provider: string;
}

/** A settlement's confirmed outcome, split into what reached the user's
 *  recipients and the PayAI platform fee leg (if any). */
export interface SettledOutflows {
  /** What each recipient actually RECEIVED (amountUnits). `recordedAmountUnits`,
   *  when present, is the amount the history row records instead — e.g. a
   *  transfer records the gross amount sent, matching the existing send's
   *  history rows, while `amountUnits` stays the net delivered. */
  recipients: readonly (ActionOutflow & { recordedAmountUnits?: bigint })[];
  fee: { amountUnits: bigint; token: Address; treasury: Address; symbol: string; decimals: number } | null;
  /** Total the payer paid, when it isn't simply recipients + fee. */
  grossUnits?: bigint;
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

/**
 * A value an action produces once it has CONFIRMED on-chain, declared up
 * front so a planner can decide — without executing anything — whether this
 * action can supply what a later action's input needs.
 *
 *   "units"  — an exact integer amount in base units (bindable into a
 *              `units` input). `denominatedIn` names the input field that
 *              holds the token this amount is in, so token compatibility can
 *              be checked statically; absent means native MON.
 *   "token"  — a token contract address (bindable into a `token` input).
 *   "units[]"— a per-item list of amounts (descriptive; not bindable).
 *
 * Declarations are data only. The confirmed VALUES come from the action's
 * on-chain result decoding, never from a quote or a prediction.
 */
export interface ActionOutputDeclaration {
  type: "units" | "token" | "units[]";
  description: string;
  denominatedIn?: { input: string };
}

/**
 * How an action charges PayAI's platform fee relative to the amounts in its
 * inputs, declared as metadata so planning code never has to recognise an
 * action by name:
 *   - "on_top": the fee is floor(total * feeBps / 10000) ADDED to the
 *     input amounts — the wallet pays total + fee (split_payment).
 * Absent = the action's input amounts are what the wallet pays (any fee is
 * taken out of them, or there is none).
 */
export interface ActionFeePolicy {
  mode: "on_top";
}

export interface Action extends ActionMetadata {
  inputSchema: ActionInputSchema;
  /** OPTIONAL. See ActionFeePolicy. */
  feePolicy?: Readonly<ActionFeePolicy>;
  /** OPTIONAL. The `action` label history rows record for this action
   *  (defaults to actionId) — lets an SDK action write the same kind of row
   *  as the existing flow it replaces (e.g. "send_payment"). */
  historyAction?: string;
  /** OPTIONAL. The outputs this action produces on confirmation, by name.
   *  An action without declarations produces nothing bindable. */
  outputs?: Readonly<Record<string, ActionOutputDeclaration>>;
  /** Read-only preview. See ActionQuoteResult. */
  quote(inputs: ActionInputs): Promise<ActionQuoteResult>;
  /**
   * Builds the unsigned step(s). NOT trusted: every returned step's `tx.to`
   * is checked against this action's allowedTargets AND its protocol's
   * allowedTargets before anything reaches a signer. A build() that is
   * buggy, or outright malicious, cannot widen its own reach — the check
   * runs on its output, not on its promises.
   */
  build(inputs: ActionInputs, quote: ActionQuoteResult, ctx?: ActionBuildContext): Promise<UnsignedActionStep[]>;
  /**
   * Turns a CONFIRMED on-chain receipt into display fields. Read-only, and
   * only ever called after settlement has independently verified the receipt
   * (the same discipline app/api/swap/confirm/route.ts already applies: the
   * chain is the source of truth, never the caller's claim).
   */
  parseResult(receipt: ActionReceipt, ctx?: ActionResultContext): Promise<Readonly<Record<string, string>>>;
  /**
   * OPTIONAL. Third-party outflows these validated inputs would cause. When
   * present, the preview and build routes run PayAI's payment policy
   * (sanctions, recipient, risk, caps — lib/sdk/policy.ts) against them, the
   * same engine the single-recipient send path uses. Read-only; never signs.
   */
  outflows?(inputs: ActionInputs): Promise<readonly ActionOutflow[]>;
  /**
   * OPTIONAL. What a CONFIRMED receipt actually settled, decoded from
   * canonical on-chain events only — never from inputs or a quote — with the
   * user's recipients separated from the PayAI fee leg (identified using the
   * build's own terms). The confirm route records one history row per
   * RECIPIENT; the fee is recorded on the settlement, never as a recipient.
   * Empty recipients when the receipt carries no canonical event. Never throws.
   */
  settledOutflows?(receipt: ActionReceipt, ctx?: ActionResultContext): Promise<SettledOutflows>;
  /**
   * OPTIONAL. For an action that trades the user's own funds (no third-party
   * recipient): the trade a CONFIRMED receipt executed, verified against the
   * build's terms and wallet, or null when it can't be verified. The confirm
   * route records exactly one "trade" history row from it, and records
   * nothing (reporting "unverified") when it is null. Never throws.
   */
  settledTrade?(receipt: ActionReceipt, ctx?: ActionResultContext): Promise<SettledTrade | null>;
  /**
   * OPTIONAL. The machine-readable outputs a CONFIRMED receipt verifiably
   * produced, matching this action's `outputs` declarations — or null when
   * the action's strict verification can't establish every fact (absent,
   * ambiguous or mismatched events, missing build terms, wrong wallet…).
   * Derived only from canonical on-chain events checked against the build's
   * terms and wallet; never from inputs, a quote or the client. Never throws.
   * The confirm route checks the result against the declarations
   * (lib/sdk/settlement.ts checkOutputsAgainstDeclaration) before storing it.
   */
  confirmedOutputs?(receipt: ActionReceipt, ctx?: ActionResultContext): Promise<VerifiedOutputs | null>;
}

/**
 * One output a confirmed action verifiably produced. Exact values only:
 * base-unit amounts as uint256 decimal strings, addresses lowercased (the
 * canonical form build terms use); native MON is the zero address — a real
 * result, but never an ERC-20 (the planner refuses to bind it).
 */
export type VerifiedOutputValue =
  | { verified: true; type: "units"; value: string; token: string }
  | { verified: true; type: "token"; value: string }
  | { verified: true; type: "units[]"; value: string[]; token: string };

/**
 * What confirmedOutputs() returns: the outputs by declared name, plus the
 * token each token-valued input was VERIFIED to be in this execution (from
 * the canonical event, which itself matched the build's terms), keyed by
 * input name. The declaration check ties every output's token to these — an
 * output can't name its own denomination.
 */
export interface VerifiedOutputs {
  outputs: Readonly<Record<string, VerifiedOutputValue>>;
  denominations: Readonly<Record<string, string>>;
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
