# Monad Mainnet deployment

PayAI is live on Monad Mainnet (chain ID `143`) at [usepayai.xyz](https://usepayai.xyz).
This is a record of what's deployed, not a setup guide — see the README for
running the project locally.

**Source of truth for the running app is the env on Vercel**, exposed read-only
at `GET /api/onchain` and `GET /api/automation-config`. Do not copy an address
from a `deployed-*.json` file or from a screenshot. Those are a historical
deploy log; see `contracts/LIVE_CONTRACTS.md`.

## Live contracts (confirmed 2026-09-20 via `/api/onchain` + `/api/automation-config`)

| Contract | Address |
| --- | --- |
| PayAIForwarder (V2) — interactive payments | [`0x8b2c7E8FA09fCd664dbA9764FD63Bf3A4c56464D`](https://monadexplorer.com/address/0x8b2c7E8FA09fCd664dbA9764FD63Bf3A4c56464D) |
| PayAITradeExecutor — interactive trades | [`0xF17a916280321Ddb657c8EDd26B2a729F6E63b69`](https://monadexplorer.com/address/0xF17a916280321Ddb657c8EDd26B2a729F6E63b69) |
| PaymentExecutor (V2) — automations | [`0x5cAf11937aCbaaFd774c3906a5086A7507fae84D`](https://monadexplorer.com/address/0x5cAf11937aCbaaFd774c3906a5086A7507fae84D) |
| AutomationVault (V2) | [`0xc4dEd0939E400f568472bee30C4B123a96F85b35`](https://monadexplorer.com/address/0xc4dEd0939E400f568472bee30C4B123a96F85b35) |
| MerchantRegistry | [`0xadf04A50a2319D8B57245Db2aEB101DAb517AA72`](https://monadexplorer.com/address/0xadf04A50a2319D8B57245Db2aEB101DAb517AA72) |
| Owner / treasury (Safe) | [`0xA282833B52b1B66D58bD2007081dCC037798C0b0`](https://monadexplorer.com/address/0xA282833B52b1B66D58bD2007081dCC037798C0b0) |
| USDC | `0x754704Bc059F8C67012fEd69BC8A327a5aafb603` |
| WMON | `0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A` |

`PaymentExecutor` enforces replay protection (a payment's `requestId` can only
ever settle once) and on-chain per-transaction and daily spend caps for the
agent path — the limits aren't just app-layer checks, the contract itself
refuses to exceed them. Interactive payments route through the forwarder
(`payer → forwarder → recipient`). Interactive Uniswap/Kuru trades route
through the trade executor. Current platform fee: 25 bps on send / wallet
automation / reserved funds; 0 bps on swaps (`GET /api/fees`).

## Operating mode

`PAYAI_MODE=monad` — every payment is a real on-chain transaction, not a
simulation. The app's default (`simulation`) is only for local development,
so a fresh clone doesn't need funds or an agent key to run.

## Signer

Scheduled and recurring payments settle through a dedicated agent wallet,
bounded by the on-chain caps above. Interactive payments never touch it: the
connected wallet signs its own transaction, and PayAI only ever proposes,
never holds a key for those funds.

The agent wallet is a hot wallet by necessity (it signs autonomously), kept
funded minimally and never reused across environments.

The optional Telegram trading bot is a **separate** custodial signer: per-user
keys, encrypted at rest, not the automation agent.

## Redeploying the contracts

If you fork this and want your own deployment:

```bash
cd contracts
MONAD_AGENT_PRIVATE_KEY=<your_key> MONAD_MAINNET_RPC=https://rpc.monad.xyz \
  npx hardhat run scripts/deploy-suite.js --network monad
```

Then point the app at the new addresses via `MONAD_MAINNET_PAYMENT_EXECUTOR`
and `MONAD_MAINNET_MERCHANT_REGISTRY` (see `.env.example`). `getNetwork()`
switches every mainnet/testnet-dependent value automatically from
`MONAD_NETWORK` — no code change needed.

> Mainnet moves real money. Use a fresh, dedicated key for the agent wallet,
> fund it minimally, and never commit it or ship it to a public client.
