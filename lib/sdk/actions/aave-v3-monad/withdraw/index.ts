/**
 * Fourth real PayAI SDK action, and the second action on the FIRST external
 * (non-PayAI-owned) protocol: Aave V3's `withdraw()` on Monad mainnet —
 * withdraw an Aave-listed ERC-20 reserve out of the Aave Pool to a chosen
 * destination address.
 *
 * Shares its verified constants and asset/amount/address helpers with
 * Phase 7A's supply action via ../shared.ts (POOL, DATA_PROVIDER,
 * resolveAaveAsset, toAaveUnits, resolveRequiredAddress, the reserve-list
 * verification + its fail-closed behavior). This file adds only what is
 * genuinely specific to withdraw: its own ABI/event, its single-step build,
 * and its own receipt parser.
 *
 * ── Fixed target ─────────────────────────────────────────────────────────
 * `tx.to` is ALWAYS the canonical Aave Pool proxy. The user never supplies a
 * target or calldata.
 *
 * ── Single-step execution — NO approval ────────────────────────────────
 * Unlike supply, withdraw needs no ERC-20 approval: the Pool burns the
 * caller's own aTokens (an internal Aave accounting balance the Pool
 * already controls), it does not pull an allowance from an external token
 * contract. So build() returns exactly ONE step: withdraw(asset, amount, to).
 * Do not add an approval step here — there is nothing to approve.
 *
 * ── Asset allowlisting is LIVE, shared with supply ──────────────────────
 * Same `resolveAaveAsset()` as Phase 7A: a live read of
 * AaveProtocolDataProvider.getAllReservesTokens(), fail-closed on any RPC
 * failure or an asset simply not being listed.
 *
 * ── `to` is an explicit required input, same reasoning as supply's
 *    onBehalfOf ─────────────────────────────────────────────────────────
 * Action.build(inputs, quote) carries no wallet context (see supply's own
 * doc and the Phase 7A review's onBehalfOf analysis, which applies
 * identically here) — so `to` is a required, explicitly-supplied address,
 * never defaulted to "the caller" and never invented. Wiring an actual
 * "default to caller" convenience is left to whichever future phase wires
 * this into Ask PayAI and can pass the ExecutionRequest's own
 * walletAddress in.
 *
 * ── Aave's own returned-amount semantics ────────────────────────────────
 * Aave V3's `withdraw()` returns `uint256 amountWithdrawn` — the ACTUAL
 * amount withdrawn, which the Pool's own source computes as
 * `min(amount, userBalance)` when `amount` is not the MAX_UINT256 sentinel
 * (this action deliberately never sends that sentinel — no "withdraw max"
 * convenience is exposed, per Phase 7B's explicit "no percentage-based
 * withdrawal" instruction), so for a normal, explicit amount that does not
 * exceed the caller's balance, the amount actually withdrawn equals the
 * requested amount — but this action never ASSUMES that: parseResult()
 * below always reports the real amount decoded from the Pool's own
 * `Withdraw` event, never the requested input, so a partial withdrawal (or
 * any other on-chain reality) is reported honestly rather than papered over.
 *
 * Server-side (reads app config and the chain). Registered by an explicit
 * call to createAaveV3MonadWithdrawProtocol() + registerProtocol() — NOT
 * auto-registered at import and NOT wired into bootstrap.ts in this phase,
 * same as supply.
 */
import "server-only";
import { encodeFunctionData, decodeEventLog, formatUnits, type Address } from "viem";
import { getChain } from "@/lib/monad/config";
import { inputString } from "@/lib/sdk/types";
import type { Action, ActionInputs, ActionQuoteResult, ActionReceipt, ProtocolAdapter, UnsignedActionStep } from "@/lib/sdk/types";
import { POOL, MONAD_MAINNET_CHAIN_ID, resolveAaveAsset, toAaveUnits, resolveRequiredAddress } from "../shared";

const PROTOCOL_ID = "aave-v3-monad";
const ACTION_ID = "withdraw";
const VERSION = "1.0.0";

/** Standard Aave V3 Pool ABI surface withdraw uses — identical across every
 *  Aave V3 deployment. `withdraw` itself is the only Pool function this
 *  file references. */
const POOL_ABI = [
  {
    type: "function", name: "withdraw", stateMutability: "nonpayable",
    inputs: [
      { name: "asset", type: "address" }, { name: "amount", type: "uint256" }, { name: "to", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** Standard Aave V3 `Withdraw` event — reserve/user/to all indexed, amount
 *  (the ACTUAL amount withdrawn) carried in the data word. Identical shape
 *  across every Aave V3 deployment, same stability guarantee as Supply's
 *  own event used in ../supply/index.ts. */
const POOL_EVENTS = [
  {
    type: "event", name: "Withdraw",
    inputs: [
      { name: "reserve", type: "address", indexed: true },
      { name: "user", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
] as const;

/** Exported (Phase 7C) so the consolidated ../index.ts factory can compose
 *  this action into one combined ProtocolAdapter alongside supply's own,
 *  without duplicating any of its quote()/build()/parseResult() logic.
 *  Mechanical visibility change only — nothing about this function's body
 *  changed. */
export function withdrawAction(chainId: number): Action {
  return {
    protocolId: PROTOCOL_ID, actionId: ACTION_ID, version: VERSION,
    name: "Withdraw from Aave", description: "Withdraw an Aave-listed reserve from the Aave V3 Pool on Monad.",
    chainId, allowedTargets: [POOL],
    inputSchema: {
      asset: { type: "token", required: true, description: "The Aave-listed ERC-20 reserve to withdraw" },
      amount: { type: "amount", required: true, description: "Amount of the asset to withdraw" },
      to: { type: "address", required: true, description: "The address that will receive the withdrawn asset" },
    },
    // No price/route/slippage exists for a principal withdrawal — this is
    // the simplest quote the Action interface allows: it confirms the
    // asset is really an Aave reserve (fail-closed, same as supply) and
    // echoes back exactly what will be requested, nothing more. It never
    // reads or reports an APY (that is a SUPPLY-side concept — the
    // liquidityRate a lender earns — and is meaningless for a withdrawal),
    // and nothing here can affect what build() constructs.
    async quote(inputs: ActionInputs): Promise<ActionQuoteResult> {
      const ctx = await resolveAaveAsset(inputString(inputs, "asset"));
      const to = resolveRequiredAddress(inputString(inputs, "to"), "to");
      const units = toAaveUnits(inputString(inputs, "amount"), ctx.decimals);
      const details: Record<string, string> = {
        asset: `${ctx.symbol} (${ctx.address})`,
        amount: `${formatUnits(units, ctx.decimals)} ${ctx.symbol}`,
        to,
      };
      return {
        summary: `Withdraw ${formatUnits(units, ctx.decimals)} ${ctx.symbol} from Aave V3 on Monad`,
        details,
        quotedAt: Date.now(),
      };
    },
    async build(inputs: ActionInputs): Promise<UnsignedActionStep[]> {
      // Recomputed independently from inputs — never trusts quote()'s own
      // numbers, exactly like supply's own build(). Also re-verifies the
      // reserve listing so a reserve delisted between quote and build is
      // refused rather than silently withdrawn from.
      const ctx = await resolveAaveAsset(inputString(inputs, "asset"));
      const to = resolveRequiredAddress(inputString(inputs, "to"), "to");
      const units = toAaveUnits(inputString(inputs, "amount"), ctx.decimals);

      // Exactly one step. No approval: withdraw burns the caller's own
      // aTokens via the Pool's internal accounting, it never pulls an
      // ERC-20 allowance from anywhere. Do not add one.
      const steps: UnsignedActionStep[] = [
        {
          kind: "action",
          label: `Withdraw ${formatUnits(units, ctx.decimals)} ${ctx.symbol} from Aave V3`,
          tx: {
            to: POOL,
            data: encodeFunctionData({ abi: POOL_ABI, functionName: "withdraw", args: [ctx.address, units, to] }),
            value: "0",
          },
        },
      ];
      return steps;
    },
    parseResult: parseWithdrawReceipt,
  };
}

/**
 * Decode the CONFIRMED withdrawal from the receipt's own logs. Only a
 * `Withdraw` event emitted BY the canonical Pool address counts — a log
 * from any other address (a look-alike, or a generic ERC-20 Transfer
 * emitted by the asset itself) is ignored outright, exactly like supply's
 * own parseSupplyReceipt only trusting its own canonical contract. Never
 * throws, never fabricates: a receipt with no matching event reports only
 * its status.
 *
 * The reported `amount` is ALWAYS the real value decoded from the event —
 * the actual amount Aave withdrew — never the amount that was requested in
 * build(). Aave's own withdraw() can legitimately return less than
 * requested (e.g. a user withdrawing more than their balance in a
 * MAX_UINT256-style "withdraw everything" call would get back exactly
 * their balance); this action's inputSchema never sends that sentinel, but
 * parseResult still never assumes equality — it reports on-chain truth,
 * not the request.
 */
async function parseWithdrawReceipt(receipt: ActionReceipt): Promise<Readonly<Record<string, string>>> {
  const base: Record<string, string> = { status: receipt.status };
  if (receipt.status !== "success") return base;
  const canon = POOL.toLowerCase();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== canon) continue; // must be the real Aave Pool
    try {
      const decoded = decodeEventLog({
        abi: POOL_EVENTS, topics: log.topics as [`0x${string}`, ...`0x${string}`[]], data: log.data,
      });
      if (decoded.eventName !== "Withdraw") continue;
      const args = decoded.args as unknown as { reserve: Address; user: Address; to: Address; amount: bigint };
      return {
        status: receipt.status,
        reserve: args.reserve,
        user: args.user,
        to: args.to,
        // The REAL amount withdrawn, from the event — never the requested
        // input. See this function's own doc above.
        amount: args.amount.toString(),
      };
    } catch { /* not a well-formed Withdraw log — keep scanning, never guess */ }
  }
  return base; // success, but no canonical Withdraw event: report nothing invented
}

/**
 * Builds the Aave V3 Monad withdraw protocol adapter. Returns null on any
 * chain other than Monad mainnet — same "register nothing rather than pin
 * to a missing target" discipline as supply's own
 * createAaveV3MonadSupplyProtocol().
 */
export function createAaveV3MonadWithdrawProtocol(): ProtocolAdapter | null {
  const chainId = getChain().id;
  if (chainId !== MONAD_MAINNET_CHAIN_ID) return null;
  return {
    protocolId: PROTOCOL_ID,
    name: "Aave V3 (Monad)",
    chainId,
    docsUrl: "https://aave.com/docs",
    allowedTargets: [POOL],
    actions: [withdrawAction(chainId)],
  };
}

/** Test-only export of the fixed, verified Pool address, so the test suite
 *  can assert against it without re-declaring a magic string independently. */
export const __testing = { POOL, MONAD_MAINNET_CHAIN_ID };

/** Test-only: forget the shared cached reserve list. Re-exported from
 *  shared.ts so this file's own tests can use the same import path
 *  supply's tests already use. */
export { __resetReservesCacheForTests } from "../shared";
