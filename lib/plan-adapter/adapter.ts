/**
 * Deterministic Intent Adapter — assembly (Phase 2C, Stage 5A).
 *
 *   text ─parseIntent()→ ParsedIntent ─assembleIntentGraph(ctx)→ IntentGraph draft
 *        → validateIntentGraph()  (the final authority; Plan Service in 5B)
 *
 * Turns a ParsedIntent (./grammar.ts) into an IntentGraph DRAFT, adding only
 * what the caller vouches for — the request id, the authenticated wallet and
 * the server's chain (AssemblyContext) — never anything from the text. The
 * draft is built field by field from approved values: pinned action refs,
 * base-unit literals, the configured stablecoin address, output bindings and
 * described (unresolved) recipients. It carries no target, calldata, value,
 * fee, approval, quote, signature or runtime state.
 *
 * Action identities are PINNED to exact versions and must be registered;
 * otherwise ACTION_UNAVAILABLE — never a substitute or a "latest" version.
 *
 * Never executes, quotes, builds, signs, broadcasts, resolves recipients,
 * reads a wallet or the chain, or creates a plan.
 *
 * Server-only (reads server token configuration and the SDK registry).
 */
import "server-only";
import type { Address } from "viem";
import { getChain, getStablecoin } from "@/lib/monad/config";
import { ensureBuiltinsRegistered } from "@/lib/sdk/bootstrap";
import { getAction } from "@/lib/sdk/registry";
import type { ActionNode, ActionRef, InputValue, IntentGraph } from "@/lib/plan/types";
import { ADAPTER_VERSION, adapterError, parseIntent, type AdapterError, type Asset, type ParsedIntent, type ParsedStep, type TokenConfig } from "./grammar";

export { ADAPTER_VERSION, parseIntent };
export type { AdapterError, ParsedIntent, ParseResult, TokenConfig } from "./grammar";

/** The exact production actions this grammar produces. Never "latest". */
export const PINNED_ACTIONS = {
  swap: { protocolId: "payai", actionId: "swap", version: "1.0.0" },
  transfer: { protocolId: "payai", actionId: "transfer", version: "1.0.0" },
} as const satisfies Record<ParsedStep["kind"], ActionRef>;

/** Trusted identity supplied by the server-side caller — never parsed from text. */
export interface AssemblyContext {
  intentId: string;
  /** The authenticated session's wallet. */
  wallet: string;
  /** The server's active chain. */
  chainId: number;
}

export interface AdapterConfig {
  tokens: TokenConfig;
  /** The configured stablecoin's address, exactly as configured; null if none. */
  stableAddress: string | null;
}

/** Native MON in a REQUIRED token input (e.g. swap's tokenOut) — the SDK's own
 *  sentinel. An optional token input is simply left out for MON. */
const NATIVE_TOKEN = "0x0000000000000000000000000000000000000000";

/** Token configuration from the existing config module. A missing stablecoin
 *  leaves only MON supported (its symbol is then UNSUPPORTED_TOKEN). */
export function adapterConfig(): AdapterConfig {
  const monDecimals = getChain().nativeCurrency.decimals;
  let stable: { address: string; symbol: string; decimals: number } | null = null;
  try {
    const s = getStablecoin();
    if (/^0x[0-9a-fA-F]{40}$/.test(s.address) && Number.isInteger(s.decimals) && s.decimals >= 0 && s.decimals <= 77 && /^[A-Za-z][A-Za-z0-9]{1,10}$/.test(s.symbol)) {
      stable = { address: s.address, symbol: s.symbol, decimals: s.decimals };
    }
  } catch {
    stable = null;
  }
  return {
    tokens: { monDecimals, stable: stable ? { symbol: stable.symbol, decimals: stable.decimals } : null },
    stableAddress: stable ? stable.address : null,
  };
}

const PENDING = () => ({ validation: { state: "pending" as const }, execution: { state: "pending" as const }, verification: { state: "pending" as const } });
const literal = (value: string): InputValue => ({ kind: "literal", value });

/**
 * The IntentGraph draft for a ParsedIntent, or ACTION_UNAVAILABLE when a
 * pinned action isn't registered (e.g. no swap executor configured). Wallet,
 * chain and id come only from `ctx`; validation is the caller's next step.
 */
export function assembleIntentGraph(parsed: ParsedIntent, ctx: AssemblyContext, config: AdapterConfig = adapterConfig()): { ok: true; draft: IntentGraph } | AdapterError {
  ensureBuiltinsRegistered();
  for (const step of parsed.steps) {
    const ref = PINNED_ACTIONS[step.kind];
    if (!getAction(ref.protocolId, ref.actionId, ref.version)) return adapterError("ACTION_UNAVAILABLE");
  }

  const stableToken = (): string | null => config.stableAddress;
  const tokenLiteral = (a: Asset): string | null => (a === "MON" ? NATIVE_TOKEN : stableToken());

  const nodes: ActionNode[] = [];
  for (let i = 0; i < parsed.steps.length; i++) {
    const step = parsed.steps[i];
    const nodeId = `n${i + 1}`;
    const inputs: Record<string, InputValue> = {};
    // Actions run in the order the user wrote them: each one depends on the
    // one before it. The Plan Service then never quotes this action until that
    // one has confirmed, and a failure there skips everything after it — so a
    // multi-action plan stops at the first failed action instead of running
    // on past it, and a completed action is never run again.
    const dependsOn: string[] = i > 0 ? [`n${i}`] : [];

    if (step.kind === "swap") {
      const out = tokenLiteral(step.tokenOut);
      if (out === null) return adapterError("UNSUPPORTED_TOKEN");
      if (step.tokenIn === "STABLE") {
        const tin = stableToken();
        if (tin === null) return adapterError("UNSUPPORTED_TOKEN");
        inputs.tokenIn = literal(tin);
      }
      inputs.tokenOut = literal(out);
      inputs.amountIn = literal(step.amountIn);
    } else {
      inputs.recipient = step.recipient.source === "address"
        ? { kind: "recipient", display: step.recipient.display, source: "address", address: step.recipient.display as Address }
        : { kind: "recipient", display: step.recipient.display, source: step.recipient.source };
      if (step.token === "STABLE") {
        const t = stableToken();
        if (t === null) return adapterError("UNSUPPORTED_TOKEN");
        inputs.token = literal(t);
      }
      if (step.amount.kind === "units") {
        inputs.amount = literal(step.amount.units);
      } else {
        const producer = `n${step.amount.step + 1}`;
        inputs.amount = { kind: "output", node: producer, output: step.amount.output };
        if (!dependsOn.includes(producer)) dependsOn.push(producer);
      }
    }
    nodes.push({ nodeId, ref: { ...PINNED_ACTIONS[step.kind] }, inputs, dependsOn, ...PENDING() });
  }

  return {
    ok: true,
    draft: {
      id: ctx.intentId,
      version: 1,
      chainId: ctx.chainId,
      wallet: ctx.wallet as Address,
      nodes,
      source: { text: parsed.sourceText, adapter: "deterministic", adapterVersion: ADAPTER_VERSION },
      status: "draft",
    },
  };
}

/** parseIntent + assembleIntentGraph with the server's token configuration. */
export function draftIntentGraph(text: string, ctx: AssemblyContext): { ok: true; draft: IntentGraph } | AdapterError {
  const config = adapterConfig();
  const parsed = parseIntent(text, config.tokens);
  if (!parsed.ok) return parsed;
  return assembleIntentGraph(parsed, ctx, config);
}
