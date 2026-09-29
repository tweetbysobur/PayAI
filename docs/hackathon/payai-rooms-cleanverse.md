# PayAI Rooms + Cleanverse

> **Status:** Specification, v0.1 — **no implementation yet.** This is the
> source-of-truth architecture document for PayAI Rooms and its Cleanverse
> integration. Update it before (not after) any code changes that diverge
> from it.
>
> **Date:** 2026-09-29 · **Repo baseline:** `claude/bitv-s3ctfc` @ `e648d7f`

## How to read this document

Every factual claim carries one of four labels. Nothing Cleanverse-specific
is treated as settled unless it is marked **[CV-Verified]**, and at the time
of writing nothing technical is.

| Label | Meaning |
|---|---|
| **[Repo]** | Verified by reading this repository at the baseline commit. File paths are cited. |
| **[CV-Verified]** | Verified from current, authoritative Cleanverse technical documentation. |
| **[CV-Public]** | Stated in Cleanverse's public, marketing-level material (see [Sources](#15-sources)). Describes intent/behaviour, not an interface. **Not sufficient to build against.** |
| **[Needs CV]** | Requires confirmation from Cleanverse (docs, API reference, or a person) before we build on it. |
| **[Proposed]** | A PayAI architectural choice or assumption made in this document. Can be changed by us. |

**Research limits, stated plainly.** During this spec pass, `cleanverse.com`
was blocked by the sandbox's network egress proxy, so no Cleanverse page
could be opened directly. The only Cleanverse information available was
search-result summaries of public pages. Cleanverse's hackathon page refers
to a "full API v3 reference with endpoints, authentication, and
request/response examples" **[CV-Public]**, but none of its content has been
read. **No Cleanverse endpoint, ABI, SDK, contract address, auth scheme, or
A-USDC deployment in this document is verified.** Anyone with access to the
Cleanverse developer docs should start with §14 (open questions).

---

## 1. Overview

**PayAI Rooms** lets a user create a shared payment room in plain English
("Create a room for 100 A-USDC for 5 people."). Participants join through a
link, connect their wallet, pass Cleanverse verification (A-Pass), and pay
their fixed share. The room tracks contributions and completes when everyone
has paid. Settlement happens on Monad.

### What already exists (the foundation) — **[Repo]**

| Capability | Where |
|---|---|
| Plain-English intent → structured request | `lib/agent/`, `lib/ask/intent/` (`classify.ts`, `types.ts`, `orchestrate.ts`) |
| Validation + risk scoring for payments | `lib/payment/engine.ts` — `runValidation()` (l.66), `assessRisk()` (l.173), `execute()` (l.537) |
| User-signed execution loop (wallet signs, server never holds user keys) | `lib/ask/intent/orchestrate.ts` — `wallet.sendTransaction()` / `wallet.waitForReceipt()` loop (l.286/301, l.505/524) |
| Direct ERC-20 `transfer` calldata for single payments | `app/api/agent/route.ts` (~l.464, `functionName: "transfer"`) |
| PayAI SDK: registry, version pinning, Layer A/B validation, signer-free `UnsignedActionStep[]` builds, exact-amount approval validation | `lib/sdk/` (`types.ts`, `registry.ts`, `validate.ts`, `bootstrap.ts`) |
| Split Settlement (one payer → up to 10 recipients) | `contracts/contracts/SplitSettlement.sol`, SDK action `lib/sdk/actions/split-settlement/` |
| Shareable payment link + public checkout page | `app/api/links/route.ts`, `app/pay/[id]/page.tsx`, `lib/platform/store.ts` (`createLink`, `getLinkGlobal`, `markLinkPaid`) |
| On-chain receipt verification of an ERC-20 payment | `app/api/links/[id]/confirm/route.ts` using `lib/monad/verify.ts` `hasErc20TransferTo()` |
| Idempotent settlement / rate limiting | `lib/platform/idempotency.ts` (`claimRequest`, `completeRequest`), `lib/platform/ratelimit.ts` (`rateLimited`) |
| KV storage (Upstash Redis, in-memory fallback) | `lib/platform/kv.ts` |
| `.nad` domain resolution | `lib/monad/domain-resolver.ts` (`resolveDomain`) |
| Wallet connection (injected + embedded providers) | `lib/wallet-service/` |
| Monad chain config, stablecoin selection | `lib/monad/config.ts` (`getStablecoin()`) |

### What is new (PayAI Rooms) — **[Proposed]**

- A **room** object and its lifecycle (create → open → complete/expired/cancelled).
- A **room-creation intent** in the NL layer.
- A **join page** (`/room/[id]`) and room API routes.
- A **verification gate**: server-side A-Pass eligibility check per participant wallet (Cleanverse).
- **Contribution confirmation**: per-participant receipt verification, bound to that participant's wallet.
- A-USDC as the room asset (address/config **[Needs CV]**).

> **Note on `lib/plan`:** the brief mentions `lib/plan`. **[Repo]** It does not
> exist. Multi-step transaction plans in this repo are `UnsignedActionStep[]`
> from the SDK (approve → action) and step arrays built in
> `lib/monad/swap.ts`, `tradeQuote.ts`, `tradeExecutor.ts`, `kuruSwap.ts`,
> `nadfun.ts`. Rooms should reuse those shapes, not introduce a planner.

---

## 2. Problem

Group payments on-chain are awkward: someone fronts the money and chases
everyone else, or a group coordinates many ad-hoc transfers with no shared
view of who has paid. For regulated-stablecoin use cases there is a second
problem: the payer must be someone who is **allowed** to move the asset.
Collecting from anonymous wallets is not acceptable when the asset itself is
restricted to verified holders.

Rooms solves both: one link, a fixed share per person, a shared progress
view, and a hard verification gate that runs **before** anyone is asked to
sign.

---

## 3. Product Concept — **[Proposed]**

- **Room creation.** The creator (a connected wallet) describes the room in
  plain English. PayAI parses it, shows a preview (asset, total, participant
  count, per-share amount, recipient), and the creator confirms. Creating a
  room is **not** a transaction — no signature, no funds move.
- **Natural-language intent.** Example: *"Split 100 A-USDC between 5 verified
  participants."* → asset A-USDC, total 100, 5 participants, fixed split,
  share 20 each.
- **Invite / join link.** Creation returns a URL (`/room/{id}`), modelled on
  the existing `/pay/{id}` checkout link. Anyone with the link can view the
  room; only eligible wallets can pay.
- **Participant state.** Each participant is a wallet address that has
  joined, with its own verification state and payment state.
- **Verification requirement.** A participant must hold a valid Cleanverse
  A-Pass (as determined by Cleanverse, see §7) before they become eligible.
  Hard gate — no exceptions, no override.
- **Contribution requirement.** Each eligible participant pays exactly their
  fixed share, once. Over- and under-payments are not accepted as a
  contribution.
- **Room completion.** When the number of confirmed contributions reaches
  the participant target, the room is `completed`. Settlement per payment
  is final on Monad at the time each contribution lands (see §8); completion
  is a state change, not an extra transfer, in the recommended MVP.

**Who receives the money?** **[Proposed]** The room creator's wallet by
default (the "collector"), optionally a different recipient address or
`.nad` name specified at creation. The recipient must itself be able to
receive A-USDC — **[Needs CV]** (see §8).

**Does the creator pay a share?** **[Proposed]** MVP: the creator may join as
one of the participants like anyone else; the room does not assume it.
Open to product decision (§14, Q-P1).

---

## 4. User Flow

```
Create Room ─▶ Join Room ─▶ Connect Wallet ─▶ Cleanverse Verification ─▶ A-Pass Eligibility
                                                                               │
                                               ┌── not eligible ──────────────┤  (HARD GATE: stop here,
                                               │                               │   show how to get verified)
                                               ▼                               ▼
                                          [blocked]                    Eligible to Pay
                                                                               │
                                                                               ▼
                                                               Pay Share (user's wallet signs)
                                                                               │
                                                                               ▼
                                                  Contribution Confirmed (server verifies receipt on-chain)
                                                                               │
                                                                               ▼
                                                     Room Completion (all shares confirmed)
```

Step detail — **[Proposed]** unless labelled:

1. **Create Room.** Creator types the intent; PayAI previews; creator
   confirms; server stores the room and returns the link. Creator wallet
   must be connected (the room is scoped to it, same as `PaymentLink.sender`
   **[Repo]** `lib/platform/types.ts:362`).
2. **Join Room.** Participant opens `/room/{id}`; sees asset, share, progress
   (count only — see §11 privacy).
3. **Connect Wallet.** Existing wallet connection **[Repo]** `lib/wallet-service/`.
4. **Wallet ownership.** Participant signs a message proving control of the
   address (no transaction, no gas). Required so that someone cannot claim a
   verified stranger's address as their own. Mechanism reuse: **[Needs repo
   check at implementation time]** whether `lib/platform/auth.ts` already
   provides a sign-in-with-wallet challenge suitable for this.
5. **Cleanverse Verification.** Server asks Cleanverse whether that address
   holds a valid A-Pass (method **[Needs CV]**, §7). If the participant has no
   A-Pass, PayAI links out to Cleanverse's own onboarding; PayAI never
   collects identity documents or PII.
6. **A-Pass Eligibility.** `eligible` only on a positive, current answer.
   Unknown, error, timeout, revoked, expired → **not eligible** (fail closed).
7. **Eligible to Pay.** Only now is the "Pay share" button enabled, and the
   server will only build the payment transaction for an eligible,
   ownership-proven participant.
8. **Pay Share.** Participant's own wallet signs and broadcasts (§8).
9. **Contribution Confirmed.** Participant (or the page) submits the tx hash;
   server fetches the receipt from Monad and verifies it (§6, §8). Idempotent.
10. **Room Completion.** On the last confirmed contribution the room flips to
    `completed`.

**Hard gate rule:** an unverified participant is never `eligible`, never
receives a built transaction from PayAI, and a contribution from an address
that was not eligible at payment time is never counted. Re-checking A-Pass at
confirmation time as well as at build time is **[Proposed]** (catches
revocation between the two).

Note the gate is enforced by PayAI's server for PayAI's own flow. A
participant could still send A-USDC to the recipient outside PayAI; whether
that succeeds is governed by the A-USDC contract's own rules **[CV-Public:
A-Tokens move only between A-Pass holders]**, and PayAI would not count it
unless it matches a room participant's confirmed contribution.

---

## 5. Natural Language Intent

**[Repo]** The Ask PayAI intent layer has a closed set of intent kinds
(`ASK_INTENT_KINDS` in `lib/ask/intent/types.ts`, which includes e.g.
`distribution`, `token_lookup`, `protocol_action`) and dispatches per kind in
`lib/ask/intent/orchestrate.ts`. Some kinds are detected deterministically
and deliberately excluded from the LLM schema (`protocol_action`,
`token_lookup`).

**[Proposed]** A new intent kind (working name `room_create`). Its slots are
**proposed, not final** — the schema should be fixed during implementation
against the existing slot conventions:

| Proposed field | Example | Notes |
|---|---|---|
| `asset` | `"A-USDC"` | MVP accepts **only** A-USDC. Anything else → refuse, don't guess. |
| `totalAmount` | `"100"` | Decimal string, token units. |
| `participantCount` | `5` | Integer, bounded (proposed 2–20). |
| `splitMode` | `"fixed"` | MVP: only `fixed` (equal shares). `weighted`/`streaming` rejected with a clear "not supported yet". |
| `shareAmount` | `"20"` (derived) | Derived, never taken from the LLM. Must divide exactly at the token's decimals; otherwise refuse or ask (§14, Q-P2). |
| `creator` | connected wallet | From the session, **never** from the text. |
| `recipient` | creator by default; address or `.nad` | `.nad` via existing `resolveDomain()` **[Repo]**. |
| `requiresVerification` | `true` | Not user-configurable in MVP. Always true for A-USDC. |
| `expiresAt` | optional | Proposed default (e.g. 7 days). |
| `memo` | optional | Free text, length-capped. |

Parsing rules **[Proposed]**:
- Numbers (total, count) are re-derived deterministically from the text and
  cross-checked against any LLM extraction; mismatch → ask, don't pick one.
- Creating a room never executes anything; the preview → confirm step is
  mandatory.

---

## 6. Room State — **[Proposed]**

Minimal record, stored in the **existing KV** (`lib/platform/kv.ts`
**[Repo]**), following the payment-link pattern of a per-owner list plus a
global mirror for the public page (`veripay:link:{id}` in
`lib/platform/store.ts` **[Repo]**). No new database, no workflow engine, no
new service.

```ts
// PROPOSED — not a final schema
interface Room {
  id: string;                    // unguessable, same generator style as payment links
  creator: `0x${string}`;        // connected wallet at creation
  recipient: `0x${string}`;      // resolved at creation, snapshotted
  asset: { symbol: "A-USDC"; address: `0x${string}`; decimals: number; chainId: number };
  totalAmount: string;           // base units
  participantTarget: number;
  requiredContribution: string;  // base units, = totalAmount / participantTarget exactly
  status: "open" | "completed" | "expired" | "cancelled";
  createdAt: number;
  expiresAt: number | null;
  completedAt: number | null;
  participants: Participant[];   // or a separate KV hash keyed by address
}

interface Participant {
  address: `0x${string}`;
  joinedAt: number;
  ownershipProvenAt: number | null;
  verification: {
    state: "unchecked" | "eligible" | "not_eligible" | "error";
    checkedAt: number | null;
    // what Cleanverse returned, minimised — NO PII (see §11)
  };
  payment: {
    state: "unpaid" | "pending" | "confirmed" | "rejected";
    txHash: `0x${string}` | null;
    confirmedAt: number | null;
  };
}
```

Invariants **[Proposed]**:
- `status` only moves forward: `open → completed | expired | cancelled`.
- At most one `confirmed` payment per address; a tx hash can be counted for
  at most one room/participant (idempotency key on tx hash, as in
  `app/api/links/[id]/confirm/route.ts` **[Repo]**).
- Confirmed count never exceeds `participantTarget`; joins beyond target are
  refused.
- `cancelled` is only allowed while no contribution is confirmed (funds
  already sent directly to the recipient cannot be "cancelled" by PayAI —
  refunds are out of scope for MVP, §14 Q-P3).
- Concurrency: KV has no transactions here; completion should be derived
  from the confirmed set on read, or guarded by an atomic primitive the KV
  adapter already exposes (`set nx`, `incr` **[Repo]**). Decide at
  implementation.

---

## 7. Cleanverse Integration

### Responsibilities

| PayAI | Cleanverse |
|---|---|
| Room creation, NL parsing, room state, UI | Identity verification (KYC / bank verification) **[CV-Public]** |
| Proving the participant controls the wallet (signed message) | Issuing / revoking the A-Pass credential **[CV-Public]** |
| Asking Cleanverse whether an address is eligible; failing closed | Answering that question authoritatively **[Needs CV: how]** |
| Building an unsigned transaction for eligible participants only | Enforcing A-Token transfer rules in the token contract **[CV-Public: A-Tokens move only between A-Pass holders]** |
| Verifying the receipt on Monad and updating the room | Travel-rule compliance of A-Token transfers **[CV-Public]** |
| Never holding user funds or keys | Custody/mirroring model of A-Tokens vs underlying stablecoin **[Needs CV]** |

### What Cleanverse publicly says — **[CV-Public]**

- **A-Pass**: a non-transferable, on-chain identity credential bound to a
  verified wallet, proving bank-verified identity; PII is kept local-only;
  credentials are revocable.
- **A-Tokens (e.g. aUSDC)**: "access tokens" mirroring regulated stablecoins;
  move only within Cleanverse, between A-Pass-verified members; each
  transfer travel-rule compliant in real time.
- Cleanverse offers API access to "Cleanverse Verified Identity (CVI)" and
  "Cleanverse Verified Assets (CVA)", with an "API v3 reference" (not read).
- Supported by the Monad Foundation; hackathon projects are reported to have
  integrated on **Monad testnet**.

### Must verify before building — all **[Needs CV]**. Do not invent any of these.

| # | Item | Why we need it |
|---|---|---|
| V1 | Cleanverse API base URL, version, environments (sandbox vs prod) | Server-side eligibility check |
| V2 | Wallet verification endpoint (is address X A-Pass-verified?) — request/response, status values (active/revoked/expired) | The hard gate |
| V3 | A-Pass read endpoint or on-chain read | Alternative/secondary gate |
| V4 | On-chain A-Pass verification: contract address(es), ABI, chain(s), how to read validity (balance? `isVerified(address)`? expiry?) | Lets PayAI verify without trusting an API response alone; also tells us what the token contract checks |
| V5 | A-USDC contract: address per network, decimals, ABI, standard (plain ERC-20 + hooks? ERC-3643-style?), mainnet vs testnet availability | Payment asset |
| V6 | Official SDK (name, package, license) — if any | Could replace hand-written client |
| V7 | Authentication: partner API keys? OAuth? request signing? rate limits? | Server config; secrets in Vercel env only |
| V8 | Partner / issuer requirements for an app like PayAI to query eligibility or facilitate A-USDC payments (agreement, whitelisting, review) | Go/no-go for the hackathon |
| V9 | Terms on what PayAI may store about a verification result (retention, caching) | §11 privacy |
| V10 | Onboarding URL/flow to send unverified users to | UX for the blocked state |

**Testnet aUSDC note.** **[Repo]** `lib/monad/config.ts` `getStablecoin()`
defaults Monad **testnet** to `0xaC0893567D43C3E7e6e35a72803df05416C1f20D`
with the comment "Testnet defaults to a sandbox aUSDC (6 decimals)". This
address is **not verified** as a current Cleanverse deployment and must not
be assumed to be A-USDC for Rooms until confirmed (V5). On **mainnet**
`getStablecoin()` returns `MONAD_MAINNET_USDC` (regular USDC), not A-USDC.

---

## 8. A-USDC Transfer Architecture

**This is the critical open area. No final decision is made here.**

### What the repo does today — **[Repo]**

- **Direct transfer.** Single payments build `transfer(recipient, amount)`
  on the token and the user's wallet sends it (`app/api/agent/route.ts`
  ~l.464). The token sees `msg.sender = payer`, `from = payer`, `to = recipient`.
- **SplitSettlement.** `splitPayment(token, recipients[], amounts[], ref)`;
  for ERC-20 the payer first `approve`s the SplitSettlement contract for the
  exact total, then the contract calls
  `IERC20(token).transferFrom(msg.sender, r, amt)` per recipient
  (`SplitSettlement.sol:239`). The contract never holds tokens. The token
  sees `msg.sender = SplitSettlement` (the spender/operator), `from = payer`,
  `to = recipient`. It is **one payer → many recipients**.
- **PayAIForwarder / V2.** Same `approve` + `transferFrom` pattern; V2 also
  does a second `transferFrom` of a fee to a Safe-controlled treasury
  (`PayAIForwarderV2.sol`), so the **treasury** becomes a recipient.
- **Receipt verification.** `hasErc20TransferTo(logs, token, recipient, min)`
  (`lib/monad/verify.ts:26`) checks a `Transfer` log's token, `to`, and amount.
  It does **not** check `from`.

### Shape mismatch — **[Repo]-derived**

Rooms is **many payers → one recipient**. SplitSettlement is one payer →
many recipients. Using it for Rooms means each participant runs a
**single-recipient split**, which adds an `approve` + a contract intermediary
and buys nothing over a direct transfer (no fan-out). SplitSettlement is
therefore **not required** for the fixed-split MVP regardless of the answers
below.

### Candidate architectures

**A. Direct: Participant → Recipient** (`transfer`) — **[Proposed] recommended MVP, pending V4/V5**
- One signature, no approve, no PayAI contract, no new contract.
- Only question for Cleanverse: sender and recipient both A-Pass holders is
  sufficient? (Q-T6)
- Reuses the existing direct-transfer path and receipt verification (with a
  `from` check added — see §11).

**B. Contract-mediated: Participant → SplitSettlement/Forwarder → Recipient** (`approve` + `transferFrom`)
- Only makes sense if we later need atomic multi-recipient payouts or on-chain
  fees. Blocked on every question below.

**C. Escrow / pooled: Participants → Room contract → Recipient on completion**
- Gives all-or-nothing semantics and refunds, but the contract **holds**
  funds (custody), needs its own A-Pass eligibility, and is a new contract to
  write and audit. **Out of scope for MVP.**

### Questions that decide between them — all **[Needs CV]**

| # | Question | Impact |
|---|---|---|
| Q-T1 | Does a contract (SplitSettlement, Forwarder, a Room escrow) need its own A-Pass to send/receive/operate A-USDC? Can a contract even hold an A-Pass? | B and C impossible if contracts can't be verified |
| Q-T2 | Is `transferFrom` supported on A-USDC at all? | B impossible if not |
| Q-T3 | On `transfer`/`transferFrom`, which parties are checked: `from`, `to`, and/or `msg.sender` (the operator)? | If operator must be verified → B needs Q-T1 |
| Q-T4 | Is `approve` to a non-A-Pass spender allowed? | B's first step may revert |
| Q-T5 | Are contract-mediated transfers supported/permitted by policy even if technically possible (travel-rule data per transfer)? | B/C compliance |
| Q-T6 | Is a direct participant→recipient transfer between two A-Pass holders sufficient and supported with no extra data (memo/travel-rule payload, signature, allowlist)? | Confirms A |
| Q-T7 | Does a transfer require extra calldata or a different function than ERC-20 `transfer` (e.g. a compliance-aware transfer function)? | Changes the calldata builder even for A |
| Q-T8 | If PayAI ever charges a fee in A-USDC, must the fee treasury (a Safe) hold an A-Pass? | Forwarder V2 fee path; **MVP proposes no fee on Rooms** |
| Q-T9 | Behaviour when a party's A-Pass is revoked mid-flow — revert, freeze, clawback? | Room state handling |
| Q-T10 | Is A-USDC live on **Monad mainnet**, or testnet only? | Hackathon may have to run on testnet |

**Decision:** until Q-T3/Q-T6/Q-T7 are answered, the spec's working
assumption is **Architecture A**, explicitly marked as an assumption. If
Cleanverse's answers rule out A, this section must be revised before any
code is written.

---

## 9. Proposed MVP Architecture — **[Proposed]**

**In scope**
- Fixed (equal) split only.
- A-USDC only; one network (whichever Q-T10 allows).
- Verified participants only; server-enforced A-Pass gate, fail closed.
- Monad settlement; each contribution is a direct, user-signed transfer (Arch. A).
- Existing intent layer: add one intent kind for room creation.
- Existing SDK only where it fits. A direct `transfer` is not a protocol
  action today; whether to express "pay room share" as an SDK action
  (for Layer B target-allowlisting of the A-USDC address) is an
  implementation-time call. It must **not** go through SplitSettlement.
- Minimal Rooms logic in existing places:
  - `lib/rooms/` (new): room model, KV persistence, share maths, state transitions.
  - `lib/cleanverse/` (new): thin client for the eligibility check, env-configured, fail-closed, with a simulation stub for `PAYAI_MODE=simulation`.
  - `app/api/rooms/…` (new): create, get, join (+ ownership proof), check eligibility, build payment, confirm payment.
  - `app/room/[id]/page.tsx` (new): join/pay page.
- Tests in `test/` (vitest), same as the rest of the repo.

**Explicitly out of scope**
Streaming payments (stretch/future), weighted splits, escrow/refunds,
cross-chain, trading/swaps into A-USDC, arbitrary tokens, fees on rooms,
workflow engines/queues, new microservices, new databases, new smart
contracts, changes to existing contracts.

**Execution modes.** **[Repo]** `PAYAI_MODE` = `simulation` (default) or
`monad`. **[Proposed]** In simulation, the Cleanverse check is a clearly
labelled stub and no real A-USDC moves; nothing in simulation may be shown
as real verification.

---

## 10. Existing vs New

"Existing" means verified in this repo at the baseline commit.

| Component | Status | Evidence / note |
|---|---|---|
| NL intent parsing + dispatch | **Existing** | `lib/ask/intent/` |
| `room_create` intent kind | New | §5 |
| Payment validation / risk scoring | **Existing** | `lib/payment/engine.ts` |
| User-signed tx send/wait loop | **Existing** | `lib/ask/intent/orchestrate.ts` |
| Direct ERC-20 transfer calldata | **Existing** | `app/api/agent/route.ts` |
| SDK registry + Layer A/B validation | **Existing** | `lib/sdk/` |
| SplitSettlement contract + SDK action | **Existing** — not used by Rooms MVP | §8 |
| Forwarder V1/V2 with fees | **Existing** — not used by Rooms MVP | §8, Q-T8 |
| Shareable link + public checkout page pattern | **Existing** (pattern to copy) | `/pay/[id]`, `lib/platform/store.ts` |
| Receipt verification (`Transfer` to recipient ≥ amount) | **Existing** | `lib/monad/verify.ts` |
| Receipt verification bound to **sender** | New | `hasErc20TransferTo` ignores `from` |
| Idempotency + rate limiting | **Existing** | `lib/platform/idempotency.ts`, `ratelimit.ts` |
| KV store | **Existing** | `lib/platform/kv.ts` |
| `.nad` resolution | **Existing** | `lib/monad/domain-resolver.ts` |
| Wallet connect | **Existing** | `lib/wallet-service/` |
| Wallet-ownership proof for a participant | New / **check** `lib/platform/auth.ts` | §4 step 4 |
| Room model, state machine, KV persistence | New | §6 |
| Room API routes + `/room/[id]` page | New | §9 |
| Cleanverse client (A-Pass eligibility) | New | §7, blocked on V1–V7 |
| A-USDC token config | New (testnet default address exists but unverified) | §7 |
| `lib/plan` | **Does not exist** | §1 note |
| Streaming payments | Not planned for MVP | §12 |

---

## 11. Security and Compliance Model

1. **Verification before eligibility.** `eligible` is set only from a
   positive, current Cleanverse answer. Any error, timeout, unknown or
   negative answer → not eligible. No manual override, no admin bypass, no
   "verify later".
2. **No payment before verification.** The server refuses to build a
   payment transaction for a participant who is not both ownership-proven
   and eligible. The UI hiding the button is not the control; the API is.
3. **No bypass of Cleanverse compliance.** PayAI does not wrap, re-route, or
   convert A-USDC to avoid the token's own transfer rules, and does not
   introduce an intermediary contract whose status is unconfirmed (§8).
4. **Wallet ownership.** The address being verified must be proven to belong
   to the person in the session (signed message with a server nonce, short
   expiry, bound to room ID). Otherwise anyone could "borrow" a verified
   stranger's address.
5. **Contribution is bound to the participant.** Confirmation must check the
   `Transfer` log's `from` equals the participant's proven address, `to`
   equals the room recipient, token equals the room's A-USDC address, amount
   equals the required share, and the tx succeeded on the configured chain.
   (The existing helper doesn't check `from`; Rooms must.) Each tx hash is
   counted at most once, globally.
6. **User-controlled signing.** Every payment is signed by the participant's
   own wallet. PayAI builds unsigned transactions only.
7. **No private keys.** No server-held participant keys; the Payment
   Automations agent wallet and the Telegram bot's custodial wallets are
   **not** used for Rooms.
8. **No custody.** Funds go directly participant → recipient in the MVP;
   PayAI and its contracts never hold room funds. Escrow would change this
   and is out of scope unless explicitly required later.
9. **Immutable room terms.** After creation, asset, recipient, total,
   participant target and share cannot change. Changing terms = new room.
   Confirmed payments are append-only and never deleted or edited.
10. **Re-check at confirmation.** Eligibility is re-checked when a
    contribution is confirmed (revocation between build and confirm).
    Behaviour if it is now revoked but the transfer already succeeded
    on-chain: **[Needs CV]** Q-T9; proposed default is to record the payment
    as `rejected` for room purposes and surface it to the creator, never to
    silently count it.
11. **Privacy / data minimisation.** PayAI stores only: address, eligibility
    boolean/status, timestamp. **No PII** from Cleanverse is requested,
    stored, or logged. The public room page shows progress as counts
    (e.g. "3 of 5 paid"); whether it may show participant addresses is a
    product decision (Q-P4) — default is **not** to show other participants'
    addresses. A connected user sees only their own payment history, per the
    existing rule (`listTx(merchantId, { sender })`).
12. **No fabricated data.** Empty or unknown states show "—". Simulation mode
    is labelled; no mock verification or balances are shown as real.
13. **Abuse controls.** Room creation, join, eligibility checks and
    confirmations are rate-limited (`rateLimited`, keyed by wallet), and
    confirmation is idempotent (`claimRequest`).
14. **Secrets.** Cleanverse credentials (V7) live only in the deploy host's
    env, like all other secrets. Never committed.
15. **Honest claims.** Product copy may say "non-custodial" for Rooms
    payments (user-signed, direct transfer), but must not claim Cleanverse
    compliance properties PayAI has not verified.

---

## 12. Streaming (future / stretch)

Not part of the MVP. Any streaming design depends on answers to Q-T1–Q-T5
(streaming almost certainly means a contract operating on A-USDC) and would
be specified in a separate section once those are answered.

---

## 13. Implementation order (once unblocked) — **[Proposed]**

1. Get answers to V1–V7 and Q-T3, Q-T6, Q-T7, Q-T10. Update §7/§8.
2. Room model + KV persistence + state transitions (pure, unit-tested).
3. Cleanverse client behind an interface, with a labelled simulation stub.
4. API routes (create/get/join/verify/build/confirm) with ownership proof,
   rate limiting, idempotency.
5. Join/pay page.
6. `room_create` intent.
7. End-to-end on the network A-USDC actually lives on (testnet if Q-T10 says so).

---

## 14. Unresolved questions

**Cleanverse — blocking**
- V1–V10 (§7) and Q-T1–Q-T10 (§8). Highest priority: **Q-T3, Q-T6, Q-T7,
  Q-T10, V2, V5, V7, V8.**

**Product — PayAI to decide**
- Q-P1: Does the creator automatically count as a participant?
- Q-P2: Totals that don't divide evenly at 6 decimals — refuse, or let the
  last share absorb the remainder? (Proposed: refuse and ask.)
- Q-P3: Refunds when a room expires or is cancelled after partial payment.
  (Proposed MVP: none; recipient holds what was paid; stated clearly in UI.)
- Q-P4: May the room page show participant addresses to other participants?
- Q-P5: Room expiry default and maximum participants.
- Q-P6: Can a participant pay for someone else's share? (Proposed: no.)

**Repo — check at implementation time**
- Whether `lib/platform/auth.ts` provides a reusable signed-challenge flow for ownership proof.
- Whether "pay room share" should be an SDK action (A-USDC target allowlist) or reuse the direct-transfer path.

---

## 15. Sources

**Repository** (baseline `e648d7f`): all paths cited inline above.

**Cleanverse — public, marketing-level only [CV-Public]** (surfaced via web
search; direct page access was blocked from this environment, so content is
from search summaries):
- [Cleanverse Build: Verified Finance Hackathon](https://cleanverse.com/hackathon) — mentions CVI/CVA API access and an "API v3 reference"; not read.
- [Cleanverse Brings Bank-Grade Trust to On-Chain Transfers](https://cleanverse.com/press-releases/1) — A-Pass / A-Token descriptions.

**Monad** (context only): [Tokens and Bridges — Monad Documentation](https://docs.monad.xyz/developer-essentials/network-information/tokens-and-bridges).

Third-party hackathon repositories that reportedly integrated Cleanverse on
testnet exist but are **not** authoritative and were not used as a source for
any interface in this document.
