# Monad Mainnet cutover — VeriPAY AI

Testnet (chain 10143) is fully deployed and verified. Mainnet (chain 143) is
**code-ready** — the config, Hardhat network, and deploy scripts all support it.
The remaining steps require **real funds** and a **real USDC address**, so they
are done by you (they cannot be automated safely).

> ⚠️ Mainnet moves real money. The agent signs autonomously, so the signer is a
> hot wallet. Use a **fresh, dedicated key**, fund it minimally, and never reuse
> the testnet key. Do **not** put the mainnet key in a public deployment without
> an auth gate on `/api/agent`.

## 1. Create a fresh mainnet agent wallet
```bash
node -e "const {generatePrivateKey,privateKeyToAccount}=require('viem/accounts');const pk=generatePrivateKey();console.log('PK',pk);console.log('ADDR',privateKeyToAccount(pk).address)"
```
Store the PK in a secret manager. Fund the address with a small amount of real
**MON** (for gas) and the **USDC** you intend to pay with.

## 2. Get the canonical Monad-mainnet USDC address
Confirm the official USDC (or your chosen stablecoin) contract on Monad mainnet,
and its decimals (USDC is usually 6).

## 3. Deploy the suite to mainnet
```bash
cd contracts
MONAD_AGENT_PRIVATE_KEY=<mainnet_pk> MONAD_MAINNET_RPC=https://rpc.monad.xyz \
  npx hardhat run scripts/deploy-suite.js --network monad
# → prints MerchantRegistry + PaymentExecutor mainnet addresses (deployed-suite.json)
```

## 4. Point the app at mainnet
In `.env.local` (and your host's env):
```
MONAD_NETWORK=mainnet
MONAD_MAINNET_RPC=https://rpc.monad.xyz
MONAD_MAINNET_USDC=<real_usdc_address>
MONAD_MAINNET_PAYMENT_EXECUTOR=<from step 3>
MONAD_MAINNET_MERCHANT_REGISTRY=<from step 3>
MONAD_AGENT_PRIVATE_KEY=<mainnet_pk>     # server-only; NEVER commit / NEVER ship to a public client
PAYAI_MODE=monad
```
`getNetwork()` switches `getChain()`, `getStablecoin()`, `getPaymentExecutor()`,
and `getMerchantRegistry()` to the mainnet values automatically — no code change.

## 5. Lower the guardrail cap for first live runs
```
VERIPAYAI_MAX_AMOUNT=25
```
Start small, confirm a real settlement on the mainnet explorer, then raise it.

## Checklist
- [ ] Fresh mainnet key created + stored securely
- [ ] Wallet funded with MON (gas) + USDC
- [ ] Canonical mainnet USDC address confirmed
- [ ] Suite deployed to `--network monad`
- [ ] `.env` switched to mainnet values
- [ ] Auth gate on `/api/agent` if the signer is on a public deployment
- [ ] First small live payment verified on the explorer
