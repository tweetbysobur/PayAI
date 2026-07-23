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
  Palette, Megaphone, Sparkles, Wallet,
} from "lucide-react";

export type TemplateCategory = "personal" | "business" | "launchpad" | "nft" | "dao" | "creator" | "custom";

export const TEMPLATE_CATEGORIES: { id: TemplateCategory; label: string; emoji: string }[] = [
  { id: "personal", label: "Personal", emoji: "👤" },
  { id: "business", label: "Business", emoji: "🏢" },
  { id: "launchpad", label: "Launchpad", emoji: "🚀" },
  { id: "nft", label: "NFT", emoji: "🖼" },
  { id: "dao", label: "DAO", emoji: "🏛" },
  { id: "creator", label: "Creator", emoji: "💰" },
  { id: "custom", label: "Custom", emoji: "✨" },
];

export interface AutomationTemplate {
  id: string;
  category: TemplateCategory;
  name: string;
  description: string;
  icon: LucideIcon;
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
