"use client";

/**
 * The one layout every approval review and receipt in PayAI uses — Send,
 * Ask PayAI's cards, plans and quotes — so they all read the same way:
 *
 *   eyebrow        what is happening ("You're sending", "Payment sent")
 *   amount         large, with the token
 *   recipient      name, then the full address it resolves to
 *   rows           label left, value right; values wrap, never cut off
 *   total          what leaves the wallet, set apart at the bottom
 *
 * Amounts are printed at a readable precision (lib/format/tokenAmount.ts):
 * what you pay rounds up, what you get rounds down, and the exact figure is
 * the row's tooltip. Presentation only — nothing here computes a fee or
 * builds a transaction.
 */
import { useState } from "react";
import { Check, Copy, ShieldCheck } from "lucide-react";
import { TokenLogo } from "@/components/TokenLogo";
import { formatAmountText, formatDecimal, roundingForLabel, type Rounding } from "@/lib/format/tokenAmount";

/** Shared button styles for review actions. */
export const REVIEW_PRIMARY =
  "inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-panel disabled:opacity-40";
export const REVIEW_SECONDARY =
  "inline-flex h-11 w-full items-center justify-center rounded-lg border border-border px-4 text-sm font-medium text-foreground transition-colors hover:bg-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40";

/** Small uppercase label above a section. */
export function Eyebrow({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">{children}</p>;
}

/** The headline amount. `amount` is a decimal string or number. */
export function AmountHero({
  eyebrow, amount, token, suffix, round = "nearest",
}: {
  eyebrow?: React.ReactNode; amount: string | number | null | undefined; token: string; suffix?: React.ReactNode; round?: Rounding;
}) {
  const exact = amount == null ? null : String(amount);
  return (
    <div>
      {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
      <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[1.75rem] font-semibold leading-none tracking-tight text-foreground [font-variant-numeric:tabular-nums]">
        <TokenLogo token={token} size={24} />
        <span title={exact ?? undefined} className="[overflow-wrap:anywhere]">{exact == null ? "—" : formatDecimal(exact, { round })}</span>
        <span className="text-lg font-medium text-muted-foreground">{token}</span>
        {suffix && <span className="text-sm font-normal text-muted-foreground">{suffix}</span>}
      </p>
    </div>
  );
}

/** 0x0264538C… in groups of four, so it can be read and compared. */
function groupAddress(a: string): string {
  const body = a.startsWith("0x") ? a.slice(2) : a;
  return `0x ${body.replace(/(.{4})(?=.)/g, "$1 ")}`;
}

/**
 * Who gets paid. A .nad name is friendly, but the address is what the
 * signature pays — so the full address is always shown, grouped for reading,
 * with a copy button.
 */
export function RecipientBlock({ label = "To", domain, address, note }: { label?: string; domain?: string | null; address?: string | null; note?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (!address) return;
    navigator.clipboard?.writeText(address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };
  return (
    <div className="py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      {domain && (
        <p className="mt-1 flex items-center gap-1.5 text-sm font-medium text-foreground">
          <ShieldCheck size={14} className="shrink-0 text-success" aria-hidden />
          <span className="[overflow-wrap:anywhere]">{domain}</span>
        </p>
      )}
      {address && (
        <div className="mt-1 flex items-start gap-2">
          <p title={address} className={`min-w-0 flex-1 font-mono text-[12px] leading-relaxed [overflow-wrap:anywhere] ${domain ? "text-muted-foreground" : "text-foreground"}`}>
            {groupAddress(address)}
          </p>
          <button type="button" onClick={copy} aria-label="Copy address" className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-input hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
          </button>
        </div>
      )}
      {note && <p className="mt-1 text-[11px] text-muted-foreground">{note}</p>}
    </div>
  );
}

/**
 * One label/value line. Pass `value` (text) to get amounts formatted and
 * rounded by what the label means, with the exact text as the tooltip; or
 * pass children for anything else. Values wrap — never truncated.
 */
export function ReceiptRow({
  label, value, children, note, mono, muted, round,
}: {
  label: string; value?: string | null; children?: React.ReactNode; note?: string; mono?: boolean; muted?: boolean; round?: Rounding;
}) {
  const text = value == null ? null : formatAmountText(value, { round: round ?? roundingForLabel(label) });
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5">
      <dt className="shrink-0 text-[13px] text-muted-foreground">{label}</dt>
      <dd className={`min-w-0 text-right text-sm [font-variant-numeric:tabular-nums] [overflow-wrap:anywhere] ${muted ? "text-muted-foreground" : "font-medium text-foreground"} ${mono ? "font-mono text-[12px]" : ""}`}>
        {text != null ? <span title={value !== text ? value ?? undefined : undefined}>{text}</span> : children}
        {note && <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">{note}</span>}
      </dd>
    </div>
  );
}

/** The bottom line — what leaves the wallet, set apart from the rows. */
export function ReceiptTotal({ label, value, note }: { label: string; value: string; note?: string }) {
  const text = formatAmountText(value, { round: roundingForLabel(label) });
  return (
    <div className="flex items-baseline justify-between gap-4 border-t border-border pt-3">
      <dt className="shrink-0 text-sm font-medium text-foreground">{label}</dt>
      <dd className="min-w-0 text-right text-base font-semibold text-foreground [font-variant-numeric:tabular-nums] [overflow-wrap:anywhere]">
        <span title={value !== text ? value : undefined}>{text}</span>
        {note && <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">{note}</span>}
      </dd>
    </div>
  );
}

/** The row list: hairlines between rows. */
export function ReceiptRows({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <dl className={`divide-y divide-border/70 ${className}`}>{children}</dl>;
}
