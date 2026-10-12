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

/** The "How to ask" section on /how-it-works, by what you want done. */
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

/** The "Start with an intent" examples and the core cards on /product. */
export const PRODUCT_EXAMPLES: IntentExample[] = [
  { say: "Send 100 USDC to alice.nad", check: { kind: "plan", actions: 1 } },
  { say: "Swap 0.1 MON to USDC", check: { kind: "plan", actions: 1 } },
  { say: "Send 5 USDC each to alice.nad and bob.nad", check: { kind: "plan", actions: 2 } },
  { say: "What's my USDC balance?", check: { kind: "route", intent: "token_balance" } },
];

export const CORE_EXAMPLES: Record<"payments" | "trading" | "chain", IntentExample> = {
  payments: { say: "Send 500 USDC to alice.nad", check: { kind: "plan", actions: 1 } },
  trading: { say: "Swap 0.2 MON to USDC", check: { kind: "plan", actions: 1 } },
  chain: { say: "Swap 10 MON to USDC and send it to alice.nad", check: { kind: "plan", actions: 2 } },
};


/** How a prompt is DISPLAYED: the example names (alice.nad, bob.nad…) become a
 *  placeholder, so nobody reads a stranger's name as the thing to type. The
 *  real sentence (`say`) is what the tests run through the product. */
export function displayPrompt(say: string): string {
  return say.replace(/\b[a-z0-9-]+\.nads?\b/gi, "‹.nad or wallet address›");
}
