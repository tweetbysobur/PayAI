import Link from "next/link";
import { Logo } from "@/components/Logo";

/** Public chrome for shared Room links and Live Rooms: the brand, Live Rooms,
 *  and nothing that requires an account. Wallet providers come from the root layout. */
export function PublicShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-background">
      <header className="mx-auto flex w-full max-w-2xl items-center justify-between px-4 py-4 sm:px-6">
        <Link href="/" className="flex items-center gap-2" aria-label="PayAI home">
          <Logo size={26} />
          <span className="text-sm font-semibold text-foreground">PayAI</span>
          <span className="text-sm text-muted-foreground">Rooms</span>
        </Link>
        <nav className="flex items-center gap-4 text-sm">
          <Link href="/rooms" className="text-muted-foreground hover:text-foreground">Live Rooms</Link>
          <Link href="/dashboard/rooms" className="text-muted-foreground hover:text-foreground">My rooms</Link>
        </nav>
      </header>
      <main className="mx-auto w-full max-w-2xl px-4 pb-16 pt-2 sm:px-6">{children}</main>
    </div>
  );
}
