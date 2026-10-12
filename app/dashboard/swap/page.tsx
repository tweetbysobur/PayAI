import { redirect } from "next/navigation";

/** Trading happens in Ask PayAI — quote, review, your wallet signs. The old
 *  Swap tab was removed from Payments & Automations; this keeps its address
 *  (bookmarks, notification links) working. */
export default function SwapPage() {
  redirect("/dashboard/ask");
}
