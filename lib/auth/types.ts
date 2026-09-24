import type { AuthMethod } from "@/lib/wallet-service/types";

export type { AuthMethod };

export interface AuthSession {
  /** Deterministic id derived from the provider + the provider's account id,
   *  e.g. "google:114823...". This identifies the PayAI account. It does NOT
   *  derive the wallet — that comes from the passkey. */
  userId: string;
  authMethod: AuthMethod;
  /** Best-effort display label (email or handle) — never used for anything
   *  security-sensitive, only shown in the UI. */
  label: string;
  createdAt: number;
}
