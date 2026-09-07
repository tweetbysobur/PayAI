/**
 * PayAI SDK — Stage 1 action registry.
 *
 * Stage 1 is deliberately in-process and PayAI-controlled. An action carries
 * quote()/build()/parseResult() — those are CODE, not data, so they cannot
 * live in KV the way a merchant record does (lib/platform/merchants.ts). In
 * this stage a protocol is registered by an in-repo module calling
 * registerProtocol() at import time, exactly the way lib/monad/swap.ts's
 * candidateProviders() assembles [uniswapV3Provider, kuruProvider]: the code
 * being present in this repository, and having passed review to get here, IS
 * the registration. There is no network registration API and no
 * "pending_review" state yet — those belong to Stage 2 (spec §14), which is
 * a separate, dedicated security pass.
 *
 * This is why the registry does NOT reuse the KV+in-memory-fallback pattern
 * from merchants.ts: there is nothing serializable to put in KV, and copying
 * that infrastructure here would be cargo-culting it. The one pattern worth
 * borrowing is the dual-index idea (a primary map plus a secondary lookup
 * index), which keeps "actions on this chain" a bounded lookup rather than a
 * full scan.
 *
 * Security posture of this file specifically:
 *  - allowedTargets (protocol- and action-level) are DEEP-FROZEN on
 *    registration, so nothing holding a reference to a registered action can
 *    later widen its own reach by mutating the array in place. This closes
 *    the "action/protocol can mutate its own allowlist" failure mode at the
 *    registry boundary, independently of validate.ts's per-request check.
 *  - lookups are exact: an action is addressed by the full
 *    (protocolId, actionId, version) identity, never a "latest" alias, so a
 *    stale version can never be silently resolved to a newer one.
 *
 * Server-side (the registered action code is server-only). No signer, no
 * key, no execution — this file only stores and looks up declarations.
 */
import type { Action, ChainId, ProtocolAdapter } from "./types";

/** Thrown for every registration-time rejection. One error type so callers
 *  treat registration as pass/fail, not something to branch on by reason. */
export class SdkRegistryError extends Error {}

interface RegisteredProtocol {
  adapter: ProtocolAdapter;
  /** actionId -> version -> Action, so an exact (id, version) lookup is O(1)
   *  and "does any version of this action exist" is answerable without a
   *  scan. */
  actions: Map<string, Map<string, Action>>;
}

/** Module-level, process-lifetime store. Not on globalThis: unlike the KV
 *  fallbacks elsewhere, this holds function references from imported modules,
 *  which are already per-process — there is nothing to share across a
 *  serverless cold start that re-importing the action modules wouldn't
 *  rebuild identically. */
const protocols = new Map<string, RegisteredProtocol>();

/** chainId -> set of protocolIds with at least one action on that chain, so
 *  listActionsForChain is a bounded lookup, not a walk of every protocol. */
const byChain = new Map<ChainId, Set<string>>();

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/** Recursively freezes an object and its array/object children, returning the
 *  same reference typed as deeply readonly-safe. Applied to allowlists so a
 *  post-registration `action.allowedTargets.push(evil)` throws in strict mode
 *  (and is a silent no-op otherwise) rather than actually widening the set. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

function assertValidAddressList(label: string, list: readonly string[]): void {
  if (!Array.isArray(list) || list.length === 0) {
    throw new SdkRegistryError(`${label} must be a non-empty allowlist — an action that targets nothing can never be validated, and an empty allowlist would fail every trade closed anyway.`);
  }
  for (const a of list) {
    if (typeof a !== "string" || !ADDR_RE.test(a)) {
      throw new SdkRegistryError(`${label} contains "${a}", which is not a valid 0x address.`);
    }
  }
}

/**
 * Registers a protocol and all its actions. Rejects — loudly, at import time,
 * so a bad action can never reach a user — on any of:
 *  - a duplicate protocolId
 *  - a non-semver version
 *  - a duplicate (actionId, version) within the protocol
 *  - a malformed or empty allowlist (protocol or action level)
 *  - an action whose chainId disagrees with a target it lists (not checkable
 *    here — see validate.ts — but the chainId must at least be present)
 *  - an action declaring a target outside its own protocol's allowlist
 *    (an action can only narrow the protocol ceiling, never widen it, and
 *    this is checked once here at registration in addition to per-request)
 */
export function registerProtocol(adapter: ProtocolAdapter): void {
  if (protocols.has(adapter.protocolId)) {
    throw new SdkRegistryError(`Protocol "${adapter.protocolId}" is already registered.`);
  }
  assertValidAddressList(`Protocol "${adapter.protocolId}" allowedTargets`, adapter.allowedTargets as readonly string[]);

  const protocolTargets = new Set(adapter.allowedTargets.map((a) => a.toLowerCase()));
  const actions = new Map<string, Map<string, Action>>();

  for (const action of adapter.actions) {
    if (action.protocolId !== adapter.protocolId) {
      throw new SdkRegistryError(`Action "${action.actionId}" claims protocolId "${action.protocolId}" but is registered under "${adapter.protocolId}".`);
    }
    if (!SEMVER_RE.test(action.version)) {
      throw new SdkRegistryError(`Action "${adapter.protocolId}/${action.actionId}" has non-semver version "${action.version}".`);
    }
    if (!Number.isInteger(action.chainId)) {
      throw new SdkRegistryError(`Action "${adapter.protocolId}/${action.actionId}" has a non-integer chainId.`);
    }
    assertValidAddressList(`Action "${adapter.protocolId}/${action.actionId}" allowedTargets`, action.allowedTargets as readonly string[]);

    // An action can only ever narrow the protocol's ceiling. Checked here so
    // a widening action is refused at registration, not merely per-request.
    for (const t of action.allowedTargets) {
      if (!protocolTargets.has(t.toLowerCase())) {
        throw new SdkRegistryError(`Action "${adapter.protocolId}/${action.actionId}" lists target ${t}, which is outside its protocol's allowedTargets. An action may only narrow the protocol allowlist, never widen it.`);
      }
    }

    const versions = actions.get(action.actionId) ?? new Map<string, Action>();
    if (versions.has(action.version)) {
      throw new SdkRegistryError(`Action "${adapter.protocolId}/${action.actionId}@${action.version}" is registered twice.`);
    }
    // Freeze the allowlists so a later in-place mutation of a registered
    // action's own array can't widen its reach.
    deepFreeze(action.allowedTargets);
    versions.set(action.version, action);
    actions.set(action.actionId, versions);
  }

  deepFreeze(adapter.allowedTargets);
  protocols.set(adapter.protocolId, { adapter, actions });

  const set = byChain.get(adapter.chainId) ?? new Set<string>();
  set.add(adapter.protocolId);
  byChain.set(adapter.chainId, set);
}

export function getProtocol(protocolId: string): ProtocolAdapter | null {
  return protocols.get(protocolId)?.adapter ?? null;
}

/** Exact lookup by full identity. No "latest" resolution, by design: a
 *  version is part of the identity, so asking for one that isn't registered
 *  returns null rather than the newest — a stale ExecutionRequest can never
 *  be silently re-pointed at a version the user never previewed. */
export function getAction(protocolId: string, actionId: string, version: string): Action | null {
  return protocols.get(protocolId)?.actions.get(actionId)?.get(version) ?? null;
}

export function hasAction(protocolId: string, actionId: string, version: string): boolean {
  return getAction(protocolId, actionId, version) !== null;
}

/** Every registered version of one action, newest-registered order not
 *  guaranteed. Empty when the (protocolId, actionId) pair is unknown. Lets
 *  the validator distinguish "this action was never registered"
 *  (ACTION_NOT_FOUND) from "it exists, but not at the version this request
 *  pinned" (VERSION_MISMATCH) — two genuinely different failures that must
 *  not be collapsed. */
export function listActionVersions(protocolId: string, actionId: string): string[] {
  const versions = protocols.get(protocolId)?.actions.get(actionId);
  return versions ? [...versions.keys()] : [];
}

/** The highest registered semver of an action, or null if it isn't
 *  registered. This is the ONLY place a "current version" is chosen, and it
 *  is used solely at PREVIEW time to decide which version to PIN into the
 *  operation. Confirmation never calls this — it resolves the exact pinned
 *  version instead (see validate.ts's resolveExecutable), so a newer version
 *  registered between preview and confirm can never silently take over an
 *  in-flight operation. Compares numeric semver components, so "1.10.0"
 *  correctly outranks "1.9.0". */
export function getCurrentActionVersion(protocolId: string, actionId: string): string | null {
  const versions = listActionVersions(protocolId, actionId);
  if (versions.length === 0) return null;
  return versions.sort((a, b) => {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
    return 0;
  })[0];
}

/** Every registered action, across all protocols and versions. */
export function listActions(): Action[] {
  const out: Action[] = [];
  for (const p of protocols.values()) {
    for (const versions of p.actions.values()) {
      for (const action of versions.values()) out.push(action);
    }
  }
  return out;
}

/** Actions pinned to a specific chain — the bounded lookup the byChain index
 *  exists for. */
export function listActionsForChain(chainId: ChainId): Action[] {
  const ids = byChain.get(chainId);
  if (!ids) return [];
  const out: Action[] = [];
  for (const protocolId of ids) {
    const p = protocols.get(protocolId);
    if (!p) continue;
    for (const versions of p.actions.values()) {
      for (const action of versions.values()) {
        if (action.chainId === chainId) out.push(action);
      }
    }
  }
  return out;
}

/** Test-only reset — the module-level maps otherwise persist across test
 *  cases that re-register the same protocol id (ESM caches by specifier).
 *  Matches lib/monad/tokenIntelligence.ts's clearMarketDataCache() precedent.
 *  Not called anywhere in application code. */
export function __resetRegistryForTests(): void {
  protocols.clear();
  byChain.clear();
}
