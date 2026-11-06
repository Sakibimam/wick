"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { WalletButton } from "@/components/wallet";
import { ChainIcon, Tk, WickMark } from "@/components/token-mark";
import { useAgentStatus } from "@/hooks/use-agent-status";
import { useChainNow } from "@/hooks/use-clock";
import { BASE_CHAIN_ID, ZERO_G_CHAIN_ID } from "@/lib/config";
import { clock, duration, fmtBlock } from "@/lib/format";
import { nextTickIn, priceLeg, tickSummary, tierWord } from "@/lib/machine";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/", label: "Machine" },
  { href: "/ledger", label: "Ledger" },
] as const;

export function NavBar() {
  const path = usePathname();
  return (
    <header className="relative z-20 bg-paper">
      <div className="mx-auto flex h-16 max-w-[1312px] items-center gap-4 px-4 sm:gap-6 sm:px-6 lg:px-12">
        <Link href="/" className="flex items-center gap-2 font-display text-[20px] font-semibold uppercase tracking-[0.1em] text-ink sm:text-[22px] sm:tracking-[0.12em]" aria-label="Wick, home">
          <WickMark className="size-7" />
          Wick
        </Link>
        <nav aria-label="Primary" className="flex gap-4 sm:gap-5">
          {LINKS.map((l) => {
            const active = l.href === "/" ? path === "/" : path.startsWith(l.href);
            return (
              <Link key={l.href} href={l.href} aria-current={active ? "page" : undefined} className={cn("whitespace-nowrap text-[16px] font-medium transition-colors duration-150", active ? "text-ink" : "text-muted hover:text-ink")}>
                {l.label}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-4">
          <WalletButton />
        </div>
      </div>
      <StatusStrip />
    </header>
  );
}

/** The chain clocks and the agent's heartbeat in one horizontal line: what was read, from which block, how long ago. */
function StatusStrip() {
  const status = useAgentStatus();
  const { now, ready } = useChainNow();
  const s = status.data;
  const ago = ready && status.dataUpdatedAt ? duration(Math.max(0, now * 1000 - status.dataUpdatedAt)) : null;
  const tick = s ? tickSummary(s) : null;
  const leg = s && ready ? priceLeg(s, now) : null;
  const tone = !s ? "tone-quiet" : leg?.open ? "tone-danger" : tick && tick.failStreak >= 2 ? "tone-warn" : "tone-ok";
  const word = !s ? null : leg?.open ? "Requoting" : tick && tick.failStreak >= 2 ? "Retrying" : `Agent ${tierWord(s.budget.tier).toLowerCase()}`;
  return (
    <div className="border-y border-rule bg-paper">
      <div className="mx-auto flex h-9 max-w-[1312px] items-center gap-x-5 overflow-hidden px-4 text-[13px] text-muted sm:px-6 lg:px-12">
        {s?.readAt ? (
          <>
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap" title="Latest Base block this page read">
              <ChainIcon chainId={BASE_CHAIN_ID} size={14} /><span className="hidden sm:inline">Base</span> <span className="num text-ink-2">{fmtBlock(s.readAt.baseBlock)}</span>
            </span>
            <span className="hidden items-center gap-1.5 whitespace-nowrap min-[420px]:inline-flex" title="Latest 0G chain block this page read">
              <ChainIcon chainId={ZERO_G_CHAIN_ID} size={14} className="hidden min-[420px]:inline-block" /><Tk className="hidden sm:inline">0G</Tk> <span className="num text-ink-2">{fmtBlock(s.readAt.zeroGBlock)}</span>
            </span>
            <span className="whitespace-nowrap">{ago !== null ? `read ${ago} ago` : null}</span>
          </>
        ) : (
          <span aria-hidden className="skeleton h-3.5 w-[260px] max-w-[60%]" />
        )}
        <span className="ml-auto flex min-w-0 items-center gap-3">
          {word ? (
            <span className={cn("inline-flex items-center gap-2 whitespace-nowrap text-ink-2", tone)}>
              <span aria-hidden className="size-2 rounded-full bg-[var(--tone)]" />
              {word}
            </span>
          ) : <span aria-hidden className="skeleton h-3.5 w-24" />}
          {ready && s ? <span className="num whitespace-nowrap text-muted lg:hidden">next {clock(nextTickIn(now))}</span> : null}
          {tick && ready ? (
            <span className={cn("hidden min-w-0 truncate lg:inline", tick.failStreak >= 2 || leg?.open ? "text-warn-ink" : "text-muted")}>
              last tick {duration(Math.max(0, now * 1000 - tick.at))} ago, {tick.words}, next in {clock(nextTickIn(now))}
            </span>
          ) : null}
        </span>
      </div>
    </div>
  );
}
