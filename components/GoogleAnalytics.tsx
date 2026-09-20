"use client";

import Script from "next/script";
import { usePathname } from "next/navigation";

const GA_MEASUREMENT_ID = process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID;

/**
 * Loads GA4 only when NEXT_PUBLIC_GA_MEASUREMENT_ID is set (unset in local
 * dev), and never on dashboard routes. The privacy page promises the
 * dashboard is not tagged with an analytics pixel; keeping this script in
 * the root layout without a path check made that claim false.
 */
export default function GoogleAnalytics() {
  const pathname = usePathname();
  if (!GA_MEASUREMENT_ID) return null;
  if (pathname?.startsWith("/dashboard")) return null;

  return (
    <>
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`}
        strategy="afterInteractive"
      />
      <Script id="ga4-init" strategy="afterInteractive">
        {`
          window.dataLayer = window.dataLayer || [];
          function gtag(){dataLayer.push(arguments);}
          gtag('js', new Date());
          gtag('config', '${GA_MEASUREMENT_ID}');
        `}
      </Script>
    </>
  );
}
