import { redirect } from "next/navigation";

/**
 * Support moved inside Help Center (see app/dashboard/help/page.tsx's
 * Support tab) — it's no longer a separate top-level destination. This page
 * stays only so every existing deep link into it (Report Failed Automation
 * on the automations page, notification/activity entries, the settings
 * card, the security page, the marketing footer) keeps landing somewhere
 * real: a server-side redirect into the merged page's Support tab,
 * preserving whatever query params (automationId, category) it was given.
 */
export default async function SupportPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") qs.set(key, value);
  }
  qs.set("tab", "support");
  redirect(`/dashboard/help?${qs.toString()}`);
}
