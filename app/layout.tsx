import type { Metadata } from "next";
import "./globals.css";
import { WalletProvider } from "@/lib/wallet/useWallet";
import { ToastProvider } from "@/components/Toast";
import GoogleAnalytics from "@/components/GoogleAnalytics";

const SITE_URL = process.env.VERIPAYAI_PUBLIC_URL || "https://veripayai.vercel.app";
const DESCRIPTION =
  "Send, swap, and schedule payments just by describing them. You approve every payment from your own wallet, and it arrives in seconds.";

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
    creator: "@tweetbysobur",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased">
        <WalletProvider>
          <ToastProvider>{children}</ToastProvider>
        </WalletProvider>
        <GoogleAnalytics />
      </body>
    </html>
  );
}
