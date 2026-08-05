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

/**
 * Embedded-wallet operations.
 *
 * These run in the BROWSER, not on the server. That isn't an arbitrary
 * choice: the first provider (Mera) derives its key from a passkey via the
 * WebAuthn PRF extension, so the key material only ever exists in the user's
 * browser and PayAI's server has nothing to sign with. Any future embedded
 * provider plugs in here the same way; one that genuinely needs a server
 * would add its own route rather than change this contract.
 *
 * The Wallet Service interface the rest of the app consumes
 * (`useWalletService()`) is unchanged by any of this — see
 * WalletServiceContext.
 */
export interface EmbeddedWalletProvider extends WalletProvider {
  kind: "embedded";
  /** Whether this browser/device can support the provider at all (passkey +
   *  PRF availability, for Mera). Reported honestly so the UI can steer to an
   *  external wallet instead of dead-ending a device that can't finish. */
  isSupported(): boolean;
  /** Create a wallet for a first-time user. */
  create(label: string): Promise<EmbeddedWalletHandle>;
  /** Re-derive an existing user's wallet. Must be deterministic — the same
   *  user must always recover the SAME address, never a second wallet. */
  recover(): Promise<EmbeddedWalletHandle>;
  /** Whether this device has a remembered credential, i.e. whether the
   *  natural next action is "recover" rather than "create". */
  hasLocalCredential(): boolean;
  /** The address this device last unlocked, if known. Public information —
   *  it lets read-only surfaces (balances, history, deposit alerts) keep
   *  working while the wallet is locked, without any ability to sign. */
  lastKnownAddress(): `0x${string}` | null;
  /** Ends the in-memory session and zeroes key material. */
  forget(): void;
  /** Re-derives the raw private key so the user can move their funds
   *  elsewhere. Required of any embedded provider: a wallet a user cannot
   *  leave, or cannot rescue when their sign-in method is lost, is custody by
   *  another name. Implementations must re-authenticate rather than reuse an
   *  unlocked session. */
  exportPrivateKey(): Promise<`0x${string}`>;
  /** Maps provider-specific failures to language a user can act on. */
  friendlyError(e: unknown): string;
}

/**
 * A live embedded wallet: an address plus the ability to sign with it.
 *
 * **Every signature must re-verify the user.** An external wallet shows a
 * confirmation pop-up for each transaction; an embedded wallet that signs
 * silently after one unlock would be the weaker of the two, which is
 * backwards for the option PayAI recommends to newcomers. Implementations
 * must therefore obtain a fresh user approval (a passkey/biometric check, for
 * Mera) inside `signMessage` and `sendTransaction` — not merely at unlock —
 * and must not reuse long-lived key material to sign.
 */
export interface EmbeddedWalletHandle {
  address: `0x${string}`;
  signMessage(message: string): Promise<string>;
  sendTransaction(tx: UnsignedTx): Promise<string>;
  /** Zeroes the session's key material. */
  end(): void;
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
  // A swap moves a user's money and can fail, which makes it exactly the kind
  // of thing the bell exists for — it produced a transaction-log row and no
  // notification at all, so a swap that reverted while the user was on another
  // page told them nothing.
  "swap_completed",
  "swap_failed",
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
