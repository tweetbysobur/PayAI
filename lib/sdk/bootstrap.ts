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
 *
 * Server-only: the action modules it registers are server-only (they read
 * app config and build calldata).
 */
import "server-only";
import { getProtocol, registerProtocol } from "./registry";
import { createWmonProtocol } from "./actions/wmon";
import { createSplitSettlementProtocol } from "./actions/split-settlement";

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
  done = true;
}

/** Test-only: forget the latch so a test that reset the registry can
 *  re-bootstrap. Not called in application code. */
export function __resetBootstrapForTests(): void {
  done = false;
}
