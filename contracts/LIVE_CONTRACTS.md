# Live contract addresses — read this first

**The `deployed-*.json` files in this directory are a historical deploy
LOG, not the current live configuration.** There are five of them (v2, v3,
v3-fresh, payment-executor-v4, v4-ultrafuzz), each recording a real deploy
that happened at the time — but the app doesn't read any of them. It reads
`MONAD_MAINNET_PAYMENT_EXECUTOR` / `MONAD_MAINNET_MERCHANT_REGISTRY` /
`MONAD_MAINNET_AUTOMATION_VAULT` directly from Vercel's environment, which
can (and, as of this writing, does) point somewhere none of those JSON
files record.

Treat every address in a `deployed-*.json` file as "this WAS deployed,"
never as "this IS live" — confirmed the hard way on 2026-08-15, when the
most-recent deploy record (`deployed-suite-v4-ultrafuzz.json`,
`MerchantRegistry 0x3e5F9416...4DEb`) turned out not to match production at
all.

## How to check what's actually live, right now

Two read-only endpoints on the running app answer this directly —
no RPC, no explorer, no guessing from this repo:

- `GET /api/onchain` → `contracts.paymentExecutor`, `contracts.merchantRegistry`
- `GET /api/automation-config` → `executor`, `vault` (AutomationVault),
  `wmon`, `usdc`

These read `lib/monad/config.ts`'s `getPaymentExecutor()` /
`getMerchantRegistry()` / `getAutomationVault()`, which resolve the live env
vars — this is the actual source of truth, always.

**Better yet, for MerchantRegistry specifically: read it straight off
PaymentExecutor's own immutable `merchantRegistry()` getter on-chain.**
It's baked into the contract at deploy time and cannot be transcribed
wrong afterward the way a copy-pasted address in a doc or screenshot can
— see the correction below for exactly why this distinction mattered.

## Confirmed live, as of 2026-08-15

| Contract | Live address | Confirmed via |
|---|---|---|
| PaymentExecutor | `0xf723BE809A99A1c29e0205a542aa2aEF80B508AF` | `/api/onchain`, verified on MonadVision (green checkmark) |
| MerchantRegistry | `0xadf04A50a2319D8B57245Db2aEB101DAb517AA72` | **On-chain**: `PaymentExecutor.merchantRegistry()` read directly via MonadVision's "Read Contract" tab — the most authoritative source available, since it's immutable |
| AutomationVault | `0x87D42314d1BAf2386fB9ff3dF398b543bc64cA47` | `/api/automation-config`; deployed + traceable on MonadVision (Contract Creator `0x25b84164...c7Fdc3a`, Aug-13-2026), not yet source-verified there |

None of these three appear in any `deployed-*.json` file in this
directory — see "Where all three came from" below for why that's expected,
not alarming.

`/api/automation-config` also returned `wmon: 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A`
and `usdc: 0x754704Bc059F8C67012fEd69BC8A327a5aafb603` — both match the
addresses hardcoded in `lib/monad/swap.ts` and `lib/monad/kuruSwap.ts`
exactly, and the USDC address independently matches what Kuru's own docs
gave for "Official tokens: USDC" too.

## Correction (2026-08-15): a screenshot-transcription error, now fixed

An earlier version of this file, and a commit that "fixed" a supposed typo
in `contracts/scripts/verify-e2e-proof-readonly.js`, recorded the
MerchantRegistry address as `0xadf04A50a2319D8857245Db2aEB101DAb517AA72`
(`...D885...`) instead of the correct `...D8B5...`. That was a
misreading of a screenshot of `/api/onchain`'s JSON response — a `B`
read as an `8` — not a real discrepancy in the app or in PR #15. The
script's *original* value was already correct; the "fix" broke it. Both
have been reverted to the real address, confirmed directly against
PaymentExecutor's own immutable on-chain `merchantRegistry()` value,
which cannot itself be mistyped.

Concretely, this means: don't trust an address transcribed by hand (by a
person or by a model reading a screenshot) as the last word on anything
this consequential — cross-check it against an on-chain read, an
explorer's copy button, or another independent source before treating it
as settled. The two-explorer cross-check done earlier in this
investigation was sound methodology; it was just pointed at the wrong
value to begin with.

## Where all three came from

**GitHub PR #15** — "Ultrafuzz report fixes: M-01, L-01, L-02, merchant-cap
+ verification tooling," merged 2026-08-14 — is the missing deploy record.
It was never written as a `deployed-*.json` file in this directory; it's
in the PR description instead, which states plainly the three addresses
were "already deployed to Monad mainnet and confirmed live via the app's
own `/api/onchain` and `/api/automation-config` endpoints." The PR shipped
the actual contract fix each address corresponds to:

- **AutomationVault** `0x87D42314...64cA47` — the M-01 fix (verifies the
  vault's own balance fell by exactly `amount`, not just that the
  recipient received it — closes a sender-surcharge-ERC20 fund-lock gap).
- **PaymentExecutor** `0xf723BE80...508AF` — the L-01 fix (native MON
  requests now settle through the same path as native payments) plus the
  merchant-cap invariant fix.
- **MerchantRegistry** `0xadf04A50...B517AA72` — the L-02 fix (a narrower
  `isRegistrar` role) plus `registerMerchantWithHistory`/`closeMigration`,
  which is the actual migration `MERCHANT_REGISTRY_MIGRATION.md` describes
  — that plan document's own status line still said "not started" as late
  as 2026-08-13, one day before this PR shipped the migration for real; its
  status has been corrected.

No sandbox session executed any of this — none has ever had
`MONAD_AGENT_PRIVATE_KEY` or live mainnet write access. This was a real
deploy + cutover run by whoever holds the actual keys, from the
`claude/bitv-s3ctfc` branch these fixes originated on (per PR #13's own
note: the contract-level fixes "need a real mainnet deploy session with
signing keys" and were deliberately kept off the app-layer-only PR).

## Still worth doing

- **AutomationVault** has no green "verified" checkmark on MonadVision yet
  (PaymentExecutor does). Bytecode-level verification was reportedly done
  against source (per PR #15's test plan), but that's a private/local
  check, not the same as submitting source to the explorer for public
  verification. Worth doing so all three show the same badge.
- Consider adding a proper `deployed-suite-v5-ultrafuzz-security-fixes.json`
  record to this directory now that all three addresses are confirmed, so
  future lookups here don't repeat this investigation from scratch. Left
  undone here deliberately — the full set of fields the other
  `deployed-*.json` files carry (owner, dailyCap, deployer, exact
  `deployedAt` timestamp) isn't independently confirmed, and inventing
  them to match the existing schema would be exactly the kind of
  unverified-value mistake this file just corrected.
