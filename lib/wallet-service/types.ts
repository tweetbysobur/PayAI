/**
 * Wallet Service — provider-agnostic types.
 *
 * This is the ONE contract every part of PayAI is allowed to depend on for
 * wallet access. Nothing outside `lib/wallet-service/` may import a specific
 * provider's SDK (Mera, or any future embedded-wallet vendor) directly — see
 * `lib/wallet-service/providers/mera.ts` for the only file allowed to do that.
 *
 * Two provider kinds ship today:
 *   - "embedded" — a custodial-at-the-provider, non-custodial-to-PayAI wallet
 *     created and recovered through a login (Google/Apple/X/Email). First
 *     embedded provider is Mera.
 *   - "external" — a self-custody browser/hardware wallet the user already
 *     has (MetaMask, Rabby, Backpack, WalletConnect…), wired through the
 *     existing EIP-1193 integration in lib/wallet/.
 *
 * Adding a second embedded provider, or swapping Mera for something else,
 * means adding one more file under providers/ and registering it in
 * registry.ts — nothing in app/ or components/ changes.
 */

export type WalletProviderKind = "embedded" | "external";

/** Provider ids known to the registry today. A future embedded provider adds
 *  its own id here and to registry.ts — nothing else changes. */
export type WalletProviderId = "mera" | "injected" | "walletconnect";

/** How a user authenticated to reach an embedded wallet. */
export type AuthMethod = "google" | "apple" | "x" | "email";

export interface WalletAccount {
  address: string;
  chainId: number | null;
  providerId: WalletProviderId;
  kind: WalletProviderKind;
  /** Present only for embedded accounts — how the user signed in. */
  authMethod?: AuthMethod | null;
}

export interface UnsignedTx {
  to: string;
  data?: string;
  value?: string;
}

/**
 * Everything that touches a wallet — the automation engine, the AI
 * assistant's confirm-and-sign step, the dashboard — talks to THIS
 * interface, never to a provider SDK. Implementations live under
 * `providers/`.
 */
export interface WalletProvider {
  id: WalletProviderId;
  kind: WalletProviderKind;
  label: string;
  /** Whether this provider has everything it needs (env config, browser
   *  extension present, etc.) to be offered to the user right now. */
  isAvailable(): boolean | Promise<boolean>;
}

/** Server-side embedded-wallet operations. Implemented once per embedded
 *  provider (see providers/mera.ts); never called from client code — routes
 *  under app/api/wallet-service/ are the only callers. */
export interface EmbeddedWalletProvider extends WalletProvider {
  kind: "embedded";
  /** Create the user's wallet on first login, or return the existing one on
   *  every later login — the provider owns dedup/recovery by userId.
   *  `created` distinguishes the two so the caller can raise a
   *  "wallet_created" notification exactly once, on the real first login,
   *  instead of on every sign-in. A provider that genuinely can't tell the
   *  difference must report `false` rather than guess — a wrong `true` would
   *  tell a returning user their wallet was just created. */
  createOrRecoverWallet(input: { userId: string; authMethod: AuthMethod }): Promise<{ address: string; recoveryMethod: string; created: boolean }>;
  signMessage(input: { userId: string; address: string; message: string }): Promise<string>;
  sendTransaction(input: { userId: string; address: string; tx: UnsignedTx; chainId: number }): Promise<string>;
}

export const WALLET_EVENT_TYPES = [
  "wallet_created",
  "deposit_received",
  "withdrawal_completed",
  "wallet_connected",
  "wallet_disconnected",
  "automation_signed",
  "automation_executed",
  "refund_completed",
] as const;
export type WalletEventType = (typeof WALLET_EVENT_TYPES)[number];

export interface WalletNotification {
  id: string;
  merchantId: string;
  sender: string;
  type: WalletEventType;
  providerId: WalletProviderId;
  at: number;
  title: string;
  detail: string;
  amount?: number | null;
  token?: string | null;
  txHash?: string;
  explorerUrl?: string;
}
