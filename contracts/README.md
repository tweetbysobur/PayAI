# PayAI contracts

Solidity sources for PayAI on Monad, built and tested with Hardhat
(solc 0.8.24, optimizer 200 runs). All contracts are MIT-licensed.

**Live addresses: see [`MAINNET.md`](../MAINNET.md)**, or ask the running app
(`GET /api/onchain`, `GET /api/automation-config`). The `deployed-*.json` files
here are a historical deploy log, not the live configuration.

## Contracts

| Contract | Purpose |
| --- | --- |
| `PayAIForwarder(V2)` | Interactive payments: payer → forwarder → recipient in one transaction, fee taken on-chain |
| `PayAITradeExecutor(V2)` | Interactive trades through allowlisted venues (Uniswap v3, Kuru) |
| `PaymentExecutor(V2)` | Automation settlements: replay protection, per-transaction and daily caps |
| `AutomationVault(V2)` | Reserved Funds: per-automation deposits, released only to the recipient or refunded |
| `MerchantRegistry` | Payee directory and per-merchant accounting |
| `SplitSettlement` | Multi-recipient settlement |
| `VeriPayRegistry` | On-chain audit record of a payment's validation decision |
| `PayAIRoomEscrow` | **Unused.** Escrow for the removed Rooms feature; never deployed |

## Commands

```bash
npm install
npx hardhat test       # full suite, including invariant and adversarial tests
npx hardhat compile
```

Deploy scripts live in `scripts/` and expect the deployer key and RPC in the
environment (never in a file). Scripts ending in `-readonly.js` only read
chain state.

## Records

| Document | What it is |
| --- | --- |
| [SECURITY_PROPERTIES.md](SECURITY_PROPERTIES.md) | Invariants and role model the tests enforce |
| [LIVE_CONTRACTS.md](LIVE_CONTRACTS.md) | Deployment and verification history |
| [PRODUCTION_CUTOVER_PLAN.md](PRODUCTION_CUTOVER_PLAN.md), [MERCHANT_REGISTRY_MIGRATION.md](MERCHANT_REGISTRY_MIGRATION.md) | Past migration plans |
| [GATE4_RUNBOOK.md](GATE4_RUNBOOK.md), [GATE8_RUNBOOK.md](GATE8_RUNBOOK.md) | Past trade-executor deployment runbooks |
