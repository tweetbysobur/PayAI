import { Geist, Geist_Mono } from "next/font/google";

/**
 * The marketing site's typefaces: Geist for everything, Geist Mono for the
 * small numbered/labelled details. Scoped to the landing page (applied on its
 * <main>), so the dashboard keeps its own type.
 */
export const geist = Geist({ subsets: ["latin"], weight: ["400", "500", "600"], display: "swap" });
export const geistMono = Geist_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-geist-mono", display: "swap" });
