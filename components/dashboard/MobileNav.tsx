"use client";

import { useLandingHref } from "@/lib/hooks/useLandingHref";
import Link from "next/link";
import { motion } from "motion/react";
import { Menu, X } from "lucide-react";
import { NavList, NavFooter } from "@/components/dashboard/Sidebar";
import { Logo } from "@/components/Logo";
import { useModalA11y } from "@/lib/hooks/useModalA11y";

/** Hamburger trigger — rendered inside Topbar, visible only below the lg breakpoint where Sidebar is hidden. */
export function MobileNavTrigger({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Open navigation menu"
      className="flex h-9 w-9 items-center justify-center rounded-md border border-border text-foreground lg:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Menu size={16} />
    </button>
  );
}

/** Slide-in drawer with exactly the sidebar's navigation (the same NavList and
 *  NavFooter components, so the two can never drift apart). */
export function MobileNavDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const landing = useLandingHref();
  useModalA11y(open, onClose);

  // No AnimatePresence — see the note in components/dashboard/TemplatePicker.tsx.
  // Especially important here: a stuck full-screen overlay would swallow every
  // tap on mobile, where this drawer is the only navigation.
  return (
    <>
      {open && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }}
          transition={{ duration: 0.15, ease: "easeOut" }}
          className="fixed inset-0 z-50 bg-contrast/60 lg:hidden"
          onClick={onClose}
        >
          <motion.aside
            role="dialog" aria-modal="true" aria-label="Navigation menu"
            initial={{ x: -24, opacity: 0 }} animate={{ x: 0, opacity: 1 }} transition={{ duration: 0.18, ease: "easeOut" }}
            className="flex h-full w-[min(18rem,85vw)] flex-col border-r border-border bg-tint"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex h-[61px] items-center justify-between border-b border-border px-5">
              <Link href={landing} onClick={onClose} className="flex items-center gap-2" title="PayAI home">
                <Logo size={26} />
                <p className="text-sm font-semibold text-foreground">PayAI</p>
              </Link>
              <button type="button" onClick={onClose} aria-label="Close navigation menu" className="flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <X size={18} />
              </button>
            </div>
            <nav aria-label="Primary" className="flex-1 overflow-y-auto px-3 py-4">
              <NavList onNavigate={onClose} />
            </nav>
            <div className="border-t border-border px-3 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
              <NavFooter onNavigate={onClose} withTour={false} />
            </div>
          </motion.aside>
        </motion.div>
      )}
    </>
  );
}
