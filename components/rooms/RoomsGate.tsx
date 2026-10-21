"use client";

import { EmptyState } from "@/components/dashboard/primitives";
import { useWalletService } from "@/lib/wallet-service/WalletServiceContext";
import { useRoomsAccess } from "@/lib/rooms/client";

/** Shows Rooms only to wallets lib/rooms/access.ts allows (testers while Rooms
 *  is being tested; everyone once the tester list is removed). */
export function RoomsGate({ children }: { children: React.ReactNode }) {
  const allowed = useRoomsAccess(useWalletService().address);
  if (allowed === null) return <p className="mx-auto max-w-3xl text-sm text-muted-foreground">Loading…</p>;
  if (!allowed) return <div className="mx-auto max-w-3xl"><EmptyState title="Rooms aren't available yet" hint="Rooms is being tested and will open soon." /></div>;
  return <>{children}</>;
}
