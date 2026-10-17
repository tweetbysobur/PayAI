# PayAI x402 facilitator

PayAI runs its own x402 v2 facilitator. It verifies and settles `exact` USDC
payments on Monad for PayAI merchants and pays the gas.

## Routes

| Route | Auth | What it does |
| --- | --- | --- |
| `GET /api/x402/supported` | public | Kinds, extensions and signer address |
| `POST /api/x402/verify` | `x-merchant-key` | Checks a payment. Moves nothing. |
| `POST /api/x402/settle` | `x-merchant-key` | Broadcasts `transferWithAuthorization` |

## Enable

1. Create a new wallet. Do not reuse `MONAD_AGENT_PRIVATE_KEY`; the app refuses to start the facilitator if you do.
2. Send it a little MON for gas. It never holds USDC.
3. Set `X402_FACILITATOR_ENABLED=true` and `X402_FACILITATOR_PRIVATE_KEY`.
4. Optional: `X402_MAX_AMOUNT_ATOMIC` (default 100 USDC) and `X402_USDC_ADDRESS`.
5. Check `GET /api/x402/supported` lists `eip155:143`.

## Merchant side

```ts
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";

const facilitator = new HTTPFacilitatorClient({
  url: "https://usepayai.xyz/api/x402",
  createAuthHeaders: async () => {
    const h = { "x-merchant-key": process.env.PAYAI_MERCHANT_KEY! };
    return { verify: h, settle: h };
  },
});
```

`payTo` must be the merchant's PayAI payout wallet.

## What PayAI refuses to relay

- anything but x402 v2, scheme `exact`, PayAI's Monad network and USDC
- Permit2 payloads and ERC-6492 wallet deployments
- a signed payload that differs from the submitted requirements
- `payTo` other than the calling merchant's wallet
- an authorization that pays a different address or amount
- zero, malformed or over-cap amounts
- sanctioned payers or payees
- payments from or to the facilitator wallet

The SDK then checks the signature, nonce, time window and an `eth_call`
simulation. Settle simulates again right before broadcast.

## Limits

- No PayAI fee. x402 pays `payTo` directly, so the forwarder fee does not apply.
- Gas comes from the facilitator wallet. Watch its MON balance.
- Rate limits: 300 requests per minute per IP, then 120 verify and 60 settle per minute per merchant.
