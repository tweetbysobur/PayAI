# VeriPAYai — Architecture & Decisions

## Decisions locked (Day 0)

1. **Relationship to VeriGate:** VeriPAYai **plugs into VeriGate**. VeriPAYai is the AI
   agent (understand → decide → pay); VeriGate is the trust layer it calls for
   verification, permission/limit enforcement, and audit logging.

2. **Stack:** match VeriGate's foundation, add the AI-agent brain on top.
   - **Next.js 16 + TypeScript + Tailwind 4** — app, UI/control panel, API routes.
   - **viem** — Monad wallet abstraction + settlement.
   - **Reuse VeriGate's `lib/cleanverse`** types/client — VeriPAYai *is* a Cleanverse agent.
   - **`@anthropic-ai/sdk` + Claude Opus 4.8** — the agent brain (intent parsing,
     decision loop, tool-use to call payment functions). Sonnet 4.6 as cost fallback.
   - **HTTP → VeriGate** trust-layer API for verify/enforce/log.

## Component map

```
┌─────────────────────────────────────────────────────────┐
│ VeriPAYai (Cleanverse agent)                              │
│                                                           │
│  User intent ──► [Agent brain: Claude + tool-use]         │
│                        │                                  │
│            structured payment request                     │
│                        │                                  │
│                        ▼                                  │
│                 [Decision loop]                           │
│                        │                                  │
└────────────────────────┼──────────────────────────────────┘
                         │  HTTP (secure API)
                         ▼
            ┌────────────────────────────┐
            │ VeriGate trust layer        │
            │  /api/pay  · permission      │
            │  engine · audit log          │
            └─────────────┬───────────────┘
                         │ approved
                         ▼
                     ┌────────┐
                     │ Monad  │  settlement (viem)
                     └────────┘
```

## VeriGate API surface VeriPAYai will consume

(from inspecting `C:\Users\USER\Documents\VERIGATE`)
- `POST /api/pay` — submit a payment for verification + execution.
- `GET/POST /api/invoices`, `/api/invoices/[id]/pay` — invoice flows.
- `GET/POST /api/merchant/settings` — merchant/permission config.
- `/api/apass/*` — agent pass: `issue`, `status`, `faucet`.
- `/api/attempts`, `/api/health` — telemetry/health.

> TODO: confirm request/response schemas against VeriGate's `lib/cleanverse/types.ts`
> and the `route.ts` handlers before wiring the client.

## Proposed VeriPAYai layout

```
VeriPAYai/
├── app/
│   ├── api/
│   │   ├── agent/route.ts      # entrypoint: intent → agent loop
│   │   └── health/route.ts
│   ├── page.tsx                # agent control panel / demo UI
│   └── layout.tsx
├── lib/
│   ├── agent/                  # Claude brain: prompt, tools, decision loop
│   ├── cleanverse/             # reused/adapted from VeriGate
│   ├── verigate/               # client for VeriGate trust-layer API
│   └── web3/monad.ts           # viem settlement helpers
├── docs/
└── README.md
```

## Open questions
- Exact VeriGate `/api/pay` payload contract (intent fields, signatures, limits).
- Where does VeriPAYai's agent wallet live — its own key, or VeriGate-issued aPass?
- Auth between VeriPAYai and VeriGate (API key? signed request?).
