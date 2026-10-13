# PayAI — Architecture & Decisions

PayAI is a standalone, non-custodial AI payment platform built on Monad Mainnet.
A user describes a payment in plain English; PayAI parses the intent, validates and
risk-scores it, has the user's own wallet sign it, and settles it on-chain through
PayAI's smart contracts. Every module below belongs to PayAI and runs entirely
in-house.

## Core principles

1. **Non-custodial.** Every transaction is signed by the user's own wallet. PayAI never
   holds keys for user funds and never asks for a seed phrase.
2. **Self-contained.** Intent parsing, validation, risk scoring, execution, settlement,
   analytics, and notifications are all internal PayAI engines. There are no external
services, third-party orchestration layers, or dependencies on any other project.
3. **Verifiable.** Every settled payment is a real on-chain transaction, anchored by
   PayAI's contracts and viewable on the Monad explorer.

## Pipeline

```
User
  │  natural language
  ▼
PayAI AI Engine ─────────► Intent Parser
                               │
                               ▼
                         Validation Engine   (recipient, token, amount, balance, network)
                               │
                               ▼
                          Risk Engine        (limits, security checks, 0–100 score)
                               │
                               ▼
                        Wallet Signature      (user signs in their own wallet)
                               │
                               ▼
                        Execution Engine      (prepares the transaction)
                               │
                               ▼
                       Settlement Engine ───► Smart Contract ───► Monad Mainnet
                               │                                       │
                               ▼                                       ▼
                       Analytics Engine  ◄──────────────────────  Explorer
                               │
                               ▼
                     Notification Engine  ───►  Dashboard
```

## Internal engines

| Engine | Responsibility | Code |
| --- | --- | --- |
| **Intent Engine** | Understands natural-language payment instructions. | `lib/agent/` |
| **Validation Engine** | Validates recipient, token, amount, balances, and network. | `lib/payment/engine.ts` (`runValidation`) |
| **Risk Engine** | Applies payment limits and security checks; produces a 0–100 score. | `lib/payment/engine.ts` (`assessRisk`) |
| **Execution Engine** | Prepares the transaction and drives wallet interaction. | `lib/payment/engine.ts` (`execute`) + `lib/monad/` |
| **Settlement Engine** | Broadcasts and confirms transactions on Monad Mainnet. | `lib/monad/` + `contracts/` |
| **Analytics Engine** | Indexes payments, transaction history, and user statistics. | `lib/platform/analytics.ts` |
| **Notification Engine** | Surfaces confirmations and payment updates. | `lib/hooks/useNotifications.ts` |

## Stack

- **Next.js (App Router) + TypeScript + Tailwind** — app, dashboard, and API routes.
- **viem** — Monad wallet abstraction, transaction building, and settlement.
- **Anthropic language model** — optional fallback for the intent engine (natural-language → structured payment).
- **Solidity (Monad Mainnet)** — `PaymentExecutor` + registry contracts for on-chain
  settlement, idempotent execution, and per-tx/daily/merchant spend limits.

## Execution modes

PayAI runs in one of two modes, controlled by `PAYAI_MODE`:

- `simulation` — deterministic, offline-safe simulation of settlement (no funds move).
  Useful for local development and demos.
- `monad` — real on-chain settlement on Monad Mainnet through PayAI's smart contracts.

## Layout

```
PayAI/
├── app/
│   ├── api/
│   │   ├── agent/route.ts        # entrypoint: intent → validate → risk → execute
│   │   ├── health/route.ts       # engine + network status
│   │   └── ...
│   ├── dashboard/                # payments, transactions, analytics, compliance, wallets
│   ├── page.tsx                  # landing page
│   └── layout.tsx
├── lib/
│   ├── agent/                    # Intent Engine (parsing + decision loop)
│   ├── payment/                  # Validation, Risk, Execution engines + payment types
│   ├── monad/                    # viem settlement, contracts, config
│   └── platform/                 # analytics, store, auth, idempotency
├── contracts/                    # PaymentExecutor + registry (Solidity)
├── docs/
└── README.md
```
