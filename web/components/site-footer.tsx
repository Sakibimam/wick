"use client";

import { CopyLink } from "@/components/copy-link";
import { ChainChip, Tk, WickMark } from "@/components/token-mark";
import { useAgentStatus } from "@/hooks/use-agent-status";
import { AQUA_ROUTER, BASE_CHAIN_ID, EXPLORERS, V4_HOOK, ZERO_G_CHAIN_ID } from "@/lib/config";
import { AGENT, BOARD, PAYMENT_LAYER } from "@/lib/evidence";
import v2 from "@/worker/live-order-v2.json";

const SITE = "https://wick.earn-shield-alerts.workers.dev";
const SHARE = `https://x.com/intent/post?text=${encodeURIComponent("Wick: a market maker on Base that pays for its own AI from the fees it earns. Every number read live from Base and 0G.")}&url=${encodeURIComponent(SITE)}`;
const link = "text-ink underline decoration-rule-2 underline-offset-4 transition-colors duration-150 hover:decoration-ink";

export function SiteFooter() {
  // Addresses come from the live status; the committed v2 deployment record covers the first paint.
  const c = useAgentStatus().data?.contracts;
  const contracts = [
    { name: "Aqua router", chainId: BASE_CHAIN_ID, address: AQUA_ROUTER },
    { name: "Quote board", chainId: BASE_CHAIN_ID, address: c?.board ?? v2.board },
    { name: "Quote check", chainId: BASE_CHAIN_ID, address: c?.extruction ?? v2.extruction },
    { name: "Uniswap v4 hook", chainId: BASE_CHAIN_ID, address: V4_HOOK.address },
    { name: "Agent", chainId: BASE_CHAIN_ID, address: AGENT },
    { name: "Payment Layer", chainId: ZERO_G_CHAIN_ID, address: PAYMENT_LAYER },
  ];
  const v1Board = c?.v1?.board ?? BOARD;
  return (
    <footer className="border-t border-rule bg-lane">
      <div className="mx-auto max-w-[1312px] px-4 pb-10 pt-12 sm:px-6 lg:px-12">
        <div className="flex flex-col gap-8 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-[44ch]">
            <p className="flex items-center gap-2 font-display text-[28px] font-semibold uppercase leading-none tracking-[0.02em] text-ink">
              <WickMark className="size-7" />Every number read live
            </p>
            <p className="mt-3 text-[16px] text-ink-2">Wick is a market maker that pays for its own AI from the fees it earns. Every figure on this site is read from Base and the <Tk>0G</Tk> chain, and these are the contracts it runs on.</p>
            <nav aria-label="Footer" className="mt-5 flex flex-wrap gap-x-6 gap-y-2 text-[15px] font-medium">
              <a href="/architecture.html" className={link}>Docs</a>
              <a href="/ledger" className={link}>Ledger</a>
              <a href={SHARE} target="_blank" rel="noreferrer" className={link}>Share on X</a>
            </nav>
          </div>
          <div>
            <ul className="grid grid-cols-1 gap-x-10 gap-y-5 text-[13px] sm:grid-cols-2">
              {contracts.map((k) => (
                <li key={k.name} className="min-w-0">
                  <p className="flex items-center gap-3 text-ink-2"><span className="font-medium text-ink">{k.name}</span><ChainChip chainId={k.chainId} className="text-[12px] text-muted" /></p>
                  <CopyLink value={k.address} href={EXPLORERS[k.chainId]!.address(k.address)} label={`${k.name} contract`} className="mt-1" />
                </li>
              ))}
            </ul>
            <p className="mt-5 flex flex-wrap items-center gap-2 text-[13px] text-muted">First quote board, retired for the current one: <CopyLink value={v1Board} href={EXPLORERS[BASE_CHAIN_ID]!.address(v1Board)} label="first quote board" /></p>
          </div>
        </div>
      </div>
    </footer>
  );
}
