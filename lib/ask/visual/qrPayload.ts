/**
 * What a decoded QR code says — treated as untrusted input. Only payment
 * shapes PayAI understands are recognised; everything else is refused with
 * a reason, and nothing in a payload is ever opened, fetched or run.
 *
 * Recognised:
 *   0x…                       a bare address (EIP-55 checksum enforced when mixed-case)
 *   name.nad                  a Monad name
 *   ethereum:0x…[@chain][?value=wei]          EIP-681 native transfer
 *   ethereum:<token>[@chain]/transfer?address=0x…[&uint256=n]  EIP-681 ERC-20 transfer
 *   (the "monad:" scheme is read the same way)
 *
 * Pure; no I/O.
 */
import { getAddress, isAddress } from "viem";

export const MAX_QR_PAYLOAD = 2048;

export type QrPayload =
  | {
      ok: true;
      /** 0x address (checksummed) or a .nad name. */
      recipient: string;
      /** Human amount, only when the payload states it unambiguously. */
      amount?: string;
      /** "MON" for a native request, or the token contract for ERC-20. */
      token?: string;
      /** A raw ERC-20 amount the QR carried; unusable without the token's decimals. */
      rawTokenAmount?: string;
      format: "address" | "nad" | "eip681";
    }
  | { ok: false; reason: string };

const NAD_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.nad$/i;

/** A checksummed address, or null when it isn't a valid one. Mixed-case
 *  input must carry a correct EIP-55 checksum (a typo'd address is refused). */
export function validAddress(s: string): string | null {
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) return null;
  const mixed = s.slice(2) !== s.slice(2).toLowerCase() && s.slice(2) !== s.slice(2).toUpperCase();
  if (mixed && !isAddress(s, { strict: true })) return null;
  return getAddress(s.toLowerCase());
}

export function validNad(s: string): string | null {
  return NAD_RE.test(s) ? s.toLowerCase() : null;
}

/** wei (base-10 string, optionally in 1e18 notation) → MON, or null. */
function weiToMon(v: string): string | null {
  let wei: bigint;
  const sci = /^(\d+)(?:\.(\d+))?e(\d+)$/i.exec(v);
  try {
    if (sci) {
      const frac = sci[2] ?? "";
      const exp = Number(sci[3]) - frac.length;
      if (exp < 0 || exp > 60) return null;
      wei = BigInt(sci[1] + frac) * 10n ** BigInt(exp);
    } else if (/^\d{1,60}$/.test(v)) {
      wei = BigInt(v);
    } else return null;
  } catch { return null; }
  if (wei <= 0n) return null;
  const whole = wei / 10n ** 18n;
  const frac = (wei % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

export function parseQrPayload(raw: string, activeChainId: number): QrPayload {
  const text = raw.trim();
  if (!text) return { ok: false, reason: "The QR code is empty." };
  if (text.length > MAX_QR_PAYLOAD) return { ok: false, reason: "The QR code holds more data than a payment request does." };
  if (/[\u0000-\u001f\u007f]/.test(text)) return { ok: false, reason: "The QR code contains characters a payment request never has." };

  const addr = validAddress(text);
  if (addr) return { ok: true, recipient: addr, format: "address" };
  if (/^0x[0-9a-f]{40}$/i.test(text)) return { ok: false, reason: "The address in the QR code has an invalid checksum — it may have been altered." };
  const nad = validNad(text);
  if (nad) return { ok: true, recipient: nad, format: "nad" };

  const uri = /^(ethereum|monad):(?:pay-)?([^@/?]+)(?:@(\d{1,12}))?(\/[a-z]+)?(?:\?(.*))?$/i.exec(text);
  if (uri) {
    const [, , target, chain, fn, query] = uri;
    if (chain && Number(chain) !== activeChainId) {
      return { ok: false, reason: `That payment request is for another network (chain ${chain}), not Monad.` };
    }
    const params = new URLSearchParams(query ?? "");
    const targetAddr = validAddress(target);
    if (!fn) {
      const recipient = targetAddr ?? validNad(target);
      if (!recipient) return { ok: false, reason: "The payment request in the QR code doesn't name a valid recipient." };
      const value = params.get("value");
      if (value != null) {
        const mon = weiToMon(value);
        if (!mon) return { ok: false, reason: "The amount in the QR code isn't a valid number." };
        return { ok: true, recipient, amount: mon, token: "MON", format: "eip681" };
      }
      return { ok: true, recipient, format: "eip681" };
    }
    if (fn.toLowerCase() === "/transfer") {
      if (!targetAddr) return { ok: false, reason: "The token in the QR code's payment request isn't a valid contract address." };
      const to = params.get("address");
      const recipient = to ? validAddress(to) ?? validNad(to) : null;
      if (!recipient) return { ok: false, reason: "The payment request in the QR code doesn't name a valid recipient." };
      const n = params.get("uint256");
      return { ok: true, recipient, token: targetAddr, ...(n && /^\d{1,78}$/.test(n) ? { rawTokenAmount: n } : {}), format: "eip681" };
    }
    return { ok: false, reason: "The QR code asks for a contract call PayAI doesn't run from a QR code." };
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) {
    return { ok: false, reason: "The QR code holds a link, not a payment request. PayAI doesn't open links from QR codes." };
  }
  return { ok: false, reason: "The QR code doesn't contain a wallet address or a payment request PayAI supports." };
}
