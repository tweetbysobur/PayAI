import { redirect } from "next/navigation";

export default function ScheduledRedirect() {
  redirect("/dashboard/automations");
}
