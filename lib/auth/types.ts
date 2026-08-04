import type { AuthMethod } from "@/lib/wallet-service/types";

export type { AuthMethod };

export interface AuthSession {
  /** Deterministic id derived from the provider + the provider's account id,
   *  e.g. "google:114823..." — this is what Mera's createOrRecoverWallet()
   *  keys on, so the same person always recovers the same embedded wallet
   *  regardless of device. */
  userId: string;
  authMethod: AuthMethod;
  /** Best-effort display label (email or handle) — never used for anything
   *  security-sensitive, only shown in the UI. */
  label: string;
  createdAt: number;
}
