import { permanentRedirect } from "next/navigation";

/** Rooms were removed from PayAI. Old links land on the home page. */
export default function RoomsRemoved() {
  permanentRedirect("/");
}
