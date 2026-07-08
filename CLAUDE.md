# CLAUDE.md

Context for AI assistants and contributors working in this repo.

## What this is

**PayAI** — a standalone, non-custodial AI payment platform, live on **Monad
Mainnet** at **https://usepayai.xyz**. Users describe a payment in plain English
("send 10 USDC to alex.nads"); PayAI parses it, validates and risk-scores it,
and the user's own wallet signs it. Fully self-contained — no external services.

## Commands

```bash
npm run dev         # local dev on http://localhost:3100 (simulation mode)
npm run typecheck   # tsc --noEmit
npm test            # vitest run (unit tests in test/)
npm run build       # next build
```

Contracts: `cd contracts && npx hardhat test`.
CI (`.github/workflows/ci.yml`) runs typecheck + test + build on every push/PR.

> `npm run lint` is currently broken by a pre-existing Next 16 + ESLint 9
> FlatCompat config bug (not a code issue). The build is the real gate.

## Architecture

```
lib/agent/      Intent engine — plain-English → structured PaymentRequest
lib/payment/    engine.ts: runValidation(), assessRisk(), execute(); + types
lib/monad/      chain config, wallet, contracts, swap, .nads resolution
lib/platform/   auth, tenancy, store, analytics, idempotency, automations
app/            App Router — dashboard/, api/, landing page
contracts/      PaymentExecutor + MerchantRegistry (Solidity, Hardhat)
```

Execution mode is `PAYAI_MODE`: `simulation` (default, mocked settlement, no
funds move — safe for local dev) or `monad` (real on-chain). Production runs
`monad`.

## Conventions & guardrails

- **Non-custodial.** Interactive payments are signed by the user's wallet.
  Only Payment Automations use the capped server agent wallet. Never claim
  blanket "non-custodial" without that nuance.
- **No fabricated data.** Never show mock balances, fake stats, or another
  user's data on public surfaces. Empty states use "—", never invented numbers.
- **Privacy.** A connected user only sees their own history/analytics
  (`listTx(merchantId, { sender })`). Don't widen that scope.
- **Brand color is purple `#7C3AED`** (`--primary: 262 83% 58%`). Not cyan.
- **Secrets** live only in the deploy host's env. Never commit `.env.local`.
  `VERIPAYAI_*` / `MONAD_*` env var names are load-bearing — don't rename
  casually (they're set in Vercel).

## Deploy

`npx vercel deploy --prod --yes`. DNS to vercel.com is flaky in some
environments — wrap deploys in a retry loop. Pushing to `main` also triggers a
Vercel build via the git integration. The public URL comes from
`VERIPAYAI_PUBLIC_URL`.
