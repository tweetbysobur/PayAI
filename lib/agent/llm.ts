/**
 * Optional LLM refinement for intent parsing.
 *
 * Only loaded (via dynamic import) when ANTHROPIC_API_KEY is present. It takes
 * the deterministic parse as a strong prior and lets Claude correct/normalize
 * fields it may have missed. Kept isolated so the core product has zero hard
 * dependency on an LLM — PayAI runs fully on the deterministic engine.
 */
import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import {
  SUPPORTED_NETWORKS,
  SUPPORTED_TOKENS,
  type Network,
  type PaymentAction,
  type Token,
} from "../payment/types";
import type { ParsedIntent } from "./types";

const ACTIONS: PaymentAction[] = [
  "send_payment",
  "create_payment_link",
  "create_checkout_link",
  "pay_invoice",
];

export async function refineWithLLM(
  rawText: string,
  prior: ParsedIntent,
): Promise<ParsedIntent> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  // Sonnet, not Opus: this is a normalization/correction pass over an
  // already-parsed intent, not open-ended reasoning -- Opus's extra latency
  // bought little here. Overridable via VERIPAYAI_MODEL if a deployment
  // needs a different tier.
  const model = process.env.VERIPAYAI_MODEL || "claude-sonnet-5";

  const msg = await client.messages.create({
    model,
    max_tokens: 1024,
    system: `You normalize stablecoin payment intents for PayAI. Return one tool call.
Valid actions: ${ACTIONS.join(", ")}. Valid tokens: ${SUPPORTED_TOKENS.join(", ")}. Valid networks: ${SUPPORTED_NETWORKS.join(", ")}.
A best-effort parse is provided as a prior; correct it only where clearly wrong. Never invent an amount or recipient that is not present.`,
    tools: [
      {
        name: "submit_intent",
        description: "Submit the normalized payment intent.",
        input_schema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ACTIONS },
            amount: { type: ["number", "null"] },
            token: { type: "string", enum: [...SUPPORTED_TOKENS] },
            recipient: { type: ["string", "null"] },
            purpose: { type: ["string", "null"] },
            network: { type: "string", enum: [...SUPPORTED_NETWORKS] },
            confidence: { type: "number" },
          },
          required: ["action", "amount", "token", "recipient", "network", "confidence"],
        },
      },
    ],
    tool_choice: { type: "tool", name: "submit_intent" },
    messages: [
      {
        role: "user",
        content: `Request: "${rawText}"\nPrior parse: ${JSON.stringify({
          action: prior.action,
          amount: prior.amount,
          token: prior.token,
          recipient: prior.recipient,
          purpose: prior.purpose,
          network: prior.network,
        })}`,
      },
    ],
  });

  const tool = msg.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
  );
  if (!tool) return prior;
  const i = tool.input as Record<string, unknown>;

  const action = (i.action as PaymentAction) ?? prior.action;
  const token = (i.token as Token) ?? prior.token;
  const network = (i.network as Network) ?? prior.network;
  const amount =
    typeof i.amount === "number" ? i.amount : prior.amount;
  const recipient =
    typeof i.recipient === "string" ? i.recipient : prior.recipient;
  const purpose =
    typeof i.purpose === "string" ? i.purpose : prior.purpose;
  const confidence =
    typeof i.confidence === "number" ? i.confidence : prior.confidence;

  return { ...prior, action, token, network, amount, recipient, purpose, confidence };
}
