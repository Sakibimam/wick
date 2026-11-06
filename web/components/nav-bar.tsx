"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { WalletButton } from "@/components/wallet";
import { useAgentStatus } from "@/hooks/use-agent-status";
import { TIER_TONE, tierWord } from "@/lib/machine";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/", label: "Machine" },
  { href: "/ledger", label: "Ledger" },
] as const;

export function NavBar() {
  const path = usePathname();
  const status = useAgentStatus();
  const tier = status.data?.budget.tier;
  return (
    <header className="relative z-20 bg-paper">
      <div className="mx-auto flex h-16 max-w-[1312px] items-center gap-6 px-4 sm:px-6 lg:px-12">
        <Link href="/" className="font-display text-[22px] font-semibold uppercase tracking-[0.12em] text-ink">Wick</Link>
        <nav aria-label="Primary" className="flex gap-5">
          {LINKS.map((l) => {
            const active = l.href === "/" ? path === "/" : path.startsWith(l.href);
            return (
              <Link key={l.href} href={l.href} aria-current={active ? "page" : undefined} className={cn("text-[16px] font-medium transition-colors duration-150", active ? "text-ink" : "text-muted hover:text-ink")}>
                {l.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-4">
          {tier ? (
            <span className={cn("hidden items-center gap-2 text-[13px] text-ink-2 md:inline-flex", `tone-${TIER_TONE[tier]}`)} title={`Budget tier ${tier}`}>
              <span aria-hidden className="size-2 rounded-full bg-[var(--tone)]" />
              Agent {tierWord(tier).toLowerCase()}
            </span>
          ) : null}
          <WalletButton />
        </div>
      </div>
    </header>
  );
}
