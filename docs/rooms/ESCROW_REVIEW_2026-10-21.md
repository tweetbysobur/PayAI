# PayAIRoomEscrow: pre-deploy security review (2026-10-21)

**This is PayAI's own internal review. It is not an independent audit.**
The contract is still unaudited and undeployed. Deploying a custodial
contract to mainnet needs an independent audit first
(`ESCROW_PRE_AUDIT_PACKAGE.md`).

Contract: `contracts/contracts/PayAIRoomEscrow.sol`, unchanged by this review
(last changed in `13c7663`).

## What was run

| Check | Result |
|---|---|
| Existing unit, adversarial and decision tests | 91 passing |
| Line-by-line manual review | No vulnerability found (see properties below) |
| Monad mainnet fork, real USDC (`0x7547…b603`), real Safe as owner and treasury | 22 of 22 lifecycle checks pass |
| Monad mainnet fork, USDC issuer powers (blocklist, pause) | 15 checks; one finding (M-1) |
| Slither 0.10 (102 detectors) | 15 results, all intended design or informational |
| Stateful random testing | 40 seeds x 1,000 operations, all 12 invariants hold |
| Mutation testing (20 hand-written mutants) | 18 caught at first; 2 test gaps found and closed; now 20 of 20 |

### Lifecycle on the fork (block 115,257,409)

Deployed with the Safe (`0xA282…C0b0`) as owner and treasury, fee 50 bps.
The deployer has no admin power after deploy. A 3 x 20 USDC room completes
and pays 60 USDC less 0.5% to the beneficiary when anyone calls `claim`; the
0.3 USDC fee reaches the Safe through `withdrawFees`. An expired USDC room
refunds 20 USDC with no fee. A cancelled MON room refunds 4 MON. A MON target
room completes on the exact remainder and cannot be overfilled. Pause blocks
new rooms only. The fee cannot be set above 50 bps. Stray MON is refused. The
escrow ends holding exactly zero.

### USDC issuer powers on the fork

USDC on Monad is Circle's FiatToken (blacklister `0x1786…d6cd`, pauser
`0xa5fa…e8ea`). Impersonated on the fork only:

- Beneficiary blocklisted: `claim` reverts, the room stays claimable, nothing is lost.
- Contributor blocklisted: `refund` reverts, the amount stays recorded.
- Treasury blocklisted: payouts are unaffected; fees stay owed until lifted or recovered.
- USDC paused: claims revert, then succeed after unpause; nothing is lost.
- The escrow itself blocklisted: every USDC room is frozen until Circle lifts it.
  Inherent to holding USDC (L2 in the pre-audit package).

## Findings

### M-1 (Medium, compliance): `claimTo` / `refundTo` route around a USDC blocklist. FIXED

A blocklisted beneficiary can call `claimTo(roomId, freshAddress)` and a
blocklisted contributor can call `refundTo(roomId, freshAddress)`. The funds
leave the escrow (which is not blocklisted) for an address that is not
blocklisted, so USDC never checks the blocklisted owner. Proven on the fork
(checks A3 and B3). No user loses money, but the escrow lets frozen funds
move, which is a sanctions and compliance risk for PayAI.

Options, for the auditor and PayAI to decide:
1. In `claimTo` and `refundTo`, refuse when the token reports the caller as
   blocklisted (a `staticcall` to `isBlacklisted(msg.sender)`, treated as
   "not blocklisted" if the token has no such function). Funds of a
   blocklisted owner then stay in escrow until the issuer lifts the block.
2. Accept the behaviour and state it in the terms.

**Fixed (option 1).** `claimTo` and `refundTo` now call
`_requireNotBlocklisted(token, msg.sender)`, which asks the token's
`isBlacklisted(address)` and reverts with `owner blocklisted` when it returns
true. Native MON and tokens without that function are unaffected. Funds of a
blocklisted owner stay in escrow and are released by `claim`/`refund` once the
issuer lifts the block. New invariant INVARIANT-RE-11.

Re-verified after the fix: 94 contract tests pass (3 new M-1 tests); on the
mainnet fork with real USDC, both bypasses are refused (A3, B3), the funds are
released once unblocked (A5, B4), and `refundTo` still works for an owner who
is not blocklisted (B5); all 41 fork checks pass. The app only calls `claim`
and `refund`, so no app change is needed.

### I-1 (Informational): `TreasurySet(address)` is not indexed

Harder to filter in logs. No security impact.

### T-1, T-2 (fixed): two test gaps found by mutation testing

- Removing the reentrancy lock broke no test, because every re-entry test
  also violated some other rule. Added a mock mode that re-enters with a
  fully valid `createRoom`, so only the lock can stop it.
- Removing the "cancelled or past deadline" refund check broke no test.
  Added a test that an open room refuses `refund` and `refundTo`.

Both in `test/PayAIRoomEscrow.adversarial.test.js` and
`contracts/mocks/RoomEscrowMocks.sol`; the contract itself is unchanged.

## Properties confirmed by reading

- Funds leave only through `claim`/`claimTo` (once, after completion),
  `refund`/`refundTo` (a contributor's own amount, after cancel or expiry) and
  `withdrawFees` (only to the treasury that holds the fee). A room is either
  claimed or refundable, never both.
- Every state-changing function is `nonReentrant` and writes state before any
  external call.
- Room terms (beneficiary, token, amounts, deadline, fee, treasury) are
  written once at creation. Owner powers shape future rooms only;
  `recoverFees` moves PayAI's own accrued fees between treasuries and never
  touches room money.
- Exact-delivery checks reject fee-on-transfer and short tokens; native
  contributions require `msg.value == amount`.
- Pause never blocks claims or refunds.

## What remains before a mainnet deploy

1. An independent audit of this exact commit (M-1 is fixed in it).
2. Deploy from the deployer wallet with the Safe as owner and treasury, verify
   the source, have the Safe allowlist USDC and set its floor.
3. Tiny mainnet smoke test signed by the owner's wallet (`ESCROW_ROOMS.md`).
4. Only then set `MONAD_MAINNET_ROOM_ESCROW` and `PAYAI_ROOM_ESCROW_ENABLED`.
