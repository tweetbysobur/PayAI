<div align="center">

<img src="public/payai-logo.svg" width="88" height="88" alt="PayAI logo" />

# PayAI

**Turn natural language intent into onchain execution.**

[![CI](https://github.com/tweetbysobur/PayAI/actions/workflows/ci.yml/badge.svg)](https://github.com/tweetbysobur/PayAI/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-7C3AED.svg)](LICENSE)
[![Network: Monad Mainnet](https://img.shields.io/badge/network-Monad%20Mainnet-7C3AED.svg)](https://monad.xyz)

[Live app](https://usepayai.xyz) · [Docs](https://docs.usepayai.xyz) · [Security](SECURITY.md) · [Support](mailto:support@usepayai.xyz)

</div>

---

PayAI lets you describe what you want done on Monad in plain English — *"send 10 USDC
to alice.nad"*, *"swap 10 MON to USDC and send it to bob.nad"*, *"pay the team every
Friday"* — and turns it into a plan you can review, approve and sign with your own wallet.
Nothing moves until you approve it, and every settled action ends with a real transaction
hash on Monad Mainnet.

## Contents

- [Features](#features)
- [How it works](#how-it-works)
- [Custody model](#custody-model)
- [Getting started](#getting-started)
- [Configuration](#configuration)
- [Smart contracts](#smart-contracts)
- [Project structure](#project-structure)
- [Testing](#testing)
- [Status](#status)
- [Contributing](#contributing) · [Security](#security) · [License](#license)

## Features

**Ask PayAI** — one chat box for everything:

- **Payments** — send MON or USDC to a `0x` address, a `.nad` name or a saved payee; pay
  several people at once (*"send 5 USDC each to alice.nad and bob.nad"*).
- **Trading** — swap, buy or sell any Monad token by symbol or contract address, routed
  through Uniswap v3, Kuru or Nad.Fun with a live quote, slippage protection and an
  on-chain minimum received.
- **Plans** — several actions in one request (*"swap 10 MON to USDC and send it to
  bob.nad"*), reviewed together and run in order on **one approval**.
- **Schedules** — future-dated and recurring payments become Payment Automations.
- **Visual intent** — attach a payment QR code (or, with an LLM key configured, an invoice
  screenshot); PayAI reads it into a request you still review and approve.
- **Questions** — balances, history and token information, answered from your own wallet.

**Dashboard** — Send, Payment Automations (Wallet Automation or Reserved Funds), bulk
distributions, transaction history with explorer links, saved recipients, wallet
intelligence and notifications.

**Wallets** — a self-custody PayAI Wallet derived from a passkey (no seed phrase, no
extension, powered by [Mera](https://github.com/category-labs/mera)), or any external
wallet over EIP-6963 / EIP-1193. Optional Google, X and email sign-in.

## How it works

```
"swap 10 MON to USDC and send it to bob.nad"
        │
        ▼
  Understanding     intent → structured plan (deterministic grammar first; an
        │           optional LLM only for phrasing the grammar can't read)
        ▼
  Validation        recipients resolved (.nad → address), assets and amounts
        │           checked, sanctions screening, risk score
        ▼
  Review            every action, amount, fee and full recipient address shown
        │
        ▼
  Approval          one approval for the plan; your wallet signs
        │
        ▼
  Execution         PayAI contracts on Monad Mainnet; each step confirmed
        │           on-chain before the next runs
        ▼
  Receipt           amounts, fees and the transaction hash, verified from the receipt
```

Every stage is TypeScript in this repository — parsing, validation, risk, execution and
verification live under `lib/`, not in a third-party service.

## Custody model

- **Interactive actions are non-custodial.** Payments, trades and plans you start are
  signed by your own wallet. A PayAI Wallet's key is derived in your browser from your
  passkey and never reaches PayAI's servers; it can be exported at any time.
- **Payment Automations** settle through a server agent wallet, because nobody is present
  to sign each run. It is bounded on-chain by per-transaction and daily caps; Reserved
  Funds automations draw only from a per-automation vault deposit that can go nowhere but
  the committed recipient or back to you.
- **The optional Telegram bot is custodial** — it holds an encrypted hot wallet per user,
  and says so on `/start`.

See [SECURITY.md](SECURITY.md) for the full model.

## Getting started

Requirements: Node.js 20+ and npm.

```bash
git clone https://github.com/tweetbysobur/PayAI.git
cd PayAI
npm install
cp .env.example .env.local
npm run dev            # http://localhost:3100
```

Out of the box the app runs in **simulation mode**: the whole pipeline runs, but
settlement is mocked, so no funds move and no keys are needed.

## Configuration

All settings are environment variables; [`.env.example`](.env.example) documents every
one. The essentials for real on-chain settlement:

```bash
PAYAI_MODE=monad                       # real settlement instead of simulation
MONAD_NETWORK=mainnet
MONAD_MAINNET_RPC=https://rpc.monad.xyz
MONAD_AGENT_PRIVATE_KEY=0x...          # server-only signer for automations — never commit
MONAD_MAINNET_USDC=0x...
MONAD_MAINNET_PAYMENT_EXECUTOR=0x...
MONAD_MAINNET_MERCHANT_REGISTRY=0x...
MONAD_MAINNET_AUTOMATION_VAULT=0x...
AUTH_SESSION_SECRET=...                # signs session and wallet-grant cookies
```

Optional: `ANTHROPIC_API_KEY` (LLM fallback for unusual phrasing and image reading —
without it the deterministic parser handles everything it can), Upstash Redis
(`KV_REST_API_URL` / `KV_REST_API_TOKEN`) for persistence (in-memory otherwise), and
per-provider sign-in credentials. A method that
isn't configured is simply not offered.

## Smart contracts

Solidity contracts under [`contracts/`](contracts), built and tested with Hardhat:

| Contract | Role |
| --- | --- |
| `PayAIForwarder` | Interactive payments: `payer → forwarder → recipient` in one transaction, with the fee taken on-chain |
| `PayAITradeExecutor` | Interactive trades through allowlisted venues only |
| `PaymentExecutor` | Automation settlements with replay protection and on-chain spend caps |
| `AutomationVault` | Reserved Funds: per-automation deposits, releasable only to the recipient or back to the depositor |
| `MerchantRegistry` | Payee directory and per-merchant accounting |
| `SplitSettlement` | Multi-recipient settlement |

Live addresses are listed in [MAINNET.md](MAINNET.md) and served by the running app at
`/api/onchain` and `/api/automation-config`, and the deployed contracts are verified on the
Monad explorer. See [`contracts/README.md`](contracts/README.md) for the full layout.

```bash
cd contracts
npm install
npx hardhat test
```

## Project structure

```
app/                 Next.js App Router
  api/               route handlers (Ask, plans, payments, automations, wallets, …)
  dashboard/         the signed-in app
  docs/              docs.usepayai.xyz
components/          React components (ask/, dashboard/, landing/, receipt/, …)
lib/
  ask/               Ask PayAI: understanding, plans, chat state, visual intent
  plan/ plan-*/      intent graph, plan API and the plan runner
  sdk/               typed protocol actions (transfer, swap, wrap, split)
  payment/           validation, risk, sanctions, fees, execution
  monad/             chain config, contracts, trading venues, .nad resolution
  automation/        automation execution and templates
  wallet-service/    wallet abstraction (passkey PayAI Wallet or external wallet)
  platform/          storage, tenancy, idempotency, analytics, events
contracts/           Solidity contracts, Hardhat tests and deploy scripts
test/                Vitest unit and integration tests
docs/                design and architecture notes
```

## Testing

```bash
npm run typecheck    # TypeScript
npm run lint         # ESLint
npm test             # Vitest (≈3,800 tests)
npm run build        # production build
```

CI runs all four, plus the contract test suite, on every pull request.

## Status

Live on Monad Mainnet and settling real payments. Honest open edges:

- Sanctions screening covers the OFAC SDN address list plus a configurable denylist; it is
  not a licensed KYC/AML programme.
- The contracts went through the DeltaV × Ultrafuzz protocol review; a full commercial
  audit is on the roadmap.
- The Telegram bot is a custodial exception to the non-custodial web app.

Changes are recorded in [CHANGELOG.md](CHANGELOG.md).

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

Please report vulnerabilities privately to **security@usepayai.xyz** — see
[SECURITY.md](SECURITY.md). Do not open public issues for anything exploitable.

## License

[MIT](LICENSE)
