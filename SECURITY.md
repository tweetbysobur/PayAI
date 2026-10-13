# Security

## Reporting a vulnerability

If you find a security issue, please email **security@usepayai.xyz** with details
and steps to reproduce. Do not open a public issue for anything exploitable.
We aim to acknowledge within 48 hours.

Please include the affected URL or file, what an attacker could do, and the
smallest steps that reproduce it. Testing must not move other people's funds,
access other users' data, or degrade the live service — use simulation mode
(`PAYAI_MODE=simulation`, the default) or your own wallets and small amounts.

In scope: this repository, the deployed PayAI contracts, and
usepayai.xyz / app.usepayai.xyz / docs.usepayai.xyz. Out of scope: third-party
services PayAI integrates with (Monad, Uniswap, Kuru, Nad.Fun, Mera, wallet
apps), denial-of-service, and social engineering.

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

## Private app data

A wallet address is public. It is not a credential. Records PayAI keeps for
that address — automations, payment-link memos, support tickets, transaction
history, analytics, linked wallets — are returned only to a browser that
recently proved it holds the key (an httpOnly grant, 12 hours, cleared on
sign-out) or to a merchant presenting its API key. On-chain data stays
public because the chain already publishes it.

The interactive private key is not among those records. It is derived in the
browser from the passkey and is never sent to the server.

## Secrets

No secrets are committed to this repository, at any point in its history
(every branch was scanned for keys, tokens and credentials before the
repository was made public; the only private keys present are the well-known
public Hardhat test keys used in unit tests). The
agent private key, Telegram master key, and API keys live only in the
deployment host's environment (`.env.local` is gitignored; only `.env.example`,
a template, is tracked).

## Source

The application and contract source are in this repository. Deployed
contracts are verified on the Monad explorer, so the bytecode running on-chain
can be matched against the Solidity here.

## Disclosure note

Several tenancy and data-exposure issues were found and fixed during
pre-launch hardening (see the git history for the `security:` and privacy
commits). These were caught before the public launch; no user funds or private
keys from the interactive (non-custodial) path were at risk.
