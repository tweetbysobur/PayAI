import { PublicShell } from "@/components/rooms/PublicShell";

export default function PublicRoomLayout({ children }: { children: React.ReactNode }) {
  return <PublicShell>{children}</PublicShell>;
}
