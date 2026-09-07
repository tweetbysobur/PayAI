# PAYAI SDK — Phase 2 UI reuse notes (documentation only)

**Status: notes for a FUTURE phase. No UI is built in Phase 1. This file records how a protocol-action preview would reuse the existing `OperationCard` lifecycle so Phase 2 is additive, not a rewrite — and so the review of Phase 1 can see that the SDK core was designed to slot into the existing UI without changing it.**

Nothing here is a commitment to a design; it's a map of the seams that already exist.

## The lifecycle is already the right one — do not touch it

**`[CONFIRMED]`** `components/ask/OperationCard.tsx` renders every operation through one fixed status machine (`lib/ask/types.ts`'s `OperationStatus`):

```
preview → ready → confirming → submitted → success | error
```

A protocol action's preview needs *exactly* this lifecycle and nothing new:
- `preview` — the action's `quote()` result is shown; nothing signed.
- `ready` — user reviewed; the confirm affordance is armed.
- `confirming` — signature in flight (existing wallet flow, unchanged).
- `submitted` — broadcast, real txHash, not yet confirmed (existing `submitted` handling already covers the receipt-wait-timeout case).
- `success` — confirmed; `parseResult()`'s `details` render here.
- `error` — pre-broadcast failure or a confirmed revert.

The whole point of the Phase 1 type design (`ActionQuoteResult`, `UnsignedActionStep` matching `UnsignedStep`, reusing `TransactionResult`/`OperationError`) is that a protocol action produces the same shapes this machine already consumes. So Phase 2's UI work is **one new body renderer**, not a new card, a new lifecycle, or a new confirm funnel.

## The one net-new UI piece Phase 2 needs

**`[PROPOSED]`** A `ProtocolActionBody` renderer inside `OperationCard.tsx`'s existing `IntentBody` switch (`components/ask/OperationCard.tsx:263`), added as one more `case` alongside `payment` / `swap` / `trade_preview` / etc. It renders, from the matched action + its `ActionQuoteResult`:

- **Protocol identity** — name + real `logoUrl` (never a fabricated/AI-generated logo; absent-is-fine, invented-is-not, matching the `ProtocolAdapter.logoUrl` doc). Reuse the existing `TokenLogo`-style treatment for consistency.
- **Action name** — e.g. "Wrap MON", from `action.name`.
- **Inputs** — the validated params, rendered as the existing `Row` label/value pairs (`OperationCard.tsx`'s `Row`), so a protocol action reads visually identical to a payment/swap card.
- **Execution destination** — the contract the action will call (its single `allowedTargets` entry for a simple action), shown so the user can see *where* funds go — the same transparency the trade card already gives with its route/provider row.
- **Quote details** — `ActionQuoteResult.details` as more `Row`s (e.g. "1 MON = 1 WMON", "You receive: 2.5 WMON").
- **Risk/approval state** — reuse the existing high-price-impact warning treatment (`OperationCard.tsx:742`'s `d.highPriceImpact` block) for any action-declared caution, and the existing approval-step disclosure the swap/trade cards already show when a step's `kind === "approve"`.
- **Result** — on `success`, `parseResult()`'s `details` through the existing `SuccessBody` pattern; the real txHash/explorer link is already handled by `TransactionResult` rendering.

That is the entire UI surface. Everything else (status chip, confirm button, submitted/error/success framing, retry) is the existing card chrome, unchanged.

## What Phase 2 must NOT do

- Must not add a new `OperationStatus` value — the six existing states cover every protocol-action outcome.
- Must not add a second confirm funnel — protocol actions ride the existing `wallet.sendTransaction(steps[i].tx)` loop in `lib/ask/intent/orchestrate.ts` (the same loop swaps/trades already use), because `UnsignedActionStep.tx` is the same shape as `UnsignedStep.tx` (enforced by the compile-time assertion in `lib/sdk/types.ts`).
- Must not build a developer portal, action explorer, protocol capability pages, or a testnet sandbox UI. Those are a later phase entirely; the eventual developer experience (premium, purple/white brand tokens from `app/globals.css`'s `--primary`, real protocol assets only, copyable code examples, strong empty/loading/error states) is described in `docs/sdk/ARCHITECTURE_SPEC_v0.1.md` §20 and is deliberately unbuilt.

## Brand alignment (for whenever the body renderer is built)

Reuse the existing tokens, add nothing: `--primary` (`#7C3AED`) for the action's accent, `--primary-ink` for purple-on-dark text (the card already switches between them correctly), `lucide-react` for iconography, the existing `Row` / `StatusIcon` / chip components. A protocol-action card should be indistinguishable in visual language from a payment or trade card — same hierarchy, same spacing, same tabular-nums for amounts.

## Why this is safe to defer

The Phase 1 core produces `ActionQuoteResult` and `UnsignedActionStep` today, fully tested, with zero UI. When Phase 2 wires the classifier branch and this body renderer, the data is already in the exact shape the card needs — so the UI phase carries no risk of forcing a change back into the SDK core or the execution lifecycle. That decoupling is the deliverable Phase 1 is proving.
