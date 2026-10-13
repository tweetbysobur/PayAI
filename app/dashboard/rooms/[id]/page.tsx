import { redirect } from "next/navigation";

/** Rooms were removed from PayAI. Old links land on the dashboard. */
export default function RoomsRemoved() {
  redirect("/dashboard");
}
