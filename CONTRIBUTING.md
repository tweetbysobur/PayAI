# Contributing

Thanks for your interest in PayAI. Contributions of all sizes are welcome — bug
reports, fixes, tests, docs and features.

## Getting set up

```bash
npm install
cp .env.example .env.local   # runs in simulation mode with no keys
npm run dev                  # http://localhost:3100
```

Out of the box it runs in `simulation` mode — the full pipeline executes but
settlement is mocked, so you don't need a wallet key or an API key to work on
most of the app. See the [README](README.md#configuration) for real on-chain
setup.

## Before you open a pull request

CI runs all of these on every pull request; please run them locally first:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

For contract changes:

```bash
cd contracts && npm install && npx hardhat test
```

## Ground rules

PayAI moves real money, so a few things are non-negotiable:

- **Nothing executes without the user's approval.** New flows go through the
  existing review → approve → sign path; never add a second execution path.
- **Never show invented data.** No mock balances, sample transactions or made-up
  numbers in the product — empty states say so.
- **A wallet only sees its own data.** Keep reads scoped to the signed-in
  wallet.
- **No secrets in the repo.** Keys and tokens live only in the deployment's
  environment; `.env.local` is gitignored.
- **Tests come with behaviour changes**, especially anything touching fees,
  amounts, signing or recipients.

## Workflow

- Branch off `main`, make your change, open a pull request against `main`.
- Keep pull requests focused — one concern per pull request.
- Write commit messages that say what changed and why
  (e.g. `fix: round displayed totals up, never down`).
- Describe the *why* in the pull request body, and how you tested it.

## Reporting issues

Bugs and feature requests: open a GitHub issue using the templates.
Security issues: see [SECURITY.md](SECURITY.md) — please don't file those
publicly.
