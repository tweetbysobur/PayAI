# Documentation

User-facing documentation lives at **[docs.usepayai.xyz](https://docs.usepayai.xyz)**
(source: [`app/docs/`](../app/docs)). This folder holds engineering notes for
people working on the code.

| Document | What it covers |
| --- | --- |
| [architecture.md](architecture.md) | System overview and the main design decisions |
| [backend/http-api.md](backend/http-api.md) | HTTP endpoints (backend reference, not a public developer API) |
| [backend/telegram-bot.md](backend/telegram-bot.md) | The optional, custodial Telegram trading bot |
| [sdk/ARCHITECTURE_SPEC_v0.1.md](sdk/ARCHITECTURE_SPEC_v0.1.md) | Original design spec for the typed protocol-action SDK (`lib/sdk`) |
| [sdk/PHASE2_UI_NOTES.md](sdk/PHASE2_UI_NOTES.md) | Notes on how protocol actions reuse the existing review UI |
| [screenshots/](screenshots) | Product screenshots used in the README |

Contract documentation is in [`contracts/README.md`](../contracts/README.md), and the
live deployment is recorded in [`MAINNET.md`](../MAINNET.md).

## Archived

Rooms were removed from PayAI in October 2026. These documents describe that
feature and its escrow contract, which remain in the repository unused and
undeployed. They are kept as a record, not as current behaviour.

- [rooms/ESCROW_ROOMS.md](rooms/ESCROW_ROOMS.md) · [rooms/ESCROW_AUDIT.md](rooms/ESCROW_AUDIT.md) ·
  [rooms/ESCROW_SECURITY_REVIEW.md](rooms/ESCROW_SECURITY_REVIEW.md) ·
  [rooms/ESCROW_PRE_AUDIT_PACKAGE.md](rooms/ESCROW_PRE_AUDIT_PACKAGE.md)
- [hackathon/payai-rooms-cleanverse.md](hackathon/payai-rooms-cleanverse.md)
