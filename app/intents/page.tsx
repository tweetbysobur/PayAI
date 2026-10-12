import { permanentRedirect } from "next/navigation";

/** "How to ask" now lives on /how-it-works, beside the steps it explains. */
export default function IntentsPage() {
  permanentRedirect("/how-it-works#how-to-ask");
}
