"use client";

import { useEffect, useState } from "react";
import { Sidebar } from "@/components/dashboard/Sidebar";
import { Topbar } from "@/components/dashboard/Topbar";
import { CommandBar } from "@/components/dashboard/CommandBar";
import { MobileNavDrawer } from "@/components/dashboard/MobileNav";
import { useNotifications } from "@/lib/hooks/useNotifications";

interface Health {
  verigate: { connected: boolean; mode: string };
  wallet: { network: string; chainId: number } | null;
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const { notifications, markSeen } = useNotifications();

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
    </div>
  );
}
