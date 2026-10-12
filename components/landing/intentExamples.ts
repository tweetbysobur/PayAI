/**
 * Every example prompt the marketing site shows, in one place.
 *
 * A prompt on these pages is a promise: someone will type it into Ask PayAI.
 * So each one carries how it is understood today, and
 * test/intent-examples.test.ts runs every one through the real code path it
 * names. A prompt the product can't act on as written fails the build instead
 * of reaching a visitor.
 *
 *   plan      the Plan API's deterministic grammar (after Ask's own framing
 *             and "each" rewrite, lib/ask/planFastPath.ts → toPlanText)
 *   schedule  the schedule parser, with a usable time
 *   route     Ask's router, ending in this intent kind, complete
 *
 * Pure data; no imports.
 */

export type ExampleCheck =
  | { kind: "plan"; actions: number }
  | { kind: "schedule"; cadence: "once" | "daily" | "weekly" | "monthly" }
  | { kind: "route"; intent: string };

export interface IntentExample {
  say: string;
  check: ExampleCheck;
}

export interface Capability {
  id: string;
  name: string;
  body: string;
  examples: IntentExample[];
}

/**
 * The capability grid on /how-it-works. Only what the product does today, in
 * the words it is actually built around. Escrow is deliberately absent: Rooms
 * pay the recipient directly, and escrow is not live.
 */
export const CAPABILITIES: Capability[] = [
  {
    id: "send",
    name: "Send",
    body: "MON or USDC to a 0x address, a .nad name or a saved payee.",
    examples: [{ say: "Send 50 USDC to alice.nad", check: { kind: "plan", actions: 1 } }],
  },
  {
    id: "several",
    name: "Pay several people",
    body: "One transfer per recipient, all in one plan you approve once.",
    examples: [{ say: "Send 5 USDC each to alice.nad and bob.nad", check: { kind: "plan", actions: 2 } }],
  },
  {
    id: "trade",
    name: "Trade",
    body: "Swap, buy or sell any Monad token — paste its contract address (CA) and say what to trade. The quote is shown before you sign.",
    examples: [{ say: "Swap 100 USDC to MON", check: { kind: "plan", actions: 1 } }],
  },
  {
    id: "chain",
    name: "Chain actions",
    body: "Several actions from one sentence, run in order. A swap's output can go straight to a transfer.",
    examples: [{ say: "Swap 10 MON to USDC and send it to alice.nad", check: { kind: "plan", actions: 2 } }],
  },
  {
    id: "schedule",
    name: "Schedule",
    body: "A one-time transfer set for a future date.",
    examples: [{ say: "Send 200 USDC to john.nad tomorrow", check: { kind: "schedule", cadence: "once" } }],
  },
  {
    id: "automate",
    name: "Automate",
    body: "Recurring transfers that run on their own from a capped agent wallet, within limits you approve once.",
    examples: [{ say: "Send 20 USDC to bob.nad every Friday", check: { kind: "schedule", cadence: "weekly" } }],
  },
  {
    id: "rooms",
    name: "Rooms",
    body: "Split a shared cost into equal shares. Each person pays their share straight to the recipient.",
    examples: [{ say: "Create a room for 100 USDC for 5 people", check: { kind: "route", intent: "room" } }],
  },
  {
    id: "protocols",
    name: "DeFi protocols — coming soon",
    body: "DeFi protocols on Monad will integrate with PayAI as partners. Once a protocol is integrated, you use it by saying what you want; PayAI checks the transaction and your wallet signs it.",
    examples: [],
  },
  {
    id: "wallet",
    name: "Ask about your wallet",
    body: "Balances, recent activity and whether a transaction went through.",
    examples: [{ say: "What's my USDC balance?", check: { kind: "route", intent: "token_balance" } }],
  },
];

/** The /intents guide: how to ask, by what you want done. */
export interface GuideGroup {
  title: string;
  body: string;
  examples: IntentExample[];
}

export const GUIDE: GuideGroup[] = [
  {
    title: "Send",
    body: "Name the amount, the token and who it's for. Plain wording is fine — so is a question.",
    examples: [
      { say: "Send 50 USDC to alice.nad", check: { kind: "plan", actions: 1 } },
      { say: "Can you send 0.5 MON to bob.nad?", check: { kind: "plan", actions: 1 } },
    ],
  },
  {
    title: "Pay several people",
    body: "Say \"each\" when everyone gets the same amount, or write each transfer out.",
    examples: [
      { say: "Send 5 USDC each to alice.nad and bob.nad", check: { kind: "plan", actions: 2 } },
      { say: "Send 1 MON to alice.nad and 2 MON to bob.nad", check: { kind: "plan", actions: 2 } },
    ],
  },
  {
    title: "Trade",
    body: "Swap between tokens, or buy and sell by amount, dollar value or share of your balance. For any other Monad token, paste its contract address (CA) first, then say what to trade — \u201Cbuy $20 of it\u201D.",
    examples: [
      { say: "Swap 100 USDC to MON", check: { kind: "plan", actions: 1 } },
      { say: "Buy $20 of MON with USDC", check: { kind: "route", intent: "trade" } },
      { say: "Sell half my MON for USDC", check: { kind: "route", intent: "trade" } },
    ],
  },
  {
    title: "Chain actions",
    body: "Join actions with \"and\" or \"then\". They run in the order you wrote them, and each waits for the one before it.",
    examples: [
      { say: "Swap 10 MON to USDC and send it to alice.nad", check: { kind: "plan", actions: 2 } },
      { say: "Send 1 MON to alice.nad, then swap 5 USDC to MON", check: { kind: "plan", actions: 2 } },
    ],
  },
  {
    title: "Schedule and automate",
    body: "Add when it should happen: a day, a date, or how often.",
    examples: [
      { say: "Send 200 USDC to john.nad tomorrow", check: { kind: "schedule", cadence: "once" } },
      { say: "Send 20 USDC to bob.nad every Friday", check: { kind: "schedule", cadence: "weekly" } },
    ],
  },
  {
    title: "Rooms",
    body: "Say the total and how many people share it.",
    examples: [{ say: "Create a room for 100 USDC for 5 people", check: { kind: "route", intent: "room" } }],
  },
  {
    title: "Ask about your wallet",
    body: "Questions are answered from your own wallet and history. Nothing is prepared.",
    examples: [
      { say: "What's my USDC balance?", check: { kind: "route", intent: "token_balance" } },
      { say: "Show my latest transaction", check: { kind: "route", intent: "transaction_details" } },
    ],
  },
];

/** The rotating prompt in the Ask section on /how-it-works. */
export const OPERATOR_EXAMPLES: IntentExample[] = [
  { say: "Send 250 USDC to alice.nad", check: { kind: "plan", actions: 1 } },
  { say: "Swap 100 MON to USDC", check: { kind: "plan", actions: 1 } },
  { say: "Swap 10 MON to USDC and send it to bob.nad", check: { kind: "plan", actions: 2 } },
  { say: "Send 20 USDC to bob.nad every Friday", check: { kind: "schedule", cadence: "weekly" } },
  { say: "Create a room for 100 USDC for 5 people", check: { kind: "route", intent: "room" } },
];

/** The "Start with an intent" examples and the core cards on /product. */
export const PRODUCT_EXAMPLES: IntentExample[] = [
  { say: "Send 100 USDC to alice.nad every Friday", check: { kind: "schedule", cadence: "weekly" } },
  { say: "Swap 0.1 MON to USDC", check: { kind: "plan", actions: 1 } },
  { say: "Send 5 USDC each to alice.nad and bob.nad", check: { kind: "plan", actions: 2 } },
  { say: "What's my USDC balance?", check: { kind: "route", intent: "token_balance" } },
];

export const CORE_EXAMPLES: Record<"payments" | "trading" | "chain", IntentExample> = {
  payments: { say: "Send 500 USDC to alice.nad every Friday", check: { kind: "schedule", cadence: "weekly" } },
  trading: { say: "Swap 0.2 MON to USDC", check: { kind: "plan", actions: 1 } },
  chain: { say: "Swap 10 MON to USDC and send it to alice.nad", check: { kind: "plan", actions: 2 } },
};


/** How a prompt is DISPLAYED: the example names (alice.nad, bob.nad…) become a
 *  placeholder, so nobody reads a stranger's name as the thing to type. The
 *  real sentence (`say`) is what the tests run through the product. */
export function displayPrompt(say: string): string {
  return say.replace(/\b[a-z0-9-]+\.nads?\b/gi, "‹.nad or wallet address›");
}
