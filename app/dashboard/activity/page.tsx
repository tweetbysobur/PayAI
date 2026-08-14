import { redirect } from "next/navigation";

/** Activity is now a tab on the Transactions page, not its own page — see
 *  components/dashboard/ActivityTabContent.tsx and
 *  app/dashboard/transactions/page.tsx. This keeps old links/bookmarks to
 *  /dashboard/activity landing somewhere real instead of a 404. */
export default function ActivityRedirect() {
  redirect("/dashboard/transactions?tab=activity");
}
