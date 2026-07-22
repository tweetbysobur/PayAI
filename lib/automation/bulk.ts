/**
 * Bulk Payments — pure calculation/validation helpers, shared by the
 * creation wizard (client) and the API route (server, which must
 * independently re-validate everything the client already checked — the
 * same "never trust the client" pattern used everywhere else in this app).
 *
 * No execution logic lives here — see lib/automation/execute.ts for that.
 * This module only decides WHO gets paid HOW MUCH; it never moves money.
 */

export type DistributionMethod = "equal" | "fixed" | "percentage" | "custom";

/** One row as entered by the user, before address resolution. */
export interface RecipientDraft {
  /** Raw text as typed/pasted/uploaded — an address, a .nad domain, or a
   *  known payee name. Resolved to a real 0x address separately. */
  input: string;
  /** Only meaningful for "fixed" and "custom" methods — the per-row amount
   *  the user entered (or left blank, which several methods tolerate). */
  amount?: number;
  /** Only meaningful for "percentage" — the per-row share, 0-100. */
  percentage?: number;
  note?: string;
}

export interface ResolvedDistributionRow {
  input: string;
  amount: number;
  note?: string;
}

export interface DistributionResult {
  ok: boolean;
  error?: string;
  rows: ResolvedDistributionRow[];
  total: number;
}

/**
 * Turns raw recipient rows + a distribution method + (for equal/percentage)
 * a total budget into a real per-recipient amount for every row. Every
 * method here is deterministic and independently re-derivable — the server
 * computes the exact same numbers from the exact same inputs, so a client
 * bug can shift what gets DISPLAYED but never what actually gets paid.
 */
export function computeDistribution(
  method: DistributionMethod,
  drafts: RecipientDraft[],
  totalBudget?: number,
): DistributionResult {
  if (drafts.length === 0) return { ok: false, error: "Add at least one recipient.", rows: [], total: 0 };

  if (method === "equal") {
    if (totalBudget == null || !Number.isFinite(totalBudget) || totalBudget <= 0) {
      return { ok: false, error: "Enter a total amount to split equally.", rows: [], total: 0 };
    }
    // Split as evenly as decimal precision allows; any leftover from
    // rounding goes to the FIRST recipient rather than being silently
    // dropped, so the sum of what's actually paid always equals the total.
    const per = Math.floor((totalBudget / drafts.length) * 1e8) / 1e8;
    const rows = drafts.map((d, i) => ({ input: d.input, amount: per, note: d.note }));
    const distributed = per * drafts.length;
    const remainder = Math.round((totalBudget - distributed) * 1e8) / 1e8;
    if (remainder !== 0) rows[0].amount = Math.round((rows[0].amount + remainder) * 1e8) / 1e8;
    return { ok: true, rows, total: totalBudget };
  }

  if (method === "fixed") {
    // Every recipient gets the SAME explicit amount — one number applies to
    // all rows, not read per-row (unlike "custom").
    if (totalBudget == null || !Number.isFinite(totalBudget) || totalBudget <= 0) {
      return { ok: false, error: "Enter the fixed amount each recipient receives.", rows: [], total: 0 };
    }
    const rows = drafts.map((d) => ({ input: d.input, amount: totalBudget, note: d.note }));
    return { ok: true, rows, total: totalBudget * drafts.length };
  }

  if (method === "percentage") {
    if (totalBudget == null || !Number.isFinite(totalBudget) || totalBudget <= 0) {
      return { ok: false, error: "Enter the total amount to allocate by percentage.", rows: [], total: 0 };
    }
    const sum = drafts.reduce((s, d) => s + (d.percentage ?? 0), 0);
    if (Math.abs(sum - 100) > 0.01) {
      return { ok: false, error: `Percentages must add up to 100% (currently ${sum.toFixed(2)}%).`, rows: [], total: 0 };
    }
    const rows = drafts.map((d) => ({ input: d.input, amount: Math.round(totalBudget * ((d.percentage ?? 0) / 100) * 1e8) / 1e8, note: d.note }));
    return { ok: true, rows, total: totalBudget };
  }

  // "custom" — every row carries its own explicit amount.
  const missing = drafts.some((d) => d.amount == null || !Number.isFinite(d.amount) || d.amount <= 0);
  if (missing) return { ok: false, error: "Enter an amount greater than 0 for every recipient.", rows: [], total: 0 };
  const rows = drafts.map((d) => ({ input: d.input, amount: d.amount!, note: d.note }));
  return { ok: true, rows, total: rows.reduce((s, r) => s + r.amount, 0) };
}

/** Duplicate detection on the RAW input, case-insensitively — catches the
 *  same address pasted twice, or the same .nad domain typed twice, even
 *  before either is resolved. Resolved-address duplicates (two different
 *  inputs that resolve to the same 0x address) are checked separately,
 *  server-side, after resolution — this module never resolves anything. */
export function findDuplicateInputs(drafts: RecipientDraft[]): string[] {
  const seen = new Map<string, number>();
  for (const d of drafts) {
    const key = d.input.trim().toLowerCase();
    if (!key) continue;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, count]) => count > 1).map(([k]) => k);
}

/**
 * Simple, dependency-free CSV parser for recipient uploads. Supports
 * headers (address/wallet, amount, percentage, note in any order) or a
 * plain single-column list of addresses (for "equal split"). Real parsing,
 * not a stub — handles quoted fields and commas inside quotes.
 */
export function parseRecipientsCsv(text: string): RecipientDraft[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  function splitCsvLine(line: string): string[] {
    const out: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = !inQuotes;
      } else if (ch === "," && !inQuotes) {
        out.push(cur); cur = "";
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out.map((c) => c.trim());
  }

  const firstRow = splitCsvLine(lines[0]).map((c) => c.toLowerCase());
  const hasHeader = firstRow.some((c) => ["address", "wallet", "recipient", "amount", "percentage", "percent", "note", "notes"].includes(c));

  if (!hasHeader) {
    // No recognizable header — treat every non-empty line as either a bare
    // address, or "address,amount" / "address,amount,note".
    return lines.map((line) => {
      const cols = splitCsvLine(line);
      return { input: cols[0], amount: cols[1] ? Number(cols[1]) : undefined, note: cols[2] || undefined };
    });
  }

  const addrIdx = firstRow.findIndex((c) => ["address", "wallet", "recipient"].includes(c));
  const amountIdx = firstRow.findIndex((c) => c === "amount");
  const pctIdx = firstRow.findIndex((c) => c === "percentage" || c === "percent");
  const noteIdx = firstRow.findIndex((c) => c === "note" || c === "notes");

  return lines.slice(1).map((line) => {
    const cols = splitCsvLine(line);
    return {
      input: cols[addrIdx] ?? "",
      amount: amountIdx >= 0 && cols[amountIdx] ? Number(cols[amountIdx]) : undefined,
      percentage: pctIdx >= 0 && cols[pctIdx] ? Number(cols[pctIdx]) : undefined,
      note: noteIdx >= 0 ? cols[noteIdx] || undefined : undefined,
    };
  }).filter((d) => d.input);
}

/** Free-text paste of addresses — one per line, or comma/whitespace
 *  separated. No amounts; used with the "equal" distribution method. */
export function parseRecipientsPaste(text: string): RecipientDraft[] {
  return text
    .split(/[\n,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((input) => ({ input }));
}
