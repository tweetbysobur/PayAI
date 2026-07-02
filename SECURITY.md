# Security

## Reporting a vulnerability

If you find a security issue, please email **buharisobur22@gmail.com** with details
and steps to reproduce. Do not open a public issue for anything exploitable.
We aim to acknowledge within 48 hours.

## Model

PayAI is non-custodial for interactive payments: the connected wallet signs its
own transactions, and the app never holds a key for user funds or asks for a
seed phrase. The app only ever *proposes* a transaction; nothing moves without
the user's own signature.

Scheduled and recurring payments are the one exception. Because the user isn't
present to sign each run, they settle through a dedicated agent wallet that is
bounded on-chain by per-transaction and daily spend caps enforced in the
`PaymentExecutor` contract — not just in application code. The agent can never
exceed those caps or touch anything the user didn't schedule. This key is
server-side only, kept funded minimally, and never shipped to the client.

## Contract safeguards

- **Replay protection** — each payment carries a `requestId` the contract marks
  as used, so a retried or duplicated call can never settle twice.
- **Spend caps** — per-transaction and daily limits are enforced on-chain.
- **Idempotency** — the application layer also de-duplicates in-flight requests
  (`lib/platform/idempotency.ts`) as a first line of defense.

## Secrets

No secrets are committed to this repository, at any point in its history. The
agent private key and API keys live only in the deployment host's environment
(`.env.local` is gitignored; only `.env.example`, a template, is tracked).

## Disclosure note

Several tenancy and data-exposure issues were found and fixed during
pre-launch hardening (see the git history for the `security:` and privacy
commits). These were caught before the public launch; no user funds or private
keys were ever at risk, as the app has always been non-custodial by design.
