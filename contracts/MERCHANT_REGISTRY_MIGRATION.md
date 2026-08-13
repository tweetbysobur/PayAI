# MerchantRegistry replacement — migration plan

Status: **not started**. Nothing in this document has been executed. This is
the plan for the one deployment we're deliberately holding back — see
"Deployable now vs. requires this migration" below.

## Why this is its own migration, not a normal redeploy

L-02's fix lives inside `MerchantRegistry.sol` itself (a new `isRegistrar`
role — see `SECURITY_PROPERTIES.md` INVARIANT-MR-1). Unlike `AutomationVault`
or `PaymentExecutor`, `MerchantRegistry` is **stateful in a way that matters
to real users**: it holds every registered merchant's `active`/`volume`/
`paymentCount`, and `PaymentExecutor.merchantRegistry` is `immutable`
(`PaymentExecutor.sol:71`, set once in the constructor, no setter) — so
redeploying the registry necessarily means redeploying `PaymentExecutor` too,
which is why this can't be folded into the "just ship the source fix" wave
the other five findings went through.

## Deployable now vs. requires this migration

| Finding | Fix location | Needs new `MerchantRegistry`? |
|---|---|---|
| M-01 (reservation isolation) | `AutomationVault.sol` | No |
| L-01 (native payment lifecycle) | `PaymentExecutor.sol` | No |
| Merchant-cap invariant | `PaymentExecutor.sol` | No |
| L-03 (PATCH state validation) | App layer (already merged to `main`) | No — not a contract at all |
| L-04 (swap min-output) | App layer (already merged to `main`) | No — not a contract at all |
| L-05 (reserved-vault accounting) | App layer (already merged to `main`) | No — not a contract at all |
| **L-02 (manager/agent authorization)** | **`MerchantRegistry.sol`** | **Yes** |

`AutomationVault` and `PaymentExecutor` can be redeployed **reusing the
existing, unmodified `MerchantRegistry`** — exactly the pattern
`contracts/scripts/deploy-suite-v4-ultrafuzz.js` already uses (it did this
for the M-02 fix in July; the same script, run again, now also carries M-01,
L-01, and the merchant-cap fix, because Hardhat compiles from whatever the
`.sol` source currently says). That script needs one update before anyone
runs it: **confirm which `PaymentExecutor`/`AutomationVault` addresses are
actually live** in Vercel's env right now and update `EXISTING_AGENT`/
`OLD_EXECUTOR`/`OLD_VAULT` accordingly — `deployed-suite-v4-ultrafuzz.json`
in this repo says that redeploy happened 2026-07-31, but the script's own
comments say the cold-wallet `setRecorder` step for it was only ever
*printed*, never confirmed executed. Don't assume; check on-chain.

L-02 stays a source-level-only fix until this plan is executed.

## What has to be preserved

Read directly from the live `MerchantRegistry` (`0x3e5F94168B6748E0396d1BBB9151bC62236f4DEb`)
and its deploy history:

1. **Every registered merchant**: `wallet`, `name`, `active`, `volume`,
   `paymentCount`, `registeredAt` — enumerable via `allMerchants()` +
   `getMerchant(wallet)` for each (`lib/monad/contracts.ts:400-418` already
   does exactly this read for the dashboard, so the same call shape is known-good).
2. **Role grants** — `isManager` and `isRecorder` (the only two roles the
   *current* registry has; `isRegistrar` is new in the fix and won't exist
   pre-migration). These are **not enumerable on-chain** — there's no
   `allManagers()`. The only way to reconstruct "who currently holds what"
   is replaying `ManagerSet`/`RecorderSet` event logs from the registry's
   deployment block to now and taking the latest event per address (a grant
   can be revoked and re-granted; only the last one counts). Known grants
   from the deploy scripts in this repo (see `deploy-suite-v3-fresh.js:87-105`):
   owner `0x8eed298c65887bb53a61e28c19a7252b9dc2364f` is manager, the hot
   agent `0x25b84164461FE6EA4dAB470460D0c4eb7c7Fdc3a` is explicitly *not* a
   manager, and executor `0xCB847C0B15798233b8a18CE926eD8b6E4Cd1D873` is a
   confirmed recorder — but later executors
   (`0x824050B7ef424a730779f676EA6863f908d82991`,
   `0xB091a2E5cE8299B52cD5E2b785e0dBD52413505c`) only ever had `setRecorder`
   *printed* as a manual cold-wallet step, never confirmed run. **The event
   log replay is the source of truth, not this repo's deploy scripts.**
3. **Ownership** — the current registry `owner` (cold wallet), who must sign
   the admin calls on the new registry too.

## Resolved: volume/paymentCount are preserved, not reset

**This was originally an open decision — it's now resolved by a contract
change.** `MerchantRegistry.sol` gained a new function,
`registerMerchantWithHistory(wallet, name, active, volume, paymentCount,
registeredAt)`, plus `closeMigration()` to permanently disable it once the
migration is verified complete (see `INVARIANT-MR-4` in the contract's
NatSpec). It's `onlyOwner` — never reachable by the agent or a registrar —
and one-way: once `closeMigration()` is called, there is no function to
reopen it, so the owner does not retain a standing ability to fabricate any
merchant's historical figures after the migration event ends.

`deploy-and-migrate-merchant-registry.js` now calls this instead of plain
`registerMerchant()`, so every migrated merchant's `volume`, `paymentCount`,
and original `registeredAt` carry over from the snapshot exactly — the
dashboard's per-merchant panel (`GET /api/onchain` →
`lib/monad/contracts.ts:412-414`, which reads directly from the contract
with no independent off-chain backup) will show the same figures after
migration as before it, not a reset to 0.

Regular `registerMerchant()` — the actual L-02 fix's own gating
(`isManager`/`isRegistrar`) — is completely unaffected by this addition;
verified explicitly in `contracts/test/MerchantRegistryMigration.test.js`.

## Sequence (not run — this is the plan, for whoever holds the keys)

1. **Pre-flight**: confirm the actual live `PaymentExecutor`/`AutomationVault`
   addresses in Vercel env (don't trust this repo's JSON files alone — see
   above). Run `contracts/scripts/snapshot-merchant-registry.js` (see below)
   against mainnet to capture merchants + reconstructed role history to a
   timestamped JSON file.
2. **Deploy** new `MerchantRegistry` + new `PaymentExecutor` (paired, since
   the registry reference is immutable) + new `AutomationVault` if that
   hasn't already happened via the non-registry wave. `contracts/scripts/
   deploy-and-migrate-merchant-registry.js` (see below) does the registry +
   executor deploy and the cold-wallet-signed role wiring in one script,
   using the snapshot from step 1 to replay `registerMerchant`/`setActive`
   for every existing merchant and `setManager`/`setRecorder`/`setRegistrar`
   for every reconstructed role holder.
3. **Verify before cutover**: `merchantCount()` on the new registry equals
   the snapshot's count; spot-check a handful of merchants' `active` state;
   confirm the new executor's `merchantRegistry` reads back correctly;
   confirm the cold-wallet-only `setRecorder` grant landed (this specific
   call cannot be scripted end-to-end without the cold key — the script
   prints it as a manual step, same convention as the existing deploy
   scripts).
4. **Cutover**: update `MONAD_MAINNET_MERCHANT_REGISTRY` (and
   `MONAD_MAINNET_PAYMENT_EXECUTOR`/`MONAD_MAINNET_AUTOMATION_VAULT` if not
   already updated by the earlier non-registry wave) in Vercel, redeploy the
   app. Per the app's existing per-automation `executorAddress`/
   `vaultAddress` pinning (`PaymentAutomation` in `lib/platform/types.ts`),
   this only affects automations created *after* cutover — nothing existing
   breaks or needs its own migration.
5. **Post-cutover**: the OLD registry keeps working indefinitely for any
   pinned automation/executor still pointed at it — nothing forces a hard
   cutoff. Decide separately (product call, not a technical requirement)
   whether/when to stop the old executor's agent from being funded further.

## Scripts referenced above

Two scripts exist in `contracts/scripts/` to make this executable when
someone's ready, **neither has been run**:

- `snapshot-merchant-registry.js` — read-only. Reads `allMerchants()` +
  `getMerchant()` for every merchant, and replays `ManagerSet`/`RecorderSet`
  events from deployment to head to reconstruct current role holders. Writes
  a timestamped JSON snapshot. Safe to run any time, changes nothing on-chain.
  Respects Monad's mainnet RPC limits (100-block `eth_getLogs` windows,
  rate-limited well under 50 req/sec) and auto-derives the registry's
  deployment block from its known deploy timestamp if not given explicitly.
- `deploy-and-migrate-merchant-registry.js` — the actual migration. Deploys
  the new registry + executor, replays the snapshot's merchants via
  `registerMerchantWithHistory()` (preserving volume/paymentCount/
  registeredAt, not resetting them), calls `closeMigration()` once the
  replay is complete, wires deployer-signable role grants, and prints the
  cold-wallet-only steps (`setRecorder` for the new executor, `setManager`
  for the real owner if different from the deployer) it cannot sign itself
  — same division of labor the existing fresh-deploy scripts already use.

Both require `MONAD_AGENT_PRIVATE_KEY` and network access to Monad mainnet,
neither of which this sandbox has — that's exactly why this stays a plan
until it's run from an environment that does. Both dry-run validated
end-to-end against a local test scenario (fresh registry, merchants with
real accrued volume, a revoke-then-regrant role history) before being
handed off — see the commit history for details.
