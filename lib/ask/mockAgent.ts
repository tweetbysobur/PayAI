/**
 * Ask PayAI — mock response layer.
 *
 * Stands in for the real intent-recognition AI this task deliberately does
 * not build yet (see the task's own "IMPORTANT SAFETY MODEL" — no natural
 * language is ever allowed to reach a transaction directly, real AI or
 * mocked). This does simple, honest keyword matching, purely so the
 * workspace has something realistic to render while the UI is built. It
 * NEVER produces an Operation in a status past "preview" — moving a card
 * forward is always a real click in the UI, handled in the page component,
 * not here.
 *
 * Replace this module's internals when the real AI layer lands; the return
 * shape (`AskMessage[]`) is the contract the UI already renders against, so
 * that swap should not require touching any component in components/ask/.
 */
import type { AskMessage, Intent } from "./types";

let counter = 0;
function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now()}_${counter}`;
}

const ADDR_RE = /0x[a-fA-F0-9]{6,40}/;
const DOMAIN_RE = /\b[a-z0-9-]+\.nad\b/i;

function extractRecipient(text: string): { recipient: string; domain: string | null } | null {
  const addr = text.match(ADDR_RE);
  if (addr) return { recipient: addr[0], domain: null };
  const domain = text.match(DOMAIN_RE);
  if (domain) return { recipient: `0x${"a".repeat(40)}`, domain: domain[0] };
  return null;
}

function extractAmountToken(text: string): { amount: string; token: string } | null {
  const m = text.match(/([\d,]+(?:\.\d+)?)\s*(USDC|USDT|MON|WMON|USD)?/i);
  if (!m) return null;
  const amount = m[1].replace(/,/g, "");
  if (Number(amount) <= 0) return null;
  return { amount, token: (m[2] ?? "USDC").toUpperCase() };
}

function assistantText(content: string): AskMessage {
  return { id: nextId("msg"), role: "assistant", content, createdAt: Date.now() };
}

function assistantOperation(content: string, intent: Intent): AskMessage {
  return {
    id: nextId("msg"), role: "assistant", content, createdAt: Date.now(),
    operation: { id: nextId("op"), intent, status: "preview" },
  };
}

/** Pure function: given the conversation so far (unused for now — no memory
 *  in the mock layer yet, each reply is derived from the latest message
 *  only), return the assistant's reply. Kept async since the real version
 *  will be. */
export async function mockRespond(userText: string): Promise<AskMessage> {
  const text = userText.trim();
  const lower = text.toLowerCase();

  // Swap — check before "send", since "swap 20 MON to USDC" also contains "to".
  const swapMatch = lower.match(/swap\s+([\d.]+)\s*(\w+)?\s+(?:to|for)\s+(\w+)/);
  if (swapMatch) {
    const [, amt, fromTok, toTok] = swapMatch;
    return assistantOperation(
      `Here's a quote for that swap.`,
      { kind: "swap", network: "monad", fromToken: (fromTok ?? "MON").toUpperCase(), toToken: toTok.toUpperCase(), fromAmount: amt, toAmountEstimate: (Number(amt) * 2.14).toFixed(2), slippage: "0.5%" },
    );
  }

  // Distribution — "to these N wallets" / "distribute" / "bulk".
  const distMatch = lower.match(/(\d+)\s+wallets?/) ?? (lower.includes("distribute") ? [null] : null);
  if (distMatch && (lower.includes("distribute") || lower.includes("wallets"))) {
    const amtTok = extractAmountToken(text);
    const count = distMatch[1] ? Number(distMatch[1]) : 25;
    return assistantOperation(
      `I can prepare a distribution to ${count} recipients.`,
      { kind: "distribution", network: "monad", token: amtTok?.token ?? "USDC", totalAmount: amtTok ? String(Number(amtTok.amount) * count) : String(count * 10), amountPerRecipient: amtTok?.amount ?? "10", recipientCount: count },
    );
  }

  // Recurring / scheduled — "every", "schedule", "weekly", "monthly".
  const freqMatch = lower.match(/every\s+(day|week|month|friday|monday|tuesday|wednesday|thursday|saturday|sunday)/) ?? lower.match(/\b(daily|weekly|monthly)\b/);
  if (freqMatch || lower.includes("schedule")) {
    const amtTok = extractAmountToken(text);
    const rec = extractRecipient(text);
    if (!amtTok || !rec) {
      return assistantText("I can schedule that — I just need the amount, token, and recipient. Something like \"Schedule 100 USDC to alex.nad every Friday.\"");
    }
    const raw = freqMatch?.[1]?.toLowerCase();
    const frequency = raw === "day" || raw === "daily" ? "daily" : raw === "month" || raw === "monthly" ? "monthly" : raw ? "weekly" : "weekly";
    const startDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    return assistantOperation(
      `I can set that up as a recurring payment.`,
      { kind: "recurring_payment", network: "monad", token: amtTok.token, amount: amtTok.amount, recipient: rec.recipient, recipientDomain: rec.domain, frequency, startDate },
    );
  }

  // Balance.
  if (lower.includes("balance") || lower.includes("how much")) {
    return assistantOperation(
      `Here's your current balance.`,
      { kind: "wallet_operation", network: "monad", operation: "balance" },
    );
  }

  // Recent payments / history.
  if (lower.includes("recent") || lower.includes("history") || lower.includes("my payments")) {
    return assistantOperation(
      `Here's what's happened recently.`,
      { kind: "wallet_operation", network: "monad", operation: "recent_payments" },
    );
  }

  // Explain a failure.
  if (lower.includes("fail") || lower.includes("why did") || lower.includes("explain")) {
    return assistantOperation(
      `Let me pull that up.`,
      { kind: "wallet_operation", network: "monad", operation: "explain_transaction", detail: "Your last payment was blocked by compliance screening — the recipient address matched a denylist entry. No funds moved." },
    );
  }

  // Plain send / one-off payment.
  if (lower.includes("send") || lower.includes("pay ")) {
    const amtTok = extractAmountToken(text);
    const rec = extractRecipient(text);
    if (!amtTok && !rec) {
      return assistantText("Who should this go to, and how much? For example: \"Send 50 USDC to 0x742d...91F.\"");
    }
    if (!amtTok) {
      return assistantText("Got the recipient — how much would you like to send, and in which token?");
    }
    if (!rec) {
      return assistantText(`Sending ${amtTok.amount} ${amtTok.token} — who's the recipient? A wallet address or a .nad name both work.`);
    }
    return assistantOperation(
      `I can prepare that payment for you.`,
      { kind: "payment", network: "monad", token: amtTok.token, amount: amtTok.amount, recipient: rec.recipient, recipientDomain: rec.domain, estimatedFee: "0.001 MON" },
    );
  }

  return assistantText(
    "I can help you send payments, schedule recurring ones, swap tokens, pay multiple wallets at once, or check your balance and history. What would you like to do?",
  );
}
