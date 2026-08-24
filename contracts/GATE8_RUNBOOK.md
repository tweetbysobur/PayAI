# Gate 8 runbook — PayAITradeExecutorV2 deploy + verify + configure + canaries

This is executed on a **Monad-connected machine with the deployer key** (the
sandbox has no signing key and no Monad RPC egress — same constraint as Gate 4
and the forwarder). Do everything from `contracts/`. **Do NOT** set
`MONAD_MAINNET_PAYAI_TRADE_EXECUTOR_V2` or `PAYAI_TRADE_EXECUTOR_V2_ENABLED`
until all six canaries pass. Do NOT update `LIVE_CONTRACTS.md` until deployment,
source verification, configuration, and all six canaries are independently
verified. **V1 (`0xF17a916280321Ddb657c8EDd26B2a729F6E63b69`) is untouched and
remains the production rollback path throughout this entire gate** — the app
keeps trading through it (Uniswap/Kuru) and through the existing direct Nad.Fun
path exactly as it does today; nothing about this runbook changes what's live.

## Confirmed parameters

| Param | Value |
|---|---|
| owner (Safe) | `0xA282833B52b1B66D58bD2007081dCC037798C0b0` |
| treasury | `0xA282833B52b1B66D58bD2007081dCC037798C0b0` (the Safe) |
| feeBps | `25` (0.25%) |
| uniswapRouter (SwapRouter02) | `0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900` |
| wmon | `0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A` |
| Nad.Fun routers | NOT constructor params — added post-deploy via Safe tx (Step 5) |
| initial Kuru allowlist (restored, not new) | `0x065C9d28E428A0db40191a54d33d5b7c71a9C394` (MON/USDC) |
| V1 executor (untouched, rollback path) | `0xF17a916280321Ddb657c8EDd26B2a729F6E63b69` |

These are byte-identical to Gate 4's constructor parameters — same Safe, same
fee, same Uniswap router, same WMON — confirmed against
`contracts/LIVE_CONTRACTS.md`'s existing V1 record before writing this runbook.

Confirmed facts (per the Gate 8 request):
- V1 remains completely untouched — no file under this gate modifies
  `contracts/contracts/PayAITradeExecutor.sol` or any of its Gate 4 scripts.
- V2 is non-upgradeable — no proxy, no delegatecall, no upgrade function
  anywhere in `PayAITradeExecutorV2.sol` (confirmed in the Gate 7 report).
- V2's owner is the Safe from the constructor (`initialOwner` param) — no
  EOA-owner window, identical to V1's pattern.
- Nad.Fun routers are not constructor parameters — `setNadFunRouter` is an
  `onlyOwner` post-deploy call, mirroring `setKuruMarket`'s existing pattern.
- Nad.Fun routers are added only through Safe transactions after deploy (Step 5).
- The existing Kuru market configuration is restored through the Safe (Step 4)
  — V2 starts with an empty `allowedKuruMarket` mapping just like V1 did at
  its own deploy; nothing carries over automatically between two separate
  contracts.
- Production V2 flags remain OFF for this entire gate.

`contracts/.env` needs `MONAD_AGENT_PRIVATE_KEY` (funded deployer for deploy;
for canaries this is the USER wallet — small MON for gas + a little USDC + a
Nad.Fun token in each phase being tested — see Step 7).

## Step 1 — Deploy (owner = Safe from block zero)

```
npx hardhat run scripts/deploy-payai-trade-executor-v2.js --network monad
```
Record the printed `PayAITradeExecutorV2` address and deploy tx. The script
reads the config straight back and flags any mismatch. This does not touch V1,
does not seed any allowlist, and does not change any env var/flag.

## Step 2 — Verify source

```
npx hardhat verify --network monad <ADDRESS> \
  0xA282833B52b1B66D58bD2007081dCC037798C0b0 \
  0xA282833B52b1B66D58bD2007081dCC037798C0b0 \
  25 \
  0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900 \
  0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A
```
Compiler: solc `0.8.24`, optimizer on, 200 runs, **no viaIR** (matches the repo
config and V1's verified build). If Sourcify DNS flakes:
`NODE_OPTIONS="--dns-result-order=ipv4first"`.

## Step 3 — Read-only config check

```
PAYAI_TRADE_EXECUTOR_V2_ADDRESS=<ADDRESS> \
  npx hardhat run scripts/check-trade-executor-v2-config-readonly.js --network monad
```
Expect PASS on owner/treasury/feeBps/paused/uniswapRouter/wmon/MAX_FEE_BPS. The
Kuru allowlist line and both Nad.Fun router lines will be FALSE until Steps 4-5.

## Step 4 — Restore the Kuru allowlist (ONE Safe transaction)

Because owner = Safe, only the Safe can call `setKuruMarket`. This is the SAME
market V1 already has allowlisted — being restored on the separate V2 contract,
not changed. In the Safe (Transaction Builder → custom / raw), send:

- **To:** `<PayAITradeExecutorV2 address>`
- **Value:** `0`
- **Data:** `0x055766c7000000000000000000000000065c9d28e428a0db40191a54d33d5b7c71a9c3940000000000000000000000000000000000000000000000000000000000000001`

(That is `setKuruMarket(0x065C9d28…C394, true)` — identical calldata to Gate 4's,
since the function signature is unchanged.)

## Step 5 — Enable the two Nad.Fun routers (TWO Safe transactions)

- **To:** `<PayAITradeExecutorV2 address>`, **Value:** `0`
- **Data (BondingCurveRouter):**
  `0xa390c9f30000000000000000000000006f6b8f1a20703309951a5127c45b49b1cd981a220000000000000000000000000000000000000000000000000000000000000001`
  (`setNadFunRouter(0x6F6B8F1a20703309951a5127c45B49b1CD981A22, true)`)
- **Data (DexRouter):**
  `0xa390c9f30000000000000000000000000b79d71ae99528d1db24a4148b5f4f865cc2b1370000000000000000000000000000000000000000000000000000000000000001`
  (`setNadFunRouter(0x0B79d71AE99528D1dB24A4148b5f4F865cc2b137, true)`)

No other Nad.Fun router is ever allowlisted.

## Step 6 — Read the allowlists back

```
PAYAI_TRADE_EXECUTOR_V2_ADDRESS=<ADDRESS> \
  npx hardhat run scripts/check-trade-executor-v2-config-readonly.js --network monad
```
Expect ALL PASS now, including: Kuru MON/USDC allowlisted, Nad.Fun
BondingCurveRouter allowlisted, Nad.Fun DexRouter allowlisted.

## Step 7 — Six canaries (tiny real trades, signed by the USER wallet)

Uniswap needs no allowlist and can run right after Step 3; the rest need
Steps 4-6 done. For the two Nad.Fun token slots you'll need a real token still
on the bonding curve (for 7.3/7.4) and a real token already graduated to the
DEX (for 7.5/7.6) — supply their addresses via `NADFUN_TEST_TOKEN`; none is
invented or defaulted here.

```
# 7.1 Uniswap buy (USDC -> WMON)
PAYAI_TRADE_EXECUTOR_V2_ADDRESS=<ADDRESS> DIRECTION=erc20-erc20 \
  npx hardhat run scripts/canary-uniswap-mainnet-v2.js --network monad

# 7.2 Kuru sell (USDC -> native MON)
PAYAI_TRADE_EXECUTOR_V2_ADDRESS=<ADDRESS> DIRECTION=erc20-native \
  npx hardhat run scripts/canary-kuru-mainnet-v2.js --network monad

# 7.3 Nad.Fun bonding-curve BUY (native MON -> bonding-curve token)
PAYAI_TRADE_EXECUTOR_V2_ADDRESS=<ADDRESS> DIRECTION=bonding-buy \
  NADFUN_TEST_TOKEN=<a real not-yet-graduated Nad.Fun token> \
  npx hardhat run scripts/canary-nadfun-mainnet-v2.js --network monad

# 7.4 Nad.Fun bonding-curve SELL (that token -> native MON)
PAYAI_TRADE_EXECUTOR_V2_ADDRESS=<ADDRESS> DIRECTION=bonding-sell \
  NADFUN_TEST_TOKEN=<same token> TEST_AMOUNT_TOKEN=<amount actually held from 7.3> \
  npx hardhat run scripts/canary-nadfun-mainnet-v2.js --network monad

# 7.5 Nad.Fun graduated-DEX BUY (native MON -> graduated token)
PAYAI_TRADE_EXECUTOR_V2_ADDRESS=<ADDRESS> DIRECTION=dex-buy \
  NADFUN_TEST_TOKEN=<a real graduated Nad.Fun token> \
  npx hardhat run scripts/canary-nadfun-mainnet-v2.js --network monad

# 7.6 Nad.Fun graduated-DEX SELL (that token -> native MON)
PAYAI_TRADE_EXECUTOR_V2_ADDRESS=<ADDRESS> DIRECTION=dex-sell \
  NADFUN_TEST_TOKEN=<same token> TEST_AMOUNT_TOKEN=<amount actually held from 7.5> \
  npx hardhat run scripts/canary-nadfun-mainnet-v2.js --network monad
```

Each script quotes/sizes from the **post-fee net** (exactly as the contract
swaps), executes, decodes `TradeExecuted`, and prints PASS/FAIL for every
required check: trade success, user==signer, event exists, correct venue,
correct tokenIn/tokenOut, correct gross amountIn, amountOut≥minOut, correct
0.25% fee, treasury received the exact fee, user received the output (amountOut
matching the user's real balance delta), executor retains zero native MON /
zero tokenIn / zero tokenOut, no leftover allowance, and — for Nad.Fun
specifically — that the Lens-quoted router for this token/direction matches the
expected router for the phase being tested (`canary-nadfun-mainnet-v2.js`
aborts BEFORE sending any transaction if it doesn't, so a bonding-curve canary
can never accidentally execute against the graduated DEX router or vice versa).

**Pay special attention to the bonding-curve BUY (7.3)** — its output check
explicitly re-reads the executor's own native MON balance after the trade and
fails if anything but zero remains, since the router is paid via `{value: net}`
and delivers output directly to `to = user`; nothing should ever round-trip
back through the executor.

**If any canary FAILS: STOP.** Do not add a workaround. Do not modify the
contract. Paste the full script output (including the failing PASS/FAIL lines
and the tx hash) back for review.

## Step 8 — Only after ALL SIX canaries PASS

- Record the deployed address, source-verification link, allowlist Safe txs,
  and all six canary tx hashes in `LIVE_CONTRACTS.md` — only after independent
  verification, never before, matching the Gate 4 precedent exactly.
- Leave `MONAD_MAINNET_PAYAI_TRADE_EXECUTOR_V2` unset and
  `PAYAI_TRADE_EXECUTOR_V2_ENABLED` unset/false. Enablement is a separate,
  later decision — not part of Gate 8.
- V1 stays exactly as-is, still serving production Uniswap/Kuru trades, for as
  long as V2 remains disabled.
