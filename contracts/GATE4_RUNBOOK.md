# Gate 4 runbook — PayAITradeExecutor deploy + verify + canaries

This is executed on a **Monad-connected machine with the deployer key** (the
sandbox has no signing key and no Monad RPC egress — same as the forwarder in
Step 8.3). Do everything from `contracts/`. **Do NOT** set
`MONAD_MAINNET_PAYAI_TRADE_EXECUTOR` or `PAYAI_TRADE_EXECUTOR_ENABLED` until all
four canaries pass.

## Confirmed parameters

| Param | Value |
|---|---|
| owner (Safe) | `0xA282833B52b1B66D58bD2007081dCC037798C0b0` |
| treasury | `0xA282833B52b1B66D58bD2007081dCC037798C0b0` (the Safe) |
| feeBps | `25` (0.25%) |
| uniswapRouter (SwapRouter02) | `0xfe31f71c1b106eac32f1a19239c9a9a72ddfb900` |
| wmon | `0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A` |
| initial Kuru allowlist | `0x065C9d28E428A0db40191a54d33d5b7c71a9C394` (MON/USDC) |
| Nad.Fun | NOT included |

`contracts/.env` needs `MONAD_AGENT_PRIVATE_KEY` (funded deployer for deploy;
for canaries this is the USER wallet — small MON for gas + a little USDC).

## Step 1 — Deploy (owner = Safe from block zero)

```
npx hardhat run scripts/deploy-payai-trade-executor.js --network monad
```
Record the printed `PayAITradeExecutor` address and deploy tx. The script reads
the config straight back and flags any mismatch.

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
config). If Sourcify DNS flakes: `NODE_OPTIONS="--dns-result-order=ipv4first"`.

## Step 3 — Read-only config check

```
PAYAI_TRADE_EXECUTOR_ADDRESS=<ADDRESS> \
  npx hardhat run scripts/check-trade-executor-config-readonly.js --network monad
```
Expect PASS on owner/treasury/feeBps/paused/router/wmon/MAX_FEE_BPS. The Kuru
allowlist line will be FALSE until Step 4.

## Step 4 — Seed the Kuru allowlist (ONE Safe transaction)

Because owner = Safe, only the Safe can call `setKuruMarket`. In the Safe
(Transaction Builder → custom / raw), send:

- **To:** `<PayAITradeExecutor address>`
- **Value:** `0`
- **Data:** `0x055766c7000000000000000000000000065c9d28e428a0db40191a54d33d5b7c71a9c3940000000000000000000000000000000000000000000000000000000000000001`

(That is `setKuruMarket(0x065C9d28…C394, true)`.) After it confirms, re-run
Step 3 — the Kuru allowlist line must now be PASS.

## Step 5 — Canaries (tiny real trades, signed by the USER wallet)

Uniswap canaries need no allowlist and can run right after Step 3. Kuru canaries
need Step 4 done.

```
# Uniswap ERC-20 -> ERC-20 (USDC -> WMON)
PAYAI_TRADE_EXECUTOR_ADDRESS=<ADDRESS> DIRECTION=erc20-erc20 \
  npx hardhat run scripts/canary-uniswap-mainnet.js --network monad

# Uniswap ERC-20 -> native MON (USDC -> MON)
PAYAI_TRADE_EXECUTOR_ADDRESS=<ADDRESS> DIRECTION=erc20-native \
  npx hardhat run scripts/canary-uniswap-mainnet.js --network monad

# Kuru native MON -> ERC-20 (MON -> USDC)
PAYAI_TRADE_EXECUTOR_ADDRESS=<ADDRESS> DIRECTION=native-erc20 \
  npx hardhat run scripts/canary-kuru-mainnet.js --network monad

# Kuru ERC-20 -> native MON (USDC -> MON)
PAYAI_TRADE_EXECUTOR_ADDRESS=<ADDRESS> DIRECTION=erc20-native \
  npx hardhat run scripts/canary-kuru-mainnet.js --network monad
```

Each script quotes/sizes from the **post-fee net** (exactly as the contract
swaps), executes, decodes `TradeExecuted`, and prints PASS/FAIL for every
required check: trade success, user==signer, event exists, venue, tokenIn,
tokenOut, amountIn, amountOut≥minOut, 0.25% fee, treasury received the fee, user
received the output, executor retains zero (USDC/WMON/native), no leftover
allowances, and that the tx interacted with the executor. Native legs account
for gas when checking the user's native delta.

**Paste the full output + tx hash of each canary back** so it can be verified
independently against the on-chain logs.

## Step 6 — Only after all four canaries PASS

- Record the deployed address + canary tx hashes in `LIVE_CONTRACTS.md`
  (only after independent verification — never before).
- Leave `PAYAI_TRADE_EXECUTOR_ENABLED` **unset/false**. Enablement is a separate,
  later decision — not part of Gate 4.

If any canary FAILS: stop, paste the output. No workarounds, no production
changes without approval.
