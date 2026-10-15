import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { WalletProvider } from "@/lib/wallet/useWallet";
import { MotionPreference } from "@/components/MotionPreference";
import { WalletServiceProvider } from "@/lib/wallet-service/WalletServiceContext";
import { ToastProvider } from "@/components/Toast";
import GoogleAnalytics from "@/components/GoogleAnalytics";
import { THEME_SCRIPT } from "@/lib/theme";

// Premium sans — self-hosted from app/fonts, so the build never depends on
// reaching Google Fonts. Geometric, modern, sleek; a deliberate step up from
// system-ui / generic Inter for a fintech-grade feel. Variable font: every
// weight from one file.
const jakarta = localFont({
  src: "./fonts/PlusJakartaSans-Variable.woff2",
  variable: "--font-jakarta",
  display: "swap",
  weight: "200 800",
});

// Reserved for specific headings that call for it (see `font-montserrat` in
// globals.css) — not the site's default type. Self-hosted the same way.
const montserrat = localFont({
  src: "./fonts/Montserrat-Variable.woff2",
  variable: "--font-montserrat",
  display: "swap",
  weight: "100 900",
});

const SITE_URL = process.env.VERIPAYAI_PUBLIC_URL || "https://usepayai.xyz";
const DESCRIPTION =
  "Send, automate, trade, and swap DeFi tokens on Monad — all in natural language with Ask PayAI. You approve everything from your own wallet, and automations require wallet confirmation.";

// viewportFit: "cover" is what makes iPhone report real env(safe-area-inset-*)
// values (notch, Dynamic Island, home-indicator strip) instead of zero — used
// below to keep fixed bottom UI (the chat composer, the floating command-bar
// button) clear of that strip on both iPhone and gesture-nav Android.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "PayAI · Payments, Trading & DeFi on Monad",
  description: DESCRIPTION,
  applicationName: "PayAI",
  keywords: ["PayAI", "Monad", "payments", "trading", "DeFi", "AI", "non-custodial", "web3", "USDC", "MON", "natural language payments"],
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: "PayAI",
    title: "PayAI · Payments, Trading & DeFi on Monad",
    description: DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: "PayAI · Payments, Trading & DeFi on Monad",
    description: DESCRIPTION,
    creator: "@usepayAI",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    // suppressHydrationWarning: THEME_SCRIPT sets data-theme on <html> before
    // React hydrates, which React would otherwise report as a mismatch.
    <html lang="en" className={`${jakarta.variable} ${montserrat.variable}`} data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="antialiased">
        {/* Wraps everything: the CSS reduced-motion rule cannot reach Framer,
            which is where most of this product's movement lives. */}
        <MotionPreference>
          <WalletProvider>
            <WalletServiceProvider>
              <ToastProvider>{children}</ToastProvider>
            </WalletServiceProvider>
          </WalletProvider>
        </MotionPreference>
        <GoogleAnalytics />
      </body>
    </html>
  );
}
