import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Schibsted_Grotesk, Space_Grotesk } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";
import { NavBar } from "@/components/nav-bar";
import { SiteFooter } from "@/components/site-footer";

const display = Space_Grotesk({ subsets: ["latin"], weight: ["500", "600"], variable: "--font-space-grotesk", display: "swap" });
const sans = Schibsted_Grotesk({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-schibsted", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-jetbrains", display: "swap" });

export const metadata: Metadata = {
  title: "Upkeep: swap at a price that expires",
  description: "Swap W0G and USDC on Base against a price an AI agent signed, then trace how the fees pay for the agent's next AI run.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#f9fafc" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <body className="flex min-h-dvh flex-col">
        <Providers>
          <NavBar />
          <main className="flex-1">{children}</main>
          <SiteFooter />
        </Providers>
      </body>
    </html>
  );
}
