"use client";

import { useEffect, useState } from "react";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { Topbar } from "@/components/dashboard/Topbar";
import { CommandBar } from "@/components/dashboard/CommandBar";
import { MobileNavDrawer } from "@/components/dashboard/MobileNav";
import { OnboardingFlow } from "@/components/onboarding/OnboardingFlow";
import { DepositAlert } from "@/components/dashboard/DepositAlert";
import { useNotifications } from "@/lib/hooks/useNotifications";
import { useWalletService as useWallet } from "@/lib/wallet-service/WalletServiceContext";

interface Health {
  payment: { connected: boolean; engine: string };
  wallet: { network: string; chainId: number } | null;
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
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
    <div className="flex min-h-screen bg-background">
      <Sidebar />
      <MobileNavDrawer open={mobileNavOpen} onClose={() => setMobileNavOpen(false)} />
      <div className="flex flex-1 flex-col">
        <Topbar health={health} notifications={notifications} onOpenNotifications={markSeen} onMenuClick={() => setMobileNavOpen(true)} />
        <main className="flex-1 overflow-y-auto p-4 sm:p-6">{children}</main>
      </div>
      <CommandBar />
      <OnboardingFlow />
      {/* Money arriving is the one event worth interrupting for — it gets its
          own alert rather than a quiet row under the bell. */}
      <DepositAlert notifications={notifications} address={wallet.readAddress} />
    </div>
  );
}
