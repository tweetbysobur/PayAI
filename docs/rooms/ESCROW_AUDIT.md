# PayAI Rooms — escrow audit (Phase 1)

Date: 2026-10-09. Scope: everything Rooms touches today, read from this
repository. Nothing here was inferred from a deploy log or an env var that
couldn't be read.

## 1. What exists

| Area | Found | Where |
|---|---|---|
| Room model | One model: **fixed share, paid directly**. A room is N equal shares (2–20 people) of MON or the configured USDC, with an expiry (1–30 days) and a recipient (the creator or a named 0x/.nad). | `lib/rooms/terms.ts`, `lib/rooms/service.ts` |
| Storage | KV under `payai:rooms:` (Upstash/Redis in production, memory locally). Terms are written once (`SET NX`) and never edited; status is derived on every read, not stored. Join is atomic (per-address `SET NX` + `INCR` capacity). | `lib/rooms/store.ts` |
| Paying a share | An ordinary PayAI plan, `payai/transfer@1.0.0`, written by the server from the room's terms. The participant reviews and signs it with the existing plan card. **Funds go participant → PayAIForwarderV2 → recipient in that one transaction.** | `service.ts` `startContribution` |
| Verification | A share is counted only from the participant's own completed plan with verified outputs equal to the share and token, and (Monad mode) from a receipt with exactly one `PaymentForwarded` (payer, recipient and token matching) plus one `FeeCollected` whose net equals the share. A tx hash counts once, globally. | `service.ts` `confirmContribution`, `verifyReceipt` |
| Cancel | Creator only, and only while nothing is paid and no share plan is moving money. | `service.ts` `cancelRoom` |
| UI | `/dashboard/rooms` (create, list), `/dashboard/rooms/[id]` (view, join, pay, confirm, cancel). The share link points into the dashboard. | `app/dashboard/rooms/**` |
| Ask PayAI | Create, list, status, join, contribute — all through the same Rooms API. | `lib/ask/intent/roomIntent.ts`, `components/ask/RoomAskCard.tsx` |
| Public directory | None. | — |

## 2. Escrow — verified absent

- **No escrow contract exists.** The 11 contracts in `contracts/contracts/`
  are AutomationVault (V1/V2), MerchantRegistry, PayAIForwarder (V1/V2),
  PayAITradeExecutor (V1/V2), PaymentExecutor (V1/V2), SplitSettlement and
  VeriPayRegistry. None holds Room funds or knows what a Room is.
- PayAIForwarderV2 and SplitSettlement are explicitly **non-custodial
  pass-throughs**: neither keeps a balance between calls.
- AutomationVault does hold user deposits, but for capped agent spending.
  Contributors can't refund from it and it has no room or deadline
  semantics. It is not a fit and is not reused.
- The product says so today. The parser refuses "escrow/refund" requests by
  name, and the room page reads "PayAI never holds the money, so there's no
  escrow and nothing is refunded". The spec records it as out of scope
  (`docs/hackathon/payai-rooms-cleanverse.md` §8, §9, line 761).
- No deployment record, env var or address for any Room escrow exists.

Answers to the audit questions:

| # | Question | Today |
|---|---|---|
| 3 | MON and USDC? | Yes, but only as direct transfers. |
| 4 | Deadlines / completion enforced? | Off-chain only (derived status in KV). Nothing on-chain stops a late share. |
| 5 | Creator claims only after conditions? | No claim exists. The recipient is paid by every share as it lands. |
| 6 | Refunds after expiry? | **None.** Shares already paid stay with the recipient. |
| 7 | Terms mutable after contributions? | Not via the app (write-once KV). There are no on-chain terms. |
| 8 | Verification | Plan outputs plus a forwarder receipt check, above. Solid for direct transfers. |
| 9 | Mera | Passkey (WebAuthn PRF) → secp256k1 key held in browser memory only. Recovery is deterministic from the same passkey; there is no server key material. A reload locks it. It needs PRF support, so it doesn't work in every browser (`embeddedSupported`). Signing goes through `useWalletService()`, which the plan card already uses. |
| 10 | 0.25% forwarder fee | Every share pays the forwarder's live `feeBps` (25) to the Safe treasury, **added on top** so the recipient nets the exact share. There is no exemption mechanism in the deployed contract. |

## 3. What is missing

1. An escrow contract that holds funds per room, enforces deadline,
   completion, claim, refund and cancel, accepts MON plus allowlisted ERC-20s
   only, and has immutable terms.
2. Its deployment, source verification and a mainnet smoke test. **Not done
   in this sprint**: deploying needs explicit approval.
3. SDK actions so create, contribute, claim and refund go through the existing
   plan → review → approve → sign → settle → verify path, not a side channel.
4. A public room page (`/r/{id}`), a creator management view, a target-based
   model, and an opt-in public directory.

## 4. Contract required — `PayAIRoomEscrow` (written here, NOT deployed)

- One contract for all rooms. No proxy, no delegatecall, no arbitrary call.
- **Fixed-share:** `share × slots` target, exactly one `share` per address.
  It completes when the last slot is paid.
- **Target:** any contribution ≥ `minContribution` (or exactly the remainder),
  never above the remainder. It completes when `raised == target`.
- Platform minimum contribution (PA-05, added 2026-10-10): 1 MON or 0.5 USDC.
  A fixed share, and a target room's minimum and target, must be at least
  this. The exact remainder is still always accepted.
- Contributions only while `now < deadline`, not cancelled, not complete.
- `claim`: anyone (PA-11, 2026-10-10; previously creator or beneficiary),
  only once complete, only once. It pays `raised − fee` to the beneficiary
  fixed at creation, and accrues the fee to the treasury snapshotted at
  creation. The caller receives nothing.
- `refund`: each contributor pulls back exactly what they put in, once, when
  the room was cancelled or the deadline passed without completion. No fee.
- `cancel`: creator only, before completion and before the deadline. It
  always makes every contribution refundable.
- Terms have no setter. The owner (meant to be the Safe) can pause **new rooms
  and new contributions only**. It can change the fee, treasury and token
  allowlist **for future rooms only** (all are snapshotted per room), and it
  can never move or freeze held funds. Claims and refunds are never pausable.
- ERC-20 contributions must arrive in full (balance delta). Fee-on-transfer
  tokens revert.

## 5. App changes required

- `payai-rooms` SDK protocol: `create_room`, `contribute`, `claim`, `refund`.
  Targets are only the configured escrow (and the exact-amount `approve` to it
  for USDC). It is registered only when `MONAD_MAINNET_ROOM_ESCROW` is set,
  and fails closed otherwise.
- Room service: escrow rooms are created as a draft, then made live by
  verifying the creator's `RoomCreated` receipt against the draft terms.
  Progress, contributor count, status, claimable and refundable amounts are
  read from the contract, not from KV. Each contribution is recorded only
  from a verified `Contributed` event.
- Public `/r/{id}` page, creator management view, opt-in Live Rooms.
- Legacy direct rooms keep working exactly as before, labelled "no escrow".

## 6. Security risks

- **An undeployed contract is the biggest risk.** Until it is deployed,
  verified and smoke-tested, the app must not, and does not, offer escrow.
- Beneficiary or contributor contracts that reject MON can't receive a claim
  or refund. The funds stay in escrow, not lost to a third party. Documented
  and tested.
- Owner powers are limited to future rooms. A compromised owner can't touch
  held funds, but can raise the fee for **new** rooms up to 1%. Each room
  shows its snapshotted fee.
- Off-chain metadata (title, description) is bound on-chain by `termsHash`.
  The page shows a mismatch rather than trusting KV.
- Activity lists only contributions PayAI verified. Direct contract calls
  still count in on-chain totals; the page notes when the two differ.

## 7. Fee implications

- Contributions to escrow **do not go through the forwarder**: the forwarder
  pays a recipient immediately, which would defeat escrow. Routing through it
  would need a forwarder change.
- The fee is therefore charged by the escrow, **once, on a successful claim**:
  `floor(raised × feeBps / 10000)`, with `feeBps` snapshotted at creation
  (**superseded:** the Rooms fee is now 0.5%, enforced on-chain with a 50 bps cap; see ESCROW_ROOMS.md). The creator
  or beneficiary bears it. Contributors authorise exactly their contribution.
  Refunds are 100%, with no fee.
- **This is a fee-policy change from today** (fee on top, paid by each
  payer). It needs product sign-off before deployment.

## 8. Tests needed

Contract (Hardhat, local EVM): creation validation, both models,
token/amount rules, the deadline boundary, completion, claim/refund/cancel
eligibility and duplicates, pause scope, owner limits, fee snapshot,
fee-on-transfer rejection, reentrancy and rejecting receivers.
App (vitest): action quote/build/receipt verification against wrong token,
amount, room, event, reverted and malformed receipts; service state
transitions; visibility; fee disclosure; Ask parity. Browser: the public page
at phone width.

## 9. Can the architecture support it safely?

Yes, without a new execution path. The SDK action registry, the
plan → quote → build → Layer B validation (allowed targets, exact approvals)
→ wallet signature → settlement verification pipeline already carries
SplitSettlement and Aave. A Room escrow is one more allowlisted target.
What it can't do today is run: **no escrow is deployed, so escrow rooms stay
unavailable in every environment until a reviewed deployment is configured.**
