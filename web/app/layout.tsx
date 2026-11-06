import type { Metadata, Viewport } from "next";
import { Barlow, Barlow_Condensed } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";
import { NavBar } from "@/components/nav-bar";
import { SiteFooter } from "@/components/site-footer";

const display = Barlow_Condensed({ subsets: ["latin"], weight: ["600"], variable: "--font-barlow-condensed", display: "swap" });
const sans = Barlow({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-barlow", display: "swap" });

const title = "Wick: the market maker that pays for its own brain";
const description = "Trade W0G and USDC on Base against a price an AI agent signed. Every fill pays a fee that crosses to 0G and buys the agent's next AI run.";

export const metadata: Metadata = {
  metadataBase: new URL("https://wick.earn-shield-alerts.workers.dev"),
  title,
  description,
  applicationName: "Wick",
  openGraph: { type: "website", siteName: "Wick", title, description, url: "/" },
  twitter: { card: "summary", title, description },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0d0d10" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable}`}>
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
