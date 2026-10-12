"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Sidebar, PAYMENTS_AREA, SETTINGS_AREA } from "@/components/dashboard/Sidebar";
import { AreaTabs, isNavActive } from "@/components/dashboard/primitives";
import { Topbar } from "@/components/dashboard/Topbar";
import { CommandBar } from "@/components/dashboard/CommandBar";
import { MobileNavDrawer } from "@/components/dashboard/MobileNav";
import { OnboardingFlow } from "@/components/onboarding/OnboardingFlow";
import { TourOverlay } from "@/components/onboarding/TourOverlay";
import { DepositAlert } from "@/components/dashboard/DepositAlert";
import { AccountReturnBanner } from "@/components/dashboard/AccountReturnBanner";
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

/** The second-level tabs for the area the current page belongs to. Pages keep
 *  their own URLs; the tabs are what groups them under one primary entry. */
function AreaNav() {
  const pathname = usePathname();
  const inArea = (tabs: readonly { href: string }[]) => tabs.some((t) => isNavActive(pathname, t));
  if (inArea(PAYMENTS_AREA)) return <AreaTabs label="Payments & Automations" tabs={PAYMENTS_AREA} />;
  if (inArea(SETTINGS_AREA)) return <AreaTabs label="Settings" tabs={SETTINGS_AREA} />;
  return null;
}

function DashboardChrome({ children }: { children: React.ReactNode }) {
  const wallet = useWallet();
  const [health, setHealth] = useState<Health | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // Room under the last thing on the page for the floating Ask PayAI button,
  // so it never sits on a Confirm button or the end of a receipt — the page
  // can always scroll clear of it. Not on Ask PayAI, which hides the button
  // and keeps its own composer at the bottom.
  const onAskPage = usePathname() === "/dashboard/ask";
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
        <main className={`flex-1 overflow-y-auto p-4 sm:p-6 ${onAskPage ? "" : "pb-24 sm:pb-24"}`}>
          <AccountReturnBanner />
          <AreaNav />
          {children}
        </main>
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
