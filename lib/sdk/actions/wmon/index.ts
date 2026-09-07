/**
 * First real PayAI SDK action: wrap / unwrap MON ⇄ WMON.
 *
 * This exists to prove the SDK path end to end against a REAL contract with
 * ZERO new risk, not to be a showcase integration:
 *  - WMON is the canonical wrapped-native token already configured in this
 *    app (lib/monad/config.ts's getWrappedNative(), address
 *    0x3bd3…433A on mainnet) — not a fabricated ExampleFi, not a placeholder.
 *  - Both actions are a SINGLE step against ONLY the WMON contract:
 *    wrap = deposit() (payable), unwrap = withdraw(amount). Neither needs an
 *    ERC-20 approval (you wrap by sending native value; you unwrap your own
 *    balance), so there is no second target, no allowance, no new signer.
 *  - The ABI is the existing WMON_ABI from lib/monad/abi.ts — no new calldata
 *    surface is introduced.
 *  - 1 WMON is always exactly 1 MON by the contract's definition, so quote()
 *    is honest with no RPC and no balance read: it states the 1:1 conversion,
 *    nothing it can't guarantee.
 *
 * Server-side (reads app config). Registered by an explicit call to
 * createWmonProtocol() + registerProtocol() — NOT auto-registered at import,
 * so importing this module has no side effects and Phase 1 wires nothing into
 * Ask PayAI yet (that is Phase 2).
 */
import "server-only";
import { encodeFunctionData, parseUnits, decodeEventLog, formatUnits, type Address } from "viem";
import { WMON_ABI } from "@/lib/monad/abi";
import { getWrappedNative, getChain } from "@/lib/monad/config";
import type { Action, ActionInputs, ActionQuoteResult, ActionReceipt, ProtocolAdapter, UnsignedActionStep } from "@/lib/sdk/types";

const PROTOCOL_ID = "wmon";
const VERSION = "1.0.0";

/** Deposit/Withdrawal events for result parsing — the WMON_ABI in
 *  lib/monad/abi.ts is function-only, so the two events are declared here
 *  rather than widening that shared ABI for one consumer. */
const WMON_EVENTS = [
  { type: "event", name: "Deposit", inputs: [{ name: "dst", type: "address", indexed: true }, { name: "wad", type: "uint256", indexed: false }] },
  { type: "event", name: "Withdrawal", inputs: [{ name: "src", type: "address", indexed: true }, { name: "wad", type: "uint256", indexed: false }] },
] as const;

function wrapAction(wmon: Address, chainId: number): Action {
  return {
    protocolId: PROTOCOL_ID, actionId: "wrap", version: VERSION,
    name: "Wrap MON", description: "Wrap native MON into WMON (1:1).",
    chainId, allowedTargets: [wmon],
    inputSchema: { amount: { type: "amount", required: true, description: "Amount of MON to wrap", decimals: 18 } },
    async quote(inputs: ActionInputs): Promise<ActionQuoteResult> {
      const amount = inputs.amount;
      return {
        summary: `Wrap ${amount} MON into ${amount} WMON`,
        details: { rate: "1 MON = 1 WMON", youReceive: `${amount} WMON` },
        quotedAt: Date.now(),
      };
    },
    async build(inputs: ActionInputs): Promise<UnsignedActionStep[]> {
      const value = parseUnits(inputs.amount, 18);
      return [{
        kind: "action", label: `Wrap ${inputs.amount} MON`,
        tx: { to: wmon, data: encodeFunctionData({ abi: WMON_ABI, functionName: "deposit" }), value: value.toString() },
      }];
    },
    parseResult: parseWmonReceipt,
  };
}

function unwrapAction(wmon: Address, chainId: number): Action {
  return {
    protocolId: PROTOCOL_ID, actionId: "unwrap", version: VERSION,
    name: "Unwrap WMON", description: "Unwrap WMON back into native MON (1:1).",
    chainId, allowedTargets: [wmon],
    inputSchema: { amount: { type: "amount", required: true, description: "Amount of WMON to unwrap", decimals: 18 } },
    async quote(inputs: ActionInputs): Promise<ActionQuoteResult> {
      const amount = inputs.amount;
      return {
        summary: `Unwrap ${amount} WMON into ${amount} MON`,
        details: { rate: "1 WMON = 1 MON", youReceive: `${amount} MON` },
        quotedAt: Date.now(),
      };
    },
    async build(inputs: ActionInputs): Promise<UnsignedActionStep[]> {
      const amount = parseUnits(inputs.amount, 18);
      return [{
        kind: "action", label: `Unwrap ${inputs.amount} WMON`,
        tx: { to: wmon, data: encodeFunctionData({ abi: WMON_ABI, functionName: "withdraw", args: [amount] }), value: "0" },
      }];
    },
    parseResult: parseWmonReceipt,
  };
}

/** Best-effort: decode the real wrapped/unwrapped amount from the WMON
 *  Deposit/Withdrawal event. Never throws — a receipt whose logs can't be
 *  decoded still reports the confirmed status honestly, it just omits the
 *  amount rather than inventing one. */
async function parseWmonReceipt(receipt: ActionReceipt): Promise<Readonly<Record<string, string>>> {
  const base: Record<string, string> = { status: receipt.status };
  if (receipt.status !== "success") return base;
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({ abi: WMON_EVENTS, topics: log.topics as [`0x${string}`, ...`0x${string}`[]], data: log.data });
      if (decoded.eventName === "Deposit") return { ...base, wrapped: formatUnits((decoded.args as { wad: bigint }).wad, 18) };
      if (decoded.eventName === "Withdrawal") return { ...base, unwrapped: formatUnits((decoded.args as { wad: bigint }).wad, 18) };
    } catch { /* not a WMON event — keep scanning */ }
  }
  return base;
}

/**
 * Builds the WMON protocol adapter from the active app config. Reads the real
 * WMON address and chain id once, at call time — so the pinned allowlist and
 * chainId always match the network this deployment is actually on. Returns
 * null when WMON isn't configured (e.g. an unconfigured testnet), so the
 * caller registers nothing rather than registering an action pinned to a
 * missing target.
 */
export function createWmonProtocol(): ProtocolAdapter | null {
  const wmon = getWrappedNative();
  if (!wmon) return null;
  const chainId = getChain().id;
  return {
    protocolId: PROTOCOL_ID,
    name: "Wrapped MON",
    chainId,
    docsUrl: "https://docs.monad.xyz",
    allowedTargets: [wmon],
    actions: [wrapAction(wmon, chainId), unwrapAction(wmon, chainId)],
  };
}
