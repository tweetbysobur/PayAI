"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion, AnimatePresence } from "motion/react";
import { Menu, X } from "lucide-react";
import { NAV } from "@/components/dashboard/Sidebar";
import { Logo } from "@/components/Logo";

/** Hamburger trigger — rendered inside Topbar, visible only below the lg breakpoint where Sidebar is hidden. */
export function MobileNavTrigger({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label="Open navigation menu"
      className="rounded-md border border-border bg-panel p-2 text-foreground lg:hidden"
    >
      <Menu size={16} />
    </button>
  );
}

/** Slide-in drawer with the same nav links as Sidebar — the mobile fallback that was previously missing entirely. */
export function MobileNavDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pathname = usePathname();

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          className="fixed inset-0 z-50 bg-black/60 lg:hidden"
          onClick={onClose}
        >
          <motion.aside
            initial={{ x: -280 }} animate={{ x: 0 }} exit={{ x: -280 }} transition={{ duration: 0.25, ease: "easeOut" }}
            className="flex h-full w-64 flex-col bg-panel"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-border px-5 py-5">
              <div className="flex items-center gap-2">
                <Logo size={28} />
                <p className="text-sm font-semibold text-foreground">PayAI</p>
              </div>
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
                      active ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-input hover:text-foreground"
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
            </nav>
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
