import type { StatusTone } from "@/components/dashboard/primitives";
import type { RoomStatus } from "@/lib/rooms/terms";

export const ROOM_STATUS: Readonly<Record<RoomStatus, { tone: StatusTone; label: string }>> = {
  open: { tone: "pending", label: "Open" },
  completed: { tone: "success", label: "Completed" },
  expired: { tone: "neutral", label: "Expired" },
  cancelled: { tone: "neutral", label: "Cancelled" },
};

export const shortAddr = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

export function fmtWhen(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
