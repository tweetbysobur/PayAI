/**
 * The transaction-log row for a confirmed protocol action that has no
 * recipient and no trade (wrap/unwrap MON, Aave supply/withdraw).
 *
 * Without one, these confirmed with nothing in History and no notification of
 * their own; the only trace was the on-chain scan reporting the token
 * movement as a bare deposit or withdrawal. Built ONLY from what the action's
 * own receipt parser verified (parseResult's `details`) — never from the
 * request. The row carries no numeric amount: it is the user's own money
 * moving between forms, not a payment, so it must stay out of every volume
 * and revenue figure (lib/platform/analytics.ts skips feature "protocol").
 * The exact verified amount is in the summary.
 */
import { formatUnits } from "viem";

export interface ProtocolHistory {
  summary: string;
  token: string;
}

type ResolveToken = (address: string) => Promise<{ symbol: string; decimals: number } | null>;

const UNITS_RE = /^(0|[1-9][0-9]{0,77})$/;

export async function protocolHistory(
  ref: { protocolId: string; actionId: string; name: string },
  details: Readonly<Record<string, string>>,
  resolve: ResolveToken,
): Promise<ProtocolHistory> {
  if (ref.protocolId === "wmon") {
    if (ref.actionId === "wrap" && details.wrapped) return { summary: `Wrapped ${details.wrapped} MON into WMON`, token: "MON" };
    if (ref.actionId === "unwrap" && details.unwrapped) return { summary: `Unwrapped ${details.unwrapped} WMON into MON`, token: "WMON" };
  }
  if (ref.protocolId === "aave-v3-monad" && (ref.actionId === "supply" || ref.actionId === "withdraw")
      && details.reserve && details.amount && UNITS_RE.test(details.amount)) {
    const t = await resolve(details.reserve).catch(() => null);
    if (t) {
      const shown = formatUnits(BigInt(details.amount), t.decimals);
      return ref.actionId === "supply"
        ? { summary: `Supplied ${shown} ${t.symbol} to Aave V3`, token: t.symbol }
        : { summary: `Withdrew ${shown} ${t.symbol} from Aave V3`, token: t.symbol };
    }
  }
  // Confirmed, but the parser couldn't attribute an amount: say so plainly.
  return { summary: `${ref.name} confirmed`, token: "" };
}
