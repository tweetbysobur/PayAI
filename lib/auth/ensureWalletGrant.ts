/**
 * Makes sure this browser holds a read grant for `address` before private
 * PayAI data is requested. If a valid cookie is already there, this does
 * not ask the wallet to sign again.
 *
 * Every outcome is a typed result, never a bare boolean: a grant that fails
 * leaves the wallet looking connected, so the reason has to be readable by
 * the caller and in the console. Nothing here carries a signature, cookie or
 * key into a result or a log line.
 */
import { WALLET_GRANT_TTL_MS, walletGrantMessage } from "./walletGrantShared";

export type WalletGrantFailure =
  /** The wallet refused, was cancelled, or threw while signing. */
  | "sign-failed"
  /** The wallet never answered within SIGN_TIMEOUT_MS. */
  | "sign-timeout"
  /** The grant endpoint could not be reached. */
  | "network"
  /** The server refused the signature. */
  | "rejected"
  /** The server refused the expiry (the browser clock is too far off). */
  | "clock"
  /** Too many attempts; try again shortly. */
  | "rate-limited"
  /** The server could not issue a grant (configuration or internal error). */
  | "server"
  /** No grant is present, and the attempt that should have made one was not
   *  observed by the caller (the passkey wallet signs it during unlock). The
   *  specific reason is in the console line the attempt wrote. */
  | "missing";

export type WalletGrantResult =
  | { ok: true; via: "existing" | "issued" }
  | { ok: false; reason: WalletGrantFailure; status?: number };

/** A wallet prompt can legitimately wait on a person, but not forever: a
 *  request that never settles would otherwise pin the in-flight slot and make
 *  every later attempt return the same stuck promise. */
export const SIGN_TIMEOUT_MS = 120_000;

let inflight: Promise<WalletGrantResult> | null = null;
let inflightFor: string | null = null;

/** The address the current grant cookie covers, or null. Read-only: it never
 *  asks the wallet for anything. `undefined` means the endpoint was unreachable. */
export async function currentGrantAddress(): Promise<string | null | undefined> {
  try {
    const res = await fetch("/api/auth/wallet-grant", { cache: "no-store" });
    const body = await res.json();
    return typeof body?.address === "string" ? body.address.toLowerCase() : null;
  } catch {
    return undefined;
  }
}

function failureFor(status: number, code: unknown): WalletGrantFailure {
  if (status === 429) return "rate-limited";
  if (status === 401) return code === "grant_expiry_invalid" ? "clock" : "rejected";
  return "server";
}

async function signWithTimeout(sign: (message: string) => Promise<string>, message: string): Promise<string | WalletGrantFailure> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<WalletGrantFailure>((resolve) => {
    timer = setTimeout(() => resolve("sign-timeout"), SIGN_TIMEOUT_MS);
  });
  try {
    const out = await Promise.race([sign(message).then((s) => s, () => "sign-failed" as const), timeout]);
    return out;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function ensureWalletGrant(
  address: string,
  sign: (message: string) => Promise<string>,
): Promise<WalletGrantResult> {
  const key = address.toLowerCase();
  if (inflight && inflightFor === key) return inflight;
  inflightFor = key;
  const attempt: Promise<WalletGrantResult> = (async (): Promise<WalletGrantResult> => {
    try {
      const current = await currentGrantAddress();
      if (current === key) return { ok: true, via: "existing" };

      const expiresAt = Date.now() + WALLET_GRANT_TTL_MS;
      const signed = await signWithTimeout(sign, walletGrantMessage(address, expiresAt));
      if (signed === "sign-failed" || signed === "sign-timeout") return { ok: false, reason: signed };
      if (typeof signed !== "string" || signed.length === 0) return { ok: false, reason: "sign-failed" };

      let res: Response;
      try {
        res = await fetch("/api/auth/wallet-grant", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ address, expiresAt, signature: signed }),
        });
      } catch {
        return { ok: false, reason: "network" };
      }
      if (res.ok) return { ok: true, via: "issued" };
      const body = await res.json().catch(() => null);
      return { ok: false, reason: failureFor(res.status, body?.code), status: res.status };
    } catch {
      return { ok: false, reason: "network" };
    } finally {
      inflight = null;
      inflightFor = null;
    }
  })();
  inflight = attempt;
  attempt.then((r) => {
    if (!r.ok) console.warn(`[payai] wallet grant not established: ${r.reason}${r.status ? ` (HTTP ${r.status})` : ""}`);
  });
  return attempt;
}

export function clearWalletGrant(): void {
  fetch("/api/auth/wallet-grant", { method: "DELETE" }).catch(() => {});
}
