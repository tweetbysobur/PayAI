# PayAIRoomEscrow — internal security review (2026-10-09)

> **Archived.** Rooms were removed from PayAI in October 2026. This document
> describes the removed feature and is kept as a record only.

**This is an internal review, not an audit.** It was done by the same team
that wrote the contract. An independent audit is still required before any
deployment.

Scope: `contracts/contracts/PayAIRoomEscrow.sol` and its interaction with the
app (`lib/sdk/actions/room-escrow`, `lib/rooms/escrow*.ts`). All evidence below
is from real contract execution on Hardhat's local EVM
(`contracts/test/PayAIRoomEscrow*.test.js` — 91 escrow tests as of 2026-10-10, after the PA-01/04/05/11 decisions; see `ESCROW_PRE_AUDIT_PACKAGE.md` §J–§K) and a browser run of the
app against the same bytecode on a local chain with id 143. Nothing here ran
on Monad.

## Confirmed defects (found and fixed in this sprint)

| # | Severity | Defect | Fix | Test |
|---|---|---|---|---|
| D1 | **Medium**: permanent lock of a completed room's funds | `claim` pushed the fee to the treasury in the same call as the payout. If the room's snapshotted treasury couldn't receive (a contract rejecting MON, or a token-blocklisted address), every claim reverted. A completed room is never refundable, so the funds were stuck forever. | The fee is **accrued** (`feesOwed[treasury][token]`) and paid by a separate `withdrawFees`, which anyone may call and which pays only that treasury. | "a treasury that can't receive never blocks a payout" |
| D2 | **Medium**: permanent lock | A beneficiary that can't receive (a contract rejecting MON, or a USDC-blocklisted address) could never be paid, and the room could never be refunded. | `claimTo(roomId, to)`, callable **only by the beneficiary**. | "a beneficiary that can't receive MON … claimTo" |
| D3 | Low: lock of the contributor's own funds | A contributor that can't receive could never refund. | `refundTo(roomId, to)`, which moves only the caller's own contribution. | "a contributor that can't receive MON recovers via refundTo" |
| D4 | Low: lock via arithmetic | `raised × feeBps` could overflow for absurd targets above roughly 1.2e73, making the claim revert forever. | `target ≤ MAX_TARGET = uint256.max / 10000`, enforced at creation. | "targets beyond MAX_TARGET are refused" |
| D5 | Low: administration | Single-step `transferOwnership`: a typo would brick administration. Funds were never at risk. | Two-step: `transferOwnership`, then `acceptOwnership`. | "two-step ownership" |
| D6 | Policy | The fee cap was 1% and deployments were intended at 0.25%, while the product decision is 0.5%. | `MAX_FEE_BPS = 50`. The deploy script hard-codes 50, and the app refuses to create rooms on any other live fee. | "Fee configuration (0.5%)", regression tests |

Note on the app's own verification: the `Claimed` event's second field is now
"where the net went". The app only ever calls `claim`, so that field equals
the beneficiary, which the app checks.

## Review checklist — results

**A. Fund custody and accounting**
- **Permanently inaccessible funds:** D1–D4 fixed. Remaining cases are design
  limitations L1 and L2 below.
- **Paying more than recorded:** not possible. A claim pays `raised − fee` and
  accrues `fee`, summing to `raised`. Refunds pay `contributionOf`, which sums
  to at most `raised`, and are zeroed before sending. The solvency invariant
  (balance = unclaimed `raised − refunded` + `feesOwed`) is asserted after
  every step of a mixed MON/USDC run.
- **Counting a contribution twice:** not possible. Each call adds `amount`
  once, ERC-20 receipt is checked by balance delta, and the app logs each tx
  hash once.
- **Redirecting funds:** only the beneficiary can redirect its own payout
  (`claimTo`), and only a contributor can redirect its own refund. Anyone may
  trigger `claim` (PA-11), but it always pays the fixed beneficiary and the
  caller gets nothing. The owner has no path to room funds; its one power
  over existing balances is `recoverFees` (PA-01), which moves only PayAI's
  own accrued fees onto the current treasury, as accounting. The privileged
  surface is asserted in a test.
- **Treasury and beneficiary validation:** both are non-zero and not the
  escrow, checked at the constructor, `setTreasury` and `createRoom`.
- **Token transfers:** a `false` return reverts, and short delivery inbound
  or outbound reverts (balance deltas).
- **Supported-token trust:** the owner allowlist is trusted. A malicious or
  changing token affects only rooms in that token (L2). The app additionally
  accepts only MON and the configured USDC.

**B. Completion and contribution rules.** All enforced on-chain and tested:
- deadline is strict (`<` for contribute, `>=` for expiry);
- completed or cancelled rooms reject funds;
- one exact share per wallet in fixed rooms;
- a target can never be exceeded;
- the minimum applies, except for the exact remainder;
- the platform minimum (PA-05: 1 MON, 0.5 USDC) is enforced at creation for
  both room kinds, and a token with no floor can't be used (fail closed);
- same-block concurrent contributions near the target are safe: the
  overshooting one reverts and its MON never arrives.

**C. Claims and refunds.** These are all impossible, and tested:
- claiming before completion;
- a double claim, including three competing claims in one block;
- a double refund, including competing refunds in one block;
- refunding a completed room after its deadline;
- claiming a failed room.

The owner can pause only new rooms and contributions. All mutating functions
share one `nonReentrant` lock and update state before external calls.
Reentrancy from refund and claim hooks is blocked in tests. A failed transfer
reverts the whole transaction, so no partial state is left behind (tested:
`claimed` stays false).

**D. Fees**
- The fee applies only to successful payouts. Refunds are fee-free.
- Arithmetic floors and can't overflow (D4).
- A room can't be created above 0.5% on-chain.
- A room's treasury and fee are snapshotted and can't change after creation.
- Values are consistent across the contract, `escrowClaimFee` in the app,
  previews, quotes, the review and the docs (unit tests plus E2E).

**E. Lifecycle**
- Terms have no setter.
- Cancel is creator-only and only while open. Cancel against a completing
  contribution in the same block is consistent: exactly one wins.
- An abandoned creation leaves only an off-chain draft; no funds are involved.
- A completed room stays claimable indefinitely.

**F. Deployment and administration**
- **Privileged functions:** `setPaused`, `setTreasury`, `setFeeBps` (≤ 50),
  `setTokenSupported`, `setMinContributionFloor` (> 0, future rooms only),
  `recoverFees` (accrued fees only, onto the current
  treasury), `transferOwnership` / `acceptOwnership`.
- **Deployment:** no initializer, so deployment can't be re-run against the
  same instance. There is no proxy and no delegatecall.
- **Chain:** the contract has no chain-id assumption. The app pins chain 143
  and a single configured address.
- **Treasury and token safety:** an unintended treasury or token can only
  come from the owner, and only for future rooms. The deploy script requires
  an explicit treasury, requires owner and treasury to be contracts on
  mainnet, and asserts the deployed state.

## Design limitations (accepted; documented)

- **L1 (resolved by PA-11, 2026-10-10):** anyone can now trigger `claim` for a
  completed room, so lost creator keys no longer strand it. If the
  beneficiary itself can't receive, only its own `claimTo` moves the funds.
- **L2:** a token that later short-delivers on outgoing transfers (for
  example, an upgradeable token adding a transfer fee) makes payouts and
  refunds in that token revert. It is reachable only through the owner's
  allowlist. Tested and documented.
- **L3:** the owner can pause new contributions. That can stop a room from
  completing, so it expires and contributors refund. This is griefing, not
  theft.
- **L4:** the owner can lower the fee for future rooms. The app then refuses
  to create rooms until its published fee matches, failing closed.
- **L5:** fixed-share slots are open to anyone, so one person with several
  wallets can take several slots. Each slot still pays the full share.
- **L6:** a creator can cancel any open room, even one with contributions.
  Contributors get full refunds; only gas is lost. Kept by decision PA-04 and
  disclosed in the app before contributing.
- **L7:** fees at 0.5% floor to zero below 200 base units (0.0002 USDC).
- **L8 (PA-01 trade-off):** a compromised owner can `setTreasury` to itself and
  then `recoverFees`, capturing PayAI's accrued fees. It can't reach
  principal, payouts or refunds. Mitigate with the Safe threshold and,
  optionally, a timelock.
- **L9 (PA-05, mitigated, not eliminated):** the platform minimum (1 MON;
  0.5 USDC) makes the reported 1-unit front-run impossible. A front-runner
  willing to put in at least the minimum can still make an exact-remainder
  contribution revert. The victim loses only gas and retries. Partial fills
  weren't adopted. See `ESCROW_PRE_AUDIT_PACKAGE.md` §K.

## Requires an independent auditor

- A full audit of the contract, including tooling-based analysis (Slither,
  Echidna or Foundry fuzzing), which this review did not run.
- Review of USDC-on-Monad specifics: proxy upgradeability, blocklisting and
  pausing, and how they interact with L2.
- Review of the Safe configuration (signers and threshold) that will own the
  contract and receive fees.
- Gas and denial-of-service review at the 1,000-slot limit. No loops depend on
  the number of contributors, but it should be confirmed.
- Review of the 2026-10-10 changes: permissionless `claim` (PA-11), owner
  `recoverFees` (PA-01) including the L8 trade-off, and the PA-05 minimum
  (`minContributionFloor`, the `createRoom` checks, and the 4-argument
  constructor).
