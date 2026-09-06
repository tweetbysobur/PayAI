/**
 * PHASE 7C — the real, single Aave V3 Monad ProtocolAdapter entrypoint.
 *
 * Phases 7A/7B each shipped their own standalone single-action protocol
 * factory (createAaveV3MonadSupplyProtocol in ./supply,
 * createAaveV3MonadWithdrawProtocol in ./withdraw), because each was
 * developed and security-reviewed independently. Both declare
 * `protocolId: "aave-v3-monad"`, and lib/sdk/registry.ts's
 * registerProtocol() rejects a second registration of an already-registered
 * protocolId (by design — see registry.ts's own doc on why a duplicate
 * protocolId is refused loudly rather than merged or overwritten). So the
 * two standalone factories can never both be registered in the same
 * registry instance — which is exactly what production needs to do.
 *
 * The fix is pure composition, not a registry change: registerProtocol()
 * already accepts one ProtocolAdapter whose `actions` array can hold any
 * number of independently-built Action objects (this is exactly how WMON's
 * own createWmonProtocol() already registers wrap AND unwrap together —
 * see lib/sdk/actions/wmon/index.ts). supplyAction()/withdrawAction() were
 * each already a plain `(chainId) => Action` builder before this phase;
 * they are now exported (mechanical visibility change only, zero logic
 * change) so this file can call both and combine their results into ONE
 * adapter, instead of each living inside its own single-action adapter.
 *
 * This is the production entrypoint going forward. The two standalone
 * factories in ./supply and ./withdraw are left in place, UNCHANGED, so
 * their own already-reviewed Phase 7A/7B test suites keep working exactly
 * as before — they remain valid for isolated single-action testing, but
 * are not what a real bootstrap.ts wiring should call (that would still
 * hit the same duplicate-protocolId rejection this file exists to avoid).
 *
 * Registry semantics are completely untouched: no change to
 * lib/sdk/registry.ts was necessary or made.
 *
 * Server-side (reads app config and the chain). Registered by an explicit
 * call to createAaveV3MonadProtocol() + registerProtocol() — NOT
 * auto-registered at import and NOT wired into bootstrap.ts in this phase
 * (bootstrap.ts is Ask PayAI's registration surface; wiring it in is a
 * separate, later decision, explicitly out of scope here).
 */
import "server-only";
import { getChain } from "@/lib/monad/config";
import type { ProtocolAdapter } from "@/lib/sdk/types";
import { POOL, MONAD_MAINNET_CHAIN_ID } from "./shared";
import { supplyAction } from "./supply";
import { withdrawAction } from "./withdraw";

/**
 * Builds the ONE real Aave V3 Monad protocol adapter — supply and withdraw
 * together, both pinned to the same canonical Pool. Returns null on any
 * chain other than Monad mainnet, same "register nothing rather than pin
 * to a missing target" discipline every other factory in this SDK follows.
 */
export function createAaveV3MonadProtocol(): ProtocolAdapter | null {
  const chainId = getChain().id;
  if (chainId !== MONAD_MAINNET_CHAIN_ID) return null;
  return {
    protocolId: "aave-v3-monad",
    name: "Aave V3 (Monad)",
    chainId,
    docsUrl: "https://aave.com/docs",
    allowedTargets: [POOL],
    actions: [supplyAction(chainId), withdrawAction(chainId)],
  };
}

/** Test-only export of the fixed, verified Pool address, so the
 *  consolidated test suite can assert against it without re-declaring a
 *  magic string independently. */
export const __testing = { POOL, MONAD_MAINNET_CHAIN_ID };

/** Test-only: forget the shared cached reserve list (shared by both
 *  actions). Re-exported so the consolidated test suite can use the same
 *  reset call the per-action suites already use. */
export { __resetReservesCacheForTests } from "./shared";
