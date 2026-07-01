/**
 * AI Payment Assistant — answers natural-language questions over the merchant's
 * own data and performs quick actions (create link / invoice). Deterministic and
 * key-free (the same deterministic-first philosophy as the agent): it
 * classifies the question, then answers from the analytics engine + store.
 *
 * Server-only.
 */
import "server-only";
import { parseIntentDeterministic } from "../agent/brain";
import {
  buildSummary,
  computeCompliance,
  computeRevenue,
  deriveCustomers,
  detectInsights,
  getAnalytics,
} from "./analytics";
import { createLink, listTx } from "./store";
import type { AssistantAnswer } from "./types";

type Window = "today" | "week" | "month" | "all";
function detectWindow(t: string): Window {
  if (/\btoday\b/.test(t)) return "today";
  if (/\bweek\b/.test(t)) return "week";
  if (/\bmonth\b/.test(t)) return "month";
  return "all";
}

export async function ask(merchantId: string, question: string): Promise<AssistantAnswer> {
  const q = question.toLowerCase().trim();
  const txs = await listTx(merchantId);

  // — Create a payment link —
  if (/\b(payment )?link\b/.test(q) && /\b(create|make|generate|new)\b/.test(q)) {
    const amount = parseIntentDeterministic(question).amount ?? 0;
    if (amount <= 0) return { intent: "create_link", answer: "What amount should the payment link be for?" };
    const link = await createLink(merchantId, { amount, memo: "Created via assistant", expiresInDays: 7 });
    return {
      intent: "create_link",
      answer: `Payment link for ${amount} USDC created (expires in 7 days): ${link.url}`,
      action: { type: "link_created", result: link },
    };
  }

  // — Generate an invoice —
  if (/\binvoice\b/.test(q) && /\b(create|make|generate|new|send)\b/.test(q)) {
    const parsed = parseIntentDeterministic(question);
    const amount = parsed.amount ?? 0;
    if (amount <= 0) return { intent: "create_invoice", answer: "What amount should the invoice be for?" };
    const who = parsed.recipient ? ` for ${parsed.recipient}` : "";
    const link = await createLink(merchantId, { amount, memo: `Invoice${who}`, expiresInDays: 14 });
    return {
      intent: "create_invoice",
      answer: `Invoice for ${amount} USDC${who} generated (due in 14 days): ${link.url}`,
      action: { type: "invoice_created", result: link },
    };
  }

  // — Revenue —
  if (/\b(revenue|earn|earnings|made|sales|income|how much)\b/.test(q)) {
    const r = computeRevenue(txs);
    const w = detectWindow(q);
    const val = w === "today" ? r.today : w === "week" ? r.thisWeek : w === "month" ? r.thisMonth : r.total;
    const label = w === "all" ? "in total" : `this ${w === "today" ? "day" : w}`;
    return {
      intent: "revenue",
      answer: `You've made ${val} ${r.currency} ${label} across ${r.settledCount} settled payment(s).`,
      data: { window: w, value: val, revenue: r },
    };
  }

  // — Failed / blocked transactions —
  if (/\b(fail|failed|blocked|declined|rejected|error)\b/.test(q)) {
    const failed = txs.filter((t) => ["blocked", "refused", "error"].includes(t.decision));
    return {
      intent: "failed_transactions",
      answer: failed.length
        ? `${failed.length} payment(s) failed or were blocked. Most recent: ${failed.slice(0, 3).map((t) => `${t.amount ?? "?"} ${t.token} (${t.decision})`).join(", ")}.`
        : "No failed or blocked payments. ✅",
      data: failed.slice(0, 20),
    };
  }

  // — Compliance status —
  if (/\b(compliance|compliant|kyc|risk profile|sanctions)\b/.test(q)) {
    const c = computeCompliance(txs);
    return {
      intent: "compliance",
      answer: `Compliance: ${c.approved} approved, ${c.review} in review, ${c.blocked} blocked — ${Math.round(c.approvalRate * 100)}% approval rate.`,
      data: c,
    };
  }

  // — Customers —
  if (/\b(customer|client|payer|who )\b/.test(q)) {
    const customers = deriveCustomers(txs).slice(0, 5);
    return {
      intent: "customers",
      answer: customers.length
        ? `Top customers: ${customers.map((c) => `${c.name ?? c.address.slice(0, 8) + "…"} (${c.totalPaid} USDC)`).join(", ")}.`
        : "No customers yet — no settled payments recorded.",
      data: customers,
    };
  }

  // — Insights / anomalies —
  if (/\b(unusual|anomal|insight|risky|suspicious|flag)\b/.test(q)) {
    const ins = detectInsights(txs);
    return {
      intent: "insights",
      answer: ins.map((i) => `${i.severity === "info" ? "•" : "⚠"} ${i.title}`).join("  "),
      data: ins,
    };
  }

  // — Recent transactions / history —
  if (/\b(transaction|history|recent|payments|activity|show)\b/.test(q)) {
    return {
      intent: "transactions",
      answer: txs.length
        ? `${txs.length} recent event(s). Latest: ${txs.slice(0, 3).map((t) => `${t.summary} [${t.decision}]`).join("; ")}.`
        : "No transactions recorded yet.",
      data: txs.slice(0, 20),
    };
  }

  // — Business summary / fallback —
  const snap = await getAnalytics(merchantId);
  return {
    intent: "summary",
    answer: buildSummary(snap),
    data: snap,
  };
}
