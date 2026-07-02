import Link from "next/link";
import { Logo } from "@/components/Logo";

export default function Terms() {
  return (
    <main className="min-h-screen bg-background">
      <header className="mx-auto flex max-w-3xl items-center justify-between px-6 py-5">
        <Link href="/" className="flex items-center gap-2"><Logo size={28} /><span className="text-sm font-semibold text-foreground">PayAI</span></Link>
        <Link href="/" className="text-sm text-muted-foreground hover:text-foreground">Back to home</Link>
      </header>
      <div className="mx-auto max-w-3xl px-6 py-12 text-sm leading-relaxed text-muted-foreground">
        <h1 className="mb-6 text-2xl font-semibold text-foreground">Terms</h1>
        <div className="space-y-4">
          <p>PayAI is provided as-is, without warranty of any kind. You are solely responsible for the wallet you connect and every transaction it signs. PayAI cannot reverse, cancel, or recover a transaction once it is broadcast to Monad.</p>
          <p>Smart contract execution (PaymentExecutor, MerchantRegistry) is final and governed by the code deployed on-chain, not by this interface. Always verify the recipient address and amount in your wallet before approving a transaction.</p>
          <p>PayAI does not custody funds, provide investment advice, or guarantee uptime of third-party RPC providers, wallets, or the Monad network itself.</p>
          <p>By using PayAI you confirm you are responsible for complying with the laws applicable to you when sending or receiving on-chain payments.</p>
        </div>
      </div>
    </main>
  );
}
