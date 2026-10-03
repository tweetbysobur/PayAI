/**
 * Registers PayAI's built-in Stage 1 protocol actions into the registry.
 *
 * Stage 1 registration is a code call, not a network API (see registry.ts's
 * own doc), so SOMETHING has to make that call. This is that something: an
 * idempotent bootstrap the server-side entry points (the classifier's
 * discovery step and the /api/ask/action* routes) call before they read the
 * registry, so the built-ins are present regardless of which entry point the
 * request happened to hit first after a cold start.
 *
 * Idempotent by design: registerProtocol throws on a duplicate, so this
 * guards every registration behind a "not already there" check and a
 * process-level `done` latch. Safe to call on every request.
 *
 * Registered protocols (this file is the one place that decides what Ask PayAI
 * can reach through the SDK, so it's auditable in a single glance):
 *   - WMON       — wrap/unwrap MON ⇄ WMON (Phase 1/2).
 *   - payai-settlement — split_payment, native MON split across recipients
 *     through the audited, mainnet-deployed SplitSettlement contract (Phase 5).
 *     Registers only on a chain where SplitSettlement is deployed (mainnet).
 *   - aave-v3-monad — supply/withdraw against the verified Aave V3 Pool on
 *     Monad mainnet (Phase 7A-7C), the first EXTERNAL (non-PayAI-owned)
 *     protocol. Registered via the single consolidated factory
 *     (createAaveV3MonadProtocol — see lib/sdk/actions/aave-v3-monad/index.ts)
 *     so both actions share one protocolId registration, never two. Registers
 *     only on Monad mainnet, same "register nothing rather than pin to a
 *     missing target" discipline as the other two.
 *   - payai — PayAI's own actions under ONE protocol registration: transfer
 *     (Phase 2B; only with forwarder payments enabled) and swap (Phase 2D;
 *     only on mainnet with a PayAI trade executor enabled). The protocol's
 *     allowlist is exactly the union of its actions' targets.
 *
 * Server-only: the action modules it registers are server-only (they read
 * app config and build calldata).
 */
import "server-only";
import { getProtocol, registerProtocol } from "./registry";
import { createWmonProtocol } from "./actions/wmon";
import { createSplitSettlementProtocol } from "./actions/split-settlement";
import { createAaveV3MonadProtocol } from "./actions/aave-v3-monad";
import { createTransferProtocol } from "./actions/transfer";
import { createSwapAction } from "./actions/swap";
import type { ProtocolAdapter } from "./types";

let done = false;

export function ensureBuiltinsRegistered(): void {
  if (done) return;
  if (!getProtocol("wmon")) {
    const wmon = createWmonProtocol();
    if (wmon) registerProtocol(wmon);
  }
  if (!getProtocol("payai-settlement")) {
    const split = createSplitSettlementProtocol();
    if (split) registerProtocol(split);
  }
  if (!getProtocol("aave-v3-monad")) {
    const aave = createAaveV3MonadProtocol();
    if (aave) registerProtocol(aave);
  }
  if (!getProtocol("payai")) {
    const payai = createPayAIProtocol();
    if (payai) registerProtocol(payai);
  }
  done = true;
}

/**
 * PayAI's own actions under ONE protocol registration, each present only when
 * its settlement path is enabled: transfer (the forwarder — it has no other
 * path) and swap (a PayAI trade executor — it has no direct-router path). The
 * protocol's allowlist is exactly the union of its actions' targets. Null when
 * neither is available.
 */
function createPayAIProtocol(): ProtocolAdapter | null {
  const transfer = createTransferProtocol();
  const swap = createSwapAction();
  const actions = [...(transfer?.actions ?? []), ...(swap ? [swap] : [])];
  if (actions.length === 0) return null;
  const targets = [...new Map(actions.flatMap((a) => a.allowedTargets).map((t) => [t.toLowerCase(), t])).values()];
  return {
    protocolId: "payai",
    name: "PayAI",
    chainId: actions[0].chainId,
    docsUrl: "https://usepayai.xyz",
    allowedTargets: targets,
    actions,
  };
}

/** Test-only: forget the latch so a test that reset the registry can
 *  re-bootstrap. Not called in application code. */
export function __resetBootstrapForTests(): void {
  done = false;
}
