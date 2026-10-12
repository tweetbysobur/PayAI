"use client";

import Link from "next/link";
import type { ComponentProps } from "react";
import { useLandingHref } from "@/lib/hooks/useLandingHref";

/** A link to the PayAI landing page, correct on every host (see useLandingHref). */
export function LandingLink(props: Omit<ComponentProps<typeof Link>, "href">) {
  return <Link {...props} href={useLandingHref()} />;
}
