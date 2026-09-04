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
 * The ONLY protocol registered in Phase 2 is WMON — deliberately. Adding a
 * second protocol is a later phase; this file is the one place that decides
 * what is active, so "what can Ask PayAI reach through the SDK" is auditable
 * in a single glance.
 *
 * Server-only: the action modules it registers are server-only (they read
 * app config and build calldata).
 */
import "server-only";
import { getProtocol, registerProtocol } from "./registry";
import { createWmonProtocol } from "./actions/wmon";

let done = false;

export function ensureBuiltinsRegistered(): void {
  if (done) return;
  if (!getProtocol("wmon")) {
    const wmon = createWmonProtocol();
    if (wmon) registerProtocol(wmon);
  }
  done = true;
}

/** Test-only: forget the latch so a test that reset the registry can
 *  re-bootstrap. Not called in application code. */
export function __resetBootstrapForTests(): void {
  done = false;
}
