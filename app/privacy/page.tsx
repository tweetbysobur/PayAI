import Link from "next/link";
import { Logo } from "@/components/Logo";

export default function Privacy() {
  return (
    <main className="min-h-screen bg-background">
      <header className="mx-auto flex max-w-3xl items-center justify-between px-6 py-5">
        <Link href="/" className="flex items-center gap-2"><Logo size={28} /><span className="text-sm font-semibold text-foreground">PayAI</span></Link>
        <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">Back to home</Link>
      </header>
      <div className="mx-auto max-w-3xl px-6 py-12 text-sm leading-relaxed text-muted-foreground">
        <h1 className="mb-6 text-2xl font-semibold text-foreground">Privacy</h1>
        <div className="space-y-4">
          <p>PayAI is a non-custodial interface to smart contracts on Monad. We never hold your funds and never have access to your private keys or seed phrase. Every payment is signed by your own wallet.</p>
          <p>Wallet addresses, transaction amounts, and payment status are public on-chain data, visible to anyone via the Monad block explorer, independent of this app.</p>
          <p>If you create a merchant workspace, we store the workspace name and an API key locally in your browser and on our server to associate your payment links and on-chain registrations with your account. We do not sell or share this data with third parties.</p>
          <p>The dashboard reads balances and transaction history directly from Monad RPC nodes and the PaymentExecutor contract. No separate tracking or analytics pixels are used on dashboard pages.</p>
        </div>
      </div>
    </main>
  );
}
