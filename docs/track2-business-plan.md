# Track 2 Business Plan — source reference

> Extracted from `VeriGate-Track2.pdf` (the original VeriGate Track 2 deck). VeriPAYai
> builds on this same use case from the **agent** side rather than the trust-layer side.
> Kept here verbatim as the source of truth for product framing.

---

**TRACK 2 · TRUSTED AI AGENT TRANSACTIONS**

**VeriGate** — A trust and control layer for AI agent payments on Monad.
Built by Gentlesoul HUB · Powered by Cleanverse

## What we are building
Payment infrastructure that lets AI agents safely initiate, approve, and complete transactions on Monad.
1. **Verified intent** — every agent request is checked before any money moves.
2. **Permission controls** — users set rules and limits that agents cannot exceed.
3. **Audit logs** — each action is recorded for accountability and traceability.

## AI agents can act, but cannot safely handle money
- ✕ **No way to verify intent** — nothing confirms an agent's request is what the user actually wanted.
- ✕ **No risk limits** — agents can move funds with no cap, no guardrails, no controls.
- ✕ **No accountability** — when an agent moves money, there is no record of who or why.

## VeriGate sits between agents and the blockchain
A trust and control layer that verifies, enforces, and records every agent payment.
- **AI AGENTS** — agents request payments
- ↓
- **VERIGATE TRUST LAYER** — verifies requests · enforces user rules · records every action
- ↓
- **MONAD** — fast, low-cost, secure settlement

## How a request moves through VeriGate
1. **Request** — an AI agent sends a transaction request.
2. **Check** — VeriGate checks permissions, limits, and rules.
3. **Decide** — the system approves, rejects, or flags it.
4. **Log** — every action is logged for audit and traceability.

## How VeriGate connects to Cleanverse
Cleanverse is the agent environment. VeriGate handles execution and compliance.
1. Cleanverse agent triggers a payment request.
2. VeriGate receives it through a secure API layer.
3. VeriGate runs verification, permissions, and risk rules.
4. Approved transactions execute on Monad.
5. Results and logs return to Cleanverse for tracking.

## Key integration points
- **API communication** — secure API link between Cleanverse and VeriGate.
- **Wallet abstraction** — unified handling for both user and AI agent wallets.
- **Permission engine** — agent-level control over what can and cannot happen.
- **Event logging** — full transparency and debugging across every action.

## Why this integration matters
- **For Cleanverse** — safe transaction capability for its AI agents, with trust built in.
- **For VeriGate** — a real usage environment for agent-driven payments.
- **For both** — programmable financial actions, trusted from execution to audit.

## Closing
The safety layer for agent-driven payments. AI agents are moving toward real-world
execution. VeriGate is the trust infrastructure that lets their payments scale safely on Monad.
