# PayAI

**An autonomous AI payment agent on Monad.**

AI-powered, non-custodial payments — natural language in, on-chain settlement out.

---

## What PayAI is

PayAI is a standalone AI payment platform that lets users send, swap, and schedule crypto payments by describing what they want in plain English. Every payment is validated, risk-scored, and settled on Monad Mainnet — non-custodial, fully traceable, instant.

---

## Architecture

```
User → Natural Language
        │
        ▼
[1] PayAI AI Engine       — understands intent, extracts action/amount/recipient/token
        │
        ▼
[2] Intent Parser         — produces a structured PaymentRequest
        │
        ▼
[3] Validation Engine     — sanctions screening, asset/network support, travel-rule
        │
        ▼
[4] Risk Engine           — weighted 0–100 score (amount, recipient type, purpose)
        │
        ▼
[5] Wallet Signature      — user signs (non-custodial) or agent wallet signs (custodial)
        │
        ▼
[6] Smart Contract        — PaymentExecutor settles + records on-chain in one tx
        │
        ▼
[7] Monad Mainnet         — real settlement, sub-second finality
        │
        ▼
[8] Explorer + Dashboard  — every tx verifiable on Monad Explorer; analytics in-app
```

---

## Features

- **Natural-language payments** — "send 10 USDC to alex.nads" just works
- **MON & USDC support** — native and ERC-20 transfers
- **.nads domain resolution** — human-readable Monad names via Nad Name Service
- **Token swaps** — MON ↔ USDC on-chain, non-custodial
- **Scheduled payments** — recurring and future-dated, bounded by on-chain caps
- **Validation Engine** — address screening, risk scoring, travel-rule checks on every payment
- **Non-custodial** — connected wallet signs its own payments; keys never leave the wallet
- **Custodial agent path** — bounded agent wallet for automated/scheduled execution
- **On-chain audit** — PaymentExecutor records agent, merchant, amount, risk score, compliance result, and idempotency key per transaction
- **Transaction history** — full exportable audit trail
- **Analytics** — volume and trends over time
- **Monad Explorer integration** — verify every tx on-chain

---

## Tech stack

| Layer | Technology |
|---|---|
| App framework | Next.js 15 + TypeScript + Tailwind 4 |
| Wallet / chain | viem + Monad Mainnet (chain ID 143) |
| AI brain | `@anthropic-ai/sdk` · Claude (Opus as primary, Sonnet as fallback) |
| Validation | PayAI Validation Engine (`lib/payment/engine.ts`) |
| Smart contracts | Hardhat · Solidity · PaymentExecutor + MerchantRegistry |
| Domains | Nad Name Service (nad.domains) |

---

## Environment variables

```bash
# Intent engine
ANTHROPIC_API_KEY=            # Claude API key (optional — deterministic fallback if unset)
VERIPAYAI_MODEL=claude-opus-4-8

# Agent guardrails
VERIPAYAI_MAX_AMOUNT=1000
VERIPAYAI_DEFAULT_NETWORK=monad

# Execution mode
PAYAI_MODE=simulation         # "simulation" (default) | "monad" (real on-chain)

# Monad RPC
MONAD_NETWORK=mainnet
MONAD_MAINNET_RPC=https://rpc.monad.xyz
MONAD_TESTNET_RPC=https://testnet-rpc.monad.xyz

# Agent wallet (server-only, custodial path)
MONAD_AGENT_PRIVATE_KEY=

# Stablecoins
MONAD_MAINNET_USDC=0x...
MONAD_TESTNET_USDC=0xaC0893567D43C3E7e6e35a72803df05416C1f20D
MONAD_USDC_DECIMALS=6

# Smart contracts
MONAD_MAINNET_PAYMENT_EXECUTOR=0x...
MONAD_MAINNET_MERCHANT_REGISTRY=0x...

# API security (required when PAYAI_MODE=monad)
VERIPAYAI_API_KEY=

# Validation engine tuning
PAYAI_TRAVEL_RULE_THRESHOLD=250
PAYAI_DENYLIST=sanctioned,blocked,ofac
PAYAI_ADDRESS_DENYLIST=
```

---

## Smart contracts

| Contract | Network | Address |
|---|---|---|
| PaymentExecutor | Monad Mainnet | See `MONAD_MAINNET_PAYMENT_EXECUTOR` |
| MerchantRegistry | Monad Mainnet | See `MONAD_MAINNET_MERCHANT_REGISTRY` |

Deploy with:

```bash
cd contracts
npx hardhat run scripts/deploy-suite.js --network monad
```

---

## Development setup

```bash
cp .env.example .env.local   # fill in ANTHROPIC_API_KEY + MONAD_AGENT_PRIVATE_KEY
npm install
npm run dev                  # http://localhost:3100
```

Set `PAYAI_MODE=monad` and provide `MONAD_AGENT_PRIVATE_KEY` to enable real on-chain execution. Without it, all payments run in simulation mode (offline-safe, no funds move).

---

## Project structure

```
lib/
├── agent/          — AI brain: intent parsing, guardrails, confidence scoring
├── payment/        — Validation Engine, Risk Engine, execution providers
│   ├── engine.ts   — runValidation(), assessRisk(), execute(), checkPaymentEngine()
│   └── types.ts    — PaymentRequest, ComplianceResult, RiskAssessment, TransactionResult
├── monad/          — chain config, wallet, executor, contracts, swap, domains
├── payees/         — static payee directory
├── platform/       — auth, tenant, store, analytics, idempotency, schedules
├── hooks/          — React hooks (useAgentConsole, useWalletBalances, etc.)
└── wallet/         — browser wallet connection (EIP-1193)
app/
├── api/            — Next.js API routes
│   ├── agent/      — POST /api/agent (main pipeline), /confirm (wallet settlement)
│   ├── health/     — GET /api/health
│   └── ...
├── dashboard/      — authenticated dashboard pages
└── page.tsx        — public landing page
contracts/          — Hardhat + Solidity smart contracts
```

---

*PayAI · AI-powered payments, settled on Monad Mainnet*
