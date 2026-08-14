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
  check_balance: [],
  transaction_history: [],
  automation_management: [],
  distribution: ["amount", "asset", "recipientCount"],
};

const SYSTEM_PROMPT = `You are the natural-language understanding layer for Ask PayAI, a non-custodial crypto payments product on Monad. Users type however they naturally would — casual language, slang, typos, incomplete thoughts, corrections. Your only job is to figure out what they're trying to do and extract exactly the information they've actually given. You never execute anything; you only describe intent for a separate, already-secure system to validate and act on.

Capabilities PayAI supports today, and what each needs:
- send_payment: amount, asset (MON or USDC), recipient (a wallet address, .nad domain, or a name)
- swap: amount, fromAsset, toAsset — exchanging one token for another
- schedule_payment: amount, asset, recipient, when (a one-time future date/time, e.g. "next Friday", "tomorrow", "2026-07-01")
- recurring_payment: amount, asset, recipient, frequency (daily, weekly, or monthly)
- check_balance: nothing required — the user wants to know what they hold
- transaction_history: nothing required — the user wants to see past activity
- automation_management: nothing required — the user wants to review or manage an existing scheduled/recurring payment
- distribution: amount, asset, recipientCount — paying many wallets in one go

Rules, no exceptions:
1. Never invent or assume a value for amount, asset, recipient, or any other field. If it wasn't stated (in this message OR earlier in the conversation), it stays null.
2. Never default an unstated asset to USDC or MON. If it matters and wasn't said, ask.
3. You are given the current PENDING intent, if any, plus recent conversation. If the new message continues, answers, or corrects that pending intent (e.g. a bare "20" after you asked for an amount, or "actually make it 30"), merge into the SAME kind with updated slots — do not treat it as an unrelated new request. Only start fresh if the message is clearly about something else.
4. If you can identify a specific capability above but something required is missing, use outcome "incomplete" and write ONE short, natural question asking for exactly what's still missing — never re-ask for something already known, never open a form.
5. If the request describes something real that PayAI does not support today (staking, lending, leverage/trading, NFTs, bridging to another chain, anything off this list), use outcome "unsupported". Explain briefly and honestly that it isn't available yet. Do NOT reinterpret it as send_payment or swap just because those happen to be supported.
6. If you genuinely cannot tell what the user wants at all, use outcome "unclear" and ask a natural clarifying question. Do not guess or force it into one of the capabilities above.
7. If it's just conversation — a greeting, thanks, a question about what PayAI is or does — with no operation implied, use outcome "chat" and reply naturally in a sentence or two.
8. Write like a helpful person, never like a template or a form label.

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
  return { amount: null, asset: null, recipient: null, when: null, frequency: null, fromAsset: null, toAsset: null, recipientCount: null };
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
    if (missing.length === 1) {
      const key = missing[0];
      const trimmed = text.trim();
      const filled: AskSlots = { ...pending.slots };
      if (key === "amount" && /^\d+(\.\d+)?$/.test(trimmed)) filled.amount = trimmed;
      else if ((key === "toAsset" || key === "asset") && /^(MON|USDC)$/i.test(trimmed)) (filled as Record<string, unknown>)[key] = trimmed.toUpperCase();
      else if (key === "recipient" && trimmed) filled.recipient = trimmed;
      else if (key === "frequency" && /^(daily|weekly|monthly)$/i.test(trimmed)) filled.frequency = trimmed.toLowerCase() as "daily" | "weekly" | "monthly";
      if (filled[key]) {
        const stillMissing = REQUIRED_SLOTS[pending.kind].filter((k) => !filled[k]);
        return stillMissing.length === 0
          ? { kind: pending.kind, outcome: "complete", slots: filled }
          : { kind: pending.kind, outcome: "incomplete", slots: filled, question: `And ${stillMissing[0]}?` };
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

  const query = detectQueryIntent(text);
  if (query === "show_balance") return { kind: "check_balance", outcome: "complete", slots: emptySlots() };
  if (query === "show_history") return { kind: "transaction_history", outcome: "complete", slots: emptySlots() };
  if (query === "scheduled_payment") return { kind: "automation_management", outcome: "complete", slots: emptySlots() };

  // parseIntentDeterministic's action defaults to "send_payment" whenever no
  // other action keyword matched — that's brain.ts's fallback value for
  // genuine payment text, not a positive "this is a payment" signal. Gating
  // on an actual send/pay verb here (rather than trusting that default)
  // matters: without it, "...I need to get MON..." reads its own "to get"
  // as a `to <recipient>` clause and misfires as an incomplete payment.
  const { looksLikeSendPayment } = await import("@/lib/ask/sendPayment/parse");
  const base = parseIntentDeterministic(text);
  if (looksLikeSendPayment(text) && base.action === "send_payment" && (base.amount != null || base.recipient)) {
    const slots: AskSlots = { ...emptySlots(), amount: base.amount != null ? String(base.amount) : null, asset: /\b(MON|USDC)\b/i.test(text) ? base.token : null, recipient: base.recipient };
    const missing = REQUIRED_SLOTS.send_payment.filter((k) => !slots[k]);
    return missing.length === 0
      ? { kind: "send_payment", outcome: "complete", slots }
      : { kind: "send_payment", outcome: "incomplete", slots, question: missing.includes("recipient") ? `Who should receive ${slots.amount ? `the ${slots.amount}${slots.asset ? ` ${slots.asset}` : ""}` : "it"}?` : missing.includes("amount") ? `How much${slots.asset ? ` ${slots.asset}` : ""} would you like to send?` : "Which token — MON or USDC?" };
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
