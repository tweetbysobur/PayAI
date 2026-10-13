# CLAUDE.md

Context for AI assistants and contributors working in this repo.

## What this is

**PayAI** — a standalone, non-custodial AI payment platform, live on **Monad
Mainnet** at **https://usepayai.xyz**. Users describe a payment in plain English
("send 10 USDC to a .nad domain"); PayAI parses it, validates and risk-scores it,
and the user's own wallet signs it. Fully self-contained — no external services.

## Commands

```bash
npm run dev         # local dev on http://localhost:3100 (simulation mode)
npm run typecheck   # tsc --noEmit
npm test            # vitest run (unit tests in test/)
npm run build       # next build
```

Contracts: `cd contracts && npx hardhat test`.
CI (`.github/workflows/ci.yml`) runs typecheck + **lint** + test + build on
every push to `main` and every PR targeting it — note it does NOT run on other
branches, so a feature branch only gets checked once its PR is open. CI uses
Node 20; `@category-labs/mera` asks for Node 24 in `engines`, but works on 20
(it needs `Symbol.dispose`, present since 20.11) and the full sequence has been
verified there.

> The lint step passes as of Aug 2026 — the older note here about `npm run lint`
> being broken by a Next 16 + ESLint 9 FlatCompat bug is out of date. Lint is a
> real gate again (0 errors; warnings don't fail the build).

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

> **Never answer "what contract is live" from `contracts/deployed-*.json`.**
> Those are a historical deploy log (five separate deploys as of Aug 2026,
> none of which match production) — the app reads
> `MONAD_MAINNET_PAYMENT_EXECUTOR` / `_MERCHANT_REGISTRY` / `_AUTOMATION_VAULT`
> from Vercel's env directly, which is not guaranteed to match any JSON file
> here. To get the real live addresses, hit `GET /api/onchain` and
> `GET /api/automation-config` on the running app (or have someone who can
> reach it paste back the JSON) — see `contracts/LIVE_CONTRACTS.md`.

> **Rooms were removed from the product (Oct 2026).** No nav entry, no pages
> (`/dashboard/rooms`, `/rooms`, `/r/*` redirect), Ask PayAI declines room
> requests (`ROOMS_REMOVED_REPLY`), and `/api/rooms/**` answers 410
> (`lib/rooms/removed.ts`). The backend (`lib/rooms`, the escrow contract and
> SDK actions) is kept dormant so it could be restored deliberately.
>
> **Escrow Rooms are built but OFF.** `PayAIRoomEscrow.sol` is written and
> Hardhat-tested but **not deployed or audited**; the app enables escrow Rooms
> only when `MONAD_MAINNET_ROOM_ESCROW` + `PAYAI_ROOM_ESCROW_ENABLED=true` are
> set. Never describe Rooms as escrow-backed in production until that happens —
> see `docs/rooms/ESCROW_ROOMS.md` for semantics, fees and the switch-on list.

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

Production is hosted on Vercel; pushes to `main` deploy through the Vercel git
integration, and `npx vercel deploy --prod --yes` deploys by hand. Secrets and
the live contract addresses are set in the host's environment, never in the
repo. If a merge doesn't appear on `usepayai.xyz`, check the git integration
first (Vercel → project → Settings → Git); GitHub's deployments API also
reports whether a deploy landed.
