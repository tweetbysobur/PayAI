import type { Metadata } from "next";
import { PublicShell } from "@/components/rooms/PublicShell";

export const metadata: Metadata = { title: "Live Rooms · PayAI" };

export default function LiveRoomsLayout({ children }: { children: React.ReactNode }) {
  return <PublicShell>{children}</PublicShell>;
}
