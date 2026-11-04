"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { WalletButton } from "@/components/wallet";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/", label: "Swap" },
  { href: "/ledger", label: "Brain ledger" },
] as const;

export function NavBar() {
  const path = usePathname();
  return (
    <header className="border-b border-rule bg-paper">
      <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-between gap-x-6 px-4 sm:px-6">
        <Link href="/" className="font-display text-[20px] font-semibold tracking-tight text-ink py-3.5">Upkeep</Link>
        <nav aria-label="Primary" className="order-3 -mb-px flex w-full gap-6 sm:order-none sm:w-auto sm:flex-1">
          {TABS.map((t) => {
            const active = t.href === "/" ? path === "/" : path.startsWith(t.href);
            return (
              <Link
                key={t.href}
                href={t.href}
                aria-current={active ? "page" : undefined}
                className={cn("border-b-2 py-3 text-[15px] transition-colors duration-150", active ? "border-accent font-medium text-ink" : "border-transparent text-muted hover:text-ink")}
              >
                {t.label}
              </Link>
            );
          })}
        </nav>
        <WalletButton />
      </div>
    </header>
  );
}
