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
vars — this is the actual source of truth, always. If a session or a
person can't reach `usepayai.xyz` directly, ask whoever can to open those
two URLs and paste the JSON back — that's sufficient, nothing else is
needed to answer "what contract does a transaction point to right now."

## Confirmed live, as of 2026-08-15 (via `/api/onchain` + `/api/automation-config`)

| Contract | Live address | Matches a `deployed-*.json` record? |
|---|---|---|
| PaymentExecutor | `0xf723BE809A99A1c29e0205a542aa2aEF80B508AF` | **No** — doesn't appear in any file in this directory |
| MerchantRegistry | `0xadf04A50a2319D8857245Db2aEB101DAb517AA72` | **No** — doesn't appear in any file in this directory |
| AutomationVault | `0x87D42314d1BAf2386fB9ff3dF398b543bc64cA47` | **No** — doesn't appear in any file in this directory |

The executor address matched between both endpoint responses (consistent,
as expected — both read the same env var). `/api/automation-config` also
returned `wmon: 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A` and
`usdc: 0x754704Bc059F8C67012fEd69BC8A327a5aafb603` — both match the
addresses hardcoded in `lib/monad/swap.ts` and `lib/monad/kuruSwap.ts`
exactly, and the USDC address independently matches what Kuru's own docs
gave for "Official tokens: USDC" too. Three independent sources agreeing
is a real cross-check, not just a repeated assumption — the token
addresses this codebase's swap/payment code depends on are correct.

`/api/onchain`'s own stats for this executor/registry pair showed zero
payments, zero merchants, zero requests at the time of this check — worth
reconciling against what the dashboard's Transactions tab actually shows
for the same account, since a mismatch there would mean the two aren't
reading the same contract.

## Where all three came from (fully resolved)

**GitHub PR #15** — "Ultrafuzz report fixes: M-01, L-01, L-02, merchant-cap
+ verification tooling," merged 2026-08-14 — is the missing deploy record.
It was never written as a `deployed-*.json` file in this directory; it's
in the PR description instead, which states plainly: "already deployed to
Monad mainnet and confirmed live via the app's own `/api/onchain` and
`/api/automation-config` endpoints," listing all three addresses in this
table exactly. The PR shipped the actual contract fixes each address
corresponds to:

- **AutomationVault** `0x87D42314...64cA47` — the M-01 fix (verifies the
  vault's own balance fell by exactly `amount`, not just that the
  recipient received it — closes a sender-surcharge-ERC20 fund-lock gap).
- **PaymentExecutor** `0xf723BE80...508AF` — the L-01 fix (native MON
  requests now settle through the same path as native payments) plus the
  merchant-cap invariant fix.
- **MerchantRegistry** `0xadf04A50...7AA72` — the L-02 fix (a narrower
  `isRegistrar` role) plus `registerMerchantWithHistory`/`closeMigration`,
  which is the actual migration `MERCHANT_REGISTRY_MIGRATION.md` describes
  — that plan document's own status line still said "not started" as late
  as 2026-08-13, one day before this PR shipped the migration for real; its
  status has been corrected.

(One loose end, cosmetic only: the PR description carries the exact same
one-character typo on the MerchantRegistry address —`...D8B5...` instead
of the confirmed-live `...D885...` — that was in
`verify-e2e-proof-readonly.js`'s hardcoded default, now fixed there. Same
origin, doesn't affect anything live — Vercel's actual env var was set
correctly regardless of what either piece of text says.)

No sandbox session executed any of this — none has ever had
`MONAD_AGENT_PRIVATE_KEY` or live mainnet write access. This was a real
deploy + cutover run by whoever holds the actual keys, from the
`claude/bitv-s3ctfc` branch these fixes originated on (per PR #13's own
note: the contract-level fixes "need a real mainnet deploy session with
signing keys" and were deliberately kept off the app-layer-only PR).
