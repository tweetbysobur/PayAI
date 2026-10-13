import localFont from "next/font/local";

/**
 * The marketing site's typefaces: Geist for everything, Geist Mono for the
 * small numbered/labelled details. Scoped to the landing page (applied on its
 * <main>), so the dashboard keeps its own type. Self-hosted from app/fonts,
 * so the build never depends on reaching Google Fonts.
 */
export const geist = localFont({ src: "../../app/fonts/Geist-Variable.woff2", weight: "100 900", display: "swap" });
export const geistMono = localFont({ src: "../../app/fonts/GeistMono-Variable.woff2", weight: "100 900", variable: "--font-geist-mono", display: "swap" });
