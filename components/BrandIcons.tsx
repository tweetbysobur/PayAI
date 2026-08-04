import type { ReactElement } from "react";

interface IconProps {
  size?: number;
  className?: string;
}

/** Official GitHub mark (Octicon "mark-github"), monochrome via currentColor. */
export function GitHubMark({ size = 18, className = "" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" className={className} xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/** Official X (formerly Twitter) mark, monochrome via currentColor. */
export function XMark({ size = 16, className = "" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.26 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.5 2.25H8.08l4.713 6.231ZM17.083 19.77h1.833L7.084 4.126H5.117Z" />
    </svg>
  );
}

/** Google "G" mark, official four-color version. */
export function GoogleMark({ size = 16, className = "" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" className={className} xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.4 0 6.4 1.17 8.8 3.46l6.55-6.55C35.4 2.62 30.06 0 24 0 14.62 0 6.52 5.38 2.56 13.22l7.62 5.92C12.1 13.13 17.6 9.5 24 9.5Z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.6-.14-3.13-.4-4.6H24v9.15h12.9c-.56 2.9-2.22 5.36-4.74 7.02l7.42 5.76C43.86 37.6 46.98 31.6 46.98 24.55Z" />
      <path fill="#FBBC05" d="M10.18 28.14a14.5 14.5 0 0 1 0-8.28l-7.62-5.92a24 24 0 0 0 0 20.12l7.62-5.92Z" />
      <path fill="#34A853" d="M24 48c6.06 0 11.15-2 14.87-5.42l-7.42-5.76c-2.06 1.4-4.7 2.22-7.45 2.22-6.4 0-11.9-3.63-14.06-8.9l-7.62 5.92C6.52 42.62 14.62 48 24 48Z" />
    </svg>
  );
}

/** Apple mark, monochrome via currentColor. */
export function AppleMark({ size = 16, className = "" }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" className={className} xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M16.365 1.43c0 1.14-.417 2.06-1.25 2.86-.895.847-1.99 1.34-3.045 1.25-.11-1.13.41-2.27 1.22-3.08.833-.83 1.99-1.4 3.045-1.43.02.13.03.27.03.4Zm4.24 16.44c-.36.83-.53 1.2-.99 1.94-.65 1.06-1.57 2.38-2.71 2.4-1.02.01-1.28-.66-2.66-.65-1.38 0-1.68.65-2.7.66-1.14.01-2-1.2-2.65-2.26-1.81-2.98-2-6.48-.88-8.34.79-1.32 2.04-2.09 3.21-2.09 1.19 0 1.94.66 2.93.66.96 0 1.54-.66 2.92-.66.99 0 2.05.55 2.8 1.5-2.46 1.35-2.06 4.87.79 5.84Z" />
    </svg>
  );
}

const BRAND_ICONS: Record<string, (p: IconProps) => ReactElement> = {
  google: GoogleMark,
  apple: AppleMark,
  x: XMark,
  github: GitHubMark,
};

/** Small dispatcher so callers can pick a brand mark by name without importing each one. */
export function BrandIcon({ name, ...props }: IconProps & { name: keyof typeof BRAND_ICONS }) {
  const Icon = BRAND_ICONS[name];
  return Icon ? <Icon {...props} /> : null;
}
