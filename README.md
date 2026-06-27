# PayAI

**An autonomous AI payment agent on Monad — powered by Cleanverse.**

Built by Gentlesoul HUB · Track 2 · Trusted AI Agent Transactions

---

## What PayAI is

PayAI is an **AI agent that uses the Cleanverse tool to initiate, approve, and complete real payments** on the Monad blockchain. Where VeriGate is the *trust and control layer* that sits between agents and the chain, **PayAI is the agent itself** — the side that understands a user's intent, decides what payment to make, and executes it safely.

> Think of it this way:
> - **VeriGate** = the guardrail (verify · enforce · log).
> - **PayAI** = the driver (understand · decide · pay) that operates *within* those guardrails.

PayAI can run standalone, or plug into a VeriGate-style trust layer for verification, permission limits, and audit logging.

## How PayAI differs from VeriGate

| | **VeriGate** | **PayAI** |
|---|---|---|
| Role | Trust & control layer | AI payment agent |
| Position | Between agents and Monad | The agent that requests/executes |
| Core job | Verify intent, enforce rules, log | Understand intent, decide, pay |
| Cleanverse relationship | Receives requests from Cleanverse agents | **Is** a Cleanverse-powered agent |
| Output | Approve / reject / flag + audit log | A correct, authorized on-chain payment |

Both share the same north star (from the Track 2 plan): *let AI agents safely handle money on Monad.* They attack it from opposite ends of the same pipeline.

## The problem (from the Track 2 plan)

AI agents can act, but cannot safely handle money:

1. **No way to verify intent** — nothing confirms an agent's request matches what the user actually wanted.
2. **No risk limits** — agents can move funds with no cap, no guardrails.
3. **No accountability** — when an agent moves money, there's no record of who or why.

PayAI addresses these from the *agent* side: it produces payments that are **intent-verified, limit-aware, and fully logged** before they ever reach the chain.

## How a payment moves through PayAI

```
User / natural-language intent
        │
        ▼
[1] UNDERSTAND   PayAI (Cleanverse) parses intent → structured payment request
        │
        ▼
[2] CHECK        Validates against user rules, limits, balances, recipient
        │
        ▼
[3] DECIDE       Confirms, asks for confirmation, or refuses
        │
        ▼
[4] PAY          Executes the transaction on Monad
        │
        ▼
[5] LOG          Records intent → decision → tx hash for audit & traceability
```

## Cleanverse integration

Cleanverse is the agent environment PayAI is built on. The flow:

1. A user expresses an intent ("pay X", "settle invoice", "subscribe to Y").
2. PayAI (running as a Cleanverse agent) turns it into a structured payment request.
3. It runs verification, permission, and risk checks (own engine and/or a trust layer like VeriGate).
4. Approved transactions execute on **Monad** — fast, low-cost, secure settlement.
5. Results and logs return to Cleanverse for tracking.

### Key integration points
- **API communication** — secure API link between Cleanverse and the payment/trust layer.
- **Wallet abstraction** — unified handling of user and agent wallets.
- **Permission engine** — agent-level control over what can and cannot happen.
- **Event logging** — full transparency and debugging across every action.

## Why this matters
- **For Cleanverse** — a real, safe transaction capability driven by its AI agents.
- **For users** — programmable payments they can trust, from intent to audit.
- **For the ecosystem** — agent-driven payments that scale safely on Monad.

---

## Project status

🚧 **Day 0 — scaffolding.** Foundational framing + architecture decisions are locked (see [docs/architecture.md](docs/architecture.md)).

## Stack (locked)

- **Next.js 16 + TypeScript + Tailwind 4** — app, UI/control panel, API (matches VeriGate).
- **viem** — Monad wallet abstraction + settlement.
- **`@anthropic-ai/sdk` + Claude Opus 4.8** — the agent brain (intent → decision → tool-use). Sonnet 4.6 as cost fallback.
- **Reused `lib/cleanverse`** from VeriGate — PayAI is a Cleanverse agent.
- **HTTP → VeriGate** trust layer for verify / enforce / log.

## Roadmap / next steps

- [x] Lock relationship to VeriGate (**plugs into** the trust layer)
- [x] Lock the stack (best fit — see above)
- [x] Scaffold the Next.js + TS app (builds clean)
- [x] Confirm VeriGate `/api/pay` contract (5-step pipeline: identity→asset→compliance→settle→audit)
- [x] Build the VeriGate trust-layer client (`lib/verigate/client.ts` — drives the pipeline)
- [x] Build the agent brain: intent → structured request → guardrails (`lib/agent/brain.ts`, Claude + fallback)
- [x] Agent entrypoint API + control-panel UI (`/api/agent`, `app/page.tsx`)
- [ ] Add `ANTHROPIC_API_KEY` to `.env.local` to enable the Claude brain (currently using fallback parser)
- [ ] Point `VERIGATE_URL` at a running VeriGate to complete a live end-to-end payment
- [ ] Wire real Monad settlement via viem (VeriGate currently simulates `settle`)
- [ ] End-to-end demo flow

### How to run

```bash
cp .env.example .env.local   # add ANTHROPIC_API_KEY + VERIGATE_URL
npm install
npm run dev                  # http://localhost:3100
```

## Structure

```
PayAI/
├── README.md        ← you are here
└── docs/            ← design notes, architecture, business plan reference
```

---

*Built by Gentlesoul HUB · Powered by Cleanverse · Settling on Monad*
