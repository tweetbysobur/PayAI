/**
 * Ask PayAI — the semantic understanding layer.
 *
 * This is the ONLY place that decides what a message means. It produces a
 * structured Understanding (see types.ts) and nothing else — it never
 * touches a wallet, never builds a transaction, never calls the payment
 * pipeline. orchestrate.ts is the only thing allowed to act on what this
 * returns, and only after the user explicitly confirms.
 *
 * Two paths:
 *  - understandWithLLM: a real Claude call (forced tool output), given the
 *    conversation so far and any in-flight (pending) intent so it can merge
 *    a follow-up ("20", "make it 30") into what's already being built,
 *    instead of treating every message as an isolated command.
 *  - understandDeterministic: the key-free fallback, reusing PayAI's
 *    existing production detectors (lib/agent/brain.ts) so the product still
 *    runs with zero external dependency — reduced to recognizable keywords
 *    rather than open-ended phrasing, and honest about that limit.
 *
 * Server-only — never bundle this (or an API key) into client code.
 */
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { ASK_INTENT_KINDS, type AskIntentKind, type AskSlots, type Understanding } from "./types";

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

const CLASSIFY_KINDS = [...ASK_INTENT_KINDS, "unsupported", "unclear", "chat"] as const;

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
};

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

Rules, no exceptions:
1. Never invent or assume a value for amount, asset, recipient, or any other field. If it wasn't stated (in this message OR earlier in the conversation), it stays null.
2. Never default an unstated asset to USDC or MON. If it matters and wasn't said, ask.
3. You are given the current PENDING intent, if any, plus recent conversation. If the new message continues, answers, or corrects that pending intent (e.g. a bare "20" after you asked for an amount, "actually make it 30", or "what about MON?" right after a balance answer), merge into the SAME kind with updated slots — do not treat it as an unrelated new request. This applies even when the pending intent is already "complete" (e.g. a payment has just been previewed and is awaiting the user's confirmation) — "actually make it 75" or "change it to 0x456..." at that point still means "correct the amount/recipient of THIS payment," not "start describing a new one." Only start fresh if the message is clearly about something else.
4. If you can identify a specific capability above but something required is missing, use outcome "incomplete" and write ONE short, natural question asking for exactly what's still missing — never re-ask for something already known, never open a form.
5. If the request describes something real that PayAI does not support today (staking, lending, leverage/trading, NFTs, bridging to another chain, anything off this list), use outcome "unsupported". Explain briefly and honestly that it isn't available yet. Do NOT reinterpret it as send_payment or swap just because those happen to be supported.
6. If you genuinely cannot tell what the user wants at all, use outcome "unclear" and ask a natural clarifying question. Do not guess or force it into one of the capabilities above.
7. If it's just conversation — a greeting, thanks, a question about what PayAI is or does — with no operation implied, use outcome "chat" and reply naturally in a sentence or two.
8. Write like a helpful person, never like a template or a form label.
9. For transaction_status/transaction_details: if the user says "that", "it", "my last payment", or similar and your own PREVIOUS reply (in the recent conversation) already named a specific transaction (a hash, or a single clearly-identified payment), fill slots.txHash with that hash — you are reading it back from context, never inventing one. If nothing specific was said and none was just discussed, leave txHash null; a downstream system resolves that to the most recent transaction on its own. If the user's wording suggests they mean some OTHER, different transaction than whatever was last discussed, and you can't tell which one from the conversation, use outcome "incomplete" and ask them to say more (who it was to, roughly how much, or roughly when) rather than guessing.

Field-specific notes:
- send_payment's asset must be MON or USDC — PayAI's instant chat sends support only these two right now. A different token named here is still fine to capture (don't force it to null), it will be rejected with an honest reason downstream.
- swap's fromAsset/toAsset can be any token symbol the user names — PayAI validates tradeability downstream.
- schedule_payment's "when" must be normalized to one of: a weekday name ("Friday"), "tomorrow", "next week", "next month", "in N days/weeks/months", or an ISO date (YYYY-MM-DD) — pick whichever is the closest honest match to what the user actually said, never a made-up specific date they didn't imply.`;

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
  return { amount: null, asset: null, recipient: null, when: null, frequency: null, fromAsset: null, toAsset: null, recipientCount: null, txHash: null };
}

/** Turns whatever the model (or a malformed/adversarial tool call) returned
 *  into a well-typed Understanding. Never trusts kind/outcome to be
 *  consistent — a mismatch or an unrecognized kind always degrades to
 *  "unclear" with a safe fallback reply, never to something that LOOKS
 *  actionable without actually being validated. */
function coerce(raw: Record<string, unknown>): Understanding {
  const kind = typeof raw.kind === "string" ? raw.kind : "unclear";
  const outcome = typeof raw.outcome === "string" ? raw.outcome : "unclear";
  const rawSlots = (raw.slots && typeof raw.slots === "object" ? raw.slots : {}) as Record<string, unknown>;
  const slots: AskSlots = { ...emptySlots() };
  for (const key of Object.keys(slots) as (keyof AskSlots)[]) {
    const v = rawSlots[key];
    if (key === "recipientCount") { slots[key] = typeof v === "number" ? v : null; continue; }
    if (key === "frequency") { slots[key] = v === "daily" || v === "weekly" || v === "monthly" ? v : null; continue; }
    (slots as Record<string, unknown>)[key] = typeof v === "string" ? v : null;
  }

  if ((ASK_INTENT_KINDS as readonly string[]).includes(kind) && (outcome === "incomplete" || outcome === "complete")) {
    const missing = REQUIRED_SLOTS[kind as AskIntentKind].filter((k) => !slots[k]);
    if (outcome === "complete" && missing.length === 0) {
      return { kind: kind as AskIntentKind, outcome: "complete", slots };
    }
    const question = typeof raw.question === "string" && raw.question.trim() ? raw.question.trim() : "Could you tell me a bit more about that?";
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
  const model = process.env.VERIPAYAI_MODEL || "claude-opus-4-8";

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

  const tool = msg.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
  if (!tool) return { kind: "unclear", outcome: "unclear", reply: "I'm not quite sure what you'd like to do — could you say a bit more?" };
  return coerce(tool.input as Record<string, unknown>);
}

/**
 * Key-free fallback — reuses PayAI's existing production detectors so the
 * product still works with zero external dependency, at reduced (keyword-
 * matched, not open-ended) capability. Only a light merge with a pending
 * intent: if a bare number/token answers exactly the one missing slot, fill
 * it; anything less direct falls back to a fresh classification.
 */
async function understandDeterministic(text: string, pending: Understanding | null): Promise<Understanding> {
  const { detectSwapIntent, parseScheduleIntent, detectQueryIntent, parseIntentDeterministic } = await import("@/lib/agent/brain");

  if (pending && pending.outcome === "incomplete") {
    const missing = REQUIRED_SLOTS[pending.kind].filter((k) => !pending.slots[k]);
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
      const stillMissing = REQUIRED_SLOTS[pending.kind].filter((k) => !filled[k]);
      return stillMissing.length === 0
        ? { kind: pending.kind, outcome: "complete", slots: filled }
        : { kind: pending.kind, outcome: "incomplete", slots: filled, question: `And ${stillMissing[0]}?` };
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
      asset: sched.token,
      recipient: sched.recipient,
      when: sched.nextRun != null ? new Date(sched.nextRun).toISOString() : null,
      frequency: sched.cadence === "once" ? null : sched.cadence,
    };
    const missing = REQUIRED_SLOTS[kind].filter((k) => !slots[k]);
    return missing.length === 0
      ? { kind, outcome: "complete", slots }
      : { kind, outcome: "incomplete", slots, question: missing[0] === "recipient" ? "Who should this pay?" : missing[0] === "amount" ? "How much should it send?" : "When should it run?" };
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

  return { kind: "unclear", outcome: "unclear", reply: "I'm not quite sure what you'd like to do — could you tell me more?" };
}

export async function understand(
  text: string,
  history: ConversationTurn[],
  pending: Understanding | null,
): Promise<Understanding> {
  if (!process.env.ANTHROPIC_API_KEY) return understandDeterministic(text, pending);
  try {
    return await understandWithLLM(text, history, pending);
  } catch {
    return understandDeterministic(text, pending);
  }
}
