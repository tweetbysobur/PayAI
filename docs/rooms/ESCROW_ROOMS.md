# Escrow Rooms — design, semantics and status

Companion to `ESCROW_AUDIT.md` (Phase 1). This file records what was built,
exactly how it behaves, and what has to happen before it can be switched on.

## Status (2026-10-10)

| Piece | State |
|---|---|
| `contracts/contracts/PayAIRoomEscrow.sol` | Written, reviewed internally (see `ESCROW_SECURITY_REVIEW.md`), and tested on Hardhat's local EVM (91 escrow tests; 100% line, 99.5% branch coverage; see `ESCROW_PRE_AUDIT_PACKAGE.md`). **Not deployed anywhere, and not independently audited.** |
| `contracts/scripts/deploy-room-escrow.js` | Written, **never run** against a real network. It refuses to run without `DEPLOY_ROOM_ESCROW_CONFIRM=I_UNDERSTAND`, hard-codes `feeBps = 50` and the 1 MON minimum, and asserts the result on-chain. |
| SDK protocol `payai-rooms@1.0.0` (`lib/sdk/actions/room-escrow`) | Built. It registers only when an escrow is configured. |
| Rooms service and API (`lib/rooms/escrow*.ts`, `app/api/rooms/**`) | Built. Every call fails closed with `ESCROW_UNAVAILABLE` until configured. |
| Pages: `/r/{id}`, `/rooms` (Live Rooms), escrow form on `/dashboard/rooms` | Built. They say plainly that escrow Rooms aren't live yet. |
| Ask PayAI | Recognises `er_…` ids and `/r/er_…` links, and uses the same API. |
| Production | **Off.** `MONAD_MAINNET_ROOM_ESCROW` and `PAYAI_ROOM_ESCROW_ENABLED` are unset. |

Escrow Rooms must not be described as live, or as holding funds, until a
reviewed deployment is configured and a mainnet smoke test has run.

## Room models

**Fixed share.** `slots` people (2–1000) each pay exactly `share`, once per
address. `target = share × slots`. The room completes when the last share
lands. The share must be at least the platform minimum.

**Target.** Anyone contributes at least `minContribution`, or exactly the
remainder when the remainder is smaller, and never more than the remainder.
An address can contribute more than once. The room completes when
`raised == target`. Both `minContribution` and `target` must be at least the
platform minimum. If the creator gives no minimum, it is the platform
minimum.

**Platform minimum contribution (PA-05, approved 2026-10-10).**

| Token | Minimum | Base units |
|---|---|---|
| MON | 1 MON | 10^18 wei |
| USDC | 0.5 USDC | 500,000 (6 decimals) |

- These are contribution minimums, not gas reserves.
- **Where it's enforced:** by the contract at room creation
  (`minContributionFloor`), and by the app. The app checks the live USDC's
  `decimals() == 6` and refuses to create rooms if the escrow's floor isn't
  PayAI's value.
- **Exact remainder:** a final contribution of exactly the remaining amount is
  always accepted, even below the minimum, so a valid room can always
  complete.
- **What it doesn't fix:** minimums *reduce* front-running grief (a 1-unit
  front-run is now impossible) but **don't eliminate it**. Someone willing to
  put in at least the minimum can still make another person's exact-remainder
  contribution revert. That person loses only gas and can retry with the new
  remainder.
- There are no partial fills, and the 0.5% fee is unchanged.

Both kinds accept native MON or the configured USDC (the contract allowlist
**and** the app's own check must both agree). Duration is 1–90 days in the
app; the contract allows 1 hour to 90 days.

## Lifecycle

The contract derives the status; nothing sets it directly:

| Status | When | Who can do what |
|---|---|---|
| open | before the deadline, not cancelled, not complete | anyone contributes; the creator may cancel |
| completed | `raised == target` reached **before** the deadline | **anyone** triggers the claim, once; the payout always goes to the fixed beneficiary and the caller receives nothing (PA-11) |
| claimed | after claim | nothing further |
| expired | deadline passed without completing | each contributor refunds their own amount, once |
| cancelled | the creator cancelled before completion and before the deadline | each contributor refunds, once |

Deadline boundary: a contribution needs `block.timestamp < deadline`.
Expiry, and therefore a non-cancel refund, needs `block.timestamp >= deadline`.
A room completed in time stays claimable forever and is never refundable.

## Exact money flows

- **Contribute.** The contributor authorises exactly their amount. MON is sent
  as `msg.value`. For USDC there is one exact `approve(escrow, amount)` (never
  unlimited; Layer B checks it), then `contribute`. The escrow must receive
  the full amount, or the call reverts (fee-on-transfer tokens are refused).
- **Claim.** Anyone can trigger it (PA-11); the caller receives nothing.
  `fee = floor(raised × feeBps / 10000)` (with `feeBps = 50`, so 0.5%) is
  **accrued** to the room's snapshotted treasury, and `raised − fee` goes to
  the beneficiary fixed at creation. This happens once. Accrued fees
  reach the treasury through `withdrawFees(treasury, token)`, which anyone may
  call but which can only pay that treasury. Accruing the fee means a treasury
  that can't receive can never block a beneficiary's payout.
- **Fee recovery (PA-01).** If a treasury can no longer receive, the owner can
  call `recoverFees(oldTreasury, token)`. It moves that treasury's accrued
  fees onto the **current** treasury's balance. It is accounting only, and
  never touches room funds, refunds or room snapshots.
- **claimTo / refundTo.** The beneficiary (only the beneficiary) can direct its
  own payout to another address. A contributor can direct its own refund the
  same way. These are escape hatches for an address that can't receive (a
  contract rejecting MON, or a token-blocklisted address). The app itself
  always uses `claim` and `refund`.
- **Refund.** The contributor receives exactly what they put in. There is no
  fee, only gas.
- **Cancel.** No funds move. Every contribution becomes refundable. The
  creator can cancel at any time before completion and the deadline, with no
  penalty (PA-04, kept). The room page says this before anyone contributes.

## Fees

| Question | Answer |
|---|---|
| Is the PayAI forwarder involved? | **No.** The forwarder pays a recipient immediately, which would defeat escrow. Escrow contributions go straight to the escrow contract through their own reviewed SDK action. |
| Does the escrow charge a fee? | Yes: the **PayAI Rooms platform fee of 0.5% (50 bps)**, once, on a successful claim. It is snapshotted per room at creation and capped on-chain at 50 bps (`MAX_FEE_BPS`). The app also refuses to create rooms if the escrow's live fee is anything other than 50 (for example a stale 25). |
| Who pays it? | The beneficiary: it is deducted from the payout. |
| Do refunds incur a fee? | No. Refunds are 100%. |
| What can the creator claim? | `raised − floor(raised × 50 / 10000)`. Examples: 1,000 USDC raised gives a 5 USDC fee and 995 USDC net. 10 USDC gives 0.05 and 9.95. Rounding is down, so a room under 200 base units (0.0002 USDC) owes no fee. |
| What does a contributor authorise? | Exactly their contribution. The fee isn't added on top. |
| Is it disclosed? | In the creation preview, the room page ("How this room works"), the plan review ("PayAI fee"), the live quote, and the release panel (raised, fee, net). |

**Two different fees; don't confuse them.** The 0.5% Rooms platform fee
belongs to the escrow and is taken only from successful room proceeds. The
PayAI **forwarder** fee (read live from PayAIForwarderV2 `feeBps`; documented as 0.25% — not re-read on-chain for this report — added on top of
ordinary sends and direct-split rooms) is unchanged and is **never** charged
on escrow contributions, which go straight to the escrow contract through
their own reviewed action. No fee-free path was introduced, and no part of the
plan, review, approval or signing architecture is bypassed. Product decision
(2026-10): the Rooms fee is 0.5%.

## Trust model

- The owner (intended to be the existing Safe; two-step transfer) can pause
  **new rooms and new contributions**, change the fee (≤ 0.5%) and treasury,
  and allowlist tokens.
  **All of these apply only to rooms created afterwards**, because each room
  snapshots its fee, treasury and token. The owner has no function that moves
  or freezes room funds. Its one power over existing balances is
  `recoverFees`, which applies only to PayAI's own accrued fees (PA-01).
  Claims and refunds can't be paused.
- PayAI's server is not needed for fund safety. Refund eligibility is pure
  contract state, so anyone can call `refund(roomId)` on the verified contract
  directly. The app's server holds only text, links and a log of verified
  events.
- A beneficiary or contributor contract that rejects MON can't receive its
  claim or refund. The funds stay in escrow and are never sent elsewhere.
  Tested.

## How the app verifies

- **Creation.** The creator's `RoomCreated` event, emitted by the configured
  escrow, must match every previewed term, including `termsHash` (which binds
  the title, description and listing choice) and the fee. Only then is the
  room adopted, once.
- **Contribution, claim, refund, cancel.** The receipt must contain exactly one
  matching escrow event, for this on-chain room and this wallet (claims are
  checked against the beneficiary). A transaction hash counts once, globally.
  A pending transaction is never counted. The UI records an outcome only after
  the plan completes **and** the server re-verifies the receipt.
- **Numbers.** Raised, remaining, contributor count, status, claimable and
  refundable amounts are read from the contract on every view. The activity
  list shows only PayAI-verified events. Contributions made directly to the
  contract count in the totals and are noted separately.
- **Privacy.** Contributors are shown as "Contributor 1, 2…". Addresses are
  never returned, except the viewer's own rows ("you") and the beneficiary,
  which is part of the terms.

## Before switching on (not done; needs explicit approval)

1. Security review or audit of `PayAIRoomEscrow.sol`, including the PA-05
   minimum checks.
2. Product sign-off is recorded: 0.5% from successful proceeds. Confirm the
   treasury address.
3. Deploy with `owner =` the Safe, `treasury =` the Safe treasury,
   `feeBps = 50` and a MON minimum of 10^18, using
   `contracts/scripts/deploy-room-escrow.js`. Confirm USDC `decimals() == 6`,
   then call `setTokenSupported(USDC, true)` and
   `setMinContributionFloor(USDC, 500000)` from the Safe.
   Source-verify on Sourcify. Record it in `contracts/LIVE_CONTRACTS.md`.
4. Run a mainnet smoke test with tiny amounts: create, contribute (MON and
   USDC), claim; and create, contribute, expire, refund.
5. Set `MONAD_MAINNET_ROOM_ESCROW` and `PAYAI_ROOM_ESCROW_ENABLED=true` in
   Vercel. Rollback is unsetting the flag; held funds stay claimable or
   refundable directly on-chain.
