"use client";

import { Suspense, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { motion, AnimatePresence } from "motion/react";
import {
  BookOpen, Search, Rocket, Repeat, Wallet as WalletIcon, ShieldCheck,
  RotateCcw, Coins, Landmark, HelpCircle, ChevronDown, LifeBuoy, ArrowRight,
} from "lucide-react";
import Link from "next/link";
import { Card, Input, Badge } from "@/components/ui";
import { SupportPanel } from "@/components/dashboard/SupportPanel";

type CategoryId =
  | "getting_started" | "automation" | "wallet_automation" | "reserved_funds"
  | "refunds" | "fees" | "tokens" | "security" | "faq";

const CATEGORIES: { id: CategoryId; label: string; icon: typeof Rocket; blurb: string }[] = [
  { id: "getting_started", label: "Getting Started", icon: Rocket, blurb: "Connect a wallet and send your first payment." },
  { id: "automation", label: "Automation", icon: Repeat, blurb: "Recurring payments, templates, and bulk distributions." },
  { id: "wallet_automation", label: "Wallet Automation", icon: WalletIcon, blurb: "Non-custodial recurring payments via ERC-20 approval." },
  { id: "reserved_funds", label: "Reserved Funds", icon: Landmark, blurb: "Pre-fund an automation from an on-chain vault." },
  { id: "refunds", label: "Refunds", icon: RotateCcw, blurb: "When and how a Reserved Funds deposit comes back." },
  { id: "fees", label: "Fees", icon: Coins, blurb: "What PayAI charges today, and what you actually pay." },
  { id: "tokens", label: "Supported Tokens", icon: Coins, blurb: "MON, USDC, and any Monad token by address." },
  { id: "security", label: "Security", icon: ShieldCheck, blurb: "How PayAI keeps custody, limits, and audits honest." },
  { id: "faq", label: "Frequently Asked Questions", icon: HelpCircle, blurb: "Quick answers to the questions that come up most." },
];

interface Article {
  id: string;
  category: CategoryId;
  question: string;
  /** Plain-language, factually grounded in what the product actually does
   *  today — never a claim about a feature that doesn't exist yet or a
   *  number that isn't real. Paragraphs are kept short; each string here
   *  renders as its own <p>. */
  answer: string[];
}

const ARTICLES: Article[] = [
  // ── Getting Started ──────────────────────────────────────────────────
  {
    id: "gs-connect",
    category: "getting_started",
    question: "How do I get started with PayAI?",
    answer: [
      "Connect a wallet from the top of the dashboard — either an embedded wallet (email, phone, passkey, or a social login) or an external wallet you already use, like MetaMask.",
      "There's no signup form and no KYC step to send a payment. Once your wallet is connected on Monad, you can send, schedule, or automate a payment right away.",
    ],
  },
  {
    id: "gs-first-payment",
    category: "getting_started",
    question: "What's the fastest way to send a payment?",
    answer: [
      "Go to Send Payment, type what you want in plain language (an amount, a token, and a recipient — an address, a .nad domain, or a saved payee), and confirm it. A PayAI Wallet asks for your passkey; an external wallet shows its own confirmation.",
      "PayAI runs every request through compliance and risk checks before it settles, and every settled payment gets a real transaction hash you can verify on Monad's block explorer.",
    ],
  },
  {
    id: "gs-automation-vs-payment",
    category: "getting_started",
    question: "What's the difference between a payment and an automation?",
    answer: [
      "A payment sends once, right now. An automation repeats on a schedule you set — daily, weekly, monthly, or a custom interval — until it completes, hits an end condition, or you cancel it.",
      "Automations use one of two funding modes (Wallet Automation or Reserved Funds) so PayAI never needs custody of your funds until the moment a payment actually executes.",
    ],
  },

  // ── Automation ────────────────────────────────────────────────────────
  {
    id: "auto-what-is",
    category: "automation",
    question: "What is a Payment Automation?",
    answer: [
      "A Payment Automation is a recurring payment PayAI executes on a schedule you define — once, daily, weekly, monthly, or a custom interval — to a fixed recipient, with a fixed or template-defined amount.",
      "You can pause, resume, edit, skip a single occurrence, or cancel an automation at any time from the Automations page.",
    ],
  },
  {
    id: "auto-timing",
    category: "automation",
    question: "Will my automation run at the exact time I picked?",
    answer: [
      "Close to it — PayAI checks for due automations roughly every minute, so execution lands near your scheduled time rather than at the exact second.",
      "If you need a payment sent right now instead of waiting for the next check, use \"Execute Now\" on the automation — it runs immediately, any time.",
    ],
  },
  {
    id: "auto-templates",
    category: "automation",
    question: "What are Automation Templates?",
    answer: [
      "Templates are pre-filled starting points for common use cases (like a recurring subscription or a payroll-style payout) so you don't have to configure every field from scratch.",
      "A template only sets smart defaults — you still choose the real recipient, amount, and timing, and can change anything it suggests before creating the automation.",
    ],
  },
  {
    id: "auto-bulk",
    category: "automation",
    question: "Can I pay multiple recipients at once?",
    answer: [
      "Yes — Bulk Payments send to many recipients in a single automation, split equally, by fixed amounts, by percentage, or a custom breakdown you define per recipient.",
      "Each recipient in a bulk run settles through the exact same compliance → risk → execution pipeline as a single-recipient payment, just called once per recipient — so a failure for one recipient never blocks the others.",
    ],
  },
  {
    id: "auto-execute-now",
    category: "automation",
    question: "Can I run an automation early, or skip an occurrence?",
    answer: [
      "\"Execute Now\" runs an active automation's next payment immediately, without waiting for its scheduled time. \"Skip\" advances past the next occurrence without sending a payment at all.",
      "Both actions require your wallet's confirmation, the same as creating or cancelling an automation — PayAI never moves funds on an automation without a signed action behind it somewhere in that automation's history.",
    ],
  },

  // ── Wallet Automation ─────────────────────────────────────────────────
  {
    id: "wa-what-is",
    category: "wallet_automation",
    question: "What is Wallet Automation?",
    answer: [
      "Wallet Automation is the non-custodial way to fund a recurring payment: you approve PayAI's on-chain PaymentExecutor contract to pull an ERC-20 token from your own wallet, up to a limit, and each scheduled occurrence pulls exactly what's due.",
      "PayAI never holds your funds between payments — they stay in your wallet until the moment of execution, and only the approved token and amount can ever be pulled.",
    ],
  },
  {
    id: "wa-revoke",
    category: "wallet_automation",
    question: "How do I revoke a Wallet Automation's approval?",
    answer: [
      "When you cancel or delete a Wallet Automation, PayAI checks whether any other active automation still uses that same token's approval — approvals are per (wallet, token, spender), not per automation, so revoking could otherwise break a different automation sharing the same token.",
      "If nothing else needs it, you'll be offered a one-click revoke that sets your approval to zero, in a transaction you sign yourself. You can also revoke any token approval directly from your wallet or a block explorer at any time.",
    ],
  },
  {
    id: "wa-insufficient",
    category: "wallet_automation",
    question: "What happens if my wallet doesn't have enough balance or approval?",
    answer: [
      "PayAI checks your on-chain balance and remaining approval ahead of each scheduled run and warns you if either looks insufficient for the upcoming payment.",
      "If a run still can't be pulled, it's recorded as a failed execution and retried automatically after a short backoff — it does not skip silently, and you'll see the failure reflected in the automation's status and activity.",
    ],
  },

  // ── Reserved Funds ────────────────────────────────────────────────────
  {
    id: "rf-what-is",
    category: "reserved_funds",
    question: "What is Reserved Funds?",
    answer: [
      "Reserved Funds is the other funding mode for automations: you deposit into PayAI's on-chain AutomationVault contract up front, and each scheduled occurrence releases the exact amount due from that reservation.",
      "It's the right choice when you want a guarantee the funds are already set aside — useful for MON (which has no ERC-20 approval mechanism) or when you don't want a standing pull-approval on your wallet.",
    ],
  },
  {
    id: "rf-custody",
    category: "reserved_funds",
    question: "Who can move funds out of the vault?",
    answer: [
      "Only two paths ever release a reservation: PayAI's automation releasing exactly the scheduled amount to the intended recipient, or a refund — which the contract always sends back to the original depositor, never anywhere else, regardless of who triggers it.",
      "You can also trigger your own refund directly against the vault contract at any time, without needing PayAI's agent to cooperate — see \"Recover reserved funds\" on the automation's card.",
    ],
  },

  // ── Refunds ───────────────────────────────────────────────────────────
  {
    id: "ref-when",
    category: "refunds",
    question: "When does a Reserved Funds deposit get refunded?",
    answer: [
      "Automatically, the moment an automation reaches a state where it will never draw on the reservation again: it's cancelled, deleted, or stops for good after repeated execution failures.",
      "If any balance remains when that happens, PayAI returns it to your wallet without you needing to ask — you'll see a \"Refunded\" status and a transaction hash on the automation's details page.",
    ],
  },
  {
    id: "ref-pending",
    category: "refunds",
    question: "My automation shows \"Refunding\" — what does that mean?",
    answer: [
      "It means something is genuinely owed back to you and the automatic refund attempt hasn't landed yet — usually a brief RPC hiccup, not a lost deposit. The reservation itself is untouched on-chain the entire time.",
      "PayAI automatically retries a pending refund on every scheduling cycle. If you don't want to wait, \"Recover reserved funds\" on the automation lets you claim it directly from your own wallet at any time.",
    ],
  },
  {
    id: "ref-history",
    category: "refunds",
    question: "Where can I see my refund history?",
    answer: [
      "Open any Reserved Funds automation's details page — the Refund History section lists every refund event with its reason, amount, transaction hash, and time, most recent first.",
    ],
  },

  // ── Fees ──────────────────────────────────────────────────────────────
  {
    id: "fees-current",
    category: "fees",
    question: "What does PayAI charge?",
    answer: [
      "PayAI currently charges a 0.25% platform fee on send-payment, Wallet Automation, and Reserved Funds. Swaps have no platform fee. You also pay standard Monad network gas on every on-chain transaction.",
      "The fee is taken on-chain from the gross amount and shown in the confirmation screen before you sign. Live rates are published at /api/fees. If they change, the rate in the confirmation you signed is the one that applies.",
    ],
  },
  {
    id: "fees-gas",
    category: "fees",
    question: "Why do I still pay gas on top of the platform fee?",
    answer: [
      "Every on-chain transaction — a payment, an approval, a vault deposit or refund — costs gas paid to the Monad network itself, the same as any blockchain transaction. The 0.25% platform fee is separate from that network gas.",
    ],
  },

  // ── Supported Tokens ──────────────────────────────────────────────────
  {
    id: "tok-which",
    category: "tokens",
    question: "Which tokens can I use?",
    answer: [
      "MON (Monad's native asset) and a curated set of verified mainnet tokens — including USDC, USDT0, AUSD, WMON, WETH, and WBTC — are supported out of the box with verified logos and decimals.",
      "Any other Monad ERC-20 token also works if you provide its contract address — PayAI resolves its real decimals and symbol on-chain before use, it just displays as \"unverified\" rather than showing a curated logo.",
    ],
  },
  {
    id: "tok-usd-value",
    category: "tokens",
    question: "Where does the approximate USD value shown next to a balance come from?",
    answer: [
      "It's a live on-chain price quote, not a static or cached number — and PayAI deliberately suppresses it for tokens whose liquidity pool is too shallow to trust, rather than show a misleading price.",
    ],
  },

  // ── Security ──────────────────────────────────────────────────────────
  {
    id: "sec-nonCustodial",
    category: "security",
    question: "Does PayAI ever hold my funds?",
    answer: [
      "Not by default in the web app. Wallet Automation never takes custody — funds stay in your wallet until the exact moment of execution. Reserved Funds does hold a deposit, but only in an on-chain vault contract that can only ever pay your intended recipient or refund back to you.",
      "The Telegram trading bot is different: it generates a hot wallet and stores the key encrypted so it can sign from chat. That path is custodial. Don't deposit more than you're willing to trust to a bot.",
    ],
  },
  {
    id: "sec-passkey",
    category: "security",
    question: "Can anything move money from my PayAI Wallet without me?",
    answer: [
      "No. Every transaction and every signature needs a fresh passkey check on your device — the same fingerprint, face, or device PIN you used to create the wallet. Unlocking the wallet does not authorise anything on its own; it only lets you see it.",
      "That means an unlocked tab left open, a shared computer, or a script that got into the page still cannot send a payment: the key used to sign is derived for that one transaction and erased immediately afterwards, and PayAI's servers never hold anything that could sign for you.",
    ],
  },
  {
    id: "sec-audit",
    category: "security",
    question: "Has PayAI's smart contract code been audited?",
    answer: [
      "PayAI's core contracts (PaymentExecutor, AutomationVault, MerchantRegistry) went through the DeltaV × Ultrafuzz protocol security program in August 2026, which found no critical fund-drain bug. Medium and low findings were patched and redeployed to mainnet.",
      "Ultrafuzz is an independent protocol review, not a full commercial audit of the application. A formal third-party audit remains on the roadmap. The write-up of each finding lives in the contracts security documentation.",
    ],
  },
  {
    id: "sec-limits",
    category: "security",
    question: "What on-chain limits protect against a runaway or compromised agent?",
    answer: [
      "PaymentExecutor enforces a per-transaction cap and a rolling daily cap, separately for stablecoins and native MON, and every payment carries a unique idempotency key so the same payment can never be executed twice.",
      "These limits are enforced by the contract itself on-chain — not just in PayAI's application code — so they hold even if the application layer were ever compromised.",
    ],
  },
  {
    id: "sec-page",
    category: "security",
    question: "Where can I read more about PayAI's security model?",
    answer: ["The full Security & Trust page covers the non-custodial design, the automation and Telegram exceptions, on-chain invariants, and the Ultrafuzz review in more depth."],
  },
  {
    id: "sec-telegram",
    category: "security",
    question: "Is the Telegram trading bot non-custodial too?",
    answer: [
      "No. The Telegram bot generates a hot wallet per Telegram user and stores the private key encrypted at rest so /buy, /sell, and /withdraw can sign from chat. That is custody.",
      "The /start command says this every time. Don't send that address more than you're comfortable trusting to a bot. You can withdraw everything with /withdraw. The web app's passkey and external wallets are a different, non-custodial model.",
    ],
  },

  // ── FAQ ───────────────────────────────────────────────────────────────
  {
    id: "faq-network",
    category: "faq",
    question: "What network does PayAI run on?",
    answer: ["Monad mainnet. Every payment, automation, and vault interaction settles as a real Monad transaction you can verify on a block explorer."],
  },
  {
    id: "faq-cancel-anytime",
    category: "faq",
    question: "Can I cancel an automation at any time?",
    answer: ["Yes, with no penalty. Cancelling immediately stops future occurrences and, for Reserved Funds, automatically refunds whatever remains in the reservation."],
  },
  {
    id: "faq-wrong-recipient",
    category: "faq",
    question: "I sent a payment to the wrong address — can it be reversed?",
    answer: [
      "No. Like any on-chain transaction, a settled payment cannot be reversed by PayAI or anyone else once it confirms. Always double-check a recipient address or .nad domain before confirming in your wallet.",
    ],
  },
  {
    id: "faq-support",
    category: "faq",
    question: "Something's wrong — how do I get help?",
    answer: ["Switch to the Support tab above. It's the fastest way to reach the team, with your automation id or transaction hash attached automatically when relevant."],
  },
];

type Tab = "articles" | "support";

function HelpCenterInner() {
  const params = useSearchParams();
  const [tab, setTab] = useState<Tab>(params.get("tab") === "support" ? "support" : "articles");
  const [query, setQuery] = useState(params.get("q") ?? "");
  const [activeCategory, setActiveCategory] = useState<CategoryId | "all">(
    (params.get("category") as CategoryId | null) ?? "all",
  );
  const [expanded, setExpanded] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return ARTICLES.filter((a) => {
      if (activeCategory !== "all" && a.category !== activeCategory) return false;
      if (!q) return true;
      return a.question.toLowerCase().includes(q) || a.answer.some((p) => p.toLowerCase().includes(q));
    });
  }, [query, activeCategory]);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="flex items-center gap-2.5 text-2xl font-semibold text-foreground"><BookOpen size={24} className="text-primary-ink" /> Help Center</h1>
        <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
          Search for how automations, refunds, fees, and security actually work in PayAI today — or report a problem directly.
        </p>
      </div>

      {/* Support used to be a separate top-level destination sitting right
          next to this one in the sidebar — same subject, two competing
          entries. It's a tab here now: one destination for "I have a
          question" and "something's wrong", with the exact same report form,
          ticket history, and deep-link prefill (automationId/category) that
          app/dashboard/support/page.tsx used to own directly. */}
      <div className="inline-flex rounded-lg border border-border bg-input/30 p-1">
        <button
          onClick={() => setTab("articles")}
          aria-current={tab === "articles" ? "page" : undefined}
          className={`inline-flex items-center gap-1.5 rounded-md px-3.5 py-1.5 text-sm font-medium transition-colors ${
            tab === "articles" ? "bg-panel text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <BookOpen size={14} /> Browse Help
        </button>
        <button
          onClick={() => setTab("support")}
          aria-current={tab === "support" ? "page" : undefined}
          className={`inline-flex items-center gap-1.5 rounded-md px-3.5 py-1.5 text-sm font-medium transition-colors ${
            tab === "support" ? "bg-panel text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <LifeBuoy size={14} /> Support
        </button>
      </div>

      {tab === "support" ? (
        <SupportPanel />
      ) : (
        <>
          <div className="relative">
            <Search size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search help articles…"
              className="w-full pl-10"
            />
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setActiveCategory("all")}
              className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                activeCategory === "all" ? "border-primary/50 bg-primary/10 text-primary-ink" : "border-border text-muted-foreground hover:border-primary/30 hover:text-foreground"
              }`}
            >
              All topics
            </button>
            {CATEGORIES.map((c) => (
              <button
                key={c.id}
                onClick={() => setActiveCategory(c.id)}
                className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                  activeCategory === c.id ? "border-primary/50 bg-primary/10 text-primary-ink" : "border-border text-muted-foreground hover:border-primary/30 hover:text-foreground"
                }`}
              >
                <c.icon size={12} /> {c.label}
              </button>
            ))}
          </div>

          {activeCategory !== "all" && !query && (
            <p className="text-xs text-muted-foreground">{CATEGORIES.find((c) => c.id === activeCategory)?.blurb}</p>
          )}

          <Card className="!p-0 overflow-hidden">
            {filtered.length === 0 ? (
              <div className="p-8 text-center">
                <p className="text-sm font-medium text-foreground">No articles match &quot;{query}&quot;</p>
                <p className="mt-1 text-xs text-muted-foreground">Try a different search, or ask directly in Support.</p>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {filtered.map((a) => {
                  const meta = CATEGORIES.find((c) => c.id === a.category)!;
                  const isOpen = expanded === a.id;
                  return (
                    <div key={a.id}>
                      <button
                        onClick={() => setExpanded(isOpen ? null : a.id)}
                        className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left transition-colors hover:bg-input/30"
                        aria-expanded={isOpen}
                      >
                        <span className="flex items-center gap-3">
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-input text-muted-foreground"><meta.icon size={14} /></span>
                          <span className="text-sm font-medium text-foreground">{a.question}</span>
                        </span>
                        <ChevronDown size={16} className={`shrink-0 text-muted-foreground transition-transform ${isOpen ? "rotate-180" : ""}`} />
                      </button>
                      <AnimatePresence initial={false}>
                        {isOpen && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: "auto", opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.2, ease: "easeOut" }}
                            className="overflow-hidden"
                          >
                            <div className="space-y-2 px-5 pb-4 pl-16">
                              {a.answer.map((p, i) => (
                                <p key={i} className="text-sm leading-relaxed text-muted-foreground">{p}</p>
                              ))}
                              {a.id === "sec-page" && (
                                <Link href="/security" className="inline-flex items-center gap-1 text-sm font-medium text-primary-ink hover:underline">
                                  Read the Security & Trust page <ArrowRight size={13} />
                                </Link>
                              )}
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          <Card className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
            <div className="flex items-center gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary-ink"><LifeBuoy size={16} /></span>
              <div>
                <p className="text-sm font-medium text-foreground">Still stuck?</p>
                <p className="text-xs text-muted-foreground">Report an issue directly, with your automation or transaction attached.</p>
              </div>
            </div>
            <button onClick={() => setTab("support")}>
              <Badge tone="primary">Open Support</Badge>
            </button>
          </Card>
        </>
      )}
    </div>
  );
}

export default function HelpCenterPage() {
  return (
    <Suspense fallback={<div className="mx-auto max-w-4xl"><p className="text-sm text-muted-foreground">Loading…</p></div>}>
      <HelpCenterInner />
    </Suspense>
  );
}
