import { Mail } from "lucide-react";
import { BrandIcon } from "@/components/BrandIcons";

/** Flat plate that holds a sign-in mark. The Google G stays in its
 *  official colours; Apple, X and the mail mark take the page colour. */
export function SignInMark({ method, size = 18 }: { method: "google" | "apple" | "x" | "email"; size?: number }) {
  return (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-border bg-background">
      {method === "email" ? (
        <Mail size={size} className="text-primary-ink" strokeWidth={1.75} />
      ) : (
        <BrandIcon name={method} size={size} className={method === "google" ? "" : "text-foreground"} />
      )}
    </span>
  );
}

/** Shared row for Google, Apple, X and email. */
export const glassSignInRow =
  "group flex w-full items-center gap-3 rounded-xl border border-border bg-background px-3 py-2.5 text-left text-sm font-medium text-foreground transition-colors duration-200 enabled:hover:border-primary/40 enabled:hover:bg-input/40 disabled:cursor-not-allowed disabled:opacity-45";
