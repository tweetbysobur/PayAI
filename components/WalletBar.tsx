"use client";

import { Badge, Button } from "@/components/ui";

/**
 * Presentational wallet bar for the agent console. State and EIP-1193 logic
 * live in lib/wallet/useWallet — the parent owns one hook instance (it also
 * needs it to sign payments) and passes the bits this bar displays.
 */
export function WalletBar({
  address,
  isWrongNetwork,
  busy,
  error,
  onConnect,
  onDisconnect,
  onSwitchNetwork,
}: {
  address: string | null;
  isWrongNetwork: boolean;
  busy: boolean;
  error: string | null;
  onConnect: () => void;
  onDisconnect: () => void;
  onSwitchNetwork: () => void;
}) {
  if (!address) {
    return (
      <div className="flex items-center gap-2">
        <Button variant="secondary" onClick={onConnect} disabled={busy} className="text-xs">
          {busy ? "Connecting…" : "Connect wallet"}
        </Button>
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {isWrongNetwork ? (
        <Button variant="secondary" onClick={onSwitchNetwork} disabled={busy} className="text-xs text-warning">
          {busy ? "Switching…" : "Wrong network — switch to Monad Testnet"}
        </Button>
      ) : (
        <Badge tone="success">Monad Testnet</Badge>
      )}
      <span className="font-mono text-xs text-muted-foreground">{address.slice(0, 6)}…{address.slice(-4)}</span>
      <Button variant="ghost" onClick={onDisconnect} className="text-xs hover:text-danger">Disconnect</Button>
      {error && <span className="text-xs text-danger">{error}</span>}
    </div>
  );
}
