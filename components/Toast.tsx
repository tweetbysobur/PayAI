"use client";

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { motion, AnimatePresence } from "motion/react";
import { CheckCircle2, XCircle, Info, X } from "lucide-react";

type ToastVariant = "success" | "error" | "info";
interface ToastItem {
  id: number;
  message: string;
  variant: ToastVariant;
}

interface ToastApi {
  toast: (message: string, variant?: ToastVariant) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const ICON: Record<ToastVariant, typeof CheckCircle2> = {
  success: CheckCircle2,
  error: XCircle,
  info: Info,
};
const ACCENT: Record<ToastVariant, string> = {
  success: "text-success",
  error: "text-danger",
  info: "text-primary-ink",
};

/**
 * Lightweight, premium toast layer — transient confirmation for actions that
 * otherwise have no feedback (wallet connect, copy, network switch, errors).
 * Bottom-center on mobile, bottom-right on desktop; auto-dismiss; accessible
 * (aria-live). One provider mounted at the root.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setItems((xs) => xs.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((message: string, variant: ToastVariant = "success") => {
    const id = nextId.current++;
    setItems((xs) => [...xs.slice(-2), { id, message, variant }]); // keep at most 3
    setTimeout(() => dismiss(id), 2600);
  }, [dismiss]);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4 sm:inset-x-auto sm:right-6 sm:items-end"
      >
        <AnimatePresence initial={false}>
          {items.map((t) => {
            const Icon = ICON[t.variant];
            return (
              <motion.div
                key={t.id}
                layout
                initial={{ opacity: 0, y: 12, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.96 }}
                transition={{ duration: 0.2, ease: "easeOut" }}
                className="pointer-events-auto flex w-full max-w-sm items-center gap-2.5 rounded-xl border border-border bg-panel/95 px-3.5 py-2.5 text-sm text-foreground shadow-2xl ring-1 ring-black/5 backdrop-blur"
              >
                <Icon size={16} className={`shrink-0 ${ACCENT[t.variant]}`} />
                <span className="flex-1 leading-snug">{t.message}</span>
                <button
                  onClick={() => dismiss(t.id)}
                  aria-label="Dismiss"
                  className="shrink-0 rounded-md p-0.5 text-muted-foreground transition hover:text-foreground"
                >
                  <X size={14} />
                </button>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

/** Access the toast function. Safe no-op if a provider isn't mounted. */
export function useToast(): ToastApi {
  return useContext(ToastContext) ?? { toast: () => {} };
}
