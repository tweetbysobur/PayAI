/**
 * Who can use Rooms while they're being tested on mainnet.
 *
 * PAYAI_ROOM_ESCROW_CREATORS lists the testers' wallets (comma separated).
 * While it's set, ALL of Rooms (direct splits, escrow rooms, the public room
 * pages and the Rooms API) exists only for those wallets; everyone else gets
 * "not found". Deleting it opens Rooms to everyone. Server-only (reads env).
 */
export function roomTesters(): string[] {
  return (process.env.PAYAI_ROOM_ESCROW_CREATORS ?? "").split(",").map((a) => a.trim().toLowerCase()).filter(Boolean);
}

export function roomsOpenToAll(): boolean {
  return roomTesters().length === 0;
}

export function roomsAllowed(wallet: string | null | undefined): boolean {
  if (roomsOpenToAll()) return true;
  return !!wallet && roomTesters().includes(wallet.toLowerCase());
}

export const ROOMS_HIDDEN = { ok: false, code: "NOT_FOUND", message: "Rooms aren't available yet." } as const;
