"use client";

import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { onThemeChange, readThemeChoice, resolveTheme, setThemeChoice, type ThemeChoice } from "@/lib/theme";

/** The current appearance choice, kept in sync with every other control. */
export function useThemeChoice(): [ThemeChoice | null, (c: ThemeChoice) => void] {
  // null until mounted: the server can't know the choice, and guessing would
  // render the wrong icon for a moment.
  const [choice, setChoice] = useState<ThemeChoice | null>(null);
  useEffect(() => {
    setChoice(readThemeChoice()); // eslint-disable-line react-hooks/set-state-in-effect -- read once on mount
    return onThemeChange(setChoice);
  }, []);
  return [choice, setThemeChoice];
}

/**
 * One-tap light/dark switch for headers. Shows where a tap goes — a sun in
 * dark mode, a moon in light. When following the device, it switches to the
 * opposite of what the device is showing right now.
 */
export function ThemeToggle({ className = "" }: { className?: string }) {
  const [choice, setChoice] = useThemeChoice();
  const resolved = choice ? resolveTheme(choice) : null;
  const next = resolved === "light" ? "dark" : "light";
  return (
    <button
      type="button"
      onClick={() => setChoice(next)}
      aria-label={`Switch to ${next} mode`}
      title={`Switch to ${next} mode`}
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-input/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${className}`}
    >
      {resolved === null ? <span className="h-4 w-4" /> : resolved === "light" ? <Moon size={16} /> : <Sun size={16} />}
    </button>
  );
}

const OPTIONS: { value: ThemeChoice; label: string; Icon: typeof Sun }[] = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "System", Icon: Monitor },
];

/** Light / Dark / System, for Settings. */
export function ThemePicker() {
  const [choice, setChoice] = useThemeChoice();
  return (
    <div role="radiogroup" aria-label="Appearance" className="inline-flex rounded-lg border border-border bg-input/40 p-1">
      {OPTIONS.map(({ value, label, Icon }) => {
        const on = choice === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => setChoice(value)}
            className={`flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${on ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            <Icon size={14} />
            {label}
          </button>
        );
      })}
    </div>
  );
}
