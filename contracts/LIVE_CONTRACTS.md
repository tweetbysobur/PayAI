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

## PayAIForwarder — deployed + verified + tested on mainnet, 2026-08-23

The on-chain footprint for INTERACTIVE, user-signed payments (Step 8.1–8.3).
Separate, non-upgradeable contract; holds no funds, has no agent role, cannot
move anyone's money — the payer is always `msg.sender` and funds route
`payer -> PayAIForwarder -> recipient` in one atomic tx with a canonical
`PaymentForwarded` event. Unrelated to PaymentExecutor / AutomationVault /
MerchantRegistry above; none of those were touched.

| Field | Value |
|---|---|
| Address | `0x4ce7B3036595eDA699Aebeb47b34fd4bc4F80709` |
| Chain | Monad mainnet (143) |
| Deployer / Contract Creator | `0x25b84164461FE6EA4dAB470460D0c4eb7c7Fdc3a` (same key as the suite above) |
| Owner (admin: pause + ownership only, cannot move funds) | **`0xA282833B52b1B66D58bD2007081dCC037798C0b0`** — a Safe multisig. Transferred 2026-08-23 from the deployer EOA (`0x25b8…dc3a`) via the forwarder's `transferOwnership` (single-step); **verified on-chain by reading the contract's own immutable `owner()` getter** on MonadVision, the authoritative source. Owner can only pause / transfer ownership — never move funds. |
| Deploy tx | `0xe78fb41e282f3aa824bc2526ee9843777af7af61de8c15fe3eb4f299e693bfb2` (block 98,496,573) |
| Source verification | **Sourcify full match** — `https://monadexplorer.com/contracts/full_match/143/0x4ce7B3036595eDA699Aebeb47b34fd4bc4F80709/`; green "Contract" badge on MonadVision |
| Real native-MON test | tx `0x52e3807823dd093ee5af5affae7bc68cf9b3878d2d362880ee3ec18e7184cde8` (block 98,505,583) — 0.001 MON, `PaymentForwarded` id 0 decoded from logs, internal transfer `forwarder -> recipient` visible on MonadVision. **`payer -> PayAIForwarder -> recipient` proven on-chain.** |
| Real ERC-20 (USDC) test | approve `0xe44ea195eec5421c30675f81df1952f0b721b39068ac808cd8e791898e91b5ae` (EXACT 0.01 USDC, not MAX) + forward `0x077c4a30d9b5eca88a6df5ceef6abffb5adcc60c01405177c3336ff82d836cd5` (block 98,507,889) — `PaymentForwarded` id 1, token `0x754704Bc...aafb603`, recipient USDC balance delta exactly +0.01. **Two-step `approve(exact) -> payer -> PayAIForwarder -> recipient` proven on-chain.** |

**LIVE in production as of 2026-08-23.** Both `MONAD_MAINNET_PAYAI_FORWARDER`
(the address above) and `PAYAI_FORWARDER_ENABLED=true` are set in Vercel, so
interactive native + ERC-20 payments now route through the forwarder — see
`lib/monad/config.ts`'s `getPayAIForwarder()` / `forwarderPaymentsEnabled()`
(fail-closed: both required). Rollback is simply setting the flag to `false`;
nothing on-chain changes. Compiler for re-verification: solc `0.8.24`, optimizer
on, 200 runs, single-file `contracts/PayAIForwarder.sol`, MIT.

Production canary (real payments through the live app, usepayai.xyz):

| Canary | Proof |
|---|---|
| USDC | tx `0x246d2e2ef1a6c7222e4487fa5d414a1953a6dce6b0bdf559d433b9de02609793` (block 98,516,844) — method `ForwardPayment`, `gentle.nad → 0x8EED…364F` for 1 USDC via the forwarder, two-step approve→forward. |
| Native MON | tx `0xe5a06379438a6423578d492d23a9691ff4a01304d3460e79f2c0cebddca76f1b` (block 98,517,095) — method `ForwardPaymentNative`, internal transfer `forwarder → 0x8EED…364F` for 1 MON. |

The public footer (`components/landing/SiteFooter.tsx`) links this address as
"Payment Forwarder Live on Monad", sourced from `/api/onchain`'s
`contracts.forwarderExplorer`.

`/api/automation-config` also returned `wmon: 0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A`
and `usdc: 0x754704Bc059F8C67012fEd69BC8A327a5aafb603` — both match the
addresses hardcoded in `lib/monad/swap.ts` and `lib/monad/kuruSwap.ts`
exactly, and the USDC address independently matches what Kuru's own docs
gave for "Official tokens: USDC" too.

## PayAITradeExecutor — deployed + verified + canaried on mainnet, 2026-08-24

The on-chain footprint for INTERACTIVE, user-signed TRADES on **Uniswap V3
and Kuru** (Gate 4). Separate, non-upgradeable, Safe-owned contract. Exact-input
only; typed adapters (no arbitrary target/calldata); Safe-controlled Kuru
allowlist + pause; 0.25% fee taken from the gross INPUT to the treasury;
output measured by the user's real balance delta; dual zero-retention on
input and output. The payer/beneficiary is always `msg.sender`. Unrelated to
PaymentExecutor / AutomationVault / MerchantRegistry / PayAIForwarder — none
were touched. **Nad.Fun is NOT included** here; the existing direct-to-router
Nad.Fun path is unchanged.

| Field | Value |
|---|---|
| Address | `0xF17a916280321Ddb657c8EDd26B2a729F6E63b69` |
| Chain | Monad mainnet (143) |
| Deployer / Contract Creator | `0x25b84164461FE6EA4dAB470460D0c4eb7c7Fdc3a` (same key as the forwarder + suite) |
| Owner (admin: pause + config only, cannot move funds) | **`0xA282833B52b1B66D58bD2007081dCC037798C0b0`** — the PayAI Safe multisig, set in the constructor (owner from block zero; no EOA-owner window). Verified on-chain via the contract's `owner()`. |
| Treasury (0.25% fee sink) | `0xA282833B52b1B66D58bD2007081dCC037798C0b0` (the Safe itself). Verified via `treasury()`. |
| feeBps | `25` (0.25%); `MAX_FEE_BPS` = 100 (1%). Verified via `feeBps()`. |
| paused | `false`. Verified via `paused()`. |
| uniswapRouter (immutable, SwapRouter02) | `0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900`. Verified via `uniswapRouter()`. |
| wmon (immutable, WETH9) | `0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A`. Verified via `wmon()`. |
| Kuru allowlist | MON/USDC market `0x065C9d28E428A0db40191a54d33d5b7c71a9C394` = `true`. Seeded by a **Safe multisig tx (2/3)** executed 2026-08-24 (`setKuruMarket`), confirmed on-chain by re-reading `allowedKuruMarket`. No other market allowlisted. |
| Deploy tx | `0xdb4bcd6f405c4ff8538fc14bb9aa79d5a9b148d33ba70015bf3b1f0b3f944802` |
| Source verification | **Sourcify full match** — `https://monadexplorer.com/contracts/full_match/143/0xF17a916280321Ddb657c8EDd26B2a729F6E63b69/`. Compiler: solc `0.8.24`, optimizer on, 200 runs, **no viaIR**, single-file `contracts/PayAITradeExecutor.sol`, MIT. |

**LIVE in production as of 2026-08-24.** Both
`MONAD_MAINNET_PAYAI_TRADE_EXECUTOR` (the address above) and
`PAYAI_TRADE_EXECUTOR_ENABLED=true` are set in Vercel, so interactive Ask
PayAI trades on Uniswap V3 + Kuru now route through this executor — see
`lib/monad/config.ts`'s `getPayAITradeExecutor()` / `tradeExecutorEnabled()`
(fail-closed: both required) and `lib/monad/tradeExecutor.ts`. Rollback is
simply setting the flag to `false`; nothing on-chain changes. Nad.Fun stays
on its own direct route regardless of this flag — untouched.

Production canary (a real trade through the live app, usepayai.xyz):

| Canary | Proof |
|---|---|
| Kuru, USDC → MON | tx `0xd1a5642cdd254e41f076adda717fb8bf345c817f45f096265d0df484c469047b` (block 98,703,131) — method `TradeKuruExactInput`, `0x25b8…dc3a` traded 0.1 USDC → MON via the Kuru MON/USDC market. Interacted-with contract on the explorer is `0xF17a…63b69` (the executor), not the market directly; the executor pulled the input, took the 0.25% fee, approved the market for the NET (0.09975 of 0.1) and reset the approval to 0 afterward, and forwarded the MON output to the user. `TradeExecuted` emitted. |

The public footer (`components/landing/SiteFooter.tsx`) links this address as
"Trade Executor Live on Monad", sourced from `/api/onchain`'s
`contracts.tradeExecutorExplorer` (shown only while the flag is on).

Pre-launch mainnet canaries (Gate 4 — tiny amounts, signed by the deployer
wallet `0x25b8…dc3a` before the app was wired to the executor; every one
verified on-chain: `TradeExecuted` decoded, correct user/venue/tokens/amountIn,
amountOut ≥ minOut, 0.25% fee to treasury, user received the output, executor
retained zero, allowances reset):

| # | Direction | Tx | In → Out | Fee |
|---|---|---|---|---|
| 1 | Uniswap ERC-20 → ERC-20 | `0x4a359084f8c28ac46012b36d68645069176babe3cf166faecb8cbf77e439d125` (blk 98627564) | 0.02 USDC → 0.662940 WMON | 0.00005 USDC |
| 2 | Uniswap ERC-20 → native MON | `0xc4e7cd9a30a0f1fcadd0dd3cd3c335f6416ca3e1d37ef17f65cb889dc0883f20` (blk 98631142) | 0.02 USDC → 0.659110 MON | 0.00005 USDC |
| 3 | Kuru native MON → ERC-20 | `0xc688edc75cd5123087c1e3b5b9c37c1a458fb3220fbce6e206945599ae508dda` (blk 98633142) | 0.02 MON → 0.000599 USDC | 0.00005 MON |
| 4 | Kuru ERC-20 → native MON | `0xe2d37c7a1f9c2ebc8cf43388c903733394a1c209c071220bfe366ddd7d8ec96c` (blk 98633516) | 0.05 USDC → 1.656096 MON | 0.000125 USDC |

Deploy / verify / config-check / canary tooling lives in
`contracts/scripts/deploy-payai-trade-executor.js`,
`check-trade-executor-config-readonly.js`, `canary-uniswap-mainnet.js`,
`canary-kuru-mainnet.js`, with the full sequence in `contracts/GATE4_RUNBOOK.md`.

## PayAITradeExecutorV2 — deployed + verified + configured + canaried on mainnet, 2026-08-24

The on-chain footprint for INTERACTIVE, user-signed TRADES on **Uniswap V3,
Kuru, and Nad.Fun** (Gate 7/8) — Gate 7 added Nad.Fun as a third venue
alongside V1's existing two; Gate 8 deployed, configured, and canaried the
result on mainnet. Separate, non-upgradeable, Safe-owned contract; same
security model as V1 (exact-input only, typed adapters, no arbitrary
target/calldata, Safe-controlled allowlists + pause, 0.25% fee from the gross
INPUT to the treasury, output measured by the user's real balance delta,
zero-retention on every asset touched). The payer/beneficiary is always
`msg.sender`. **V1 (`0xF17a916280321Ddb657c8EDd26B2a729F6E63b69`) was not
modified or redeployed** — it remains fully intact and is the production
rollback path for as long as V2 stays disabled. Unrelated to PaymentExecutor
/ AutomationVault / MerchantRegistry / PayAIForwarder — none were touched.

| Field | Value |
|---|---|
| Address | `0x920409bed646fFA094b9851867435a74B55Ca40d` |
| Chain | Monad mainnet (143) |
| Owner (admin: pause + config only, cannot move funds) | **`0xA282833B52b1B66D58bD2007081dCC037798C0b0`** — the PayAI Safe multisig, set in the constructor (owner from block zero; no EOA-owner window). Verified on-chain via the contract's `owner()`. |
| Treasury (0.25% fee sink) | `0xA282833B52b1B66D58bD2007081dCC037798C0b0` (the Safe itself). Verified via `treasury()`. |
| feeBps | `25` (0.25%); `MAX_FEE_BPS` = 100 (1%). Verified via `feeBps()`. |
| paused | `false`. Verified via `paused()`. |
| uniswapRouter (immutable, SwapRouter02) | `0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900`. Verified via `uniswapRouter()`. |
| wmon (immutable, WETH9) | `0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A`. Verified via `wmon()`. |
| Kuru allowlist | MON/USDC market `0x065C9d28E428A0db40191a54d33d5b7c71a9C394` = `true`. Seeded by a Safe multisig tx, confirmed on-chain by re-reading `allowedKuruMarket`. Same market V1 already has allowlisted — restored on this separate contract, not changed. No other market allowlisted. |
| Nad.Fun BondingCurveRouter allowlist | `0x6F6B8F1a20703309951a5127c45B49b1CD981A22` = `true`. Seeded by a Safe multisig tx, confirmed via `allowedNadFunRouter`. |
| Nad.Fun DexRouter allowlist | `0x0B79d71AE99528D1dB24A4148b5f4F865cc2b137` = `true`. Seeded by a Safe multisig tx, confirmed via `allowedNadFunRouter`. No other Nad.Fun router allowlisted. |
| Deploy tx | `0x5f3567ff59f06c447b129f6a19463c8808c5cb270b2d3641a7b59bba84319bad` |
| Source verification | **Sourcify full match** — `https://monadexplorer.com/contracts/full_match/143/0x920409bed646fFA094b9851867435a74B55Ca40d/`. Compiler: solc `0.8.24`, optimizer on, 200 runs, **no viaIR**, single-file `contracts/PayAITradeExecutorV2.sol`, MIT. |

**Deployed, verified, and configured — NOT yet enabled in production.**
`MONAD_MAINNET_PAYAI_TRADE_EXECUTOR_V2` and `PAYAI_TRADE_EXECUTOR_V2_ENABLED`
remain unset in Vercel; Ask PayAI trades continue routing through V1
(Uniswap/Kuru) and the existing direct path (Nad.Fun) exactly as before. See
`lib/monad/config.ts`'s `getPayAITradeExecutorV2()` /
`tradeExecutorV2Enabled()` (fail-closed: both required) and
`lib/monad/tradeExecutor.ts`'s `selectExecutor()`, which will route Uniswap,
Kuru, and Nad.Fun all through V2 once enabled — superseding V1 for the first
two, and serving Nad.Fun through an executor for the first time. Rollback
before enabling is simply never setting the flag; rollback after enabling is
setting it back to unset/false — nothing on-chain changes either way.

Mainnet canaries (tiny amounts, signed by the deployer wallet
`0x25b8…dc3a` before any production flag is touched; every one verified
on-chain: `TradeExecuted` decoded, correct user/venue/tokens/amountIn,
0.25% fee to treasury, executor retained zero, allowances reset):

| # | Direction | Tx | In → Out | Fee | Result |
|---|---|---|---|---|---|
| 1 | Uniswap, USDC → WMON | (see terminal output, Gate 8) | 0.02 USDC → 0.62422099 WMON | 0.00005 USDC | PASS — all checks |
| 2 | Kuru, USDC → native MON | `0x23e5510db5c0fdfe34ec0ae9e85ca5d124046a2b4d96af72c61d3ac3389ac4d6` (blk 98840701) | 0.05 USDC → 1.56298966 MON | 0.000125 USDC | PASS — all checks |
| 3 | Nad.Fun bonding-curve BUY, native MON → token | (see terminal output, Gate 8) | 0.01 MON → 957.79331022 token | 0.000025 MON | PASS — all checks |
| 4 | Nad.Fun bonding-curve SELL, token → native MON | (see terminal output, Gate 8) | 190 token → 0.01934569 MON | 0.475 token | Substantively PASS — 14/15 checks (see note below) |
| 5 | Nad.Fun DEX BUY, native MON → token | `0x68f182e50f2246f890416d51e19722dc23dd18de4de23d7c82bebc9c6fa7c085` (blk 98861268) | 0.01 MON → 2.09606476 token | 0.000025 MON | PASS — all checks |
| 6 | Nad.Fun DEX SELL, token → native MON | (see terminal output, Gate 8) | 2 token → 0.00932896 MON | 0.005 token | Substantively PASS — 14/15 checks (see note below) |

**Note on canaries #4 and #6:** both hit the same informal wallet-balance
heuristic (native output net of gas > 0), not a fund-safety or contract
defect — every check that actually attests correctness passed on both
(correct venue/tokens/amounts, correct 0.25% fee, treasury received it
exactly, `amountOut ≥ minOut`, zero-retention, no leftover allowance, correct
`TradeExecuted` emitter and router). Both trades deliberately used very small,
low-value test tokens; on Monad's current gas cost, a native-MON output that
small can be smaller than the tx's own gas fee, which trips a wallet-level
"did the balance go up" check that assumes gas is negligible relative to
output. The contract's own event and the zero-retention/fee checks — the
things that actually prove correctness and fund safety — passed cleanly in
both cases. Accepted as sufficient rather than re-run with a larger amount,
since scaling this specific test further would only spend more MON without
adding any additional safety signal.

Deploy / verify / config-check / canary tooling lives in
`contracts/scripts/deploy-payai-trade-executor-v2.js`,
`check-trade-executor-v2-config-readonly.js`, `canary-uniswap-mainnet-v2.js`,
`canary-kuru-mainnet-v2.js`, `canary-nadfun-mainnet-v2.js`, with the full
sequence in `contracts/GATE8_RUNBOOK.md`.

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
