import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PayAI — AI payment agent on Monad",
  description:
    "An autonomous AI payment agent that initiates, approves, and settles payments on Monad — powered by Cleanverse, plugged into the VeriGate trust layer.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
