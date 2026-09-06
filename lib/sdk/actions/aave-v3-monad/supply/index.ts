/**
 * Third real PayAI SDK action, and the FIRST external (non-PayAI-owned)
 * protocol: Aave V3's `supply()` on Monad mainnet — deposit an Aave-listed
 * ERC-20 reserve into the Aave Pool on behalf of a chosen address.
 *
 * Every address below was independently verified against the OFFICIAL
 * `aave-dao/aave-address-book` GitHub source (file `src/AaveV3Monad.sol`,
 * fetched and byte-decoded directly, not taken from a chat message or a
 * summarized fetch) and cross-referenced to the `monadscan.com` links that
 * file itself embeds — see PHASE 6B / PHASE 7A investigation notes. This
 * adapter intentionally does NOT use the address pasted into the Phase 7A
 * task text: that string was one hex character short of a valid 20-byte
 * address (39 hex chars, not 40) and is rejected outright rather than
 * "fixed" by guessing which digit was missing.
 *
 * ── Fixed target, exactly like WMON/SplitSettlement ─────────────────────
 * `tx.to` for the real action step is ALWAYS the canonical Aave Pool proxy.
 * The user never supplies a target, a spender, calldata, or a referral code.
 *
 * ── Two-step execution (Phase 5A/5B pattern) ────────────────────────────
 *   1. approve(asset, POOL, amount)   — Layer B's validateApprovalStep()
 *      decodes this for real and requires spender === POOL exactly, amount
 *      === the declared amount exactly, never MAX_UINT256.
 *   2. supply(asset, amount, onBehalfOf, 0) — referralCode is ALWAYS the
 *      literal 0; it is not, and must never become, a user-controlled input.
 *
 * ── Asset allowlisting is LIVE, not a hardcoded guess-list ──────────────
 * "An Aave-listed reserve" is verified by actually reading
 * `AaveProtocolDataProvider.getAllReservesTokens()` — the standard, stable,
 * unchanged-across-every-Aave-V3-deployment read function — on Monad at
 * call time. A token that is a perfectly normal ERC-20 but NOT one of
 * Aave's listed reserves fails closed (AaveSupplyInputError), the same way
 * split-settlement's resolveTokenCtx fails closed on an unreadable ERC-20.
 * An RPC failure while checking also fails closed: this action NEVER
 * assumes an unverifiable asset is safe.
 *
 * ── onBehalfOf is an explicit required input, not a silent default ─────
 * The SDK's Action.build(inputs, quote) signature (lib/sdk/types.ts) is
 * deliberately signer-agnostic and carries no wallet address — only
 * ExecutionRequest (one layer up, in the not-yet-wired Ask PayAI dispatch)
 * knows the caller. Defaulting onBehalfOf to "the caller" would require
 * either widening Action's signature (a redesign explicitly out of scope)
 * or having the Ask PayAI route inject it before calling build() (modifying
 * Ask PayAI, also explicitly out of scope for Phase 7A). So onBehalfOf is a
 * required, explicitly-supplied address field, exactly like every recipient
 * address in split-settlement's own inputSchema — never inferred, never
 * silently substituted. Wiring an actual "default to caller" convenience is
 * left to whichever future phase wires this into Ask PayAI and can pass the
 * ExecutionRequest's own walletAddress in.
 *
 * ── Quote is read-only and informational only ───────────────────────────
 * The only thing quote() surfaces beyond the fixed inputs is the reserve's
 * current supply APY, read from AaveProtocolDataProvider.getReserveData().
 * That number is DISPLAY ONLY: build() never reads it, and a failure to
 * read it never blocks quote() or build() (supply/withdraw are principal
 * actions with no slippage or minOut to protect).
 *
 * Server-side (reads app config and the chain). Registered by an explicit
 * call to createAaveV3MonadSupplyProtocol() + registerProtocol() — NOT
 * auto-registered at import and NOT wired into bootstrap.ts in this phase
 * (bootstrap.ts is Ask PayAI's registration surface; wiring it in is a
 * separate, later decision, not part of this SDK-only implementation).
 *
 * Phase 7B note: the Pool/DataProvider constants and the asset/amount/
 * reserve-verification helpers below were extracted into ../shared.ts
 * (verbatim, no behavior change) so the withdraw action can reuse them
 * instead of duplicating them. This file's own quote()/build()/
 * parseResult() logic — the part that is genuinely specific to supply — is
 * untouched.
 */
import "server-only";
import { encodeFunctionData, decodeEventLog, formatUnits, type Address } from "viem";
import { getChain } from "@/lib/monad/config";
import { getPublicClient } from "@/lib/monad/wallet";
import type { Action, ActionInputs, ActionQuoteResult, ActionReceipt, ProtocolAdapter, UnsignedActionStep } from "@/lib/sdk/types";
import {
  POOL, DATA_PROVIDER, DATA_PROVIDER_ABI, MONAD_MAINNET_CHAIN_ID,
  resolveAaveAsset, toAaveUnits, resolveRequiredAddress, AaveActionInputError,
} from "../shared";

const PROTOCOL_ID = "aave-v3-monad";
const ACTION_ID = "supply";
const VERSION = "1.0.0";

/** Backward-compatible alias — Phase 7A's own test suite and any external
 *  reference imports this name. Same class as shared.ts's AaveActionInputError. */
export const AaveSupplyInputError = AaveActionInputError;

/** Standard Aave V3 Pool ABI surface this action uses — identical across
 *  every Aave V3 deployment (the whole point of the address-book pattern):
 *  the fixed-arity `supply` function and its dedicated `Supply` event. No
 *  other Pool function is referenced anywhere in this file. */
const POOL_ABI = [
  {
    type: "function", name: "supply", stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" }, { name: "amount", type: "uint256" },
      { name: "onBehalfOf", type: "address" }, { name: "referralCode", type: "uint16" },
    ],
    outputs: [],
  },
] as const;

const POOL_EVENTS = [
  {
    type: "event", name: "Supply",
    inputs: [
      { name: "reserve", type: "address", indexed: true },
      { name: "user", type: "address", indexed: false },
      { name: "onBehalfOf", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "referralCode", type: "uint16", indexed: true },
    ],
  },
] as const;

/** Standard ERC-20 approve — supply-only (withdraw has no approval step). */
const ERC20_APPROVE_ABI = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

const RAY = 10n ** 27n;

/** Best-effort, informational-only supply APY. Never thrown from quote() —
 *  a read failure just omits the line, exactly like split-settlement's own
 *  quote() would rather omit a detail than fabricate one. This number is
 *  NEVER passed into build() or used to size any transaction. */
async function readSupplyApyPercent(asset: Address): Promise<string | null> {
  try {
    const pub = getPublicClient();
    const data = await pub.readContract({
      address: DATA_PROVIDER, abi: DATA_PROVIDER_ABI, functionName: "getReserveData", args: [asset],
    }) as readonly bigint[];
    const liquidityRate = data[5]; // ray-scaled current supply APR
    const percent = (Number(liquidityRate) / Number(RAY)) * 100;
    if (!Number.isFinite(percent)) return null;
    return percent.toFixed(2);
  } catch {
    return null;
  }
}

function supplyAction(chainId: number): Action {
  return {
    protocolId: PROTOCOL_ID, actionId: ACTION_ID, version: VERSION,
    name: "Supply to Aave", description: "Supply an Aave-listed reserve into the Aave V3 Pool on Monad.",
    chainId, allowedTargets: [POOL],
    inputSchema: {
      asset: { type: "token", required: true, description: "The Aave-listed ERC-20 reserve to supply" },
      amount: { type: "amount", required: true, description: "Amount of the asset to supply" },
      onBehalfOf: { type: "address", required: true, description: "The address that will receive the aTokens / be credited with this supply" },
    },
    async quote(inputs: ActionInputs): Promise<ActionQuoteResult> {
      const ctx = await resolveAaveAsset(inputs.asset);
      const onBehalfOf = resolveRequiredAddress(inputs.onBehalfOf, "onBehalfOf");
      const units = toAaveUnits(inputs.amount, ctx.decimals);
      const apy = await readSupplyApyPercent(ctx.address);
      const details: Record<string, string> = {
        asset: `${ctx.symbol} (${ctx.address})`,
        amount: `${formatUnits(units, ctx.decimals)} ${ctx.symbol}`,
        onBehalfOf,
        approxSupplyApy: apy != null ? `${apy}%` : "unavailable",
      };
      return {
        summary: `Supply ${formatUnits(units, ctx.decimals)} ${ctx.symbol} to Aave V3 on Monad`,
        details,
        quotedAt: Date.now(),
      };
    },
    async build(inputs: ActionInputs): Promise<UnsignedActionStep[]> {
      // Recomputed independently from inputs — never trusts quote()'s own
      // numbers, exactly like split-settlement's build(). Also re-verifies
      // the reserve listing so a reserve delisted between quote and build
      // is refused rather than silently supplied to.
      const ctx = await resolveAaveAsset(inputs.asset);
      const onBehalfOf = resolveRequiredAddress(inputs.onBehalfOf, "onBehalfOf");
      const units = toAaveUnits(inputs.amount, ctx.decimals);

      const steps: UnsignedActionStep[] = [
        {
          kind: "approve",
          label: `Approve ${formatUnits(units, ctx.decimals)} ${ctx.symbol} for Aave V3 Pool`,
          tx: {
            to: ctx.address,
            data: encodeFunctionData({ abi: ERC20_APPROVE_ABI, functionName: "approve", args: [POOL, units] }),
            value: "0",
          },
          approval: { token: ctx.address, spender: POOL, amount: units.toString() },
        },
        {
          kind: "action",
          label: `Supply ${formatUnits(units, ctx.decimals)} ${ctx.symbol} to Aave V3`,
          tx: {
            to: POOL,
            // referralCode is ALWAYS the literal 0 — never sourced from inputs.
            data: encodeFunctionData({ abi: POOL_ABI, functionName: "supply", args: [ctx.address, units, onBehalfOf, 0] }),
            value: "0",
          },
        },
      ];
      return steps;
    },
    parseResult: parseSupplyReceipt,
  };
}

/**
 * Decode the CONFIRMED supply from the receipt's own logs. Only a `Supply`
 * event emitted BY the canonical Pool address counts — a log from any other
 * address (a look-alike, or a generic ERC-20 Transfer emitted by the asset
 * itself) is ignored outright, exactly like split-settlement's
 * parseSplitReceipt only trusting its own canonical contract. Never throws,
 * never fabricates: a receipt with no matching event reports only its
 * status.
 */
async function parseSupplyReceipt(receipt: ActionReceipt): Promise<Readonly<Record<string, string>>> {
  const base: Record<string, string> = { status: receipt.status };
  if (receipt.status !== "success") return base;
  const canon = POOL.toLowerCase();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== canon) continue; // must be the real Aave Pool
    try {
      const decoded = decodeEventLog({
        abi: POOL_EVENTS, topics: log.topics as [`0x${string}`, ...`0x${string}`[]], data: log.data,
      });
      if (decoded.eventName !== "Supply") continue;
      const args = decoded.args as unknown as { reserve: Address; user: Address; onBehalfOf: Address; amount: bigint; referralCode: number };
      return {
        status: receipt.status,
        reserve: args.reserve,
        user: args.user,
        onBehalfOf: args.onBehalfOf,
        amount: args.amount.toString(),
        referralCode: String(args.referralCode),
      };
    } catch { /* not a well-formed Supply log — keep scanning, never guess */ }
  }
  return base; // success, but no canonical Supply event: report nothing invented
}

/**
 * Builds the Aave V3 Monad supply protocol adapter. Returns null on any
 * chain other than Monad mainnet — Aave V3 is not deployed anywhere else
 * this app targets — same "register nothing rather than pin to a missing
 * target" discipline as createWmonProtocol()/createSplitSettlementProtocol().
 */
export function createAaveV3MonadSupplyProtocol(): ProtocolAdapter | null {
  const chainId = getChain().id;
  if (chainId !== MONAD_MAINNET_CHAIN_ID) return null;
  return {
    protocolId: PROTOCOL_ID,
    name: "Aave V3 (Monad)",
    chainId,
    docsUrl: "https://aave.com/docs",
    allowedTargets: [POOL],
    actions: [supplyAction(chainId)],
  };
}

/** Test-only export of the fixed, verified addresses this file hardcodes,
 *  so the test suite can assert against them without re-declaring magic
 *  strings independently (and silently drifting from the real values). */
export const __testing = { POOL, DATA_PROVIDER, MONAD_MAINNET_CHAIN_ID };

/** Test-only: forget the cached reserve list (now shared.ts's own module
 *  state) so a test that changed the mocked reserve set isn't served a
 *  stale, previously-cached answer. Re-exported here so Phase 7A's own
 *  test suite keeps working against the same import path unchanged. */
export { __resetReservesCacheForTests } from "../shared";
