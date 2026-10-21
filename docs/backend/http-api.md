# PayAI HTTP API (backend reference)

Internal reference for PayAI's HTTP endpoints. Moved out of the public docs
site (formerly `/docs/api`) on 2026-09-29. This is backend documentation, not a
published developer platform.

## What this is

The dashboard talks to `/api/*` with a session cookie. That is first-party, not
a partner integration. A service building against PayAI should start with the
public GET routes and the merchant key, and expect the surface to evolve.

## Public GET endpoints

| Method | Path | What it returns |
|---|---|---|
| GET | `/api/fees` | Current platform fee rates per feature |
| GET | `/api/onchain` | Live contract addresses |
| GET | `/api/automation-config` | Executor, vault, WMON, USDC addresses |
| GET | `/api/health` | Liveness — connected or not. No model, no balances |
| GET | `/api/tokens` | Verified token list, or resolve an address |

`/api/tokens?address=0x…` reads arbitrary contracts and is rate-limited.
`/api/health` does not expose the agent wallet address or its balance.

## Merchant key

`POST /api/merchants` creates a workspace and returns an API key once. Send it
as `x-merchant-key` on later merchant-scoped calls (for example payment links).
The key is not recoverable from the API after that response — store it; PayAI
will not send it again.

## What is not a public API

Automations, Ask PayAI, swaps, and anything that can move funds are
session-authenticated dashboard routes, or gated on an internal signer key that
is not issued to third parties. Treat them as the app backend.
