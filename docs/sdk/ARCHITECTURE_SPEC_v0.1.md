# PAYAI SDK ARCHITECTURE SPEC v0.1

**Status: PHASE 0 — architecture audit + specification only. Not implemented. Not approved. No code in this spec has been written to the app.**

This document is the deliverable for a Phase 0 architecture audit: inspect PayAI's actual repository, determine what the SDK should reuse vs. build new, and produce a reviewable spec. Every claim below is tagged `[CONFIRMED]` (verified by reading the actual code, cited by path) or `[PROPOSED]` (new design this spec is recommending). Nothing is invented as if it already existed.

---

## 1. Current PayAI architecture relevant to the SDK

**`[CONFIRMED]`** PayAI is a single Next.js App Router application — there is no monorepo, no `packages/` directory, no workspace tooling (`package.json` has no `workspaces` field). Every capability lives in one deployable: `lib/` (server logic), `app/` (routes + pages), `components/` (UI), `contracts/` (a separate Hardhat project, not wired into the npm workspace).

**`[CONFIRMED]`** Two independent "intent → execution" pipelines exist today, not one:

1. **The older agent pipeline** (`app/api/agent/route.ts`, `lib/agent/brain.ts`, `lib/payment/engine.ts`) — payments only. Takes a natural-language `intent` string, runs guardrails → validation → risk scoring → execution, gated by `resolveTenantId()` (merchant `x-merchant-key`) and, for live execution, `authError()` (a `VERIPAYAI_API_KEY` bearer check). This is the closest thing PayAI has today to an external, programmatic, non-browser API.
2. **Ask PayAI** (`lib/ask/intent/classify.ts`, `lib/ask/intent/orchestrate.ts`, `lib/ask/types.ts`, `lib/ask/useAskChat.ts`) — the conversational surface covering payments, swaps, scheduled/recurring payments, distributions, wallet intelligence, token intelligence, and arbitrary-token trading. This is the newer, actively-developed surface and the one an SDK-driven "protocol action" capability would most naturally extend.

**`[CONFIRMED]`** Ask PayAI's intent model is a **closed, compile-time union**, not a dynamic registry:
- `lib/ask/intent/types.ts`'s `ASK_INTENT_KINDS` is a literal `as const` array (`"send_payment" | "swap" | ... | "trade"`). Its own doc comment states the extension model explicitly: *"Adding a future capability... means adding one entry to `ASK_INTENT_KINDS` and one branch in `orchestrate.ts` — nothing in the UI has to change."* That is a **code change + redeploy per capability today**, not a runtime registration API.
- `lib/ask/intent/orchestrate.ts`'s `respondToUnderstanding()` is a hardcoded `switch (u.kind)` over that closed set, each case calling one dedicated `dispatchX()` function.
- `AskSlots` (`lib/ask/intent/types.ts`) is a fixed struct (`amount`, `asset`, `recipient`, `fromAsset`, `toAsset`, `txHash`, etc.) — there is no generic "arbitrary typed parameters per intent" mechanism.

This is the single most important fact for this spec: **PayAI has zero existing dynamic extensibility.** Everything the task description imagines ("PayAI discovers those actions", "PayAI maps intent to a supported action") is new work, not a reuse of an existing plugin point.

**`[CONFIRMED]`** The `Operation`/`OperationCard` model (`lib/ask/types.ts`) is real, general, and reusable. Every intent renders into an `Operation { id, intent, status, result?, error?, submitted? }`. `OperationStatus` is a fixed lifecycle: `preview → ready → confirming → submitted → success | error`. The UI is documented as *"the ONLY thing allowed to advance a card from one status to the next, always in response to a real click."* This lifecycle already matches what an SDK `ExecutionRequest`/`ExecutionResult` needs and should not be reinvented (see §9–11).

**`[CONFIRMED]`** The closest existing analog to a "protocol adapter" is `lib/monad/swap.ts`'s `SwapProvider` interface:
```ts
export interface SwapProvider {
  readonly name: string;
  isConfigured(): boolean;
  quote(fromToken: SwapToken, toToken: SwapToken, amountIn: number): Promise<SwapQuote>;
  buildPlan(fromToken: SwapToken, toToken: SwapToken, amountIn: number, wallet: Address, slippage?: number): Promise<SwapPlan>;
}
```
Three real implementations exist (`uniswapV3Provider` direct, `kuruSwap.ts`, `nadfun.ts`'s quoting reused by `tradeExecutor.ts`), aggregated via `candidateProviders()`/`bestQuote()`. **Critically, all three are PayAI-team-authored, in-repo, PR-reviewed code** — no third party supplies `buildPlan` today. This is the pattern to generalize, but generalizing it to *untrusted third-party protocols* is exactly where the security model must do new work (§16).

**`[CONFIRMED]`** Unsigned-transaction shape is already proven signer-agnostic. `UnsignedStep { kind: "approve" | "swap"; label; tx: { to; data; value }; settleLeg? }` (`lib/monad/swap.ts` / `tradeExecutor.ts` / `tradeQuote.ts`) is driven by **two different signers today**: the browser wallet (`lib/ask/intent/orchestrate.ts` calling `wallet.sendTransaction(steps[i].tx)`, where `wallet` implements `SendPaymentWallet` from `lib/ask/sendPayment/orchestrator.ts`) and, as of this session's Telegram bot work, a per-user server-held signer (`lib/telegram/tradeRunner.ts`). This is real, working prior art for "the SDK's execution unit must be signer-agnostic" — do not invent a second transaction shape.

**`[CONFIRMED]`** On-chain target allowlisting already exists and works, in `contracts/contracts/PayAITradeExecutor.sol` / `PayAITradeExecutorV2.sol`:
- Uniswap router is fixed at deploy (immutable).
- Kuru markets are an **owner-gated allowlist**: `setKuruMarket(address market, bool allowed) external onlyOwner`.
- Nad.Fun routers are similarly allowlisted (`isNadFunRouterAllowed`).
- Fee is capped (`MAX_FEE_BPS`), contract is pausable, reentrancy-guarded, and asserts **zero retained balance** after every trade (`"native retained"` / `"tokenIn retained"` reverts).
- Dispatch is fail-closed: `lib/monad/tradeExecutor.ts`'s `selectExecutor(venue)` returns `null` (falling back to the existing direct-router path) unless a deployment is both configured *and* explicitly enabled via env (`PAYAI_TRADE_EXECUTOR_V2_ENABLED`).

This is real, live, production-proven "protocol allowlisting" infrastructure. The SDK's security model should extend this exact pattern (§16), not invent a parallel one.

**`[CONFIRMED]`** Wallet/custody has exactly **two** models in production today, plus a third added this session for a narrower purpose:
1. **User's own wallet**, signing in the browser (`lib/wallet-service/WalletServiceContext.tsx`, `registry.ts`, `reconcile.ts`) — the default for every interactive payment/swap/trade.
2. **One shared, server-held agent key** (`MONAD_AGENT_PRIVATE_KEY`, `lib/monad/wallet.ts`) — used *only* for capped Payment Automations, contract-enforced via `AutomationVault.sol` (funds pre-reserved, directionally locked to one recipient per reservation — see `INVARIANT-AV-2`/`INVARIANT-AV-6` in that contract) or `PaymentExecutor.sol`.
3. **Per-external-user server-held keys** (`lib/telegram/wallets.ts`, added this session) — a narrow, single-purpose custody model for the Telegram trading bot only.

The SDK must not casually add a fourth. It should **never hold a key at all** — see §12.

**`[CONFIRMED]`** Settlement is centralized, not duplicated: `/api/swap/confirm/route.ts` is the *one* place a swap/trade is recorded, and it **never trusts the caller's claimed outcome** — it re-fetches the on-chain receipt (`pub.waitForTransactionReceipt`) and only records success if `receipt.status === "success"`. `lib/automation/execute.ts`'s `executeOnePayment` is the equivalent single path for automations. Both browser-signed trades and the Telegram bot's server-signed trades already settle through the same `/api/swap/confirm` call.

**`[CONFIRMED]`** Cross-cutting platform infrastructure the SDK should reuse verbatim:
- `lib/platform/idempotency.ts` — `claimRequest`/`completeRequest`/`releaseRequest`, SET-NX based, already used by `/api/swap/confirm`, `/api/cron/run-schedules`, and the Telegram webhook.
- `lib/platform/ratelimit.ts` — `rateLimited(req, bucket, { max, windowSec, subject })`, and — as of this session — **enforced as a protocol**: `test/api-rate-limit-coverage.test.ts` fails CI if any API route neither calls it nor carries a written exemption.
- `lib/platform/tenant.ts` / `lib/platform/merchants.ts` — tenant resolution via a secret `apiKey`, KV-backed with in-memory fallback, dual-hash id↔apiKey lookup pattern.
- `lib/monad/verify.ts` — amount/decimal validation helpers (`toBaseUnits`, `toParseableAmount`, `normalizeDecimalString`) and transfer-shape detection (`hasErc20TransferTo`, `isNativeTransferTo`).

**`[CONFIRMED]`** Test architecture: 79 files under `test/`, flat (no per-module subdirectories), Vitest, `server-only` stubbed out for unit tests (`vitest.config.ts`), heavy use of module-level `vi.mock` plus in-memory maps cleared in `afterEach`. This session established a **stash-verify discipline** (write the test, temporarily break the implementation, confirm the test fails, restore, confirm it passes) for every security-relevant test — the SDK's security-critical tests (allowlist enforcement, schema validation, replay protection) should follow the same discipline.

**`[CONFIRMED]`** There is no existing developer-portal UI. `components/` has exactly four top-level areas: `ask/`, `dashboard/`, `landing/`, `onboarding/` — no `components/ui/` design-system folder, no code-block/syntax-highlighting component, no docs-page pattern. The brand system is CSS-variable-based Tailwind v4 tokens (`--primary: 262 83% 58%` = `#7C3AED`, `lucide-react` icons, no shadcn/ui). An SDK developer portal reuses the brand tokens; it does not reuse any component.

---

## 2. Recommended SDK package location

**`[PROPOSED]`** Do not introduce monorepo tooling to solve this. Nothing about npm workspaces, Turborepo, or Nx exists in this repo today, and adopting one is a disproportionate first step for an SDK that doesn't have a single external consumer yet.

Staged location, matching §3 of "staged internal → public":

- **Stage 1 (Phase 1 of this spec, §26):** `lib/sdk/` inside the existing app. Types, the action registry, and the validation/allowlist layer live here, imported directly by `lib/ask/intent/orchestrate.ts`. No new package boundary, no publish step, fastest to wire into the existing classifier/dispatch — this is where the *first 1–2 protocol actions* should be built, by the PayAI team, mirroring exactly how `SwapProvider` implementations are built today.
- **Stage 2 (once a real external protocol needs to integrate without a PayAI PR):** extract the protocol-facing surface only — the `Action`/`ProtocolAdapter` type contracts, a thin registration client, and the JSON-Schema-style validation helpers — into `packages/sdk/`, added via a minimal `"workspaces": ["packages/*"]` entry in the root `package.json`. The app continues to depend on `packages/sdk` as a local workspace package; nothing about the app's deployment changes.
- **Stage 3 (once 2–3 real integrations have exercised the contract):** publish `packages/sdk` to npm as `@payai/sdk`, with real semver.

Do not skip Stage 1. Building a publishable package before a single real protocol integration exists is exactly the "over-engineer the first version" risk the task explicitly warns against.

---

## 3. SDK responsibilities

**`[PROPOSED]`**
- Define the `Action` and `ProtocolAdapter` type contracts.
- Provide a registry (discovery) for protocols/actions, server-side.
- Validate action inputs against a protocol-declared schema.
- Validate that every unsigned transaction step returned by an adapter targets an **allowlisted contract address** for that action — before it ever reaches a signer.
- Translate a matched `(protocolId, actionId, inputs)` into the existing `Operation`/`ExecutionRequest` shape PayAI's UI and execution layer already understand.
- Surface protocol/action metadata for a future developer portal (§20).

## 4. SDK non-responsibilities

**`[PROPOSED, restating the task's own constraints as binding]`**
- Does NOT hold, generate, or touch a private key, ever.
- Does NOT build or sign transactions itself beyond producing the same `UnsignedStep[]` shape the existing execution layer already consumes.
- Does NOT parse natural language itself — it feeds a candidate action catalog to the *existing* classifier (`classify.ts`), which still owns intent interpretation.
- Does NOT execute, broadcast, or settle transactions — that stays in `lib/ask/intent/orchestrate.ts` / `/api/swap/confirm` / the equivalent automation path.
- Does NOT expose `execute(to, data, value)` or any arbitrary-calldata primitive as a developer-facing API, under any name.
- Does NOT modify `PayAITradeExecutor.sol`, `PayAITradeExecutorV2.sol`, fee configuration, router allowlists, or `PAYAI_TRADE_EXECUTOR_V2_ENABLED`.

---

## 5. Canonical Action interface

**`[PROPOSED]`** The task's draft (`{ id, protocol, name, version, description, chainId, inputs, validation, prepare, execute, parseResult }`) has one fatal flaw for a *third-party* adapter: an `execute` a protocol supplies and PayAI blindly calls **is** the arbitrary-calldata anti-pattern the brief forbids, just renamed. `SwapProvider.buildPlan` gets away with an unconstrained return today only because every implementation is PayAI's own reviewed code (§1). A third-party equivalent cannot carry the same trust.

The fix: split "compute what to call" from "decide whether it's allowed to be called." The action *declares* what it's allowed to touch; PayAI's own layer enforces that declaration against whatever `build()` actually returns, every time, regardless of whether `build()`'s code is trusted, buggy, or malicious.

```ts
export type ChainId = number; // Monad mainnet / testnet numeric chain id — see §9 for representation

export interface ActionIdentity {
  protocolId: string;   // stable slug, e.g. "examplefi"
  actionId: string;     // stable slug within the protocol, e.g. "stake"
  version: string;      // semver — see §18
}

export interface ActionMetadata extends ActionIdentity {
  name: string;              // display name, e.g. "Stake MON"
  description: string;
  chainId: ChainId;
  /** Exact contract addresses this action is EVER allowed to call.
   *  Every UnsignedStep this action's build() returns must have `tx.to`
   *  in this set — enforced by PayAI, not by the adapter's own code.
   *  Mirrors PayAITradeExecutor.sol's Kuru-market-allowlist model, at
   *  the registry layer instead of on-chain, because a third-party
   *  action isn't necessarily routed through that contract. */
  allowedTargets: `0x${string}`[];
}

/** A JSON-Schema-shaped description of this action's inputs — validated
 *  by PayAI before anything else runs. No `any`, matching lib/ask/types.ts's
 *  own stated discipline ("No `any`, no free-text execution"). */
export interface ActionInputSchema {
  [paramName: string]: {
    type: "amount" | "token" | "address" | "string" | "number" | "boolean";
    required: boolean;
    description: string;
  };
}

export interface ActionQuoteResult {
  /** Human-readable summary for the preview card — reuses the existing
   *  TradePreviewData shape's spirit (lib/ask/types.ts). */
  summary: string;
  /** Arbitrary typed fields the action wants to show the user before
   *  they approve — e.g. { estimatedApy: "4.2%" } for a stake action. */
  details: Record<string, string>;
  quotedAt: number; // Date.now() — mirrors TradePreviewOk.quotedAt staleness handling
}

export interface UnsignedActionStep {
  kind: "approve" | "action"; // mirrors UnsignedStep's "approve" | "swap"
  label: string;
  tx: { to: `0x${string}`; data: `0x${string}`; value: string };
}

export interface Action extends ActionMetadata {
  inputSchema: ActionInputSchema;
  /** Read-only. May call out to the protocol's own RPC/subgraph. Never
   *  returns a transaction — only what the user would see in a preview,
   *  same boundary TradePreviewIntent already enforces (see lib/ask/types.ts's
   *  own doc: "nothing about this type or its card ever signs, approves, or
   *  moves funds"). */
  quote(inputs: Record<string, string>): Promise<ActionQuoteResult>;
  /** Builds the unsigned step(s). PayAI validates every returned tx.to
   *  against `allowedTargets` and REJECTS the whole action if any step
   *  fails that check — build() is never trusted on its own. */
  build(inputs: Record<string, string>, quote: ActionQuoteResult): Promise<UnsignedActionStep[]>;
  /** Parses a confirmed on-chain receipt into a result the caller can
   *  show/store — read-only, same as WalletTransactionView's discipline
   *  ("reflects what actually happened on-chain... never a claim"). */
  parseResult(receipt: unknown): Promise<Record<string, string>>;
}
```

## 6. ProtocolAdapter interface

**`[PROPOSED]`**
```ts
export interface ProtocolAdapter {
  protocolId: string;
  name: string;
  chainId: ChainId;
  logoUrl?: string;     // real asset only — see §20's "no fake AI-generated logos"
  docsUrl?: string;
  actions: Action[];
  /** The full set of contract addresses ANY action in this protocol is
   *  ever allowed to touch — a superset check above the per-action
   *  allowedTargets, so a compromised/buggy action can't accidentally
   *  widen its own reach by editing its own metadata at runtime; the
   *  protocol-level allowlist is the ceiling. */
  allowedTargets: `0x${string}`[];
}
```

## 7. PayAIClient interface

**`[PROPOSED]`** This is the *protocol developer's* SDK surface — what they actually import. Deliberately small.
```ts
export interface PayAIClient {
  registerProtocol(adapter: ProtocolAdapter): Promise<{ status: "pending_review" | "active"; protocolId: string }>;
  updateAction(action: Action): Promise<{ status: "pending_review" | "active" }>;
  // No execute(), no sendTransaction(), no signer access — a protocol
  // developer never gets a wallet handle from this client, by design (§4).
}
```
Registration is **not** instant-active in Phase 1 — see §15/§25. `registerProtocol` returns `pending_review` until a PayAI-side reviewer allowlists the declared `allowedTargets` (mirrors how a merchant account is created today: `createMerchant()` in `lib/platform/merchants.ts` has no public-facing route calling it — merchant onboarding is already a controlled, non-self-serve process).

## 8. Intent model

**`[CONFIRMED baseline, PROPOSED extension]`** Do not replace `ASK_INTENT_KINDS`. Add exactly **one** new kind, `"protocol_action"`, following the file's own documented extension pattern (one new entry + one new `orchestrate.ts` branch). Its slots are generic, not part of the fixed `AskSlots` struct:
```ts
interface ProtocolActionSlots {
  protocolId: string | null;
  actionId: string | null;
  params: Record<string, string>; // validated against the matched Action's inputSchema
}
```
Matching flow: the classifier is given a **summarized** action catalog (name + one-line description per registered action — not full schemas, to keep the Anthropic prompt small; see this session's own P1.5 latency work on why prompt size matters) and asked to pick, at most, one `(protocolId, actionId)` plus best-effort params, with the existing curated kinds (`send_payment`, `swap`, `trade`, etc.) always taking priority when ambiguous — mirroring how `token_lookup`/`trade` are already gated deterministically (an address regex) *before* ever reaching the LLM (`classify.ts`'s `detectTokenLookup()`), so a protocol action never accidentally swallows a payment or an existing trade intent.

## 9. ExecutionRequest model

**`[PROPOSED]`**
```ts
export interface ExecutionRequest {
  protocolId: string;
  actionId: string;
  version: string;       // the version the user's preview was quoted against
  inputs: Record<string, string>;
  walletAddress: string; // the ONLY wallet this can ever execute against — never a value from the action/adapter
  chainId: ChainId;
}
```
Maps directly onto the existing `TradePreviewIntent.execution.request` shape's role in `lib/ask/types.ts` — same idea, generalized.

## 10. ExecutionResult model

**`[PROPOSED]`** Do not invent a new result type. Reuse `TransactionResult` / `OperationError` (`lib/ask/types.ts`) as-is:
```ts
// Success: TransactionResult { txHash, explorerUrl, blockNumber?, gasFee? }
// Failure: OperationError { message, code?, txHash?, explorerUrl?, approvalTx? }
```
Add action-specific parsed fields (from `Action.parseResult()`) as an optional `details: Record<string, string>` alongside, never replacing the above.

## 11. Transaction model

**`[CONFIRMED reuse]`** `UnsignedActionStep` (§5) is `UnsignedStep` with `kind: "action"` in place of `"swap"` — deliberately the same shape as `lib/monad/swap.ts`'s `UnsignedStep`/`TradeExecutionStep`, so the *existing* execution loop in `lib/ask/intent/orchestrate.ts` needs only a new branch, not new signing/broadcast/settlement code.

## 12. Wallet boundary

**`[PROPOSED, restating a hard constraint]`** The SDK package (whether in `lib/sdk/` or later `packages/sdk`) must contain **zero** code that imports `viem/accounts`, constructs a `WalletClient`, or reads any private key material. Signing happens exactly where it happens today: the browser wallet for an interactive user, or an already-existing bot/automation signer for a non-interactive one. The SDK's only output toward signing is `UnsignedActionStep[]`.

## 13. Protocol discovery model

**`[PROPOSED]`** A new server-side registry, `lib/sdk/registry.ts` in Stage 1, following the exact KV+in-memory-fallback, dual-hash pattern already used by `lib/platform/merchants.ts` and this session's `lib/telegram/wallets.ts`:
- Primary store: `protocolId -> ProtocolAdapter` (metadata only — actions' `quote`/`build`/`parseResult` functions are **code**, not data, so in Stage 1 they are literally TypeScript modules registered in-repo, exactly like `SwapProvider` implementations are today; Stage 2's out-of-process model, §16, changes this to a request/response contract instead of imported code).
- Secondary index: `chainId -> protocolId[]`, so discovery for "what's available on Monad mainnet right now" is a bounded lookup, not a full scan.
- Discovery is an **in-process function call** from `classify.ts`'s matching step — not a network round trip — for latency reasons already established in this session's P1.5 work (every added round trip is a cost that shows up in every single Ask PayAI message, not just protocol-action ones).

## 14. Action registration model

**`[PROPOSED]`** Two tiers, deliberately:
- **Stage 1:** registration IS a PR to this repo. A new action is a new TypeScript module implementing `Action`, reviewed exactly like `SwapProvider` implementations are today. No new "self-serve" surface exists yet. This is the safest possible starting point and matches the task's own "prefer incremental integration... do not over-engineer the first version."
- **Stage 2+:** `PayAIClient.registerProtocol()`/`updateAction()` (§7) write to the registry via an authenticated API call, landing in `pending_review` status. A PayAI-side reviewer (human, initially) verifies `allowedTargets` against the protocol's real deployed contracts before flipping status to `active`. No action is ever intent-matchable while `pending_review`.

## 15. Validation model

**`[PROPOSED]`** Two independent layers, both mandatory, neither optional:
1. **Input validation** — every `params` value the classifier extracts is checked against the matched action's `inputSchema` (§5) before `quote()`/`build()` is ever called. Amount-typed params reuse `lib/monad/verify.ts`'s existing helpers (`toBaseUnits`, `toParseableAmount`, `normalizeDecimalString`) rather than re-implementing decimal handling a third time.
2. **Output validation** — every `UnsignedActionStep` a `build()` call returns is checked, unconditionally, against that action's `allowedTargets` (§5) AND the protocol's `allowedTargets` (§6). Any step whose `tx.to` isn't in both sets is rejected outright and the whole action fails closed — this is the check that makes a malicious or buggy adapter incapable of directing funds anywhere unreviewed, independent of how much anyone trusts the adapter's own code.

## 16. Security model

**`[PROPOSED, mapped explicitly against the brief's own checklist]`**

| Requirement | Mechanism |
|---|---|
| Arbitrary calldata prevention | `Action` never exposes `execute(to,data,value)`; `build()`'s output is validated, not trusted (§15). |
| Target contract allowlisting | Per-action `allowedTargets` + per-protocol `allowedTargets`, both enforced server-side before signing; mirrors `PayAITradeExecutor.sol`'s live `setKuruMarket` allowlist model (§1), generalized off-chain since a third-party action isn't necessarily routed through that contract. |
| Chain ID validation | Every `Action`/`ProtocolAdapter` is pinned to one `chainId`; a request against the wrong active network is refused, mirroring `previewTrade()`'s existing `getNetwork() !== "mainnet"` refusal (`lib/monad/tradeQuote.ts`). |
| Action schema validation | §15, layer 1. |
| Parameter / token / amount validation | Reuse `lib/monad/verify.ts` + `lib/payees/directory.ts`'s `isAddress`. |
| Slippage validation | Actions that quote a min-out reuse the existing `MAX_SLIPPAGE`/`validateSlippage` pattern from `lib/monad/tradeQuote.ts` rather than each action inventing its own ceiling. |
| Quote freshness | `ActionQuoteResult.quotedAt` + a staleness check mirroring `isMaterialChange()` (`lib/monad/tradeQuote.ts`) — a quote too old is re-fetched, never executed against stale numbers. |
| Simulation/preflight | Where the target supports it, `simulateContract` before broadcast — mirrors `lib/monad/executor.ts`'s `executeTransfer`'s existing simulate-then-write pattern. |
| Replay/idempotency | Reuse `lib/platform/idempotency.ts` wholesale — same `claimRequest`/`completeRequest` keyed on a request id, no new idempotency mechanism. |
| Permission boundaries | Registration requires review (§14); execution requires an already-authenticated wallet session; the SDK introduces no new custody (§12). |
| Malicious protocol integrations | Registry review gate + allowlist enforcement (§15) — a malicious protocol can declare whatever `Action` code it wants; it can never make PayAI sign a transaction to a target outside its own declared, reviewed allowlist. |
| Malicious action definitions | Same mechanism — the allowlist check doesn't trust the action's own metadata about itself either; a reviewer's approval is what actually admits a target into the enforced set, not the registration payload alone. |
| Version compatibility | §18 — a version mismatch between preview and execute is refused, never silently upgraded. |
| Failed transaction handling | Reuse `OperationStatus`'s `submitted`/`error` split and the existing pending-settlement reconciliation pattern (`lib/ask/intent/orchestrate.ts`) — no new failure taxonomy. |
| Partial/multi-step execution | Reuse `UnsignedStep[]` + `settleLeg` tagging (`lib/monad/tradeQuote.ts`) for actions that need an approval-then-call sequence. |
| Transaction traceability | Reuse `recordTx`/`TxLogEntry` (`lib/platform/store.ts`/`types.ts`), extended with `protocolId`/`actionId`/`version` fields, the same way `outputTokenAddress` was added to `TxLogEntry` this session without touching the settlement contract itself. |

**`[OPEN QUESTION]`** Stage 1's trust model (adapter code lives in-repo, PayAI-reviewed) is safe but not self-serve. Stage 2's trust model (adapter code runs out-of-process, PayAI validates only the returned steps) is the genuinely self-serve model the task is asking for, but it is meaningfully riskier and needs its own dedicated security design pass before it ships — this spec recommends Stage 1 first specifically so that pass can happen with real registered actions to test against, not a hypothetical.

## 17. Error model

**`[PROPOSED]`** Extend `OperationError` (§10) with an SDK-specific `code` taxonomy rather than a new error type: `ACTION_NOT_FOUND`, `PROTOCOL_NOT_CONFIGURED`, `SCHEMA_VALIDATION_FAILED`, `TARGET_NOT_ALLOWLISTED`, `QUOTE_STALE`, `VERSION_MISMATCH`, `CHAIN_MISMATCH`. `OperationError.code` is already typed as an optional `string` today — no breaking change.

## 18. Versioning strategy

**`[PROPOSED]`** Semver per action, `{protocolId, actionId, version}` as the full identity. The version the user's *preview* resolved against is pinned into the eventual `ExecutionRequest`; if the registry's live version for that action has changed by execute-time, the request is refused with `VERSION_MISMATCH` rather than silently executing against whatever is newest — this generalizes `isMaterialChange()`'s existing "the quote moved, don't silently execute" refusal from "price moved" to "the action itself changed."

## 19. Testnet development workflow

**`[CONFIRMED infrastructure, PROPOSED reuse]`** No new sandbox is needed. `getNetwork()` (`lib/monad/config.ts`) already distinguishes mainnet/testnet, and `PAYAI_MODE=simulation` already mocks settlement app-wide for local dev. A protocol developer registers an action with both a mainnet and (optional) testnet `allowedTargets` entry and exercises it against Monad testnet using the exact same code path production uses — no parallel "sandbox mode" to build or maintain.

## 20. Example protocol integration

**`[PROPOSED, worked example]`**
```ts
// A hypothetical lending protocol registers one action.
const stakeAction: Action = {
  protocolId: "examplefi",
  actionId: "stake",
  version: "1.0.0",
  name: "Stake MON",
  description: "Stake MON into ExampleFi's validator pool.",
  chainId: MONAD_MAINNET_CHAIN_ID,
  allowedTargets: ["0xExampleFiStakingPool..."],
  inputSchema: { amount: { type: "amount", required: true, description: "Amount of MON to stake" } },
  async quote(inputs) { /* reads the pool's real APY/exchange rate */ },
  async build(inputs, quote) { /* returns [{ kind: "action", label: "Stake MON", tx: { to: "0xExampleFiStakingPool...", data, value } }] */ },
  async parseResult(receipt) { /* decodes a Staked event */ },
};
```

## 21. Example user intent flowing through the system

**`[PROPOSED, worked example]`**
1. User types "Stake 100 MON" in Ask PayAI.
2. `classify.ts`'s existing curated-kind detection runs first (payment/swap/trade/etc.) — none match.
3. The new protocol-action matching step (§8) is given the summarized catalog, matches `examplefi.stake`, extracts `{ amount: "100" }`.
4. `inputSchema` validation passes.
5. `stakeAction.quote({ amount: "100" })` runs, producing a preview (reuses `OperationStatus: "preview"`, rendered by a new but structurally identical `OperationCard` variant).
6. User clicks confirm → `stakeAction.build(...)` runs → the returned step's `tx.to` is checked against `allowedTargets` → passes.
7. The existing wallet-signing flow signs and broadcasts, exactly as it does for a swap today.
8. `/api/swap/confirm`-equivalent settlement re-verifies the receipt, calls `parseResult()`, records via `recordTx` with `protocolId`/`actionId`/`version` attached.
9. `OperationStatus` moves to `success`; the card renders `parseResult()`'s output.

## 22. Recommended package/file structure

**`[PROPOSED, Stage 1]`**
```
lib/sdk/
  types.ts        // Action, ProtocolAdapter, ActionMetadata, ActionInputSchema, ActionQuoteResult, UnsignedActionStep
  registry.ts      // KV+memory registry, mirrors lib/platform/merchants.ts's pattern
  validate.ts      // inputSchema validation + allowlist (tx.to) enforcement
  actions/
    examplefi/
      stake.ts      // one Action implementation per file, mirrors lib/monad/kuruSwap.ts's shape
docs/sdk/
  ARCHITECTURE_SPEC_v0.1.md   // this document
```
**`[PROPOSED, Stage 2, once extracted]`**
```
packages/sdk/
  src/
    types.ts
    client.ts       // PayAIClient
  package.json      // name: "@payai/sdk"
```

## 23. Dependencies

**`[CONFIRMED baseline]`** The app has zero schema-validation-library dependency today — every existing check is hand-rolled (`verify.ts`, `classify.ts`'s slot checks). **`[OPEN QUESTION]`** whether Phase 1 introduces one (e.g. `zod`) for `inputSchema` enforcement, or keeps the hand-rolled convention. Recommend deferring this decision to Phase 1 kickoff rather than deciding it in this spec — it's a real dependency-surface decision, not an architecture one.

## 24. Migration/reuse plan from current PayAI architecture

**`[PROPOSED summary of what's reused vs. net-new]`**

Reused as-is: `Operation`/`OperationStatus` lifecycle, `UnsignedStep` transaction shape, `/api/swap/confirm`-style settlement verification, `lib/platform/idempotency.ts`, `lib/platform/ratelimit.ts`, `lib/monad/verify.ts`, `TransactionResult`/`OperationError`, the KV+in-memory registry pattern from `merchants.ts`.

Net-new: the `Action`/`ProtocolAdapter` type contracts, the registry itself, the allowlist-enforcement validation layer, one new `ASK_INTENT_KINDS` entry + matching logic, `PayAIClient`, the eventual `packages/sdk` extraction.

Explicitly NOT touched: any smart contract, `PAYAI_TRADE_EXECUTOR_V2_ENABLED`, fee configuration, router/market allowlists, wallet/signing code, production config.

## 25. Risks and unresolved questions

**`[OPEN QUESTIONS]`**
1. Stage 1 (in-repo, reviewed) vs. Stage 2 (out-of-process, self-serve) is the biggest unresolved fork — this spec recommends starting at Stage 1 and treating Stage 2's security design as a separate, dedicated pass once real actions exist to design against.
2. How many registered protocol actions before the classifier's summarized catalog makes the Anthropic prompt too large/slow? No number is known yet — needs measurement once ≥5–10 real actions exist.
3. Fee/monetization model for protocol-action trades is undecided (does PayAI take a cut, like `PayAITradeExecutor`'s fee, or is this purely a routing service for Phase 1?).
4. Registry review is described as a human step in Phase 1 — at what integration volume does that become a bottleneck, and what does the automated version of that gate look like?
5. Multi-chain representation (`chainId` field) is specified but PayAI today is Monad-only end to end; nothing in this spec should be read as proposing multi-chain support — `chainId` exists purely so the type is future-proof, not because non-Monad execution is in scope.
6. Legal/security liability for a registered protocol's own contract bugs is unaddressed by this spec and needs its own answer before Stage 2.

## 26. Phase 1 implementation plan (NOT authorized by this spec — for review only)

**`[PROPOSED]`** If and when this spec is approved:
1. `lib/sdk/types.ts` — the `Action`/`ProtocolAdapter`/`ActionQuoteResult`/`UnsignedActionStep` types from §5–6.
2. `lib/sdk/registry.ts` — KV+memory registry, mirroring `merchants.ts`.
3. `lib/sdk/validate.ts` — schema + allowlist enforcement (§15), with stash-verified tests proving a step targeting a non-allowlisted address is rejected.
4. **One real action, built by the PayAI team, in-repo** (Stage 1 trust model) — proves the whole path end-to-end before any third party is involved. A good candidate: something structurally simple (a single-step, no-approval action) so the first integration tests the plumbing, not a hard trading-style multi-step case.
5. One new `ASK_INTENT_KINDS` entry (`"protocol_action"`) + one `orchestrate.ts` branch + the classifier matching step (§8), with the existing curated kinds proven to still take priority (regression tests against `test/ask-router.test.ts`'s existing conventions).
6. A generic `OperationCard` variant for a protocol action preview — new UI, but the *lifecycle* is unchanged (§1), so this should be additive to `OperationCard.tsx`, not a rewrite.
7. Full test suite, typecheck, lint, build — same gate every change in this repo already goes through.
8. **Do not** build the developer portal, `packages/sdk` extraction, or any Stage 2 self-serve registration in this phase.

---

## Summary — explicit separation per the task's closing instruction

**CONFIRMED FROM EXISTING CODE:** No monorepo/workspace tooling exists. Ask PayAI's intent model (`ASK_INTENT_KINDS`, `AskSlots`, `orchestrate.ts`'s switch) is a closed, compile-time union — zero dynamic extensibility today. `Operation`/`OperationStatus` is a real, reusable execution lifecycle. `SwapProvider` is real, working, in-repo-trusted protocol-adapter prior art. `UnsignedStep` is proven signer-agnostic across two real signers (browser wallet, per-user bot signer). `PayAITradeExecutor.sol`/`V2.sol` already implement live, owner-gated target allowlisting. Wallet custody has exactly two production models plus one narrow-purpose third added this session; nothing about this spec proposes a fourth. Settlement is centralized and always re-verifies the on-chain receipt. Idempotency, rate-limiting, and tenant/apiKey infrastructure are mature and directly reusable. No developer-portal UI exists.

**PROPOSED ARCHITECTURE:** A staged `lib/sdk/` → `packages/sdk` package path. An `Action`/`ProtocolAdapter` contract that separates declarative, PayAI-enforced target allowlisting from adapter-supplied `quote`/`build`/`parseResult` code, so a third party's code is never blindly trusted with call-target selection. One new `ASK_INTENT_KINDS` entry with generic, schema-validated params, reusing the existing `Operation` lifecycle and `UnsignedStep` transaction shape rather than inventing either. A registry mirroring `merchants.ts`'s existing KV pattern. A two-tier registration model (Stage 1: PayAI-authored, in-repo, reviewed; Stage 2: self-serve with mandatory review-before-active).

**OPEN QUESTIONS:** Stage 1 vs. Stage 2 trust model timing; classifier catalog scaling; fee/monetization; review-process scaling; a schema-validation dependency decision; Stage 2 liability model. All listed in full in §25.

**RECOMMENDED NEXT STEP:** Review this spec. If approved, Phase 1 is exactly §26 — small, additive, reusing existing infrastructure at every seam, building and proving exactly one real action before any third-party integration is considered. No implementation, no `packages/sdk`, no developer portal, and no push to `main` happens until that review.
