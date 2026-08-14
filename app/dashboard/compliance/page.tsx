import { redirect } from "next/navigation";

/** Compliance is now a tab on the Transactions page, not its own page — see
 *  components/dashboard/ComplianceTabContent.tsx and
 *  app/dashboard/transactions/page.tsx. This keeps old links/bookmarks to
 *  /dashboard/compliance landing somewhere real instead of a 404. */
export default function ComplianceRedirect() {
  redirect("/dashboard/transactions?tab=compliance");
}
