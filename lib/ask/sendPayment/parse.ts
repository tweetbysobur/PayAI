/**
 * Ask PayAI Phase 2 — the "AI intent parser" layer for send_payment.
 *
 * Pure text extraction only. Every field on the returned candidate stays
 * `null` unless it is literally present in the raw text — this module never
 * resolves a name to an address, never assumes a token, never assumes a
 * network, never fills a gap with a default. That promotion (or the decision
 * that a field is missing and must be asked about) belongs entirely to
 * validate.ts. The actual send/receive amounts that end up on-chain are
 * always re-derived from the raw text by the real, already-hardened
 * lib/agent/brain.ts parser inside /api/agent — this module's only job is
 * deciding fast, locally, whether something is even present to ask about.
 */
import type { SendPaymentCandidate } from "./types";

/** Mirrors lib/ask/mockAgent.ts's own "plain send" trigger condition, so the
 *  two stay in sync — swap/schedule/distribute/balance/etc. are checked
 *  first by the caller (mockRespond's existing priority order) and take
 *  precedence, exactly as they do in the mock layer. */
export function looksLikeSendPayment(text: string): boolean {
  const t = text.toLowerCase();
  return /\bsend\b/.test(t) || /\bpay\s/.test(t);
}

const ADDR_RE = /0x[a-fA-F0-9]{40}/;
const DOMAIN_RE = /\b[a-z0-9-]+\.(nad|nads)\b/i;
const AMOUNT_RE = /\d+(?:\.\d+)?/;
const ASSET_RE = /\b(USDC|MON)\b/i;
/** Recognized-but-not-yet-supported tokens — matched so validate.ts can give
 *  an honest "not available yet" answer instead of misreading a token the
 *  user did name as one they forgot to mention. */
const OTHER_ASSET_RE = /\b(USDT|USD|DAI|WETH|WBTC|WMON|ETH|BTC)\b/i;
const TO_CLAUSE_RE = /\bto\s+(.+?)(?:\s+on\s+\w+|\s+for\b|\s+via\b|[.,]|$)/i;
/** Networks PayAI does not operate on. Explicitly mentioning one must never
 *  be silently ignored — see the "never silently switch networks" rule. */
const OTHER_NETWORK_RE = /\b(base|polygon|ethereum|eth|arbitrum|optimism|solana|bsc|avalanche)\b/i;

export function extractSendPaymentCandidate(rawText: string): SendPaymentCandidate {
  // Strip a raw address before hunting for a bare number, so its hex digits
  // are never misread as an amount (same precaution lib/agent/brain.ts takes).
  const addrMatch = rawText.match(ADDR_RE);
  const withoutAddr = addrMatch ? rawText.replace(addrMatch[0], " ") : rawText;
  const amountMatch = withoutAddr.match(AMOUNT_RE);
  const assetMatch = rawText.match(ASSET_RE) ?? rawText.match(OTHER_ASSET_RE);
  const domainMatch = rawText.match(DOMAIN_RE);
  const toMatch = rawText.match(TO_CLAUSE_RE);
  const networkMatch = rawText.match(OTHER_NETWORK_RE);

  let recipientText: string | null = null;
  if (addrMatch) recipientText = addrMatch[0];
  else if (domainMatch) recipientText = domainMatch[0];
  else if (toMatch) recipientText = toMatch[1].replace(ASSET_RE, "").trim() || null;

  return {
    intent: "send_payment",
    assetText: assetMatch ? assetMatch[0].toUpperCase() : null,
    amountText: amountMatch ? amountMatch[0] : null,
    recipientText,
    networkText: networkMatch ? networkMatch[0] : null,
    rawText,
  };
}
