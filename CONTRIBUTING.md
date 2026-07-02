# Contributing

Thanks for your interest in PayAI. This is a young project, so the process is
light but real.

## Getting set up

```bash
npm install
cp .env.example .env.local   # runs in simulation mode with no keys
npm run dev                  # http://localhost:3100
```

Out of the box it runs in `simulation` mode — the full pipeline executes but
settlement is mocked, so you don't need a wallet key or an API key to work on
most of the app. See the [README](README.md) for real on-chain setup.

## Before you open a PR

All three of these must pass — CI runs them on every PR:

```bash
npm run typecheck
npm run lint
npm run build
```

For contract changes:

```bash
cd contracts && npx hardhat test
```

## Workflow

- Branch off `main`, make your change, open a pull request against `main`.
- Keep PRs focused — one concern per PR.
- Commit messages follow the pattern already in the log:
  `type: short summary` (e.g. `fix:`, `feat:`, `docs:`, `security:`, `refactor:`).
- Describe *why* in the PR body, not just *what*.

## Reporting issues

Bugs and feature requests: open a GitHub issue. Security issues: see
[SECURITY.md](SECURITY.md) — please don't file those publicly.
