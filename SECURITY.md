# Security

## Reporting a vulnerability

If you find a security issue, please email **security@usepayai.xyz** with details
and steps to reproduce. Do not open a public issue for anything exploitable.
We aim to acknowledge within 48 hours.

## Model

PayAI is non-custodial for **interactive** payments and trades: the connected
wallet signs its own transactions, and the app never asks for a seed phrase.
The app only ever *proposes* a transaction; nothing moves without the user's
own signature.

Two exceptions, named rather than implied away:

1. **Payment Automations.** Because the user isn't present to sign each run,
   they settle through a dedicated agent wallet bounded on-chain by
   per-transaction and daily spend caps in `PaymentExecutor` — not just in
   application code. The agent can never exceed those caps or touch anything
   the user didn't schedule. This key is server-side only, kept funded
   minimally, and never shipped to the client.

2. **Telegram trading bot.** Optional. PayAI generates a hot wallet per
   Telegram user and stores the private key encrypted at rest
   (`TELEGRAM_WALLET_MASTER_KEY`, AES-256-GCM) so `/buy` / `/sell` /
   `/withdraw` can sign from chat. That path is custodial. `/start` discloses
   this every time. Webhook deliveries fail closed without
   `TELEGRAM_WEBHOOK_SECRET`.

## Independent review

In August 2026 the contracts completed the **DeltaV × Ultrafuzz** protocol
security program. No critical fund-drain finding. Medium and low findings
(fee-on-transfer accounting, sender-surcharge vault drain, native request
lifecycle, registrar privilege) were patched and redeployed. Ultrafuzz is an
independent protocol review, **not** a full commercial audit of the
application. A formal third-party audit remains on the roadmap.

## Contract safeguards

- **Replay protection** — each payment carries a `requestId` the contract marks
  as used, so a retried or duplicated call can never settle twice.
- **Spend caps** — per-transaction and daily limits are enforced on-chain.
- **Idempotency** — the application layer also de-duplicates in-flight requests
  (`lib/platform/idempotency.ts`) as a first line of defense.
- **Typed trades** — interactive swaps go through `PayAITradeExecutor` with
  allowlisted venues, not arbitrary target/calldata.

## Sanctions screening

Every resolved recipient address is screened before a payment is approved
(`lib/payment/sanctions.ts`). Two layers apply:

- An always-on env denylist (`PAYAI_ADDRESS_DENYLIST`), available at cold start.
- The **OFAC SDN** sanctioned digital-currency address list, fetched from a
  public source and cached in memory (override with `PAYAI_SANCTIONS_LIST_URL`,
  or set it empty to disable the remote list). The check itself is synchronous
  so validation stays fast; the list refreshes out-of-band.

The screen is **fail-safe**: if the remote list can't be fetched, the
last-known-good set (plus the env denylist) still applies — an outage never
silently disables screening, and never blocks every payment. This is address
screening against the real OFAC list, not a full licensed KYC/AML programme;
that remains on the roadmap.

## Secrets

No secrets are committed to this repository, at any point in its history. The
agent private key, Telegram master key, and API keys live only in the
deployment host's environment (`.env.local` is gitignored; only `.env.example`,
a template, is tracked).

## Source

The application repository is private. Deployed contracts are verified on the
Monad explorer. Public pages must not claim the full source is public.

## Disclosure note

Several tenancy and data-exposure issues were found and fixed during
pre-launch hardening (see the git history for the `security:` and privacy
commits). These were caught before the public launch; no user funds or private
keys from the interactive (non-custodial) path were at risk.
