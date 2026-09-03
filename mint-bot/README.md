# Monad NFT Mint Bot (Telegram)

A standalone Telegram bot that mints NFTs on Monad. It works before your NFT
contract exists. Set the address later with one command and minting goes live.

## Two mint modes

- Non-custodial: the bot sends the user an `ethereum:` link (EIP-681). The user
  signs in their own wallet. No keys on the server. This is the default and the
  safe path.
- Custodial: a server wallet mints on the user's behalf. One tap. You hold the
  key and the funds. Only enable this if you accept that risk.

## Setup

1. Create a bot with @BotFather. Copy the token.
2. Get your Telegram user id from @userinfobot.
3. Copy env and fill it in:

```bash
cp .env.example .env
# set TELEGRAM_BOT_TOKEN and ADMIN_TELEGRAM_IDS
# leave NFT_CONTRACT_ADDRESS blank for now
```

4. Install and run:

```bash
npm install
npm run dev      # local
npm run build && npm start   # production
```

## Going live when your NFT is ready

In Telegram, as an admin:

```
/setcontract 0xYourNftAddress
/setfn mint quantity        # match your contract's mint function
/setprice 0.1               # price per mint in MON, 0 for free
```

Then any user runs `/mint`.

## Deploy to Railway

Railway is the recommended host: always on, free tier, no public URL needed
(the bot uses long polling).

1. Push this repo to GitHub (done).
2. On railway.app, New Project -> Deploy from GitHub repo -> pick this repo.
3. In the service settings, set Root Directory to `mint-bot`.
4. Add variables (from `.env.example`): `TELEGRAM_BOT_TOKEN`, `ADMIN_TELEGRAM_IDS`,
   `MONAD_NETWORK`, and later `NFT_CONTRACT_ADDRESS`. Add `CUSTODIAL_PRIVATE_KEY`
   only if you want custodial mode.
5. Deploy. `railway.json` handles build and start.

Persisting `/setcontract` across restarts: add a Railway Volume mounted at
`/app/data` and set `DATA_DIR=/app/data`. Without a volume the live config
resets to the env values on redeploy, so also set `NFT_CONTRACT_ADDRESS` in
Railway once your NFT is live as the durable source of truth.

## Matching your contract

`/setfn <name> <shape>` covers the common ERC-721 mint signatures:

| shape         | signature                          |
| ------------- | ---------------------------------- |
| `none`        | `mint()`                           |
| `quantity`    | `mint(uint256 quantity)`           |
| `to`          | `safeMint(address to)`             |
| `to_quantity` | `mint(address to, uint256 count)`  |

If your contract uses a different signature, tell us and we extend the map.

## Config persistence

`/setcontract`, `/setfn`, `/setprice` write to `data/contract.json`, so a
restart keeps the live config. Env values seed the first run.

## Notes

- Network is `MONAD_NETWORK` (`testnet` default, `mainnet` for production).
- Monad mainnet chain id is 143, testnet is 10143.
- Custodial mode stays off unless `CUSTODIAL_PRIVATE_KEY` is set to a valid key.
- Never commit `.env` or `data/`.
