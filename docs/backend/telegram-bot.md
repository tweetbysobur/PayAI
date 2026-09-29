# Telegram trading bot (backend reference)

Internal reference for the optional Telegram trading bot. Moved out of the
public docs site (formerly `/docs/telegram`) on 2026-09-29. The public custody
disclosure stays on `/security` and `/terms`, and the bot repeats it on every
`/start`.

## This path is custodial

On `/start` the bot creates a hot wallet for the Telegram user and stores the
private key encrypted at rest so `/buy`, `/sell`, and `/withdraw` can sign from
chat. That is custody. Users should not deposit more than they are willing to
trust to a bot.

The disclosure is sent every time `/start` runs, including when a wallet
already exists. Users withdraw to an address they control with `/withdraw`.
The web-app passkey and external wallets are a different, non-custodial model.

The webhook fails closed without a configured secret. If the bot is not set up
on a deployment, these commands do not exist there.

## Commands

| Command | What it does |
|---|---|
| `/start` | Create or show the hot wallet, with the custody notice |
| `/help` | Command list |
| `/balance` | MON and USDC balances |
| `/price <token>` | Look up a token |
| `/buy <token> <MON amount>` | Spend MON to buy a token |
| `/sell <token> <amount>` | Sell a token for MON |
| `/withdraw <amount> <MON\|token> <to>` | Send funds out of the bot wallet |

The bot wallet needs MON for gas, even on a trade that does not spend MON as
the input asset.

## What it is not

- Not the PayAI Wallet created from a passkey in the browser.
- Not Wallet Automation or Reserved Funds — those are the scheduled-payments path.
- Not a place to paste a seed phrase. It already has a key; it does not need one.
