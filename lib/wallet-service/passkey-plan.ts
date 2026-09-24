/**
 * Decides whether a passkey ceremony may create a wallet.
 *
 * The address is a pure function of the passkey. A new passkey is a new
 * wallet, and the old one is not deleted — it just stops being the one the
 * app opens. Creating is therefore the dangerous branch: it is allowed only
 * after a silent probe has confirmed this device has no PayAI passkey, and
 * never when this sign-in is already linked to a wallet.
 *
 * A dismissed prompt is not "no passkey". Browsers use the same error for
 * cancel and for an empty authenticator once a sheet has been shown, so a
 * shown sheet that fails never creates.
 */

export type OpenMode = "auto" | "unlock" | "switch" | "create";

export interface OpenContext {
  mode: OpenMode;
  /** This browser saved a credential id (localStorage or the parent-domain
   *  cookie). Sign-in and unlock both ignore it and ask the authenticator
   *  for every PayAI passkey, because the saved id can be the empty wallet
   *  created after the host split. */
  remembered: boolean;
  signedIn: boolean;
  serverHasWallet: boolean;
  /** `PublicKeyCredential.getClientCapabilities().immediateGet`. */
  immediate: boolean;
  serverAddress?: string | null;
}

export type PasskeyFailure = "empty" | "cancel" | "other";

export interface OpenDeps<T> {
  discover(mediation: "immediate" | "required"): Promise<T>;
  create(): Promise<T>;
  failureKind(error: unknown, mediation: "immediate" | "required"): PasskeyFailure;
}

export type OpenCode = "cancelled" | "need-create" | "existing-account" | "failed";

export class WalletOpenError extends Error {
  readonly code: OpenCode;
  readonly addressHint?: string;
  constructor(code: OpenCode, message: string, addressHint?: string) {
    super(message);
    this.name = "WalletOpenError";
    this.code = code;
    this.addressHint = addressHint;
  }
}

export function isWalletOpenError(error: unknown): error is WalletOpenError {
  if (error instanceof WalletOpenError) return true;
  return !!error && typeof error === "object" && (error as { name?: string }).name === "WalletOpenError";
}

function messageFor(code: OpenCode, address?: string | null): string {
  const hint = address ? ` (${address.slice(0, 6)}…${address.slice(-4)})` : "";
  switch (code) {
    case "existing-account":
      return `This sign-in already has a PayAI wallet${hint}. Unlock that passkey — a new one would be a different, empty wallet. If it isn't on this device, open the password manager that synced it (iCloud or Google) and try again.`;
    case "need-create":
      return "No PayAI passkey was used. If you've used PayAI before, try again and pick the existing passkey — creating a new one will not bring the old wallet back.";
    case "cancelled":
      return "Passkey sign-in was cancelled. Nothing was created.";
    default:
      return "Couldn't open your wallet.";
  }
}

function stop(ctx: OpenContext, code: OpenCode): never {
  throw new WalletOpenError(code, messageFor(code, ctx.serverAddress), ctx.serverAddress ?? undefined);
}

/** A silent "nothing here" result. Never creates on the sign-in path — that
 *  error is also what a cancelled picker returns, and creating then would mint
 *  a second wallet for someone who simply dismissed the sheet. */
function afterConfirmedEmpty<T>(ctx: OpenContext, deps: OpenDeps<T>): Promise<{ value: T; created: boolean }> {
  if (ctx.serverHasWallet) stop(ctx, "existing-account");
  if (ctx.mode === "create") {
    return deps.create().then(
      (value) => ({ value, created: true as const }),
      (error: unknown) => {
        if (deps.failureKind(error, "required") !== "other") stop(ctx, "cancelled");
        throw error;
      },
    );
  }
  stop(ctx, "need-create");
}

async function finishDiscover<T>(ctx: OpenContext, deps: OpenDeps<T>): Promise<{ value: T; created: boolean }> {
  try {
    return { value: await deps.discover("required"), created: false };
  } catch (error) {
    const kind = deps.failureKind(error, "required");
    if (kind === "other") throw error;
    // The sheet was shown. Cancel and "nothing to pick" look the same, so
    // this path never creates.
    if (ctx.serverHasWallet) stop(ctx, "existing-account");
    if (ctx.mode === "unlock" || ctx.mode === "switch") stop(ctx, "cancelled");
    stop(ctx, "need-create");
  }
}

/**
 * Opens the passkey wallet. `created` is true only when a new passkey was
 * registered in this call.
 */
export async function runPasskeyOpen<T>(ctx: OpenContext, deps: OpenDeps<T>): Promise<{ value: T; created: boolean }> {
  if (ctx.mode === "switch" || ctx.mode === "unlock") return finishDiscover(ctx, deps);

  // Explicit create still refuses to mint a second wallet for a sign-in that
  // already has one, and still prefers a passkey the probe can see.
  if (ctx.mode === "create" && ctx.serverHasWallet) stop(ctx, "existing-account");

  // The confirmed-create button. The previous attempt already proved there
  // was nothing to unlock. Probing again would show a second empty sheet on
  // browsers without immediate mediation.
  if (ctx.mode === "create" && !ctx.immediate) {
    try {
      return { value: await deps.create(), created: true };
    } catch (error) {
      if (deps.failureKind(error, "required") !== "other") stop(ctx, "cancelled");
      throw error;
    }
  }

  if (ctx.immediate) {
    try {
      return { value: await deps.discover("immediate"), created: false };
    } catch (error) {
      const kind = deps.failureKind(error, "immediate");
      if (kind === "empty") return afterConfirmedEmpty(ctx, deps);
      // Probe couldn't be trusted (or the user hit a real sheet). Fall
      // through to the normal picker, which does not create on failure.
      return finishDiscover(ctx, deps);
    }
  }

  return finishDiscover(ctx, deps);
}

/** Classifies WebAuthn failures without importing the passkey library.
 *  Immediate mediation rejects with NotAllowedError and no UI when the
 *  authenticator has no discoverable credential — that is `empty`. The same
 *  name after a shown sheet is a cancel, and must not create a wallet. */
export function classifyPasskeyFailure(error: unknown, mediation: "immediate" | "required"): PasskeyFailure {
  if (!error || typeof error !== "object") return "other";
  const code = "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
  if (code === "PRF_UNAVAILABLE" || code === "CRYPTO_UNAVAILABLE" || code === "INPUT_INVALID") return "other";
  const cause = "cause" in error ? (error as { cause?: unknown }).cause : undefined;
  const nameOf = (value: unknown) =>
    value && typeof value === "object" && "name" in value ? String((value as { name?: unknown }).name ?? "") : "";
  const name = nameOf(cause) || nameOf(error);
  if (name === "NotSupportedError" || name === "TypeError" || name === "DataError") return "other";
  const msg = `${"message" in error ? String((error as { message?: unknown }).message ?? "") : ""} ${
    cause && typeof cause === "object" && "message" in cause ? String((cause as { message?: unknown }).message ?? "") : ""
  }`.toLowerCase();
  const soft = code === "PASSKEY_OPERATION_FAILED" || name === "NotAllowedError" || name === "AbortError"
    || msg.includes("cancel") || msg.includes("not allowed") || msg.includes("aborted") || msg.includes("the operation either timed out");
  if (!soft) return "other";
  return mediation === "immediate" ? "empty" : "cancel";
}
