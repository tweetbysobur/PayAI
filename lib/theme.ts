/**
 * Light / dark appearance.
 *
 * Dark is the default and stays exactly as it was. A person can pick light,
 * dark, or follow their device ("system"). The choice is kept in a cookie on
 * the parent domain, so it carries across usepayai.xyz, app.usepayai.xyz and
 * docs.usepayai.xyz, and mirrored in localStorage for hosts without one (local
 * development, preview deployments).
 *
 * The page is painted in the right theme from the first frame by THEME_SCRIPT,
 * an inline script in <head> that runs before anything renders; the hook and
 * setter here only handle changes after that.
 */

export type ThemeChoice = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_KEY = "payai-theme";
const CHANGE_EVENT = "payai-theme-change";

export function isThemeChoice(v: unknown): v is ThemeChoice {
  return v === "light" || v === "dark" || v === "system";
}

/** The cookie's Domain: the shared parent of every PayAI host, or none. */
export function cookieDomainFor(hostname: string): string | null {
  return /(^|\.)usepayai\.xyz$/i.test(hostname) ? ".usepayai.xyz" : null;
}

export function readThemeChoice(): ThemeChoice {
  if (typeof document === "undefined") return "dark";
  const m = document.cookie.match(new RegExp(`(?:^|; )${THEME_KEY}=([^;]*)`));
  if (m && isThemeChoice(m[1])) return m[1];
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (isThemeChoice(v)) return v;
  } catch { /* storage blocked */ }
  return "dark";
}

export function resolveTheme(choice: ThemeChoice): ResolvedTheme {
  if (choice !== "system") return choice;
  if (typeof window === "undefined") return "dark";
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function paint(resolved: ResolvedTheme) {
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.style.colorScheme = resolved;
}

export function setThemeChoice(choice: ThemeChoice) {
  const domain = cookieDomainFor(location.hostname);
  document.cookie = `${THEME_KEY}=${choice}; Path=/; Max-Age=31536000; SameSite=Lax${domain ? `; Domain=${domain}` : ""}${location.protocol === "https:" ? "; Secure" : ""}`;
  try { localStorage.setItem(THEME_KEY, choice); } catch { /* storage blocked */ }
  paint(resolveTheme(choice));
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: choice }));
}

/** Calls back with the new choice whenever it changes — from this tab, or
 *  (through storage events) another tab. Returns an unsubscribe. */
export function onThemeChange(cb: (choice: ThemeChoice) => void): () => void {
  const local = (e: Event) => cb((e as CustomEvent<ThemeChoice>).detail);
  const storage = (e: StorageEvent) => {
    if (e.key === THEME_KEY && isThemeChoice(e.newValue)) { paint(resolveTheme(e.newValue)); cb(e.newValue); }
  };
  // Following the device: repaint when the device itself switches.
  const mq = window.matchMedia?.("(prefers-color-scheme: light)");
  const system = () => { if (readThemeChoice() === "system") { paint(resolveTheme("system")); cb("system"); } };
  window.addEventListener(CHANGE_EVENT, local);
  window.addEventListener("storage", storage);
  mq?.addEventListener?.("change", system);
  return () => {
    window.removeEventListener(CHANGE_EVENT, local);
    window.removeEventListener("storage", storage);
    mq?.removeEventListener?.("change", system);
  };
}

/**
 * Runs inline in <head>, before first paint, so a light-mode visitor never
 * sees a dark flash. Self-contained (no imports) and must never throw.
 */
export const THEME_SCRIPT = `(function(){try{var k=${JSON.stringify(THEME_KEY)},c=null,m=document.cookie.match(/(?:^|; )${THEME_KEY}=([^;]*)/);if(m)c=m[1];if(c!=="light"&&c!=="dark"&&c!=="system"){try{c=localStorage.getItem(k)}catch(e){}}if(c!=="light"&&c!=="dark"&&c!=="system")c="dark";var r=c==="system"?(window.matchMedia&&matchMedia("(prefers-color-scheme: light)").matches?"light":"dark"):c;var d=document.documentElement;d.dataset.theme=r;d.style.colorScheme=r}catch(e){}})();`;
