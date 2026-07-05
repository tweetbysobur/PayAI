import Link from "next/link";
import { Home, Compass } from "lucide-react";
import { Logo } from "@/components/Logo";

/** Branded 404 — a clean off-ramp instead of a bare Next.js not-found page. */
export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background px-6 text-center">
      <Logo size={40} className="mb-6" />
      <p className="text-4xl font-semibold tracking-tight text-foreground">404</p>
      <h1 className="mt-2 text-lg font-medium text-foreground">This page doesn&apos;t exist</h1>
      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
        The link may be broken or the page may have moved.
      </p>
      <div className="mt-6 flex items-center gap-3">
        <Link href="/" className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition hover:opacity-90">
          <Home size={15} /> Home
        </Link>
        <Link href="/dashboard" className="flex items-center gap-2 rounded-lg border border-border px-4 py-2.5 text-sm text-foreground transition hover:bg-input">
          <Compass size={15} /> Dashboard
        </Link>
      </div>
    </div>
  );
}
