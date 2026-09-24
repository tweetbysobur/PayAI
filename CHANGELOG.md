# Changelog

All notable changes to PayAI are documented here.

## [Unreleased]

- **An existing passkey wallet can link Google without becoming a new account.**
  Settings offers it as optional. The passkey still opens the wallet on its
  own. Once Gmail is linked, signing in with that Google account opens the
  same wallet and will not register a second one. A Google account that
  already opens a different wallet is refused, and so is a second Gmail on
  a wallet that already has one. The marks live in frosted
  plates, on both the sign-in screen and the landing preview, instead of
  plain bordered boxes. The passkey button stays the primary action.
  Automations, payment-link memos, support tickets, history, analytics, and
  linked-wallet lists were readable by anyone who knew a public address.
  Reading them now takes a short-lived httpOnly grant signed by that wallet
  at unlock. A merchant API key still reads its own tenant. On-chain balances
  stay public, because the chain already is. Signing out clears the grant.
  `app.usepayai.xyz` left the saved passkey id behind on `usepayai.xyz`
  (browsers do not share localStorage across hosts), so sign-in registered a
  second passkey and a second, empty wallet. The original passkey and its
  funds were never deleted. Sign-in now asks the authenticator for an existing
  PayAI passkey first, and the credential hint is also stored in a cookie on
  `.usepayai.xyz`. A Google, X, or email sign-in that already has a wallet
  cannot mint another one. A new passkey is created only when this device has
  none and that sign-in has no wallet yet. "Use a different passkey" lists
  every passkey for the domain, which is how the original wallet is opened
  if a newer empty one was saved on this browser.
  source is public (the repo is private; contracts stay verified on the explorer).
  Security, Privacy, and Terms now name the two custody exceptions (Payment
  Automations and the Telegram hot-wallet bot), the 0.25% platform fee, the
  DeltaV × Ultrafuzz protocol review as a review rather than a full audit, and
  that UsePayAI is not PayAI Network. Help Center fees copy no longer says $0.
- **Public docs.** `/docs` plus getting started, payments, automations, fees,
  Ask PayAI, contracts, HTTP API, and Telegram. Security, Privacy, and Terms
  share the same reading layout (sidebar, long-form, live contract table)
  instead of stacked marketing cards.
- **Do not leak the private surface.** `veripayai.vercel.app` redirects to the
  canonical hosts. How-it-works no longer lists session/automation API routes.
  `/api/health` no longer returns the model name, scheduler counters, or block
  height. The README no longer points at the private GitHub account.
- **Three hostnames.** `usepayai.xyz` is marketing, `app.usepayai.xyz` is the
  product, `docs.usepayai.xyz` is documentation. Same Vercel project, free
  subdomains. Bookmarks to `/auth` and `/docs` on the apex redirect. Passkeys
  stay bound to `usepayai.xyz` so existing wallets keep working on the app
  host.
- **docs.usepayai.xyz.** Same app, free subdomain. Middleware serves docs at
  the root of that host (`/payments` not `/docs/payments`). usepayai.xyz/docs
  still works until you add the CNAME in Vercel.
- **Live contract roster.** Public pages, the footer, `/api/onchain`, and the
  wallets Security Center now lead with PayAIForwarder and PayAITradeExecutor
  (the contracts a wallet actually pays and trades through). PaymentExecutor
  is labeled as the automation path. Vault is on `/api/onchain`. Retired V1
  and unwired deploys (TradeExecutorV2, SplitSettlement) are listed on
  `/docs/contracts` as not in the app.
- **Analytics.** Google Analytics does not load on `/dashboard/*`, matching the
  privacy page.
- **Bulk import.** Removed the SheetJS (`xlsx`) Excel parser. CSV, paste, and
  manual entry remain.
- **Docs.** `MAINNET.md` now lists the live V2 executor / forwarder / vault
  addresses as read from `/api/onchain` and `/api/automation-config`, not a
  stale deploy log. Metadata fallback URL is `https://usepayai.xyz`.
- **Mera is live as the first embedded-wallet provider.** A new user signs in
  and gets a real wallet with one biometric prompt — no extension, no seed
  phrase. Mera derives a standard EVM account from the user's passkey via the
  WebAuthn PRF extension, so the key exists only in the browser: PayAI's
  server never receives, stores, or can use it. Recovery is deterministic —
  the same passkey always reproduces the same address, on any device it syncs
  to, so a returning user can never end up with a duplicate wallet.
  Integrating it required no change to the Wallet Service interface and no
  change to any call site (automations, AI assistant, dashboard), despite the
  provider working nothing like the placeholder it replaced.
- Social/email sign-in now establishes the PayAI **account**, with the wallet
  derived from the passkey immediately afterwards — Mera is passkey-based and
  cannot derive a wallet from an OAuth identity.
- Onboarding rebuilt around the new flow: Terms/Privacy acceptance, then
  "Continue with PayAI Wallet / Google / Apple / X / Email", with
  "Connect Existing Wallet" below the divider for people who already have one.
- **Wallet Service**: a new provider-agnostic wallet abstraction
  (`lib/wallet-service/`) sits between PayAI and every wallet provider —
  nothing in the app talks to a specific provider directly anymore. Ships
  with two providers: the existing external-wallet integration (MetaMask,
  Rabby, Backpack, WalletConnect…) and a Mera embedded-wallet adapter, ready
  to activate the moment `MERA_API_KEY`/`MERA_PROJECT_ID` are configured.
- **Embedded wallets & social sign-in**: a new `/auth` onboarding flow —
  "Continue with Google / Apple / X / Email" — creates or recovers a user's
  embedded wallet automatically, no seed phrase, no browser extension.
  Config-gated per provider; degrades honestly (never fabricates a signed-in
  state) until real OAuth credentials are set.
  `useWalletService()` is now the one hook the whole app uses to read the
  active wallet (embedded or external) and sign — automations, the AI
  assistant, and the dashboard all go through it, never a provider SDK.
- **AI Confirmation screen**: the AI assistant now shows Recipient / Token /
  Amount / Schedule / Execution Mode / Estimated Fees — with Edit, Cancel,
  and Confirm — before ever requesting a wallet signature, in both the
  command bar and the Send Payment page.
- **Wallet dashboard**: added Connected Wallets, Recovery Status, and a
  Withdraw action alongside Deposit/Receive.
- **Notifications**: new wallet-level notification types (wallet created/
  connected/disconnected, deposit received, withdrawal completed, automation
  signed) alongside the existing automation and payment feeds.
- **Email sign-in** now sends real one-time codes (Resend). Codes are stored
  only as salted hashes, are single-use, expire after 10 minutes, and are
  burned after 5 wrong guesses; the send and verify endpoints are rate
  limited per-IP and per-address.
- **Deposit & withdrawal notifications** are now raised from real on-chain
  activity, via a throttled catch-up scan per wallet: ERC-20 movements from
  `Transfer` logs, and native MON — which emits no log — by reading the
  transactions in the blocks since the wallet's last checkpoint, so a MON
  deposit is reported with the same real txHash, sender, and amount as a
  token one. The first scan sets a baseline only (no replay of a wallet's
  whole history), sends PayAI already settled are never notified twice, and
  the scan is time-boxed so a slow RPC can't stall the notification feed.
  Native sends made from inside a contract still need trace APIs public RPCs
  don't expose, and a catch-up window wider than ~1,500 blocks skips native
  detection rather than issuing tens of thousands of block reads.

## [0.2.0] - 2026-07-02

- Custom domain: PayAI now lives at [usepayai.xyz](https://usepayai.xyz).
- Privacy: dashboard, transactions, and analytics are now scoped to the
  connected wallet, one user never sees another's payment history.
- Redesigned Transactions and Payments pages with real MON/USDC coin marks,
  on-chain proof links, and a cleaner, denser layout.
- Landing page rewritten in plain, benefit-first language and trimmed of
  redundant sections.
- Branded social-share card (Open Graph/Twitter) and favicon.
- Fixed a crash on the Analytics page caused by a data-shape mismatch with
  the analytics API.
- Removed the last references to prior internal tooling; PayAI's payment
  pipeline (intent parsing, validation, risk, execution, settlement) is now
  fully self-contained.

## [0.1.0] - 2026-06-27

Initial public release.

- AI-powered payment dashboard with natural-language payment intent parsing.
- Real-time payment validation and risk scoring via PayAI's built-in Validation and Risk engines.
- On-chain settlement through the PaymentExecutor and MerchantRegistry contracts on Monad Mainnet.
- Wallet Intelligence: live balances, payment history, and analytics sourced directly from Monad RPC and on-chain event logs.
- Premium wallet connection flow with MetaMask and Rabby support, with network-mismatch guidance.
- Security Center with live network status, verified contract addresses, and session tracking.
