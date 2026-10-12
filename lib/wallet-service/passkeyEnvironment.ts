/**
 * Why a passkey wallet might not work in THIS browser, known before the user
 * taps — so they are told what to do instead of hitting a failed prompt.
 *
 *  - In-app browsers (links opened inside WhatsApp, Instagram, Facebook,
 *    Telegram, TikTok, Snapchat, LINE, or an Android WebView) don't support
 *    passkeys reliably or at all.
 *  - A wallet is derived from the passkey's PRF extension. Browsers that can
 *    say so report `extension:prf` from getClientCapabilities(); only an
 *    explicit `false` is treated as unsupported.
 *
 * Pure helpers plus one async capability read; no state.
 */

const IN_APP_RE = /\b(FBAN|FBAV|FB_IAB|Instagram|WhatsApp|Telegram|TelegramBot|musical_ly|BytedanceWebview|TikTok|Snapchat|Line\/|MicroMessenger|LinkedInApp|Twitter for)\b|; wv\)/i;

/** The in-app browser's name when the user agent shows one, else null. */
export function inAppBrowserName(userAgent: string): string | null {
  if (!IN_APP_RE.test(userAgent)) return null;
  if (/WhatsApp/i.test(userAgent)) return "WhatsApp";
  if (/Instagram/i.test(userAgent)) return "Instagram";
  if (/FBAN|FBAV|FB_IAB/i.test(userAgent)) return "Facebook";
  if (/Telegram/i.test(userAgent)) return "Telegram";
  if (/musical_ly|BytedanceWebview|TikTok/i.test(userAgent)) return "TikTok";
  if (/Snapchat/i.test(userAgent)) return "Snapchat";
  if (/Line\//i.test(userAgent)) return "LINE";
  if (/MicroMessenger/i.test(userAgent)) return "WeChat";
  if (/LinkedInApp/i.test(userAgent)) return "LinkedIn";
  if (/Twitter for/i.test(userAgent)) return "X";
  return "this app";
}

/** "Safari" on Apple devices, "Chrome" elsewhere — what to open instead. */
export function suggestedBrowser(userAgent: string): string {
  return /iPhone|iPad|iPod|Macintosh/i.test(userAgent) ? "Safari" : "Chrome";
}

/** false only when the browser explicitly reports no PRF support. */
export async function prfSupport(): Promise<boolean | null> {
  if (typeof window === "undefined" || typeof window.PublicKeyCredential === "undefined") return false;
  const ctor = window.PublicKeyCredential as typeof PublicKeyCredential & {
    getClientCapabilities?: () => Promise<Record<string, boolean | undefined>>;
  };
  if (typeof ctor.getClientCapabilities !== "function") return null;
  try {
    const caps = await ctor.getClientCapabilities();
    const v = caps["extension:prf"];
    return typeof v === "boolean" ? v : null;
  } catch {
    return null;
  }
}
