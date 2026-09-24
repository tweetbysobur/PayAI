"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Card } from "@/components/ui";
import { SignInMark } from "@/components/auth/SignInMark";
import { useWalletService as useWallet } from "@/lib/wallet-service/WalletServiceContext";

/**
 * Optional Google sign-in for a wallet that already exists.
 * The passkey remains the way in. Linking only means that Gmail can open
 * this same wallet later. It never creates a second one.
 */
export function GoogleLinkCard() {
  const wallet = useWallet();
  const params = useSearchParams();
  const address = wallet.accountAddress;
  const passkeyAccount = wallet.kind === "embedded" || wallet.hasEmbeddedCredential || !!address;
  const [linked, setLinked] = useState<{ label: string } | null>(null);
  const [busy, setBusy] = useState<"link" | "unlink" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const linkError = params.get("link_error");
  const justLinked = params.get("linked") === "google";

  useEffect(() => {
    if (!address || !wallet.authMethods.google) return;
    let cancelled = false;
    fetch(`/api/auth/linked-login?address=${address}`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        setLinked(j.linked?.label ? { label: j.linked.label } : null);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [address, wallet.authMethods.google, justLinked]);

  if (!wallet.authMethods.google || !passkeyAccount) return null;

  async function link() {
    setError(null);
    setBusy("link");
    try {
      await wallet.linkGoogleAccount();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not link Google.");
      setBusy(null);
    }
  }

  async function unlink() {
    setError(null);
    setBusy("unlink");
    try {
      await wallet.unlinkGoogleAccount();
      setLinked(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not unlink Google.");
    } finally {
      setBusy(null);
    }
  }

  const notice = linkError === "google-taken"
    ? "That Google account already opens a different PayAI wallet. This wallet was not changed."
    : linkError === "wallet-taken"
      ? "This wallet is already linked to another Google account. Unlink that one first. Nothing was changed."
      : null;

  return (
    <Card title="Google sign-in" className="mb-4">
      <div className="flex items-start gap-3">
        <SignInMark method="google" />
        <div className="min-w-0 flex-1">
          <p className="text-sm text-foreground">
            {linked ? `Linked to ${linked.label}` : "Optional. Your passkey is still how this wallet opens."}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {linked
              ? "You can sign in with this Google account and land on this same wallet. Linking did not create another one, and the passkey still works on its own."
              : "Link Gmail if you want a second way in. It attaches to this passkey wallet. It does not replace it, and you never have to use Google."}
          </p>
        </div>
      </div>

      {justLinked && linked && (
        <p className="mt-3 text-xs text-primary-ink">Google is linked. Signing in with it opens this wallet.</p>
      )}
      {notice && <p className="mt-3 text-xs text-danger">{notice}</p>}
      {error && <p className="mt-3 text-xs text-danger">{error}</p>}

      <div className="mt-4 flex flex-wrap gap-2">
        {linked ? (
          <button
            type="button"
            onClick={() => { void unlink(); }}
            disabled={!!busy}
            className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-xs font-medium text-foreground transition hover:border-primary/40 disabled:opacity-40"
          >
            {busy === "unlink" ? <Loader2 size={14} className="animate-spin" /> : "Unlink Google"}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => { void link(); }}
            disabled={!!busy}
            className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-xs font-medium text-foreground shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08)] transition hover:border-primary/40 disabled:opacity-40"
          >
            {busy === "link" ? <Loader2 size={14} className="animate-spin" /> : "Link Google"}
          </button>
        )}
      </div>
    </Card>
  );
}
