"use client";

import { useState } from "react";
import { KeyRound, ShieldAlert, Eye, EyeOff, Copy, Check, Loader2, Fingerprint } from "lucide-react";
import { Card } from "@/components/ui";
import { useWalletService } from "@/lib/wallet-service/WalletServiceContext";
import { useToast } from "@/components/Toast";

/**
 * Export the embedded wallet's private key.
 *
 * This exists because a passkey-derived wallet has no seed phrase to fall
 * back on: lose the passkey and, without an export, the funds are gone
 * permanently — PayAI holds nothing that could restore them. It is also what
 * keeps the wallet genuinely the user's, since the key imports straight into
 * MetaMask or Rabby.
 *
 * Handled carefully, because a revealed key is bearer access to the funds:
 *   - two deliberate steps (warn, then confirm) so it can't be tapped by
 *     accident;
 *   - a fresh passkey check every time, even when the wallet is unlocked;
 *   - hidden until explicitly revealed, so it isn't left on screen or caught
 *     by a screen-share;
 *   - held in component state only — never persisted, logged, or sent
 *     anywhere — and dropped as soon as the panel closes.
 */
export function ExportWalletCard() {
  const wallet = useWalletService();
  const { toast } = useToast();
  const [stage, setStage] = useState<"idle" | "warned" | "revealed">("idle");
  const [busy, setBusy] = useState(false);
  const [privateKey, setPrivateKey] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only meaningful for the embedded wallet. An external wallet's key belongs
  // to MetaMask/Rabby and PayAI has no business offering to export it.
  if (wallet.kind !== "embedded" && !wallet.isLocked) return null;

  // Locked (a reload cleared the in-memory key) — say so plainly and offer to
  // unlock here. Hiding the card would look like the wallet had vanished,
  // which is exactly the wrong impression: it's one passkey check away.
  if (wallet.isLocked) {
    return (
      <Card title="Export wallet" className="mt-4">
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-input text-muted-foreground"><KeyRound size={18} /></div>
          <div>
            <p className="text-sm text-foreground">Your wallet is locked</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Unlock with your passkey to export your private key. Your wallet and its funds are safe —
              PayAI keeps the key in memory only, so it clears whenever you reload.
            </p>
          </div>
        </div>
        <button
          onClick={() => { setBusy(true); wallet.setUpEmbeddedWallet({ create: false }).catch(() => {}).finally(() => setBusy(false)); }}
          disabled={busy}
          className="mt-3 flex items-center gap-1.5 rounded-lg border border-border px-3.5 py-2 text-xs font-medium text-foreground transition hover:border-primary/40 hover:bg-input/40 disabled:opacity-60"
        >
          {busy ? <Loader2 size={13} className="animate-spin" /> : <Fingerprint size={13} />}
          {busy ? "Waiting for your device…" : "Unlock wallet"}
        </button>
      </Card>
    );
  }

  function reset() {
    setPrivateKey(null);
    setVisible(false);
    setCopied(false);
    setError(null);
    setStage("idle");
  }

  async function reveal() {
    setBusy(true);
    setError(null);
    try {
      setPrivateKey(await wallet.exportEmbeddedKey());
      setStage("revealed");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not export your key.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Export wallet" className="mt-4">
      {stage === "idle" && (
        <>
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary-ink"><KeyRound size={18} /></div>
            <div>
              <p className="text-sm text-foreground">Export your private key</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Your PayAI Wallet is secured by your passkey, not a seed phrase. Exporting the key lets you
                restore this wallet in MetaMask or Rabby — and is the only way to reach your funds if you ever
                lose the passkey.
              </p>
            </div>
          </div>
          <button
            onClick={() => setStage("warned")}
            className="mt-3 rounded-lg border border-border px-3.5 py-2 text-xs font-medium text-foreground transition hover:border-primary/40 hover:bg-input/40"
          >
            Export private key
          </button>
        </>
      )}

      {stage === "warned" && (
        <>
          <div className="flex items-start gap-3 rounded-lg border border-danger/30 bg-danger/10 p-3.5">
            <ShieldAlert size={16} className="mt-0.5 shrink-0 text-danger" />
            <div className="text-xs text-foreground">
              <p className="font-medium text-danger">Anyone with this key controls your wallet.</p>
              <ul className="mt-1.5 list-disc space-y-1 pl-4 text-muted-foreground">
                <li>Never share it, photograph it, or paste it into any website — including one claiming to be PayAI.</li>
                <li>PayAI will never ask you for it. Support will never ask you for it.</li>
                <li>Store it somewhere only you can reach, like a password manager.</li>
              </ul>
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <button onClick={reset} className="flex-1 rounded-lg border border-border px-3 py-2.5 text-xs font-medium text-muted-foreground transition hover:text-foreground">
              Cancel
            </button>
            <button
              onClick={reveal} disabled={busy}
              className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-primary px-3 py-2.5 text-xs font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-60"
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Fingerprint size={13} />}
              {busy ? "Waiting for your device…" : "I understand — reveal"}
            </button>
          </div>
          {error && <p className="mt-2 text-center text-xs text-danger">{error}</p>}
        </>
      )}

      {stage === "revealed" && privateKey && (
        <>
          <p className="text-xs text-muted-foreground">
            Import this into MetaMask or Rabby with &ldquo;Import account → Private key&rdquo;. It gives the same
            address as your PayAI Wallet.
          </p>
          <div className="mt-2.5 flex items-center gap-2 rounded-lg border border-border bg-input/40 px-3 py-2.5">
            <code className={`flex-1 break-all font-mono text-xs ${visible ? "text-foreground" : "select-none blur-sm"}`}>
              {visible ? privateKey : "0x" + "•".repeat(64)}
            </code>
            <button
              onClick={() => setVisible((v) => !v)}
              aria-label={visible ? "Hide private key" : "Show private key"}
              className="shrink-0 rounded-md p-1.5 text-muted-foreground transition hover:bg-input hover:text-foreground"
            >
              {visible ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
          <div className="mt-2.5 flex gap-2">
            <button
              onClick={() => {
                navigator.clipboard?.writeText(privateKey).then(() => {
                  setCopied(true);
                  toast("Private key copied — paste it somewhere safe, then clear your clipboard");
                  setTimeout(() => setCopied(false), 2000);
                }).catch(() => setError("Couldn't copy. Reveal it and copy manually."));
              }}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2.5 text-xs font-medium text-foreground transition hover:border-primary/40"
            >
              {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
              {copied ? "Copied" : "Copy key"}
            </button>
            <button onClick={reset} className="flex-1 rounded-lg bg-primary px-3 py-2.5 text-xs font-medium text-primary-foreground transition hover:opacity-90">
              Done — hide it
            </button>
          </div>
          {error && <p className="mt-2 text-center text-xs text-danger">{error}</p>}
        </>
      )}
    </Card>
  );
}
