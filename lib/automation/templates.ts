/**
 * Automation Templates catalog.
 *
 * A template is PURELY a set of defaults for the existing Payment Automation
 * creation wizard — it configures the same engine every automation already
 * runs on (Wallet Automation / Reserved Funds, the same cron scheduler, the
 * same execution paths). No template has its own execution logic, its own
 * schedule runner, or its own storage — it only pre-fills fields the user
 * can still fully edit before confirming, exactly like typing them by hand.
 *
 * `templateId`/`templateCategory` are stored on the created automation
 * (see lib/platform/types.ts) purely as a label for the dashboard's "created
 * from" display and category filter — never consulted by execution.
 */
import type { LucideIcon } from "lucide-react";
import {
  Repeat, Home, Users, PiggyBank, Building2, FileText, Store, Repeat2,
  Rocket, Undo2, Award, Clock3, Landmark, HandCoins, Gift, Image,
  Palette, Megaphone, Sparkles, Wallet, Coins, Wallet2, Banknote, Handshake,
} from "lucide-react";

export type TemplateCategory = "personal" | "business" | "bulk" | "launchpad" | "nft" | "dao" | "creator" | "custom";

export const TEMPLATE_CATEGORIES: { id: TemplateCategory; label: string; emoji: string }[] = [
  { id: "personal", label: "Personal", emoji: "👤" },
  { id: "business", label: "Business", emoji: "🏢" },
  { id: "bulk", label: "Bulk Payments", emoji: "💸" },
  { id: "launchpad", label: "Launchpad", emoji: "🚀" },
  { id: "nft", label: "NFT", emoji: "🖼" },
  { id: "dao", label: "DAO", emoji: "🏛" },
  { id: "creator", label: "Creator", emoji: "💰" },
  { id: "custom", label: "Custom", emoji: "✨" },
];

/** A distribution-method hint for Bulk Payment templates only — same "hint,
 *  not a lock-in" contract as every other template default: the Bulk Payment
 *  wizard pre-selects it, the user can still change it before signing. */
export type BulkDistributionHint = "equal" | "fixed" | "percentage" | "custom";

/**
 * Maturity of a workflow, shown to the user as a badge.
 *
 *   "available"   — fully implemented and proven in production. No badge:
 *                   a badge on everything is a badge on nothing, and this is
 *                   the expected default. This is also why the badge
 *                   "disappears automatically" once a workflow ships — you
 *                   change one field here and the UI follows.
 *   "beta"        — genuinely works end to end, but has a real limitation
 *                   worth disclosing before someone commits money to it.
 *   "coming_soon" — NOT implemented. The card is readable so the plan is
 *                   transparent, but creation is blocked at the UI *and*
 *                   refuses at the picker, so it can never start a wizard.
 *
 * Assigning a status is a factual claim about the product. Anything marked
 * "available" must actually be proven; anything with a known constraint gets
 * "beta" and states the constraint in `statusNote`.
 */
export type WorkflowStatus = "available" | "beta" | "coming_soon";

export interface AutomationTemplate {
  id: string;
  category: TemplateCategory;
  name: string;
  description: string;
  icon: LucideIcon;
  /** Absent means "available" — the common case stays uncluttered. */
  status?: WorkflowStatus;
  /** Required for beta/coming_soon: the specific limitation or the plan.
   *  Shown in the card so the badge is never unexplained. */
  statusNote?: string;
  /** Defaults applied to the creation wizard — every field stays fully
   *  editable afterward. Omitted fields keep the wizard's own defaults. */
  defaults: {
    /** A starting-symbol hint only (any fungible Monad token, not limited to MON/USDC) — the creation wizard's token selector resolves it and the user can freely change it. */
    token?: string;
    cadence?: "once" | "daily" | "weekly" | "monthly" | "custom";
    intervalCount?: number;
    intervalUnit?: "days" | "weeks" | "months";
    purpose?: string;
    fundingMode?: "wallet" | "reserved";
    endMode?: "never" | "after_count" | "until_date";
    /** Bulk Payment templates only — a starting distribution-method hint. */
    distributionMethod?: BulkDistributionHint;
  };
}

export const TEMPLATES: AutomationTemplate[] = [
  // Personal
  { id: "personal-one-time", category: "personal", name: "One-time Transfer", description: "A single payment to someone, sent once.", icon: Repeat, defaults: { cadence: "once", token: "USDC", purpose: "Gift" } },
  { id: "personal-weekly-allowance", category: "personal", name: "Weekly Allowance", description: "A fixed amount sent every week, ongoing.", icon: Wallet, defaults: { cadence: "weekly", token: "USDC", purpose: "Family", fundingMode: "wallet" } },
  { id: "personal-monthly-rent", category: "personal", name: "Monthly Rent", description: "Rent paid to the same recipient every month.", icon: Home, defaults: { cadence: "monthly", token: "USDC", purpose: "Rent", fundingMode: "reserved" } },
  { id: "personal-family-support", category: "personal", name: "Family Support", description: "Recurring support sent to family, on your schedule.", icon: Users, defaults: { cadence: "monthly", token: "USDC", purpose: "Family", fundingMode: "wallet" } },
  { id: "personal-savings", category: "personal", name: "Savings", description: "Move a set amount into savings automatically.", icon: PiggyBank, defaults: { cadence: "monthly", token: "USDC", purpose: "Savings", fundingMode: "reserved" } },

  // Business
  { id: "business-payroll", category: "business", name: "Payroll", description: "Recurring salary payments on a fixed cycle.", icon: Building2, defaults: { cadence: "monthly", token: "USDC", purpose: "Salary", fundingMode: "reserved", endMode: "never" } },
  { id: "business-contractor", category: "business", name: "Contractor Payments", description: "Pay a contractor on a repeating schedule.", icon: FileText, defaults: { cadence: "monthly", token: "USDC", purpose: "Business", fundingMode: "wallet" } },
  { id: "business-invoice", category: "business", name: "Invoice Payments", description: "A one-time payment against an invoice.", icon: FileText, defaults: { cadence: "once", token: "USDC", purpose: "Business" } },
  { id: "business-vendor", category: "business", name: "Vendor Payments", description: "Recurring payouts to a supplier or vendor.", icon: Store, defaults: { cadence: "monthly", token: "USDC", purpose: "Business", fundingMode: "wallet" } },
  { id: "business-subscription", category: "business", name: "Subscription Billing", description: "Recurring dues that never miss a date.", icon: Repeat2, defaults: { cadence: "monthly", token: "USDC", purpose: "Subscription", fundingMode: "wallet", endMode: "never" } },

  // Bulk Payments
  { id: "bulk-community-rewards", category: "bulk", name: "Community Rewards", description: "Distribute a reward amount across many community wallets at once.", status: "beta", statusNote: "Fully functional in Wallet Automation. Reserved Funds cannot back a bulk run — a vault reservation is locked to a single recipient.", icon: Gift, defaults: { cadence: "once", token: "USDC", purpose: "Business", distributionMethod: "equal" } },
  { id: "bulk-airdrops", category: "bulk", name: "Airdrops", description: "A one-time token airdrop to a list of recipient addresses.", status: "beta", statusNote: "Fully functional in Wallet Automation. Reserved Funds cannot back a bulk run — a vault reservation is locked to a single recipient.", icon: Coins, defaults: { cadence: "once", token: "MON", purpose: "Business", distributionMethod: "fixed" } },
  { id: "bulk-salary-distribution", category: "bulk", name: "Salary Distribution", description: "Pay a whole team's salaries in one recurring run.", status: "beta", statusNote: "Fully functional in Wallet Automation. Reserved Funds cannot back a bulk run — a vault reservation is locked to a single recipient.", icon: Wallet2, defaults: { cadence: "monthly", token: "USDC", purpose: "Salary", fundingMode: "reserved", distributionMethod: "custom" } },
  { id: "bulk-contributor-payments", category: "bulk", name: "Contributor Payments", description: "Recurring payouts to a group of contributors, split however you choose.", status: "beta", statusNote: "Fully functional in Wallet Automation. Reserved Funds cannot back a bulk run — a vault reservation is locked to a single recipient.", icon: Handshake, defaults: { cadence: "monthly", token: "USDC", purpose: "Business", fundingMode: "wallet", distributionMethod: "percentage" } },
  { id: "bulk-multi-wallet-transfer", category: "bulk", name: "Multi-wallet Transfers", description: "Send different amounts to a set of your own or others' wallets in one go.", status: "beta", statusNote: "Fully functional in Wallet Automation. Reserved Funds cannot back a bulk run — a vault reservation is locked to a single recipient.", icon: Banknote, defaults: { cadence: "once", token: "USDC", purpose: "Business", distributionMethod: "custom" } },

  // Launchpad
  { id: "launchpad-token-sale", category: "launchpad", name: "Token Sale Contribution", description: "A one-time contribution to a token sale.", icon: Rocket, defaults: { cadence: "once", token: "USDC", purpose: "Investment" } },
  { id: "launchpad-investor-refund", category: "launchpad", name: "Investor Refund", description: "A one-time refund sent back to an investor.", icon: Undo2, defaults: { cadence: "once", token: "USDC", purpose: "Business" } },
  { id: "launchpad-reward", category: "launchpad", name: "Reward Distribution", description: "A single distribution of rewards to a recipient.", icon: Award, defaults: { cadence: "once", token: "MON", purpose: "Business" } },
  { id: "launchpad-vesting", category: "launchpad", name: "Vesting Distribution", description: "Recurring vested amounts released on schedule.", icon: Clock3, defaults: { cadence: "monthly", token: "USDC", purpose: "Investment", fundingMode: "reserved" } },

  // NFT
  { id: "nft-mint-payment", category: "nft", name: "Mint Payment", description: "A one-time payment for minting.", icon: Image, defaults: { cadence: "once", token: "MON", purpose: "Business" } },
  { id: "nft-creator-royalty", category: "nft", name: "Creator Royalty Distribution", description: "Recurring royalty payouts to a creator.", icon: Palette, defaults: { cadence: "monthly", token: "USDC", purpose: "Business", fundingMode: "wallet" } },
  { id: "nft-community-reward", category: "nft", name: "Community Reward Distribution", description: "A one-time reward payout to the community.", icon: Gift, defaults: { cadence: "once", token: "MON", purpose: "Business" } },

  // DAO
  { id: "dao-treasury", category: "dao", name: "Treasury Distribution", description: "A scheduled payout from a DAO treasury.", icon: Landmark, defaults: { cadence: "monthly", token: "USDC", purpose: "Business", fundingMode: "reserved" } },
  { id: "dao-contributor-payroll", category: "dao", name: "Contributor Payroll", description: "Recurring pay for a DAO contributor.", icon: HandCoins, defaults: { cadence: "monthly", token: "USDC", purpose: "Salary", fundingMode: "reserved" } },
  { id: "dao-grant", category: "dao", name: "Grant Distribution", description: "A one-time or staged grant payout.", icon: Award, defaults: { cadence: "once", token: "USDC", purpose: "Business" } },

  // Creator
  { id: "creator-revenue-share", category: "creator", name: "Revenue Sharing", description: "Recurring revenue split sent to a collaborator.", icon: Megaphone, defaults: { cadence: "monthly", token: "USDC", purpose: "Business", fundingMode: "wallet" } },
  { id: "creator-affiliate", category: "creator", name: "Affiliate Payout", description: "Recurring commission paid to an affiliate.", icon: HandCoins, defaults: { cadence: "monthly", token: "USDC", purpose: "Business", fundingMode: "wallet" } },
  { id: "creator-sponsorship", category: "creator", name: "Sponsorship Distribution", description: "A one-time sponsorship payment.", icon: Sparkles, defaults: { cadence: "once", token: "USDC", purpose: "Business" } },
];

export function templatesByCategory(category: TemplateCategory): AutomationTemplate[] {
  return TEMPLATES.filter((t) => t.category === category);
}

export function findTemplate(id: string): AutomationTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}

export const VALID_TEMPLATE_CATEGORIES: string[] = TEMPLATE_CATEGORIES.map((c) => c.id);

/** A template's effective status. Absent = "available", so the common case
 *  needs no field and a shipped workflow's badge disappears by deleting one. */
export function workflowStatus(t: AutomationTemplate): WorkflowStatus {
  return t.status ?? "available";
}

/** Whether a workflow may start a creation wizard. The picker enforces this
 *  in addition to disabling the button, so a "Coming Soon" workflow cannot be
 *  launched by any path — keyboard, programmatic click, or a stale render. */
export function canLaunchWorkflow(t: AutomationTemplate): boolean {
  return workflowStatus(t) !== "coming_soon";
}

/** Presentation for each status. Kept beside the data so the badge, the
 *  action label, and the disabled state can never drift apart. */
export const WORKFLOW_STATUS_META: Record<WorkflowStatus, {
  label: string; action: string; badge: string | null; tone: string;
}> = {
  available: { label: "Available", action: "Use Workflow", badge: null, tone: "border-exec-success/30 bg-exec-success/10 text-exec-success" },
  beta: { label: "Beta", action: "Try Beta", badge: "Beta", tone: "border-primary/40 bg-primary/10 text-primary-ink" },
  coming_soon: { label: "Coming Soon", action: "Coming Soon", badge: "Coming Soon", tone: "border-exec-scheduled/30 bg-exec-scheduled/10 text-exec-scheduled" },
};
