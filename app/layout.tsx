import type { Metadata } from "next";
import "./globals.css";
import { WalletProvider } from "@/lib/wallet/useWallet";

export const metadata: Metadata = {
  title: "PayAI — AI payment agent on Monad",
  description:
    "An autonomous AI payment agent that initiates, validates, and settles payments on Monad — non-custodial, compliance-screened, and fully on-chain.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased">
        <WalletProvider>{children}</WalletProvider>
      </body>
    </html>
  );
}
