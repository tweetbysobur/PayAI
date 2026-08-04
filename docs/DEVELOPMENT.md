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
Vercel build via the git integration (Vercel project `veripayai`, scope
`omnichatdev`). The public URL comes from `VERIPAYAI_PUBLIC_URL`.

> The git integration is worth sanity-checking when a merge doesn't appear on
> `usepayai.xyz`. It was disconnected for a stretch in Aug 2026, during which
> pushes to `main` landed in GitHub and silently never built — production
> served a days-old deployment while `main` moved on, with nothing surfaced as
> an error anywhere. Vercel → project → Settings → Git shows the current state;
> the tell that it's live is a Vercel check appearing on new PRs.
>
> Some sandboxes (including Claude Code's) cannot reach `api.vercel.com` at all,
> so a deploy or a deployment-status check may be impossible from there rather
> than merely flaky. `deployment_status` events are enabled on the repo, so
> GitHub's deployments API is a usable fallback for confirming a deploy landed.
