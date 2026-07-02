# Monad Mainnet deployment

PayAI is live on Monad Mainnet (chain ID `143`) at [usepayai.xyz](https://usepayai.xyz).
This is a record of what's deployed, not a setup guide — see the README for
running the project locally.

## Deployed contracts

| Contract | Address | Deployed |
| --- | --- | --- |
| PaymentExecutor | [`0x2919eAbb…085da`](https://monadexplorer.com/address/0x2919eAbbef3A56d9975821031e2C2764BBB085da) | 2026-06-24 |
| MerchantRegistry | [`0x89A42a8d…dA439`](https://monadexplorer.com/address/0x89A42a8dCcB6219b068E636ad9953d5488cDa439) | 2026-06-24 |

Both are verified on the Monad explorer. `PaymentExecutor` enforces replay
protection (a payment's `requestId` can only ever settle once) and on-chain
per-transaction and daily spend caps for the agent path — the limits aren't
just app-layer checks, the contract itself refuses to exceed them.

## Operating mode

`PAYAI_MODE=monad` — every payment is a real on-chain transaction, not a
simulation. The app's default (`simulation`) is only for local development,
so a fresh clone doesn't need funds or an agent key to run.

## Signer

Scheduled and recurring payments settle through a dedicated agent wallet,
bounded by the on-chain caps above. Interactive payments never touch it: the
connected wallet signs its own transaction, and PayAI only ever proposes,
never holds a key for user funds.

The agent wallet is a hot wallet by necessity (it signs autonomously), kept
funded minimally and never reused across environments.

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
