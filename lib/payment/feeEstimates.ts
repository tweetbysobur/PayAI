/**
 * What GET /api/fees is — and is not — stated in its own response, so a
 * configured estimate can't be mistaken for the rate PayAI charges. Every
 * fee is computed on-chain by the settling contract from its own feeBps() at
 * execution; app/api/fees/route.ts returns env-configured values alongside
 * this description. Pure data; safe anywhere.
 */
export const FEES_ABOUT = {
  kind: "configured_estimates",
  authoritative: false,
  note:
    "These are PayAI's configured fee estimates, used for previews. They are not read from the contracts and are not authoritative. " +
    "The fee actually charged is computed by each PayAI contract from its own on-chain feeBps() when the transaction executes, " +
    "and your confirmation screen shows the exact fee and total before you sign. Split payments are charged at the forwarder's on-chain rate and are not listed here.",
  authoritativeSource: {
    send_payment: "PayAIForwarderV2.feeBps()",
    split_payment: "PayAIForwarderV2.feeBps() (0.25% of the recipients' total)",
    swap: "PayAITradeExecutor.feeBps() (trades routed through PayAI's trade executor only)",
    wallet_automation: "PaymentExecutorV2.feeBps()",
    reserved_funds: "AutomationVaultV2.feeBps()",
  },
} as const;
