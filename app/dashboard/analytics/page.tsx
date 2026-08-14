import { redirect } from "next/navigation";

/** Analytics is now a tab on the Transactions page, not its own page — see
 *  components/dashboard/AnalyticsTabContent.tsx and
 *  app/dashboard/transactions/page.tsx. This keeps old links/bookmarks to
 *  /dashboard/analytics landing somewhere real instead of a 404. */
export default function AnalyticsRedirect() {
  redirect("/dashboard/transactions?tab=analytics");
}
