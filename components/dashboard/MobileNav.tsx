"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "motion/react";
import { Menu, X } from "lucide-react";
import { NAV, LEARN_LINKS } from "@/components/dashboard/Sidebar";
import { reopenOnboarding } from "@/lib/hooks/useOnboarding";
import { GraduationCap } from "lucide-react";
import { Logo } from "@/components/Logo";
import { useModalA11y } from "@/lib/hooks/useModalA11y";

/** Hamburger trigger — rendered inside Topbar, visible only below the lg breakpoint where Sidebar is hidden. */
export function MobileNavTrigger({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label="Open navigation menu"
      className="rounded-md border border-border bg-panel p-2 text-foreground lg:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Menu size={16} />
    </button>
  );
}

/** Slide-in drawer with the same nav links as Sidebar — the mobile fallback that was previously missing entirely. */
export function MobileNavDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pathname = usePathname();
  useModalA11y(open, onClose);

  // No AnimatePresence — see the note in components/dashboard/TemplatePicker.tsx.
  // Especially important here: a stuck full-screen overlay would swallow every
  // tap on mobile, where this drawer is the only navigation.
  return (
    <>
      {open && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
          className="fixed inset-0 z-50 bg-black/60 lg:hidden"
          onClick={onClose}
        >
          <motion.aside
            role="dialog" aria-modal="true" aria-label="Navigation menu"
            initial={{ x: -280 }} animate={{ x: 0 }} transition={{ duration: 0.25, ease: "easeOut" }}
            className="flex h-full w-64 flex-col bg-panel"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border px-5 py-5">
              <Link href="/" onClick={onClose} className="flex items-center gap-2" title="Back to home">
                <Logo size={28} />
                <p className="text-sm font-semibold text-foreground">PayAI</p>
              </Link>
              <button onClick={onClose} aria-label="Close navigation menu" className="text-muted-foreground hover:text-foreground">
                <X size={18} />
              </button>
            </div>
            <nav className="flex-1 overflow-y-auto px-3 py-4">
              {NAV.map((item) => {
                const active = pathname === item.href;
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-disabled={item.soon}
                    onClick={onClose}
                    className={`mb-0.5 flex items-center justify-between rounded-md px-3 py-2.5 text-sm transition ${
                      active ? "bg-primary/15 text-primary-ink" : "text-muted-foreground hover:bg-input hover:text-foreground"
                    } ${item.soon ? "pointer-events-none opacity-50" : ""}`}
                  >
                    <span className="flex items-center gap-2.5">
                      <Icon size={16} />
                      {item.label}
                    </span>
                    {item.soon && <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">Soon</span>}
                  </Link>
                );
              })}

              <p className="mb-1 mt-4 flex items-center gap-1.5 px-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/60">
                <GraduationCap size={12} /> Learn PayAI
              </p>
              {LEARN_LINKS.map((item) => {
                const Icon = item.icon;
                const content = <span className="flex items-center gap-2.5"><Icon size={15} /> {item.label}</span>;
                const cls = "flex items-center rounded-md px-3 py-2 text-[13px] text-muted-foreground transition hover:bg-input hover:text-foreground";
                if (item.action === "onboarding") {
                  return <button key={item.label} onClick={() => { onClose(); reopenOnboarding(); }} className={`w-full text-left ${cls}`}>{content}</button>;
                }
                return item.external
                  ? <a key={item.label} href={item.href} target="_blank" rel="noreferrer" onClick={onClose} className={cls}>{content}</a>
                  : <Link key={item.label} href={item.href} onClick={onClose} className={cls}>{content}</Link>;
              })}
            </nav>
          </motion.aside>
        </motion.div>
      )}
    </>
  );
}
