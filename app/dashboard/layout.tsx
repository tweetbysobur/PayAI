"use client";

import { useEffect, useState } from "react";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { Topbar } from "@/components/dashboard/Topbar";
import { CommandBar } from "@/components/dashboard/CommandBar";
import { MobileNavDrawer } from "@/components/dashboard/MobileNav";
import { OnboardingFlow } from "@/components/onboarding/OnboardingFlow";
import { TourOverlay } from "@/components/onboarding/TourOverlay";
import { DepositAlert } from "@/components/dashboard/DepositAlert";
import { useNotifications } from "@/lib/hooks/useNotifications";
import { SyncProvider } from "@/lib/hooks/useSync";
import { AskPageChatProvider } from "@/lib/ask/AskPageChatContext";
import { useWalletService as useWallet } from "@/lib/wallet-service/WalletServiceContext";

interface Health {
  payment: { connected: boolean; engine: string };
  wallet: { network: string; chainId: number } | null;
}

/** Wraps the dashboard so every surface below shares one refresh — see
 *  lib/hooks/useSync.tsx. */
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <SyncProvider>
      <AskPageChatProvider>
        <DashboardChrome>{children}</DashboardChrome>
      </AskPageChatProvider>
    </SyncProvider>
  );
}

function DashboardChrome({ children }: { children: React.ReactNode }) {
  const wallet = useWallet();
  const [health, setHealth] = useState<Health | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // readAddress, not address: a locked wallet still has history and can still
  // receive money — the feed shouldn't go blind just because the key is gone.
  const { notifications, markSeen } = useNotifications(wallet.readAddress, wallet.providerId);

  useEffect(() => {
    fetch("/api/health").then((r) => r.json()).then(setHealth).catch(() => {});
  }, []);

  return (
    // h-dvh + overflow-hidden, not min-h-screen: this is what actually
    // bounds the flex-1/min-h-0/overflow-y-auto chain below (Sidebar,
    // main, and Ask PayAI's own chat box all depend on an ancestor with a
    // REAL fixed height to clip against). min-h-screen has no upper bound,
    // so once page content grew tall enough (a long chat, more txns), the
    // whole document exceeded the viewport and the BROWSER scrolled the
    // entire page -- carrying the sidebar off-screen with it -- instead of
    // each region's own internal scroll area doing its job.
    <div className="flex h-dvh overflow-hidden bg-background">
      <Sidebar />
      <MobileNavDrawer open={mobileNavOpen} onClose={() => setMobileNavOpen(false)} />
      {/* min-w-0: a flex child's default min-width is `auto` (its content's
          natural width), not 0 — so on a phone, anything inside Topbar that
          didn't fit on one line (see Topbar's own fix) could still force
          THIS column wider than the viewport, dragging everything below it
          — the balance cards, every dashboard page's content — off-screen
          along with it, since they're stacked in the same column. This is
          the standard fix for that flexbox default, independent of
          whatever any child's own content happens to need. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar health={health} notifications={notifications} onOpenNotifications={markSeen} onMenuClick={() => setMobileNavOpen(true)} />
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">{children}</main>
      </div>
      <CommandBar />
      <OnboardingFlow />
      <TourOverlay />
      {/* Money arriving is the one event worth interrupting for — it gets its
          own alert rather than a quiet row under the bell. */}
      <DepositAlert notifications={notifications} address={wallet.readAddress} />
    </div>
  );
}
