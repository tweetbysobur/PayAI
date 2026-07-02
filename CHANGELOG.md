# Changelog

All notable changes to PayAI are documented here.

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
