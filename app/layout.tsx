import type { Metadata } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";
import "./globals.css";
import { WalletProvider } from "@/lib/wallet/useWallet";
import { ToastProvider } from "@/components/Toast";
import GoogleAnalytics from "@/components/GoogleAnalytics";

// Premium sans — self-hosted at build. Geometric, modern, sleek; a deliberate
// step up from system-ui / generic Inter for a fintech-grade feel.
const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-jakarta",
  display: "swap",
  weight: ["400", "500", "600", "700", "800"],
});

const SITE_URL = process.env.VERIPAYAI_PUBLIC_URL || "https://veripayai.vercel.app";
const DESCRIPTION =
  "Send, swap, and automate payments on Monad. You approve every payment from your own wallet, and automations require wallet confirmation.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "PayAI · Payments on Monad",
  description: DESCRIPTION,
  applicationName: "PayAI",
  keywords: ["PayAI", "Monad", "payments", "AI", "non-custodial", "web3", "USDC", "MON", "natural language payments"],
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: "PayAI",
    title: "PayAI · Payments on Monad",
    description: DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: "PayAI · Payments on Monad",
    description: DESCRIPTION,
    creator: "@usepayAI",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={jakarta.variable}>
      <body className="antialiased">
        <WalletProvider>
          <ToastProvider>{children}</ToastProvider>
        </WalletProvider>
        <GoogleAnalytics />
      </body>
    </html>
  );
}
