/** Shared client-side input validation — format checks beyond "is this field empty." */

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const DOMAIN_RE = /^[a-z0-9-]+\.(nad|nads)$/i;
const AMOUNT_RE = /^\d+(\.\d+)?$/;

export function amountError(value: string): string | null {
  if (!value.trim()) return null;
  if (!AMOUNT_RE.test(value.trim())) return "Enter a valid amount (numbers only, one decimal point).";
  if (Number(value) <= 0) return "Amount must be greater than 0.";
  return null;
}

export function recipientError(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (ADDRESS_RE.test(v) || DOMAIN_RE.test(v)) return null;
  return "Enter a wallet address (0x…40 chars) or a .nad/.nads domain.";
}

export function isValidAmount(value: string): boolean {
  return AMOUNT_RE.test(value.trim()) && Number(value) > 0;
}

export function isValidRecipient(value: string): boolean {
  const v = value.trim();
  return ADDRESS_RE.test(v) || DOMAIN_RE.test(v);
}

/** Strict address check — for on-chain calls that take a raw address with no domain resolution. */
export function addressError(value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (!ADDRESS_RE.test(v)) return "Enter a valid wallet address (0x followed by 40 hex characters).";
  return null;
}

export function isValidAddress(value: string): boolean {
  return ADDRESS_RE.test(value.trim());
}
