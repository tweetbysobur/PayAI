"use client";

import { motion } from "motion/react";
import { forwardRef, useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Animated number that counts up to `value` on mount and whenever it changes.
 * Used for KPI tiles so balances/volumes settle in rather than snapping — a
 * small premium cue. Respects reduced motion by snapping immediately.
 */
export function CountUp({ value, decimals = 0, duration = 700, className = "" }: { value: number; decimals?: number; duration?: number; className?: string }) {
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);
  useEffect(() => {
    const reduce = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const from = fromRef.current;
    const to = value;
    if (reduce || from === to) { setDisplay(to); fromRef.current = to; return; }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic
      setDisplay(from + (to - from) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
      else fromRef.current = to;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  return <span className={className}>{display.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}</span>;
}

export function Card({
  title,
  right,
  children,
  className = "",
}: {
  title?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
      className={`rounded-xl border border-border bg-panel p-6 ${className}`}
    >
      {(title || right) && (
        <div className="mb-4 flex items-center justify-between">
          {title && <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>}
          {right}
        </div>
      )}
      {children}
    </motion.div>
  );
}

type BadgeTone = "neutral" | "success" | "warning" | "danger" | "primary";
const BADGE_TONE: Record<BadgeTone, string> = {
  neutral: "border-border bg-input text-muted-foreground",
  success: "border-success/30 bg-success/10 text-success",
  warning: "border-warning/30 bg-warning/10 text-warning",
  danger: "border-danger/30 bg-danger/10 text-danger",
  primary: "border-primary/30 bg-primary/10 text-primary-ink",
};

export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-md border px-2.5 py-1 text-xs font-medium ${BADGE_TONE[tone]}`}>
      {children}
    </span>
  );
}

export function Button({
  children,
  variant = "primary",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" }) {
  const base = "inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-all duration-150 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100";
  const variants = {
    primary: "bg-primary text-primary-foreground shadow-sm shadow-primary/25 hover:bg-primary/90",
    secondary: "border border-border bg-transparent text-foreground hover:border-muted-foreground/30 hover:bg-input",
    ghost: "text-muted-foreground hover:bg-input hover:text-foreground",
  };
  return (
    <button className={`${base} ${variants[variant]} ${className}`} {...props}>
      {children}
    </button>
  );
}

/**
 * The one skeleton primitive. Every loading placeholder in the app routes
 * through this so a "still fetching" state looks identical on every page —
 * previously transactions/wallets hand-rolled `animate-pulse bg-input` divs
 * while automations showed plain "Loading..." text and analytics showed an
 * em-dash (indistinguishable from a real zero). Respects reduced motion:
 * the pulse is a decorative cue, so it drops to a static block.
 */
export function Skeleton({ className = "", style }: { className?: string; style?: React.CSSProperties }) {
  return <div aria-hidden style={style} className={`animate-pulse rounded bg-input motion-reduce:animate-none ${className}`} />;
}

/**
 * N skeleton list rows (icon + line + trailing value) — the shape a table or
 * activity feed settles into, so the placeholder matches the real layout
 * instead of reflowing when data lands.
 */
export function SkeletonRows({ rows = 4, className = "" }: { rows?: number; className?: string }) {
  return (
    <div role="status" aria-busy="true" aria-live="polite" className={`space-y-3 ${className}`}>
      <span className="sr-only">Loading…</span>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-4">
          <Skeleton className="h-8 w-8 shrink-0 rounded-lg" />
          <Skeleton className="h-3 flex-1" />
          <Skeleton className="h-3 w-16 shrink-0" />
        </div>
      ))}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input(props, ref) {
  return (
    <input
      ref={ref}
      {...props}
      className={`rounded-lg border border-border bg-input px-3 py-2.5 text-base text-foreground outline-none transition-colors placeholder:text-muted-foreground focus-visible:border-primary/50 focus-visible:ring-2 focus-visible:ring-ring sm:text-sm ${props.className ?? ""}`}
    />
  );
});
