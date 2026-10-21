import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { EscrowRoom } from "@/components/rooms/escrow/EscrowRoom";

/**
 * /r/{id} — a Room's canonical, shareable payment page. Opens the room
 * directly: no dashboard, no Ask PayAI. Escrow rooms (er_…) render here; a
 * legacy direct room (room_…) keeps its existing page.
 */
export const metadata: Metadata = { title: "Room · PayAI", robots: { index: false } };

export default async function SharedRoomPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (/^room_[0-9a-f]{24}$/.test(id)) redirect(`/dashboard/rooms/${id}`);
  return <EscrowRoom id={id} />;
}
