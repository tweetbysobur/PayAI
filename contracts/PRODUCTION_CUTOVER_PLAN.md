# Production impact assessment & cutover plans — PaymentExecutor and AutomationVault

Status: **read-only assessment, nothing deployed, nothing modified.** Written
before any decision to deploy M-01 (`AutomationVault`) or L-01 (`PaymentExecutor`,
paired with the merchant-cap fix). No deployment date is recommended here.

Every finding below is tagged:
- **CONFIRMED** — verified directly from repository source, deploy records, or code logic.
- **UNVERIFIED** — a best-available record that has NOT been independently confirmed as current.
- **REQUIRES ON-CHAIN CHECK** — only answerable by reading live Monad mainnet state (RPC) or the app's live production database, neither reachable from this session.
- **REQUIRES PRODUCT DECISION** — a choice for the team, not a technical fact.

## Tooling status for this assessment

Four independent attempts to reach any live data source this session, all blocked:

| Attempt | Result |
|---|---|
| `usepayai.xyz/api/onchain` (app's own configured-address endpoint) | `EGRESS_BLOCKED` |
| `rpc.monad.xyz` direct | `403` at egress proxy |
| Vercel MCP `web_fetch_vercel_url` | Requires approval not granted this session |
| `monadexplorer.com` (public block explorer) | `EGRESS_BLOCKED` |

Everything below that would normally come from a chain read or the production
KV store is marked **REQUIRES ON-CHAIN CHECK** rather than guessed.

---

## 1. Current contract addresses

**UNVERIFIED** — none of these confirmed as the actual value of
`MONAD_MAINNET_PAYMENT_EXECUTOR` / `MONAD_MAINNET_AUTOMATION_VAULT` in
production. Reconstructed from `contracts/deployed-*.json`, in deploy order:

| Deployed | Registry | Executor | Vault |
|---|---|---|---|
| 2026-06-24 (v2) | `0x89A42a8d...cDa439` | `0x2919eAbb...B085da` | — |
| 2026-07-08 17:27 (v3) | `0x89A42a8d...cDa439` | `0x990DdEc5...d7a8F7` | — |
| 2026-07-08 23:16 (v3-fresh) | `0x3e5F9416...236f4DEb` | `0xCB847C0B...6E4Cd1D873` | `0x1b84c9Aa...AAD3FE0f` |
| 2026-07-22 (v4) | `0x3e5F9416...236f4DEb` (reused) | `0x824050B7...908d82991` | — |
| 2026-07-31 (v4-ultrafuzz, most recent record) | `0x3e5F9416...236f4DEb` (reused) | `0xB091a2E5...52413505c` | `0x5a3C186c...BB12a6EF61` |

Most recent record is not the same as "confirmed live" — the v4-ultrafuzz
deploy script explicitly does not touch env vars or Vercel, and its
cold-wallet `setRecorder` follow-up was only ever printed as a manual
instruction. **REQUIRES ON-CHAIN CHECK** to confirm which executor currently
holds a live `isRecorder` grant on the registry (a sure sign of which one is
actually wired up), and ideally direct confirmation of the Vercel env values.

---

## 2. Current AutomationVault

### a. Active reservations
**REQUIRES ON-CHAIN CHECK.** `AutomationVault.reservations` is a
`mapping(bytes32 => Reservation)` with no enumerable key list and no
`allReservations()`-style view — there is structurally no way to ask the
contract "list every active reservation." The only two ways to reconstruct
this: (i) the app's own production database, where every row with
`fundingMode: "reserved"` and a non-terminal `status` represents a candidate,
cross-checked against `reservedBalance(automationId)` on-chain; or (ii)
replaying `Reserved`/`Released`/`Refunded` events from the vault's deployment
block to head and netting out non-zero balances. Both require access this
session doesn't have.

### b. Automations pinned to the old vault
**REQUIRES ON-CHAIN CHECK** (more precisely: requires production database
access, not blockchain access — noting the distinction since the two need
different credentials). **CONFIRMED** from code: this data exists and is
queryable *in principle* — every automation row stores its own
`vaultAddress` (`PaymentAutomation.vaultAddress`, `lib/platform/types.ts:193`),
stamped once at creation time and never mutated afterward. So "how many
automations are pinned to vault X" is a simple filter over the production KV
store, not a chain scan — but I have no access to that live store from this
sandbox, only the schema.

### c. Whether reserved funds are currently held
**REQUIRES ON-CHAIN CHECK.** `address(vault).balance` for native MON,
`token.balanceOf(vault)` per supported ERC-20. Both are trivial single RPC
calls once mainnet is reachable — just not from here right now.

### d. What happens to each category during a vault cutover
**CONFIRMED** from code — this is the one section answerable without live
data, because it's about how the existing (already-shipped, already-live)
pinning logic behaves, not about current counts:

- Every reservation created before cutover keeps its `vaultAddress` pinned
  in its stored row. `releaseFromVault`/`refundReservationViaAgent`
  (`lib/monad/contracts.ts:289-...`, `:534-...`) already prefer that pinned
  address over whatever `getAutomationVault()` currently resolves to — this
  is the exact mechanism the L-05 fix depends on and is unrelated to it
  being correct. **Cutover does not, by itself, orphan or strand any
  existing reservation.**
- `checkFundingHealth` (the L-05 fix) reads the same pinned address, so
  health checks for pre-cutover reservations stay accurate against the OLD
  vault after cutover — they don't start reading the new one.
- Only automations created *after* the env var change get the new vault
  pinned (`app/api/automations/route.ts` stamps `vaultAddress:
  getAutomationVault()` at creation time — reads whatever's currently
  configured, once, at that moment).
- **Operational dependency, not a code risk:** the OLD vault continues to
  trust exactly the same `isAgent` grant it was deployed with — deploying a
  NEW vault doesn't revoke anything on the old one. The agent's hot wallet
  must simply stay funded with enough native MON to keep paying gas for
  BOTH vaults for as long as any reservation remains open against the old
  one. **REQUIRES PRODUCT DECISION**: how long to keep operating both, and
  whether/when to actively sweep remaining old-vault reservations to zero
  (fully optional — nothing forces this).

---

## 3. Current PaymentExecutor

### a. Pending payment requests
**REQUIRES ON-CHAIN CHECK.** Unlike reservations, this one IS enumerable on
current live bytecode — `requestsCount()` + `getRequest(i)` for
`i in [0, requestsCount())`, filtered to `paid == false` — a straightforward
read-only loop once mainnet RPC is reachable. Not run from here.

### b. Active automations/workflows referencing the current executor
Same shape as vault pinning above: **CONFIRMED** in principle
(`PaymentAutomation.executorAddress`, `lib/platform/types.ts:191`, stamped
at creation), **REQUIRES ON-CHAIN CHECK** (production DB access) for the
actual count.

### c. Allowances needing re-approval after a new executor
**CONFIRMED**, and this one doesn't need live data to know it's required —
it's a structural fact about ERC-20: `approve()` is per-spender. The agent's
current USDC (and any other ERC-20) allowance was granted to the OLD
executor's address specifically; `executePayment`/`executePaymentFrom`/
`payRequest`'s ERC-20 path pulls via `transferFrom(agent, ..., amount)` from
whichever address is `msg.sender` on the CURRENT executor, so **a fresh
`approve()` from the agent wallet to the new executor's address is required
before any ERC-20 payment can settle on it** — this doesn't touch or reduce
the OLD approval at all. Native MON payments need no approval (sent via
`msg.value`), so this only affects the ERC-20 path. The *current allowance
amount* on the old executor is **REQUIRES ON-CHAIN CHECK** if that number
specifically matters for planning.

---

## 4. Safe cutover plan — PaymentExecutor (L-01 + merchant-cap)

1. **Pre-flight** (all REQUIRES ON-CHAIN CHECK, do before proceeding):
   confirm the actual live executor address (Vercel env or `isRecorder`
   status on the registry), enumerate pending (`paid == false`) requests via
   `requestsCount()`/`getRequest()`, confirm current agent→executor USDC
   allowance.
2. **Deploy** the new `PaymentExecutor` reusing the existing
   `MerchantRegistry` — `contracts/scripts/deploy-suite-v4-ultrafuzz.js`
   already implements exactly this shape; needs its hardcoded
   `EXISTING_AGENT`/`OLD_EXECUTOR`/`OLD_VAULT` constants reviewed against
   step 1's confirmed values before running.
3. **Cold-wallet step** (cannot be scripted, by design — same reason
   `deploy-suite-v4-ultrafuzz.js` only prints it): the real owner signs
   `MerchantRegistry.setRecorder(newExecutor, true)`.
4. **Agent approves** USDC (and any other supported ERC-20) to the new
   executor's address. Old approval is untouched and keeps working for the
   old executor.
5. **Decide what happens to pending requests** found in step 1
   (**REQUIRES PRODUCT DECISION**): the old executor keeps functioning
   indefinitely, so an open request can simply be paid there via
   `payRequest` before cutover, or left as a stale historical record if
   abandoned — nothing forces a resolution before switching the env var.
6. **Cutover**: update `MONAD_MAINNET_PAYMENT_EXECUTOR`, redeploy the app.
   Only NEW `createPaymentRequest`/`executePayment` calls after this point
   use the new address; nothing in-flight breaks.
7. **Old executor stays queryable** indefinitely for historical
   `getPayment`/`getRequest` reads — no forced retirement.

## 5. Safe cutover plan — AutomationVault (M-01)

Structurally simpler than the executor cutover: `AutomationVault` has no
external dependency needing a permission grant (its constructor sets
`isAgent[initialAgent] = true` directly — no equivalent of the registry's
cold-wallet `setRecorder` step).

1. **Pre-flight** (REQUIRES ON-CHAIN CHECK): enumerate active reservations
   against the current vault (via the production DB filtered by
   `vaultAddress`, cross-checked against `reservedBalance()` on-chain — see
   section 2a) and confirm current vault balance per token.
2. **Deploy** the new `AutomationVault(owner, agent)` — same
   `owner`/`agent` as the current one, no registry dependency at all.
3. **Cutover**: update `MONAD_MAINNET_AUTOMATION_VAULT`, redeploy the app.
   Every automation created after this point gets the new vault's address
   pinned at creation time; every reservation created before it keeps
   targeting the old vault via its own pinned `vaultAddress` — confirmed
   safe by the L-05 fix specifically (section 2d above).
4. **No forced fund movement.** The old vault keeps working — release and
   refund both continue to function against it — for as long as any
   reservation remains open there. Sweeping it to zero is an operational
   choice, not a cutover requirement (**REQUIRES PRODUCT DECISION** on
   timing, if wanted at all).
5. **Operational note**: keep the agent wallet funded for gas against BOTH
   vaults until the old one's reservations are confirmed drained.

---

## What this assessment deliberately does NOT do

- No deployment date recommended.
- No deployment script executed.
- No mainnet state modified, read, or written — every finding above is
  either a repository fact or an explicit "requires access this session
  doesn't have."
