/**
 * Ask PayAI — the semantic understanding layer.
 *
 * This is the ONLY place that decides what a message means. It produces a
 * structured Understanding (see types.ts) and nothing else — it never
 * touches a wallet, never builds a transaction, never calls the payment
 * pipeline. orchestrate.ts is the only thing allowed to act on what this
 * returns, and only after the user explicitly confirms.
 *
 * `understand()` is a lightweight ROUTER first, an Anthropic caller second —
 * see routeRequest() below. Most messages (greetings, factual questions,
 * read-only wallet/transaction queries the deterministic engine can
 * confidently resolve, and follow-ups that merge into an already-classified
 * pending intent) are answered without ever touching the network. Anthropic
 * is reserved for messages that actually need semantic reasoning: a fresh
 * money-moving request (send/swap/schedule/recurring/distribution — these
 * always get a real understanding pass, never a locally-guessed shortcut,
 * even when the deterministic engine thinks it already has every field) or
 * anything the deterministic engine can't confidently place at all.
 *
 * When Anthropic IS needed, understandWithLLM makes a real Claude call
 * (forced tool output), given the conversation so far and any in-flight
 * (pending) intent so it can merge a follow-up ("20", "make it 30") into
 * what's already being built. If no key is configured, or a live call
 * fails, the router's own engine (classifyFresh/tryMergePending — also what
 * every "skip Anthropic" route above is answered from) is used instead —
 * reduced to recognizable keywords rather than open-ended phrasing, and
 * honest about that limit.
 *
 * Server-only — never bundle this (or an API key) into client code.
 */
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { ASK_INTENT_KINDS, type AskIntentKind, type AskSlots, type Understanding } from "./types";
import { ensureBuiltinsRegistered } from "@/lib/sdk/bootstrap";
import { getAction, getCurrentActionVersion } from "@/lib/sdk/registry";
import { getChain, getStablecoin } from "@/lib/monad/config";
import { recipientAppearsIn } from "@/lib/payees/directory";
import { detectSplit } from "./split";
import { detectCompoundRequest } from "./compound";
import { detectRoomRequest } from "./roomIntent";
import { unreadableTiming, unreadableTimingReply } from "@/lib/agent/scheduleTiming";

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

// The kinds the Anthropic classifier is allowed to emit. "protocol_action"
// is deliberately EXCLUDED: SDK protocol actions are only ever produced by
// the deterministic, registry-gated detector below (detectProtocolAction),
// never inferred by the model — so the model can never select a protocol,
// action, or version on its own. Everything else in ASK_INTENT_KINDS is
// fair game for the model.
const CLASSIFY_KINDS = [
  ...ASK_INTENT_KINDS.filter((k) => k !== "protocol_action").filter((k) => k !== "room"),
  "unsupported", "unclear", "chat",
] as const;

/** Slots each actionable kind actually needs before it's ready for a preview. */
export const REQUIRED_SLOTS: Record<AskIntentKind, (keyof AskSlots)[]> = {
  send_payment: ["amount", "asset", "recipient"],
  swap: ["amount", "fromAsset", "toAsset"],
  schedule_payment: ["amount", "asset", "recipient", "when"],
  recurring_payment: ["amount", "asset", "recipient", "frequency"],
  wallet_balance: [],
  token_balance: ["asset"],
  transaction_history: [],
  wallet_activity: [],
  // txHash is deliberately NOT required — most requests ("did it go
  // through?", "my latest transaction") name no hash at all. The
  // orchestrator resolves those against real recent activity; txHash here
  // is only for when context already pins one down.
  transaction_status: [],
  transaction_details: [],
  automation_management: [],
  distribution: ["amount", "asset", "recipientCount"],
  token_lookup: ["tokenAddress"],
  // fromAsset/toAsset here are frequently pre-filled by applyTradeContext()
  // before this is ever checked (from the previously identified token, or a
  // sensible USDC default) — see that function's own doc for exactly when.
  trade: ["tradeAction", "amount", "fromAsset", "toAsset"],
  // protocol_action is only ever produced COMPLETE by the deterministic
  // detector (never via the LLM schema or the generic slot-completeness
  // path), so this list is for type-exhaustiveness and defensive
  // completeness only. protocolId/actionId identify the registered action;
  // amount is WMON's single input.
  protocol_action: ["protocolId", "actionId", "amount"],
  // Only ever produced complete by detectRoomRequest (never by the model).
  room: ["roomAction"],
};

/**
 * What an understanding still needs before it can be acted on: the kind's
 * REQUIRED_SLOTS, plus one schedule rule the slot list alone can't express —
 * a WEEKLY recurring payment also needs its day. Without it the schedule
 * engine has nothing to anchor "every week" to, and the request would only
 * fail later with a generic "When should it run?". Asking for the day here
 * means asking for exactly the one thing that is actually missing.
 */
export function missingSlots(kind: AskIntentKind, slots: AskSlots): (keyof AskSlots)[] {
  const missing = REQUIRED_SLOTS[kind].filter((k) => !slots[k]);
  if (kind === "recurring_payment" && slots.frequency === "weekly" && !slots.when) missing.push("when");
  return missing;
}

const SYSTEM_PROMPT = `You are the natural-language understanding layer for Ask PayAI, a non-custodial crypto payments product on Monad. Users type however they naturally would — casual language, slang, typos, incomplete thoughts, corrections. Your only job is to figure out what they're trying to do and extract exactly the information they've actually given. You never execute anything; you only describe intent for a separate, already-secure system to validate and act on.

Capabilities PayAI supports today, and what each needs:
- send_payment: amount, asset (MON or USDC), recipient (a wallet address, .nad domain, or a name)
- swap: amount, fromAsset, toAsset — exchanging one token for another
- schedule_payment: amount, asset, recipient, when (a one-time future date/time, e.g. "next Friday", "tomorrow", "2026-07-01")
- recurring_payment: amount, asset, recipient, frequency (daily, weekly, or monthly)
- wallet_balance: nothing required — the user wants their whole wallet's balance (all supported assets), e.g. "what's in my wallet", "how much money do I have"
- token_balance: asset (MON or USDC) — the user wants ONE specific token's balance, e.g. "how much USDC do I have", "what's my MON balance". If they ask about a token PayAI doesn't track, still capture the asset they named — it's explained honestly downstream, never silently redirected to a supported one.
- transaction_history: nothing required (asset is an optional filter, e.g. "how much USDC did I send recently") — the user wants a list of past transactions
- wallet_activity: nothing required — a broader "what's been happening" question; treat the same as transaction_history when the distinction doesn't matter
- transaction_status: nothing strictly required, but fill txHash when context clearly identifies which transaction (see rule 9) — the user is asking whether a payment went through / succeeded / is still pending
- transaction_details: nothing strictly required, same txHash rule — the user wants specifics (who, how much, when) about a particular past transaction
- automation_management: nothing required — the user wants to review or manage an existing scheduled/recurring payment
- distribution: amount, asset, recipientCount — paying many wallets in one go
- token_lookup: tokenAddress — identifying an arbitrary Monad contract address the user pasted or named (e.g. "what is this token? 0x...", "check this CA: 0x...", "is 0x... tradable?"). This is normally handled deterministically before you're ever called, purely by regex — you'll only see it if a message mixes a real address with something else that genuinely needs judgment (e.g. "is this legit, 0x...?" alongside an unrelated question).
- trade: tradeAction (buy or sell), fromAsset (what's being spent), toAsset (what's being acquired), amount, amountType — a real trade quote preview for ANY Monad token, not just MON/USDC. fromAsset/toAsset can be a symbol (USDC, MON) or, when the user means "this"/"it" referring to a token already identified earlier in the conversation, leave that field null — the system fills it in from context, you don't need to guess or invent an address. amountType must be exactly one of: "exact_input" (a plain amount of the asset being spent — "use 50 USDC", "spend 20 MON"), "usd" (a dollar amount — "$50 worth", "get me 50 dollars of this"), "percentage" (a fraction of the wallet's balance — "half my USDC", amount is the percent number as a string e.g. "50"), "balance_all" (the entire balance — "sell all my MON", "my whole balance" — amount can be left null), or "exact_output" (an exact amount of what they want to RECEIVE, e.g. "I want exactly 100 tokens") — exact_output is recognized but PayAI can't quote it yet, so still report it honestly as amountType "exact_output" rather than silently reinterpreting it as exact_input. A slippage tolerance the user explicitly names ("use 1% slippage") goes in the slippage field as a plain percent number ("1") — never invent one if not stated.

Rules, no exceptions:
1. Never invent or assume a value for amount, asset, recipient, or any other field. If it wasn't stated (in this message OR earlier in the conversation), it stays null.
2. Never default an unstated asset to USDC or MON. If it matters and wasn't said, ask.
3. You are given the current PENDING intent, if any, plus recent conversation. If the new message continues, answers, or corrects that pending intent (e.g. a bare "20" after you asked for an amount, "actually make it 30", or "what about MON?" right after a balance answer), merge into the SAME kind with updated slots — do not treat it as an unrelated new request. This applies even when the pending intent is already "complete" (e.g. a payment or swap has just been previewed and is awaiting the user's confirmation) — "actually make it 75", "change it to 0x456...", or "use MON instead" (correcting fromAsset/toAsset on a pending swap) at that point still mean "correct THIS operation," not "start describing a new one." Only start fresh if the message is clearly about something else.
4. If you can identify a specific capability above but something required is missing, use outcome "incomplete" and write ONE short, natural question asking for exactly what's still missing — never re-ask for something already known, never open a form.
5. If the request describes something real that PayAI does not support today (staking, lending, leverage/trading, NFTs, bridging to another chain, anything off this list), use outcome "unsupported". Explain briefly and honestly that it isn't available yet. Do NOT reinterpret it as send_payment or swap just because those happen to be supported.
6. If you genuinely cannot tell what the user wants at all, use outcome "unclear" and ask a natural clarifying question. Do not guess or force it into one of the capabilities above.
7. If it's just conversation — a greeting, thanks, a question about what PayAI is or does — with no operation implied, use outcome "chat" and reply naturally in a sentence or two.
8. Write like a helpful person, never like a template or a form label.
9. For transaction_status/transaction_details: if the user says "that", "it", "my last payment", or similar and your own PREVIOUS reply (in the recent conversation) already named a specific transaction (a hash, or a single clearly-identified payment), fill slots.txHash with that hash — you are reading it back from context, never inventing one. If nothing specific was said and none was just discussed, leave txHash null; a downstream system resolves that to the most recent transaction on its own. If the user's wording suggests they mean some OTHER, different transaction than whatever was last discussed, and you can't tell which one from the conversation, use outcome "incomplete" and ask them to say more (who it was to, roughly how much, or roughly when) rather than guessing.
10. For trade specifically, "actually use MON instead" (or any bare asset correction on an already-complete trade) means: for a pending BUY, correct fromAsset (what's being spent) — the thing being acquired was already anchored by context; for a pending SELL, correct toAsset (what's being received) — the thing being sold was already anchored. This is the one case where a bare token mention safely maps to a specific side (unlike swap's own "use MON instead", which stays genuinely ambiguous between fromAsset/toAsset and is left unresolved there).

Field-specific notes:
- send_payment's asset must be MON or USDC — PayAI's instant chat sends support only these two right now. A different token named here is still fine to capture (don't force it to null), it will be rejected with an honest reason downstream.
- swap's fromAsset/toAsset can be any token symbol the user names — PayAI validates tradeability downstream.
- schedule_payment's "when" must be normalized to one of: a weekday name ("Friday"), "tomorrow", "next week", "next month", "in N days/weeks/months", or an ISO date (YYYY-MM-DD) — pick whichever is the closest honest match to what the user actually said, never a made-up specific date they didn't imply.
- trade never signs or executes anything — it only ever produces a quote preview. Still apply rule 1 fully: never invent an amount, and never invent WHICH token "this"/"it" refers to if no token has actually been identified earlier in the conversation (leave fromAsset/toAsset null and ask, exactly like any other missing field).`;

const TOOL_SCHEMA = {
  name: "submit_understanding",
  description: "Report what the user's message means.",
  input_schema: {
    type: "object" as const,
    properties: {
      kind: { type: "string", enum: [...CLASSIFY_KINDS] },
      outcome: { type: "string", enum: ["incomplete", "complete", "unsupported", "unclear", "chat"] },
      slots: {
        type: "object",
        properties: {
          amount: { type: ["string", "null"] },
          asset: { type: ["string", "null"] },
          recipient: { type: ["string", "null"] },
          when: { type: ["string", "null"] },
          frequency: { type: ["string", "null"], enum: ["daily", "weekly", "monthly", null] },
          fromAsset: { type: ["string", "null"] },
          toAsset: { type: ["string", "null"] },
          recipientCount: { type: ["number", "null"] },
          txHash: { type: ["string", "null"], description: "Only when read back from a transaction already named in context — never invented." },
          tokenAddress: { type: ["string", "null"], description: "An EVM contract address (0x... 40 hex chars) actually present in the message — never invented." },
          tradeAction: { type: ["string", "null"], enum: ["buy", "sell", null] },
          amountType: { type: ["string", "null"], enum: ["exact_input", "exact_output", "usd", "percentage", "balance_all", null] },
          slippage: { type: ["string", "null"], description: "A plain percent number the user explicitly named (e.g. \"1\" for 1%) — never invented." },
        },
      },
      question: { type: ["string", "null"], description: "Set only when outcome is 'incomplete' — the single next thing to ask." },
      reply: { type: ["string", "null"], description: "Set only when outcome is 'unsupported', 'unclear', or 'chat' — the plain-text response." },
      capability: { type: ["string", "null"], description: "Set only when outcome is 'unsupported' — what the user actually asked for." },
    },
    required: ["kind", "outcome", "slots"],
  },
};

function emptySlots(): AskSlots {
  return {
    amount: null, asset: null, recipient: null, when: null, frequency: null, fromAsset: null, toAsset: null,
    recipientCount: null, txHash: null, tokenAddress: null, tradeAction: null, amountType: null, slippage: null,
  };
}

/** The token most recently identified via a real token_lookup — the ONLY
 *  thing "this"/"it" is ever allowed to resolve to. Null whenever nothing
 *  was actually identified, so a trade with no real context correctly stays
 *  "incomplete" and asks, rather than guessing. */
function contextTokenFrom(pending: Understanding | null): string | null {
  return pending && pending.kind === "token_lookup" && pending.outcome === "complete" ? pending.slots.tokenAddress ?? null : null;
}

/** Resolves whichever side of a trade wasn't explicitly named, the same way
 *  regardless of whether Anthropic or the deterministic fast path produced
 *  the slots (both funnel through this):
 *   - BUY with no toAsset named -> the previously identified context token
 *     (that's what "this"/"it" means for a buy: the thing being acquired).
 *   - BUY with amountType "usd" and no fromAsset named -> USDC (the "$"
 *     already specifies the currency; this is narrower than and does not
 *     relax rule 2's general "never default an unstated asset" instruction).
 *   - SELL with no fromAsset named -> the context token (what "this"/"it"
 *     means for a sell: the thing being disposed of).
 *   - SELL with no toAsset named at all -> USDC, PayAI's default settlement
 *     asset elsewhere in the product (Step 2's own quote-asset default,
 *     lib/monad/prices's numeraire) — easily corrected afterward ("actually
 *     get MON instead"), so a low-risk default rather than an extra question. */
/**
 * The asset to put on a side the user never named. USDC is the natural quote
 * asset — except when USDC is already the OTHER side, which this used to
 * ignore. "Sell half my USDC" names USDC as what's being sold, then defaulted
 * the receiving side to USDC too, producing a complete-looking USDC->USDC
 * trade that no router can quote; the user got "no route found" for an
 * ordinary sell. MON is the counter-asset in that one case (it is the chain's
 * native asset and the other half of the deepest pair).
 *
 * A contract address on the other side never matches "USDC", so it correctly
 * keeps the USDC default.
 */
function counterAssetFor(otherSide: string | null | undefined): string {
  return otherSide && otherSide.toUpperCase() === "USDC" ? "MON" : "USDC";
}

/** The only symbols PayAI can resolve a trade side by NAME alone (mirrors —
 *  deliberately not imports, to keep this module free of any RPC/module
 *  dependency for what's just a cheap, synchronous slot check —
 *  lib/monad/tokenRegistry.ts's curated set plus native MON; lib/monad/swap.ts's
 *  own resolveSwapSide error names this identical list). Anything else that
 *  isn't a real 0x address can't actually be traded by that name at all. */
const CURATED_TRADE_SYMBOLS = new Set(["MON", "WMON", "USDC", "USDT0", "AUSD", "WETH", "WBTC"]);

/** True for a non-null value that names neither a real contract address nor
 *  one of PayAI's curated symbols — i.e. a bare word nothing downstream can
 *  actually resolve to a tradable asset. Used below to recognize the specific
 *  case that used to reach the trade builder and fail with a confusing
 *  "isn't a token PayAI can swap yet" error: when a context token is already
 *  known (a real address, from an earlier token_lookup), the model sometimes
 *  fills toAsset/fromAsset with THAT SAME token's own display symbol — it
 *  appears in the visible conversation (this module's own tokenLookupLead
 *  reply), so the model reasonably treats it as "already named" — rather
 *  than leaving the field null the way it would for a genuinely new,
 *  unidentified token. Left as a bare symbol, that string is unresolvable
 *  (resolveTradeSide only accepts a real address OR a curated symbol) even
 *  though the trade is for a token PayAI can perfectly well quote by its
 *  real address. Treating it the same as "not named" and substituting the
 *  real context address is strictly more correct: it's never a deliberate
 *  reference to some OTHER, different unsupported asset — there is no way
 *  for a bare invented symbol to mean anything else in this specific
 *  situation. */
function isUnresolvedBareSymbol(v: string | null | undefined): boolean {
  return !!v && !EVM_ADDRESS_RE.test(v) && !CURATED_TRADE_SYMBOLS.has(v.toUpperCase());
}

function applyTradeContext(slots: AskSlots, contextTokenAddress: string | null): AskSlots {
  if (slots.tradeAction !== "buy" && slots.tradeAction !== "sell") return slots;
  const next = { ...slots };
  if (next.tradeAction === "buy") {
    if ((!next.toAsset || isUnresolvedBareSymbol(next.toAsset)) && contextTokenAddress) next.toAsset = contextTokenAddress;
    if (!next.fromAsset && next.amountType === "usd") next.fromAsset = counterAssetFor(next.toAsset);
  } else {
    if ((!next.fromAsset || isUnresolvedBareSymbol(next.fromAsset)) && contextTokenAddress) next.fromAsset = contextTokenAddress;
    if (!next.toAsset) next.toAsset = counterAssetFor(next.fromAsset);
  }
  return next;
}

function tradeQuestionFor(missing: (keyof AskSlots)[]): string {
  if (missing.includes("tradeAction")) return "Would you like to buy or sell?";
  if (missing.includes("amount")) return "How much would you like to spend?";
  if (missing.includes("toAsset")) return "Which token would you like to buy?";
  if (missing.includes("fromAsset")) return "Which token would you like to spend?";
  return "Could you tell me a bit more about that trade?";
}

/** P1.5 — the one still-missing slot, asked naturally. Used by
 *  tryMergePending's generic incomplete-fill loop below, the ONE place that
 *  previously fell back to a bare `` `And ${slotKey}?` `` — which reads as
 *  "And recipientCount?" or "And frequency?", a raw camelCase field name
 *  leaking straight into the chat. Every other question path in this file
 *  (classifyFresh's send_payment/schedule branches, tradeQuestionFor above)
 *  already asks naturally; this closes the one spot that didn't. Kind-aware
 *  only where the plain phrasing would otherwise be misleading (a swap or
 *  distribution's "amount" doesn't mean "send"). */
function naturalMissingSlotQuestion(kind: AskIntentKind, key: keyof AskSlots): string {
  switch (key) {
    case "amount":
      return kind === "swap" || kind === "trade" ? "How much would you like to swap?"
        : kind === "distribution" ? "How much should each recipient get?"
        : "How much would you like to send?";
    case "asset": case "fromAsset": case "toAsset":
      return "Which token should I use?";
    case "recipient":
      return "Who should receive it?";
    case "when":
      return kind === "recurring_payment" ? "Which day should it run each week?" : "When should this run?";
    case "frequency":
      return "How often should this repeat?";
    case "recipientCount":
      return "How many recipients?";
    default:
      return "Could you tell me a bit more?";
  }
}

/** Turns whatever the model (or a malformed/adversarial tool call) returned
 *  into a well-typed Understanding. Never trusts kind/outcome to be
 *  consistent — a mismatch or an unrecognized kind always degrades to
 *  "unclear" with a safe fallback reply, never to something that LOOKS
 *  actionable without actually being validated. `contextTokenAddress` is
 *  applied here (not left to the model) so "this"/"it" resolves the exact
 *  same way regardless of whether Anthropic or the deterministic fast path
 *  produced the trade — see applyTradeContext's own doc. */
function coerce(raw: Record<string, unknown>, contextTokenAddress: string | null = null): Understanding {
  const kind = typeof raw.kind === "string" ? raw.kind : "unclear";
  const outcome = typeof raw.outcome === "string" ? raw.outcome : "unclear";
  const rawSlots = (raw.slots && typeof raw.slots === "object" ? raw.slots : {}) as Record<string, unknown>;
  let slots: AskSlots = { ...emptySlots() };
  for (const key of Object.keys(slots) as (keyof AskSlots)[]) {
    const v = rawSlots[key];
    if (key === "recipientCount") { slots[key] = typeof v === "number" ? v : null; continue; }
    if (key === "frequency") { slots[key] = v === "daily" || v === "weekly" || v === "monthly" ? v : null; continue; }
    if (key === "tradeAction") { slots[key] = v === "buy" || v === "sell" ? v : null; continue; }
    if (key === "amountType") {
      slots[key] = v === "exact_input" || v === "exact_output" || v === "usd" || v === "percentage" || v === "balance_all" ? v : null;
      continue;
    }
    (slots as Record<string, unknown>)[key] = typeof v === "string" ? v : null;
  }
  if (kind === "trade") slots = applyTradeContext(slots, contextTokenAddress);

  // protocol_action is produced ONLY by the deterministic, registry-gated
  // detectors — the model's schema excludes it (CLASSIFY_KINDS), and a tool
  // call that names it anyway is refused here rather than trusted. This is
  // what keeps the LLM from ever introducing an SDK action (or a split
  // recipient).
  if (kind !== "protocol_action" && (ASK_INTENT_KINDS as readonly string[]).includes(kind) && (outcome === "incomplete" || outcome === "complete")) {
    const missing = missingSlots(kind as AskIntentKind, slots);
    if (outcome === "complete" && missing.length === 0) {
      return { kind: kind as AskIntentKind, outcome: "complete", slots };
    }
    // The model's own question when it asked one; when it claimed "complete"
    // but a required slot is in fact missing, ask for exactly that slot.
    const question = outcome === "incomplete" && typeof raw.question === "string" && raw.question.trim() ? raw.question.trim()
      : missing.length > 0 ? naturalMissingSlotQuestion(kind as AskIntentKind, missing[0])
      : "Could you tell me a bit more about that?";
    return { kind: kind as AskIntentKind, outcome: "incomplete", slots, question };
  }
  if (outcome === "unsupported") {
    return {
      kind: "unsupported", outcome: "unsupported",
      capability: typeof raw.capability === "string" && raw.capability.trim() ? raw.capability.trim() : "that",
      reply: typeof raw.reply === "string" && raw.reply.trim() ? raw.reply.trim() : "That's not something PayAI supports yet.",
    };
  }
  if (outcome === "chat") {
    return { kind: "chat", outcome: "chat", reply: typeof raw.reply === "string" && raw.reply.trim() ? raw.reply.trim() : "How can I help?" };
  }
  return { kind: "unclear", outcome: "unclear", reply: typeof raw.reply === "string" && raw.reply.trim() ? raw.reply.trim() : "I'm not quite sure what you'd like to do — could you say a bit more?" };
}

async function understandWithLLM(
  text: string,
  history: ConversationTurn[],
  pending: Understanding | null,
): Promise<Understanding> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  // Sonnet, not Opus: this is a narrow, tool-schema-constrained extraction
  // task (classify + fill slots), not open-ended reasoning -- Opus's extra
  // latency bought little here. Overridable via VERIPAYAI_MODEL if a
  // deployment needs a different tier.
  const model = process.env.VERIPAYAI_MODEL || "claude-sonnet-5";

  const contextLines = history.slice(-8).map((t) => `${t.role === "user" ? "User" : "Ask PayAI"}: ${t.content}`).join("\n");
  const pendingLine = pending ? `Pending intent (merge into this if the new message relates to it): ${JSON.stringify(pending)}` : "No pending intent.";

  const msg = await client.messages.create({
    model,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools: [TOOL_SCHEMA],
    tool_choice: { type: "tool", name: "submit_understanding" },
    messages: [
      {
        role: "user",
        content: `${pendingLine}\n\nRecent conversation:\n${contextLines || "(none yet)"}\n\nNew message: "${text}"`,
      },
    ],
  });

  if (msg.usage) {
    const cost = estimateCostUsd(model, msg.usage.input_tokens, msg.usage.output_tokens);
    console.log([
      "[AskPayAI Router]", "anthropic_call=true", `model=${model}`,
      `input_tokens=${msg.usage.input_tokens}`, `output_tokens=${msg.usage.output_tokens}`,
      ...(cost != null ? [`est_cost_usd=${cost.toFixed(5)}`] : []),
    ].join("\n"));
  }

  const tool = msg.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (!tool) return { kind: "unclear", outcome: "unclear", reply: "I'm not quite sure what you'd like to do — could you say a bit more?" };
  return enforceRecipientProvenance(coerce(tool.input as Record<string, unknown>, contextTokenFrom(pending)), text, history, pending);
}

/**
 * The LLM may point at a recipient the user named; it may never supply one.
 * A recipient slot it returns is kept only if that exact address / name /
 * .nad domain appears in something the USER said: this message, an earlier
 * user turn, or the pending intent the user is correcting. Otherwise the slot
 * is cleared and the user is asked who should receive the funds — never
 * substituted. Assistant turns are not a source: the model's own words can't
 * vouch for a recipient.
 */
export function enforceRecipientProvenance(
  u: Understanding,
  text: string,
  history: readonly ConversationTurn[],
  pending: Understanding | null,
): Understanding {
  if (u.outcome !== "complete" && u.outcome !== "incomplete") return u;
  const recipient = u.slots.recipient;
  if (!recipient) return u;
  const sources = [
    text,
    ...history.filter((t) => t.role === "user").map((t) => t.content),
    ...(pending && (pending.outcome === "complete" || pending.outcome === "incomplete") && pending.slots.recipient ? [pending.slots.recipient] : []),
  ];
  if (recipientAppearsIn(recipient, sources)) return u;
  const amount = u.slots.amount ? ` the ${u.slots.amount}${u.slots.asset ? ` ${u.slots.asset}` : ""}` : " it";
  return {
    kind: u.kind, outcome: "incomplete",
    slots: { ...u.slots, recipient: null },
    question: `Who should receive${amount}? Give a wallet address or a .nad name.`,
  };
}

/**
 * Resolves a follow-up against an already-known pending intent — filling a
 * missing slot ("50" after "How much?") or correcting a complete one
 * ("actually make it 75"). Deliberately synchronous and side-effect-free:
 * this is the piece routeRequest() trusts to skip Anthropic for a follow-up
 * even on a money-moving intent, since it's only ever a small, unambiguous
 * substitution into a request Anthropic (or a confidently-matched
 * deterministic detector) already classified once — never a fresh guess.
 * Returns null when the message doesn't clearly answer/correct anything,
 * so the caller can fall through to a fresh classification instead.
 */
/** Keywords that mean "tell me more about the token we're already talking
 *  about" — narrow enough to never misfire on an unrelated follow-up (e.g.
 *  "what's my wallet balance?" doesn't match), broad enough to cover the
 *  conversation-context requirement without ever needing an Anthropic call:
 *  once a token_lookup is pending, a plain question using one of these words
 *  and naming no NEW address just re-resolves the SAME address. */
const TOKEN_FOLLOWUP_RE = /\b(price|worth|value|liquidity|liquid|volume|tradable|trade(?:able)?|pair|pairs|route|routes|supply|decimals|holders|verified|legit|scam|contract|market\s*cap|mcap|fdv|status|progress|graduated|bonding\s*curve|creator|pool)\b/i;

/** "How much would I get for 50?" / "what would 50 get me" / "quote 50" —
 *  requires BOTH the phrase AND an actual number, so "how much USDC do I
 *  have" (no number) is never misread as a token quote request; that one
 *  correctly keeps falling through to the real wallet-balance path below. */
const TOKEN_AMOUNT_QUESTION_RE = /\b(how\s+(much|many)|what\s+would\s+i\s+get|quote)\b/i;

/** A specific quote asset named in a token follow-up ("...with USDC?",
 *  "...for MON?") — WMON is normalized to MON since Uniswap always trades
 *  the wrapped form under the hood (see swap.ts's resolveSwapSide); showing
 *  it as a separate asset here would just be the same route under a
 *  different name. */
const TOKEN_ASSET_MENTION_RE = /\b(USDC|W?MON)\b/i;

/** A message that actually wants to SPEND/ACQUIRE something — distinct from
 *  merely asking ABOUT a pair or price (TOKEN_FOLLOWUP_RE's "can I trade it
 *  with USDC?" has no amount/action and stays a read-only market question).
 *  Deliberately requires a real signal (a buy/sell verb, a dollar amount, a
 *  percentage-of-balance phrase, or "get me"/"can I get" framing) — bare
 *  "trade" alone does NOT match, so it never fires on a plain tradability
 *  question. Checked ahead of detectSwapIntent in classifyFresh too, since
 *  that detector also triggers on "swap"/"trade" and would otherwise happily
 *  (and wrongly) capture "this" as a literal token symbol for phrasing like
 *  "swap 100 USDC into this token".
 *
 *  The one exception to "bare trade doesn't match" is the Ask PayAI empty
 *  state's own tile, "Trade a token", whose label is sent verbatim as a
 *  message. It is anchored at BOTH ends, so it matches that phrase and
 *  nothing else: a tradability question ("can I trade it?"), a market one
 *  ("trade volume?") and, importantly, a real swap that merely opens with the
 *  word ("trade tokens for USDC", "trade 50 USDC for MON") all still fall
 *  through to detectSwapIntent exactly as before. Every phrasing here reaches
 *  Anthropic in production regardless — this only decides how well the
 *  key-free fallback copes with one specific button. */
const TRADE_SIGNAL_RE = /\b(buy|purchase|sell)\b|\bswap\b[^.!?]*\b(this|it|that)\b|\$\s*\d|\bhalf\b[^.!?]*\bmy\b|\ball\s+my\b|\bmy\s+(?:entire|whole)\b|\b(can\s+i\s+get|get\s+me)\b|^\s*(?:trade|swap)\s+(?:a\s+|an\s+|some\s+)?(?:tokens?|crypto|coins?)\s*[.!?]?\s*$|^\s*(?:trade|swap)\s*[.!?]*\s*$/i;

function tryMergePending(text: string, pending: Understanding | null): Understanding | null {
  // Conversation context for an already-identified token — "What's the
  // price?" right after a token_lookup card means THIS token, not a fresh
  // unrelated question. A message naming a NEW address always overrides
  // this (handled separately, before tryMergePending is ever called — see
  // routeRequest); a message that's actually a TRADE REQUEST (see
  // TRADE_SIGNAL_RE) is a kind change, not a same-kind follow-up, so it
  // deliberately falls through here to classifyFresh's detectTradeFresh
  // instead, which resolves the SAME context token as the input to a
  // real trade preview rather than another read-only market answer.
  if (
    pending && pending.kind === "token_lookup" && pending.outcome === "complete" &&
    !EVM_ADDRESS_RE.test(text) && !TRADE_SIGNAL_RE.test(text)
  ) {
    const numMatch = text.match(/\d+(?:\.\d+)?/);
    const isAmountQuestion = !!numMatch && TOKEN_AMOUNT_QUESTION_RE.test(text);
    if (TOKEN_FOLLOWUP_RE.test(text) || isAmountQuestion) {
      const slots: AskSlots = { ...pending.slots };
      const assetMatch = text.match(TOKEN_ASSET_MENTION_RE);
      if (assetMatch) slots.toAsset = assetMatch[0].toUpperCase() === "WMON" ? "MON" : assetMatch[0].toUpperCase();
      if (isAmountQuestion) slots.amount = numMatch![0];
      return { kind: "token_lookup", outcome: "complete", slots };
    }
  }

  // Corrections to an already-previewed trade — "Actually make it 100."
  // (amount), "Actually use MON instead." (the non-anchored side — see rule
  // 10 in the system prompt for why this one IS safe to resolve locally,
  // unlike swap's own ambiguous "use X instead"), "Sell instead." (action
  // flip). All require an explicit cue, matching send_payment/swap's own
  // correction pattern below — a bare number/word here is genuinely
  // ambiguous with the start of an unrelated new message.
  if (pending && pending.outcome === "complete" && pending.kind === "trade") {
    const trimmed = text.trim();
    if (/\b(sell|buy)\s+instead\b|\breverse\s+(it|that|the\s+trade)\b|\bflip\s+it\b/i.test(trimmed)) {
      const flipped = pending.slots.tradeAction === "buy" ? "sell" : "buy";
      // Amount deliberately dropped: "50 USDC worth" reversed under "sell"
      // no longer means the same thing (now 50 of WHAT?) — asking fresh
      // beats silently reinterpreting a number under the new direction.
      return {
        kind: "trade", outcome: "incomplete",
        slots: { ...pending.slots, tradeAction: flipped, fromAsset: pending.slots.toAsset, toAsset: pending.slots.fromAsset, amount: null, amountType: null },
        question: "How much would you like to spend?",
      };
    }
    if (/\b(actually|instead|change it|update it|make it|correct(ion)?)\b/i.test(trimmed)) {
      const updated: AskSlots = { ...pending.slots };
      let changed = false;
      const usdMatch = trimmed.match(/\$\s*(\d+(?:\.\d+)?)/);
      const addrMatch = trimmed.match(EVM_ADDRESS_RE);
      const assetMatch = !addrMatch ? trimmed.match(TOKEN_ASSET_MENTION_RE) : null;
      if (usdMatch) { updated.amount = usdMatch[1]; updated.amountType = "usd"; changed = true; }
      else {
        const amountMatch = trimmed.match(/\d+(?:\.\d+)?/);
        if (amountMatch) { updated.amount = amountMatch[0]; updated.amountType = updated.amountType === "usd" ? "exact_input" : updated.amountType; changed = true; }
      }
      if (addrMatch || assetMatch) {
        const newAsset = addrMatch ? addrMatch[0] : (assetMatch![0].toUpperCase() === "WMON" ? "MON" : assetMatch![0].toUpperCase());
        if (pending.slots.tradeAction === "buy") updated.fromAsset = newAsset;
        else if (pending.slots.tradeAction === "sell") updated.toAsset = newAsset;
        changed = true;
      }
      if (changed) return { kind: "trade", outcome: "complete", slots: updated };
    }
  }

  // Answering a pending trade's still-missing field — "buy or sell?",
  // "how much?", "which token?". Trade-specific (rather than the generic
  // incomplete-fill loop below) because it needs to infer amountType from
  // HOW the answer was phrased ("$50" vs "half" vs a plain number), not
  // just capture a bare value.
  if (pending && pending.outcome === "incomplete" && pending.kind === "trade") {
    const stripped = text.trim().replace(/[.!]+$/, "");
    const missing = REQUIRED_SLOTS.trade.filter((k) => !pending.slots[k]);
    const filled: AskSlots = { ...pending.slots };
    let filledOne = false;

    // "50 USDC" answers "how much would you like to spend?" completely in
    // one reply — both the amount AND which asset, unambiguous together
    // even though a bare "50" alone (matched below) wouldn't be enough to
    // also place an asset. Checked first so it doesn't fall into the
    // amount-only branch and leave the asset unfilled.
    const numAssetMatch = missing.includes("amount") ? stripped.match(/^(\d+(?:\.\d+)?)\s*(USDC|W?MON)$/i) : null;
    if (numAssetMatch) {
      filled.amount = numAssetMatch[1];
      filled.amountType = "exact_input";
      const asset = numAssetMatch[2].toUpperCase() === "WMON" ? "MON" : numAssetMatch[2].toUpperCase();
      if (missing.includes("toAsset") && !missing.includes("fromAsset")) filled.toAsset = asset;
      else if (missing.includes("fromAsset") && !missing.includes("toAsset")) filled.fromAsset = asset;
      // Both sides still open: the amount still lands, the asset is left
      // for a separate answer rather than guessed onto either side.
      filledOne = true;
    } else if (missing.includes("tradeAction") && /^(buy|sell)$/i.test(stripped)) {
      filled.tradeAction = stripped.toLowerCase() as "buy" | "sell";
      filledOne = true;
    } else if (missing.includes("amount")) {
      const usdMatch = stripped.match(/^\$\s*(\d+(?:\.\d+)?)$/);
      if (usdMatch) { filled.amount = usdMatch[1]; filled.amountType = "usd"; filledOne = true; }
      else if (/^(all|everything)$/i.test(stripped)) { filled.amountType = "balance_all"; filledOne = true; }
      else if (/^half$/i.test(stripped)) { filled.amount = "50"; filled.amountType = "percentage"; filledOne = true; }
      else if (/^\d+(?:\.\d+)?$/.test(stripped)) { filled.amount = stripped; filled.amountType = filled.amountType ?? "exact_input"; filledOne = true; }
    } else if (TOKEN_ASSET_MENTION_RE.test(stripped) && /^(USDC|W?MON)$/i.test(stripped)) {
      const asset = stripped.toUpperCase() === "WMON" ? "MON" : stripped.toUpperCase();
      // Only commit when EXACTLY ONE side is open — both open at once means
      // this bare word can't be placed without guessing which one it answers.
      if (missing.includes("toAsset") && !missing.includes("fromAsset")) { filled.toAsset = asset; filledOne = true; }
      else if (missing.includes("fromAsset") && !missing.includes("toAsset")) { filled.fromAsset = asset; filledOne = true; }
    }

    if (filledOne) {
      const stillMissing = REQUIRED_SLOTS.trade.filter((k) => !filled[k]);
      return stillMissing.length === 0
        ? { kind: "trade", outcome: "complete", slots: filled }
        : { kind: "trade", outcome: "incomplete", slots: filled, question: tradeQuestionFor(stillMissing) };
    }
  }

  if (pending && pending.outcome === "incomplete") {
    const missing = missingSlots(pending.kind, pending.slots);
    // Trailing punctuation ("50.", "yes!") shouldn't block recognizing the
    // answer underneath it — the value stored is always the stripped form.
    const stripped = text.trim().replace(/[.!]+$/, "");
    // Try every still-missing slot against the shape of what was actually
    // said — not just when exactly one thing is missing overall (a payment
    // can easily be two slots short, e.g. after "I want to send some USDC."
    // leaves both amount and recipient open). Only ever commits a fill when
    // EXACTLY ONE still-missing slot's shape matches this message; if the
    // message's shape could plausibly answer more than one open question
    // (e.g. a bare number when both amount and recipientCount are open),
    // that's genuinely ambiguous and this fallback does not guess.
    const candidates: Partial<AskSlots> = {};
    for (const key of missing) {
      if (key === "amount" && /^\d+(\.\d+)?$/.test(stripped)) candidates.amount = stripped;
      else if ((key === "toAsset" || key === "asset" || key === "fromAsset") && /^(MON|USDC)$/i.test(stripped)) (candidates as Record<string, unknown>)[key] = stripped.toUpperCase();
      else if (key === "recipient" && stripped && !/^\d+(\.\d+)?$/.test(stripped) && !/^(MON|USDC)$/i.test(stripped)) {
        const addr = stripped.match(/0x[a-fA-F0-9]{40}/)?.[0];
        const domain = stripped.match(/\b[a-z0-9-]+\.(nad|nads)\b/i)?.[0];
        candidates.recipient = addr ?? domain ?? stripped.replace(/^to\s+/i, "").trim();
      }
      else if (key === "frequency" && /^(daily|weekly|monthly)$/i.test(stripped)) candidates.frequency = stripped.toLowerCase() as "daily" | "weekly" | "monthly";
      else if (key === "recipientCount" && /^\d+$/.test(stripped)) candidates.recipientCount = Number(stripped);
      else if (key === "when" && stripped) candidates.when = stripped;
    }
    const filledKeys = Object.keys(candidates) as (keyof AskSlots)[];
    if (filledKeys.length === 1) {
      const filled: AskSlots = { ...pending.slots, ...candidates };
      const stillMissing = missingSlots(pending.kind, filled);
      return stillMissing.length === 0
        ? { kind: pending.kind, outcome: "complete", slots: filled }
        : { kind: pending.kind, outcome: "incomplete", slots: filled, question: naturalMissingSlotQuestion(pending.kind, stillMissing[0]) };
    }
  }

  // A correction to a payment that's already complete and being previewed
  // ("Actually make it 75", "change it to 0x456...") — narrower than the
  // missing-slot fill above (requires an explicit correction word, not just
  // a bare number) since a bare number here is genuinely ambiguous: it could
  // be the start of an unrelated new message rather than a correction.
  if (pending && pending.outcome === "complete" && pending.kind === "send_payment") {
    const trimmed = text.trim();
    if (/\b(actually|instead|change it|update it|make it|correct(ion)?)\b/i.test(trimmed)) {
      const addrMatch = trimmed.match(/0x[a-fA-F0-9]{40}/);
      const domainMatch = !addrMatch ? trimmed.match(/\b[a-z0-9-]+\.(nad|nads)\b/i) : null;
      const recipientMatch = addrMatch ?? domainMatch;
      // Strip whatever was just matched as the recipient before hunting for
      // an amount — a domain like "bob2.nad" has a digit in it that must
      // never be misread as a corrected amount (same precaution parse.ts
      // takes for a raw address).
      const withoutRecipient = recipientMatch ? trimmed.replace(recipientMatch[0], " ") : trimmed;
      const amountMatch = withoutRecipient.match(/\d+(?:\.\d+)?/);
      const assetMatch = trimmed.match(/\b(MON|USDC)\b/i);
      if (recipientMatch || amountMatch || assetMatch) {
        const updated: AskSlots = { ...pending.slots };
        if (recipientMatch) updated.recipient = recipientMatch[0];
        if (assetMatch) updated.asset = assetMatch[0].toUpperCase();
        if (amountMatch) updated.amount = amountMatch[0];
        return { kind: "send_payment", outcome: "complete", slots: updated };
      }
    }
  }

  // Same idea for an already-quoted swap ("Actually make it 30.") — but
  // narrower still: only a pure amount correction is handled locally. A
  // token mention ("use MON instead") could mean either fromAsset or
  // toAsset, and guessing which one would risk quoting the wrong pair; that
  // case (and any token outside MON/USDC, which this fallback doesn't even
  // check for) is left to Anthropic rather than resolved incorrectly here.
  if (pending && pending.outcome === "complete" && pending.kind === "swap") {
    const trimmed = text.trim();
    if (/\b(actually|instead|change it|update it|make it|correct(ion)?)\b/i.test(trimmed)) {
      const mentionsToken = /\b(MON|USDC)\b/i.test(trimmed);
      const amountMatch = trimmed.match(/\d+(?:\.\d+)?/);
      if (amountMatch && !mentionsToken) {
        return { kind: "swap", outcome: "complete", slots: { ...pending.slots, amount: amountMatch[0] } };
      }
    }
  }

  return null;
}

/** Best-effort deterministic extraction for the clearest trade phrasings —
 *  the FALLBACK used only when Anthropic isn't configured or fails (a fresh
 *  trade always gets a real Anthropic pass otherwise, same as
 *  send_payment/swap — see routeRequest's own rule on this). Not required to
 *  handle every phrasing perfectly; genuinely open-ended wording ("Use half
 *  of my USDC to buy this, but not more than what I'd need for gas") is
 *  exactly what Anthropic is for. Checked BEFORE detectSwapIntent in
 *  classifyFresh below so a message like "swap 100 USDC into this token"
 *  never reaches detectSwapIntent at all — that detector also triggers on
 *  "swap"/"trade" and would otherwise capture "this" as a literal (bogus)
 *  token symbol. */
function detectTradeFresh(text: string, contextTokenAddress: string | null): Understanding | null {
  if (!TRADE_SIGNAL_RE.test(text)) return null;
  const t = text.trim();

  const isSell = /\bsell\b/i.test(t);
  const isBuy = !isSell && (/\b(buy|purchase)\b/i.test(t) || /\bswap\b/i.test(t) || /\b(can\s+i\s+get|get\s+me)\b/i.test(t));
  const action: "buy" | "sell" | null = isSell ? "sell" : isBuy ? "buy" : null;

  let amount: string | null = null;
  let amountType: NonNullable<AskSlots["amountType"]> | null = null;
  const usdMatch = t.match(/\$\s*(\d+(?:\.\d+)?)/);
  const allMatch = /\ball\s+my\b|\bmy\s+(?:entire|whole)\b/i.test(t);
  const halfMatch = /\bhalf\b/i.test(t) && /\bmy\b/i.test(t);
  const numMatch = t.match(/\b(\d+(?:\.\d+)?)\b/);
  if (usdMatch) { amount = usdMatch[1]; amountType = "usd"; }
  else if (allMatch) { amountType = "balance_all"; }
  else if (halfMatch) { amount = "50"; amountType = "percentage"; }
  else if (numMatch) { amount = numMatch[1]; amountType = "exact_input"; }

  // The one curated asset explicitly named (if any) — assumed to be on the
  // side the action implies (spend-side for buy, sold-side for sell) unless
  // a second asset also appears (e.g. "Sell 20 MON for USDC"), which then
  // names the OTHER side explicitly too. Anything this can't confidently
  // place (multiple assets in an unclear order, no asset at all with no
  // context either) stays null and gets asked about, or is resolved by
  // Anthropic on the real pass.
  const assetMatches = [...t.matchAll(/\b(USDC|W?MON)\b/gi)].map((m) => (m[1].toUpperCase() === "WMON" ? "MON" : m[1].toUpperCase()));
  const [namedAsset, secondAsset] = assetMatches;

  let slots: AskSlots = { ...emptySlots(), tradeAction: action, amount, amountType };
  if (action === "buy" || action === "sell") {
    if (namedAsset) slots.fromAsset = namedAsset;
    if (secondAsset) slots.toAsset = secondAsset;
  }
  slots = applyTradeContext(slots, contextTokenAddress);

  if (!action) return { kind: "trade", outcome: "incomplete", slots, question: "Would you like to buy or sell?" };
  const missing = REQUIRED_SLOTS.trade.filter((k) => !slots[k]);
  if (missing.length === 0) return { kind: "trade", outcome: "complete", slots };
  return { kind: "trade", outcome: "incomplete", slots, question: tradeQuestionFor(missing) };
}

/**
 * Fresh (non-follow-up) classification via PayAI's existing production
 * detectors — reduced (keyword-matched, not open-ended) capability, and
 * honest about that limit. Used both as the key-free fallback and, via
 * routeRequest(), as the router's own "can I handle this locally" engine
 * for read-only queries. `pending` is used only to resolve a trade's
 * context token (see contextTokenFrom) — nothing else here reads it.
 */
async function classifyFresh(text: string, pending: Understanding | null = null): Promise<Understanding> {
  // Same precedence as routeRequest: a split verb is handled only by the
  // deterministic split path, before any other detector can claim it.
  const split = await detectSplit(text);
  if (split) return split;

  const trade = detectTradeFresh(text, contextTokenFrom(pending));
  if (trade) return trade;

  const { detectSwapIntent, parseScheduleIntent, detectQueryIntent, parseIntentDeterministic } = await import("@/lib/agent/brain");

  const swap = detectSwapIntent(text);
  if (swap) {
    const slots: AskSlots = { ...emptySlots(), fromAsset: swap.fromToken, toAsset: swap.toToken, amount: swap.amount != null ? String(swap.amount) : null };
    return swap.amount != null
      ? { kind: "swap", outcome: "complete", slots }
      : { kind: "swap", outcome: "incomplete", slots, question: `How much ${swap.fromToken} would you like to swap?` };
  }

  const sched = parseScheduleIntent(text);
  if (sched) {
    const kind: AskIntentKind = sched.cadence === "once" ? "schedule_payment" : "recurring_payment";
    const slots: AskSlots = {
      ...emptySlots(),
      amount: sched.amount != null ? String(sched.amount) : null,
      // Only a token the person actually named — the engine's own default
      // (USDC) is not something they said, so it's asked for instead.
      asset: /\b(MON|USDC)\b/i.test(text) ? sched.token : null,
      recipient: sched.recipient,
      when: sched.nextRun != null ? new Date(sched.nextRun).toISOString() : null,
      frequency: sched.cadence === "once" ? null : sched.cadence,
    };
    const missing = missingSlots(kind, slots);
    return missing.length === 0
      ? { kind, outcome: "complete", slots }
      : { kind, outcome: "incomplete", slots, question: naturalMissingSlotQuestion(kind, missing[0]) };
  }

  // Best-effort keyword heuristics for transaction status/details — the
  // deterministic detectors in brain.ts don't have an equivalent of their
  // own, so this stays local to the key-free fallback. Checked BEFORE
  // detectQueryIntent's show_history: "show me my LATEST transaction" (one,
  // singular) would otherwise match show_history's generic "show...
  // transaction" pattern and get misread as a request for the whole list.
  // txHash is left null in every case here; the orchestrator resolves "no
  // specific hash named" to the most recent real transaction.
  if (/\b(go(es)?\s+through|went\s+through|successful|succeed(ed)?|confirmed|is\s+it\s+(done|pending)|failed)\b/i.test(text) &&
      /\b(payment|transaction|transfer|it|that|this)\b/i.test(text)) {
    return { kind: "transaction_status", outcome: "complete", slots: emptySlots() };
  }
  if (/\b(latest|last|recent|most recent)\s+(payment|transaction|transfer)\b/i.test(text) ||
      /\bwho\s+did\s+i\s+(pay|send)\b/i.test(text) || /\bhow\s+much\s+did\s+i\s+send\b/i.test(text) ||
      /\bwhen\s+did\s+(that|it|the)\b.*\b(happen|go)\b/i.test(text)) {
    return { kind: "transaction_details", outcome: "complete", slots: emptySlots() };
  }

  const query = detectQueryIntent(text);
  if (query === "show_balance") {
    // A message naming exactly one token (and not the other supported one)
    // reads as "just that one" — including an unsupported token, so it gets
    // an honest "not tracked" answer instead of silently showing the whole
    // wallet. Anything with no single token named is the whole wallet.
    const hasMon = /\bMON\b/i.test(text), hasUsdc = /\bUSDC\b/i.test(text);
    const otherToken = text.match(/\b(USDT|USD|DAI|WETH|WBTC|WMON|ETH|BTC)\b/i);
    if (hasMon && !hasUsdc) return { kind: "token_balance", outcome: "complete", slots: { ...emptySlots(), asset: "MON" } };
    if (hasUsdc && !hasMon) return { kind: "token_balance", outcome: "complete", slots: { ...emptySlots(), asset: "USDC" } };
    if (otherToken && !hasMon && !hasUsdc) return { kind: "token_balance", outcome: "complete", slots: { ...emptySlots(), asset: otherToken[0].toUpperCase() } };
    return { kind: "wallet_balance", outcome: "complete", slots: emptySlots() };
  }
  if (query === "show_history") return { kind: "transaction_history", outcome: "complete", slots: emptySlots() };
  if (query === "scheduled_payment") return { kind: "automation_management", outcome: "complete", slots: emptySlots() };

  // parseIntentDeterministic's action defaults to "send_payment" whenever no
  // other action keyword matched — that's brain.ts's fallback value for
  // genuine payment text, not a positive "this is a payment" signal. Gating
  // on an actual send/pay verb here (rather than trusting that default)
  // matters: without it, "...I need to get MON..." would misfire as a
  // payment — looksLikeSendPayment requires a real "send"/"pay " word,
  // which that phrase doesn't have, so it's excluded regardless of what
  // detectRecipient below extracts (see brain.ts's own fix for why "to get"
  // no longer gets misread as a `to <recipient>` clause in the first place).
  // Unlike the two branches, an amount/recipient isn't required to enter
  // this one — "I want to send some USDC." names no amount or recipient at
  // all yet is a completely legitimate start to a payment ("How much?" is
  // the right next question), and requiring one up front would just make
  // that exact case fall through to "unclear" instead.
  const { looksLikeSendPayment } = await import("@/lib/ask/sendPayment/parse");
  const base = parseIntentDeterministic(text);
  if (looksLikeSendPayment(text) && base.action === "send_payment") {
    const slots: AskSlots = { ...emptySlots(), amount: base.amount != null ? String(base.amount) : null, asset: /\b(MON|USDC)\b/i.test(text) ? base.token : null, recipient: base.recipient };
    const missing = REQUIRED_SLOTS.send_payment.filter((k) => !slots[k]);
    // Amount before recipient when both are missing — "How much?" then
    // "Who should receive it?", matching how a person would actually ask.
    return missing.length === 0
      ? { kind: "send_payment", outcome: "complete", slots }
      : { kind: "send_payment", outcome: "incomplete", slots, question: missing.includes("amount") ? `How much${slots.asset ? ` ${slots.asset}` : ""} would you like to send?` : missing.includes("recipient") ? `Who should receive ${slots.amount ? `the ${slots.amount}${slots.asset ? ` ${slots.asset}` : ""}` : "it"}?` : "Which token — MON or USDC?" };
  }

  // LAST — every curated detector above has already declined. An SDK
  // protocol action is only ever considered here, so it can never take
  // priority over a payment, swap, trade, schedule, or query.
  const protocolAction = detectProtocolAction(text);
  if (protocolAction) return protocolAction;

  return { kind: "unclear", outcome: "unclear", reply: "I'm not quite sure what you'd like to do — could you tell me more?" };
}

/* ── The router ────────────────────────────────────────────────────────────
 * routeRequest() decides, BEFORE any Anthropic call, whether one is needed
 * at all. It is deliberately small and deterministic — not a parallel
 * keyword classifier competing with the real natural-language layer, just a
 * front gate that recognizes the messages the application can already
 * answer with total confidence (a greeting, a fixed fact, a follow-up that
 * unambiguously merges into a known pending intent, or a read-only query
 * the existing deterministic detectors resolve) and lets everything else —
 * including every FRESH money-moving request — through to real semantic
 * understanding. */

export const ROUTE_CATEGORIES = [
  "simple_chat",
  "deterministic_query",
  "wallet_query",
  "transaction_query",
  "follow_up",
  "actionable_operation",
  "ambiguous",
] as const;
export type RouteCategory = (typeof ROUTE_CATEGORIES)[number];

export interface RouteResult {
  route: RouteCategory;
  /** Whether understand() needs to make a real Anthropic call for this. */
  anthropic: boolean;
  /** Set (and authoritative) whenever anthropic is false. */
  understanding: Understanding | null;
  /** The deterministic engine's own best guess either way — used as the
   *  fallback if anthropic is true but no key is configured, or a live call
   *  fails. Never used as the primary answer when anthropic is true. */
  fallback: Understanding;
}

const READONLY_KINDS = new Set<AskIntentKind>([
  "wallet_balance", "token_balance", "transaction_history", "wallet_activity",
  "transaction_status", "transaction_details", "automation_management",
]);
const TRANSACTION_KINDS = new Set<AskIntentKind>([
  "transaction_history", "wallet_activity", "transaction_status", "transaction_details",
]);

const GREETING_RE = /^(hi|hello|hey|yo|howdy|good\s*(morning|afternoon|evening)|sup|what'?s\s*up)[!.? ]*$/i;
const THANKS_RE = /^(thanks|thank\s*you|thx|ty|appreciate\s*it|cheers)[!.? ]*$/i;
const FAREWELL_RE = /^(bye|goodbye|see\s*ya|see\s*you|later|farewell|take\s*care)[!.? ]*$/i;

/** A signal that an actionable request might be riding along in the same
 *  message as a greeting/fact/time question ("what is USDC, and can you
 *  send 50 of it to 0x...?"). GREETING/THANKS/FAREWELL are already anchored
 *  to the WHOLE message so they can't be hijacked this way, but the FACTS
 *  and time/date checks below match a substring anywhere in the text — this
 *  guards them so a compound message always falls through to real
 *  classification instead of silently answering only the fact half and
 *  dropping the actionable half. */
const ACTIONABLE_SIGNAL_RE = /\b(send|pay|swap|convert|exchange|trade|schedule|recurring|automate)\b|0x[a-fA-F0-9]{40}|\d+(?:\.\d+)?\s*(?:MON|USDC)\b/i;

/** A bare EVM address — the ONLY signal token_lookup detection needs. Kept
 *  distinct from ACTIONABLE_SIGNAL_RE's own address check above (that one
 *  is about whether a compound message might have an actionable half riding
 *  along with a fact/greeting; this one is the literal extraction). */
const EVM_ADDRESS_RE = /0x[a-fA-F0-9]{40}/;

/** A real money-moving verb alongside the address means the address is a
 *  RECIPIENT or a swap target, not the subject of a lookup — "send 10 USDC
 *  to 0x..." must never be hijacked into a token lookup. "trade" is a whole
 *  word match (\b...\b), so it does NOT match inside "tradable" — "Is this
 *  token tradable? 0x..." correctly stays a lookup. */
/** A question about past activity ("what did I pay…"), not a new request. */
const QUESTION_START_RE = /^\s*(what|when|who|how|did|show|list|where|which)\b/i;
const MONEY_ACTION_VERBS_RE = /\b(send|pay|swap|convert|exchange|trade|schedule|recurring|automate|distribute|split)\b/i;

/**
 * Deterministic detection of an SDK protocol action (Phase 2). This is the
 * ONLY producer of the "protocol_action" kind — the Anthropic classifier
 * can't emit it (see CLASSIFY_KINDS) — and it is called LAST in classifyFresh,
 * after every curated detector has already declined, so a curated intent
 * always wins over a superficially similar protocol-action phrase.
 *
 * It never invents identity: protocolId/actionId come from matching an
 * explicit, tightly-scoped phrase to a REGISTERED action, actionVersion is
 * the version currently registered (pinned so confirmation resolves exactly
 * that one), and the action is only offered when it is actually registered
 * AND pinned to the chain this deployment is on. The amount is the literal
 * number from the text — never guessed. Nothing here builds calldata, names
 * a target, or produces a transaction; it stops at "which registered action,
 * and with what amount", exactly as Phase 2C requires.
 *
 * Phase 2 recognizes only WMON wrap/unwrap. The patterns are intentionally
 * narrow ("wrap 1 MON", "unwrap 1 WMON") — a broader natural-language surface
 * is a later concern, and being conservative here means this can never shadow
 * a curated intent by over-matching.
 */
const WRAP_RE = /\bwrap\s+([0-9]+(?:\.[0-9]+)?)\s*mon\b/i;
const UNWRAP_RE = /\bunwrap\s+([0-9]+(?:\.[0-9]+)?)\s*w?mon\b/i;


function detectProtocolAction(text: string): Understanding | null {
  ensureBuiltinsRegistered();
  const activeChainId = getChain().id;

  const resolve = (actionId: "wrap" | "unwrap", amount: string): Understanding | null => {
    const version = getCurrentActionVersion("wmon", actionId);
    if (!version) return null; // not registered -> not offered
    const action = getAction("wmon", actionId, version);
    // Only offer an action that is actually registered AND on this chain —
    // the classifier must never surface an action it couldn't execute.
    if (!action || action.chainId !== activeChainId) return null;
    return {
      kind: "protocol_action", outcome: "complete",
      slots: { ...emptySlots(), protocolId: "wmon", actionId, actionVersion: version, amount },
    };
  };

  // unwrap is checked before wrap so "unwrap ... mon" (which also contains
  // the substring "wrap") is never misread as a wrap.
  const unwrap = text.match(UNWRAP_RE);
  if (unwrap) return resolve("unwrap", unwrap[1]);
  const wrap = text.match(WRAP_RE);
  if (wrap) return resolve("wrap", wrap[1]);

  const aave = detectAaveAction(text, activeChainId);
  if (aave) return aave;
  return null;
}

/** "Supply 100 USDC to Aave" / "Supply 100 USDC to Aave V3" —
 *  "Withdraw 50 USDC from Aave" / "Withdraw 50 USDC from Aave V3". Same
 *  discipline as WRAP_RE/UNWRAP_RE above: the amount is the
 *  literal number in the text, and the token is resolved ONLY to the one
 *  configured stablecoin via getStablecoin() (a real, verified address) —
 *  never an arbitrary symbol-to-address guess. Aave's own supply/withdraw
 *  actions only ever take an ERC-20 reserve (never native MON), so unlike
 *  the split path there is no "mon" branch here at all. "v3" is optional
 *  and case-insensitive so both "Aave" and "Aave V3" match. */
const AAVE_SUPPLY_RE = /\bsupply\s+([0-9]+(?:\.[0-9]+)?)\s*usdc\s+to\s+aave(?:\s*v3)?\b/i;
const AAVE_WITHDRAW_RE = /\bwithdraw\s+([0-9]+(?:\.[0-9]+)?)\s*usdc\s+from\s+aave(?:\s*v3)?\b/i;

/**
 * Deterministic Aave V3 Monad supply/withdraw detection (Phase 8). Never
 * invents a destination address: the resulting actionInputs carries only
 * `asset` and `amount` — no `onBehalfOf`/`to`. Those are Aave's own required,
 * explicit inputs (see lib/sdk/actions/aave-v3-monad/supply and /withdraw's
 * own docs on why the SDK itself never defaults them), and are filled in by
 * orchestrate.ts's dispatchProtocolAction with the ACTUAL connected wallet
 * address — the one piece of real caller context that exists at that layer —
 * never by this classifier, which has no wallet context at all and must
 * never fabricate one.
 */
function detectAaveAction(text: string, activeChainId: number): Understanding | null {
  const supplyMatch = text.match(AAVE_SUPPLY_RE);
  const withdrawMatch = !supplyMatch ? text.match(AAVE_WITHDRAW_RE) : null;
  const match = supplyMatch ?? withdrawMatch;
  if (!match) return null;
  const actionId: "supply" | "withdraw" = supplyMatch ? "supply" : "withdraw";

  // The only token this detector can safely resolve without guessing a
  // contract address — same as the split path's USDC branch (lib/ask/intent/split.ts).
  let usdc;
  try {
    usdc = getStablecoin();
  } catch {
    return null; // stablecoin not configured on this deployment — fail closed
  }

  const version = getCurrentActionVersion("aave-v3-monad", actionId);
  if (!version) return null; // not registered -> not offered
  const action = getAction("aave-v3-monad", actionId, version);
  // Only offer an action that is actually registered AND on this chain — the
  // classifier must never surface an action it couldn't execute.
  if (!action || action.chainId !== activeChainId) return null;

  return {
    kind: "protocol_action", outcome: "complete",
    slots: {
      ...emptySlots(),
      protocolId: "aave-v3-monad", actionId, actionVersion: version,
      actionInputs: { asset: usdc.address, amount: match[1] },
    },
  };
}

/** Detects "what is this token, 0x...", a bare address, "check this CA:
 *  0x...", etc. — purely mechanical (one regex match plus a negative
 *  keyword check), so this is answered without ever spending an Anthropic
 *  call on it, no matter how the user phrases it. */
function detectTokenLookup(text: string): Understanding | null {
  const match = text.match(EVM_ADDRESS_RE);
  if (!match) return null;
  if (MONEY_ACTION_VERBS_RE.test(text)) return null;
  return { kind: "token_lookup", outcome: "complete", slots: { ...emptySlots(), tokenAddress: match[0] } };
}

/** Ordinary conversation with no operation implied — answered locally,
 *  never worth an Anthropic call. */
function matchSimpleChat(text: string): string | null {
  const t = text.trim();
  // Mirrors the empty state's four on-ramps, in the same words — "trade a
  // token" rather than "swap tokens", since trade is the capability that
  // actually handles buy/sell on any Monad token.
  if (GREETING_RE.test(t)) return "Hey! I'm Ask PayAI — tell me what you'd like to do: send a payment, trade a token, automate a payment, or check your balance.";
  if (THANKS_RE.test(t)) return "Anytime! Let me know if there's anything else.";
  if (FAREWELL_RE.test(t)) return "See you around!";
  return null;
}

/** Fixed, honest facts about the product — the answer never depends on the
 *  user's own data or context, so there's nothing for an LLM to reason
 *  about. Kept intentionally short and accurate to what's actually true
 *  elsewhere in the product, not a marketing pitch. */
const FACTS: { re: RegExp; reply: string }[] = [
  { re: /\bwhat\s+is\s+payai\b/i, reply: "PayAI is an AI payment platform on Monad — you describe a payment in plain English, and your own wallet signs interactive payments. PayAI never asks for your seed phrase. Scheduled automations use a capped on-chain agent; the Telegram bot, if you use it, is a separate custodial hot wallet." },
  { re: /\bhow\s+does\s+payai\s+work\b/i, reply: "You tell PayAI what you want to do — send, swap, or schedule a payment — in your own words. PayAI parses it, shows you a preview, and only moves anything once you explicitly confirm and sign with your own wallet." },
  { re: /\bwhat\s+is\s+mon\b/i, reply: "MON is the native token of Monad, the network PayAI runs on — it's used to pay network fees and can be sent or swapped like any other supported asset." },
  { re: /\bwhat\s+is\s+usdc\b/i, reply: "USDC is a USD-pegged stablecoin — one of the two assets PayAI supports sending and swapping today, alongside MON." },
];

/** Deterministic, non-personal facts (product info, time/date) — answered
 *  locally. Distinct from simple_chat only for router/logging clarity. */
function matchDeterministicFact(text: string): string | null {
  if (ACTIONABLE_SIGNAL_RE.test(text)) return null;
  const t = text.trim();
  for (const f of FACTS) if (f.re.test(t)) return f.reply;
  if (/\bwhat\s+time\s+is\s+it\b/i.test(t)) {
    return `It's ${new Date().toISOString().slice(11, 16)} UTC right now — check your device's clock for your local time.`;
  }
  if (/\bwhat'?s\s+(today'?s\s+)?date\b|\bwhat\s+day\s+is\s+it\b/i.test(t)) {
    return `Today is ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })} (UTC).`;
  }
  return null;
}

// "Was THAT successful?" needs conversation history to know what "that"
// refers to — the deterministic transaction_status/transaction_details
// heuristics match on generic words (it/that/this/payment/transaction) and
// can't tell a self-contained query ("show my LATEST transaction", safe to
// resolve locally — it names what it means) from a bare pronoun leaning on
// context that may point at something other than "the most recent one".
// Only the self-contained shape is trusted locally; a bare pronoun WITH
// real prior conversation to (possibly wrongly) default away from goes to
// Anthropic, which can actually read the referent back out of that history.
const SELF_CONTAINED_TX_RE = /\b(latest|last|recent|most\s+recent)\b/i;
const REFERENTIAL_PRONOUN_RE = /\b(that|it|this)\b/i;

/** Decides whether this message needs Anthropic before anything is spent on
 *  it. See the module-level comment above for the categories and the
 *  reasoning behind which ones skip a real call. */
export async function routeRequest(text: string, pending: Understanding | null, history: ConversationTurn[] = []): Promise<RouteResult> {
  const chatReply = matchSimpleChat(text);
  if (chatReply) {
    const u: Understanding = { kind: "chat", outcome: "chat", reply: chatReply };
    return { route: "simple_chat", anthropic: false, understanding: u, fallback: u };
  }
  const factReply = matchDeterministicFact(text);
  if (factReply) {
    const u: Understanding = { kind: "chat", outcome: "chat", reply: factReply };
    return { route: "deterministic_query", anthropic: false, understanding: u, fallback: u };
  }

  // A message with a split verb is ALWAYS a fresh split, answered entirely by
  // the deterministic split path (lib/ask/intent/split.ts): a preview-ready
  // split or a specific clarification — never a pending-intent merge, never
  // the single-recipient send detector (which would read "send 50 USDC split
  // between A, B and C" as a send of everything to A), and never Anthropic.
  // Rooms were removed from PayAI. A room request still gets recognised
  // (lib/ask/intent/roomIntent.ts) — checked before split/compound, since "a
  // room for 100 USDC for 5 people" is one room, not a split — but only so it
  // can be answered plainly. Nothing is prepared.
  if (detectRoomRequest(text)) {
    const u: Understanding = { kind: "unsupported", outcome: "unsupported", capability: "rooms_removed", reply: ROOMS_REMOVED_REPLY };
    return { route: "actionable_operation", anthropic: false, understanding: u, fallback: u };
  }

  const split = await detectSplit(text);
  if (split) return { route: "actionable_operation", anthropic: false, understanding: split, fallback: split };

  // More than one action (or more than one recipient for one action) can't be
  // held by this path's single operation. Say so and prepare nothing, rather
  // than keep one action and silently drop the rest (lib/ask/intent/compound.ts).
  // Several exactly-written actions are the plan path's (lib/ask/planTurn.ts).
  const compound = detectCompoundRequest(text);
  if (compound) return { route: "actionable_operation", anthropic: false, understanding: compound, fallback: compound };

  // A money-moving request with timing the schedule engine can't honour (a
  // time of day, a timezone, "every 2 weeks", "October 20", "tonight"…) is
  // clarified, never prepared: otherwise the time was silently replaced by
  // 09:00 UTC, or the request became an immediate send (lib/agent/scheduleTiming.ts).
  if (MONEY_ACTION_VERBS_RE.test(text) && !QUESTION_START_RE.test(text)) {
    const timing = unreadableTiming(text);
    if (timing) {
      const u: Understanding = { kind: "unsupported", outcome: "unsupported", capability: "schedule_timing", reply: unreadableTimingReply(timing) };
      return { route: "actionable_operation", anthropic: false, understanding: u, fallback: u };
    }
  }

  // A pending send_payment/swap/schedule already waiting on a specific slot
  // (most importantly `recipient`) gets first crack at the message — "To
  // 0x1234..." after "I want to send USDC." / "50." is answering THAT
  // question, not starting an unrelated token lookup, even though it
  // contains a bare address. Only once nothing pending actually claims this
  // message does a fresh address get treated as "tell me about this token"
  // (see detectTokenLookup below) — which still correctly wins over a
  // pending token_lookup itself, since TOKEN_FOLLOWUP_RE's merge branch
  // inside tryMergePending explicitly declines when a NEW address is present.
  const merged = tryMergePending(text, pending);
  if (merged) return { route: "follow_up", anthropic: false, understanding: merged, fallback: merged };

  const tokenLookup = detectTokenLookup(text);
  if (tokenLookup) return { route: "deterministic_query", anthropic: false, understanding: tokenLookup, fallback: tokenLookup };

  const fresh = await classifyFresh(text, pending);
  // classifyFresh only ever actually returns an actionable kind (complete or
  // incomplete) or "unclear" — this check also narrows fresh.kind to
  // AskIntentKind for the Set lookups below.
  if (fresh.outcome !== "incomplete" && fresh.outcome !== "complete") {
    return { route: "ambiguous", anthropic: true, understanding: null, fallback: fresh };
  }
  if (
    (fresh.kind === "transaction_status" || fresh.kind === "transaction_details") &&
    history.length > 0 && REFERENTIAL_PRONOUN_RE.test(text) && !SELF_CONTAINED_TX_RE.test(text)
  ) {
    return { route: "ambiguous", anthropic: true, understanding: null, fallback: fresh };
  }
  if (READONLY_KINDS.has(fresh.kind)) {
    const route: RouteCategory = TRANSACTION_KINDS.has(fresh.kind) ? "transaction_query" : "wallet_query";
    return { route, anthropic: false, understanding: fresh, fallback: fresh };
  }
  // A detected SDK protocol action is DETERMINISTIC and registry-gated (see
  // detectProtocolAction) — it must never be sent to Anthropic. The LLM
  // schema deliberately excludes "protocol_action" (see CLASSIFY_KINDS), so
  // routing it to a live call would just lose it; and there is nothing for a
  // model to interpret — the action, version, and amount were all resolved
  // mechanically. Returned as the authoritative understanding, no call spent.
  if (fresh.kind === "protocol_action") {
    return { route: "actionable_operation", anthropic: false, understanding: fresh, fallback: fresh };
  }
  // A FRESH send_payment/swap/schedule_payment/recurring_payment/
  // distribution always gets a real Anthropic read, even when the
  // deterministic engine thinks it already has every field — a clean
  // "Send 50 USDC to 0x..." is exactly as easy for a human to read as it is
  // for a keyword matcher, but money-moving intent deserves real semantic
  // understanding, not a locally-guessed shortcut. A FOLLOW-UP correcting
  // an already-Anthropic-vetted pending operation is the different, safe
  // case handled above by tryMergePending.
  return { route: "actionable_operation", anthropic: true, understanding: null, fallback: fresh };
}

/** Rough, dev-facing cost estimate — never shown to users, only logged.
 *  Rates are USD per 1M tokens; unrecognized models log token counts only. */
const MODEL_PRICING_PER_MILLION: Record<string, { input: number; output: number }> = {
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const rate = MODEL_PRICING_PER_MILLION[model];
  if (!rate) return null;
  return (inputTokens * rate.input + outputTokens * rate.output) / 1_000_000;
}

/** Structured, dev-facing observability only — never returned to the client
 *  (understand()'s return value is just the Understanding). Matches the
 *  product's own log-line format so these are easy to grep/aggregate. */
function logRouterDecision(routed: RouteResult) {
  const lines = [`[AskPayAI Router]`, `route=${routed.route}`, `anthropic=${routed.anthropic}`];
  const kind = (routed.understanding ?? routed.fallback).kind;
  if (kind !== "chat" && kind !== "unclear" && kind !== "unsupported") lines.push(`intent=${kind}`);
  console.log(lines.join("\n"));
}

export async function understand(
  text: string,
  history: ConversationTurn[],
  pending: Understanding | null,
): Promise<Understanding> {
  const routed = await routeRequest(text, pending, history);
  logRouterDecision(routed);
  if (!routed.anthropic) return routed.understanding!;

  if (!process.env.ANTHROPIC_API_KEY) return routed.fallback;
  try {
    return reconcileSchedule(await understandWithLLM(text, history, pending), routed.fallback);
  } catch {
    return routed.fallback;
  }
}

const SCHEDULE_KINDS = new Set<AskIntentKind>(["schedule_payment", "recurring_payment"]);

/** Ask PayAI's reply to a request for a Room — a feature that was removed. */
export const ROOMS_REMOVED_REPLY =
  "Rooms aren't part of PayAI anymore. To split a cost, send each person's share directly — for example \"send 20 USDC each to alice.nad and bob.nad\". Nothing was prepared.";

/**
 * The model reads the request; it does not get to silently discard a
 * schedule the deterministic parser found in the same words.
 *
 * When the deterministic pass recognised a schedule (a day, a date, a
 * cadence), that timing is authoritative: the model's reading is kept for
 * amount, token and recipient, but its kind and timing can't drop or replace
 * the parsed schedule — including the dangerous case of reading "send 1 USDC
 * to bob.nad every Friday" as an immediate send. Anything the model resolved
 * that the parser didn't still fills the gaps, and what is still missing is
 * asked for, one slot at a time. Exported for tests.
 */
export function reconcileSchedule(model: Understanding, deterministic: Understanding): Understanding {
  if (!SCHEDULE_KINDS.has(deterministic.kind as AskIntentKind)) return model;
  if (deterministic.outcome !== "complete" && deterministic.outcome !== "incomplete") return model;
  if (model.outcome !== "complete" && model.outcome !== "incomplete") return model;
  if (model.kind !== "send_payment" && !SCHEDULE_KINDS.has(model.kind)) return model;

  const kind = deterministic.kind as AskIntentKind;
  const d = deterministic.slots;
  const m = model.slots;
  const slots: AskSlots = {
    ...m,
    amount: m.amount ?? d.amount,
    asset: m.asset ?? d.asset,
    recipient: m.recipient ?? d.recipient,
    when: d.when ?? m.when,
    frequency: kind === "recurring_payment" ? d.frequency ?? m.frequency : null,
  };
  const missing = missingSlots(kind, slots);
  return missing.length === 0
    ? { kind, outcome: "complete", slots }
    : { kind, outcome: "incomplete", slots, question: naturalMissingSlotQuestion(kind, missing[0]) };
}
