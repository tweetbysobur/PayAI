# Changelog

All notable changes to PayAI are documented here.

## [Unreleased]

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
