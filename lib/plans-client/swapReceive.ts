/**
 * What a swap in a plan returns, for the review card: the confirmed amount
 * once it settles, else the exact quote it ran on, else a live estimate.
 * Pure — the card supplies the data.
 */
import { formatUnits } from "viem";
import type { ReviewStepDTO } from "./api";
import type { PlanViewDTO } from "./runner";

type SwapStep = Extract<ReviewStepDTO, { action: "swap" }>;
type PlanNode = PlanViewDTO["nodes"][number];

/** Decimals of the tokens a plan swap can return. */
const DECIMALS: Readonly<Record<string, number>> = { MON: 18, WMON: 18, USDC: 6 };

export interface SwapEstimate { receive: string; minimum: string; total: string | null }

export interface SwapReceive {
  label: "You receive" | "You received";
  value: string;
  note: "quoted" | "estimate" | undefined;
  minimum: string | null;
  total: string | null;
}

/** The amount a confirmed swap actually returned, from the executor's own
 *  TradeExecuted event as the plan recorded it. Null until it is confirmed. */
export function receivedAmount(step: SwapStep, node: PlanNode | undefined): string | null {
  const out = node?.state === "confirmed" ? node.result?.outputs?.amountOut : undefined;
  // Recorded as { verified, type, value, token }; only a verified value counts.
  const rec = out && typeof out === "object" ? (out as { verified?: boolean; value?: unknown }) : null;
  const raw = rec ? (rec.verified === true ? rec.value : undefined) : out;
  const decimals = DECIMALS[step.receiveToken.symbol];
  if (raw === undefined || raw === null || decimals === undefined) return null;
  try {
    return `${formatUnits(BigInt(String(raw)), decimals)} ${step.receiveToken.symbol}`;
  } catch {
    return null;
  }
}

/** What the swap returns, best source first: confirmed on-chain, the exact
 *  quote it ran on, then the live estimate. */
export function swapReceive(step: SwapStep, node: PlanNode | undefined, quoted: Readonly<Record<string, string>> | undefined, live: SwapEstimate | null): SwapReceive | null {
  const received = receivedAmount(step, node);
  if (received) return { label: "You received", value: received, note: undefined, minimum: null, total: null };
  if (quoted?.["you receive (est.)"]) {
    return {
      label: "You receive", value: `≈ ${quoted["you receive (est.)"]}`, note: "quoted",
      minimum: quoted["minimum received"] ?? null, total: quoted["total from your balance"] ?? null,
    };
  }
  if (live) return { label: "You receive", value: `≈ ${live.receive}`, note: "estimate", minimum: live.minimum, total: live.total };
  return null;
}

