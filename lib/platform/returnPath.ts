/**
 * Where to send someone after they connect or create a wallet, when they came
 * from somewhere specific (a shared Room link). Only PayAI's own room pages
 * and dashboard are accepted — never another origin, a protocol-relative URL,
 * or anything with a backslash — so a crafted ?next= can't become an open
 * redirect. Null means "use the page's normal destination".
 */
export function safeReturnPath(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw.length > 200) return null;
  if (/^\/r\/er_[0-9a-f]{24}$/.test(raw)) return raw;
  if (/^\/rooms$/.test(raw)) return raw;
  if (/^\/dashboard(\/[a-z0-9_-]+){0,3}$/.test(raw)) return raw;
  return null;
}
