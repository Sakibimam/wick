import { CopyLink } from "@/components/copy-link";
import { ChainChip, Tk, WickMark } from "@/components/token-mark";
import { AQUA_ROUTER, BASE_CHAIN_ID, EXPLORERS, ZERO_G_CHAIN_ID } from "@/lib/config";
import { AGENT, PAYMENT_LAYER } from "@/lib/evidence";
import v2 from "@/worker/live-order-v2.json";

const CONTRACTS = [
  { name: "Aqua router", chainId: BASE_CHAIN_ID, address: AQUA_ROUTER },
  { name: "Quote board", chainId: BASE_CHAIN_ID, address: v2.board },
  { name: "Quote check", chainId: BASE_CHAIN_ID, address: v2.extruction },
  { name: "Agent", chainId: BASE_CHAIN_ID, address: AGENT },
  { name: "Payment Layer", chainId: ZERO_G_CHAIN_ID, address: PAYMENT_LAYER },
] as const;

const SITE = "https://wick.earn-shield-alerts.workers.dev";
const SHARE = `https://x.com/intent/post?text=${encodeURIComponent("Wick: a market maker on Base that pays for its own AI from the fees it earns. Every number read live from Base and 0G.")}&url=${encodeURIComponent(SITE)}`;

export function SiteFooter() {
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
              <a href="/architecture.html" className="text-ink underline decoration-rule-2 underline-offset-4 transition-colors duration-150 hover:decoration-ink">Docs</a>
              <a href="/ledger" className="text-ink underline decoration-rule-2 underline-offset-4 transition-colors duration-150 hover:decoration-ink">Ledger</a>
              <a href={SHARE} target="_blank" rel="noreferrer" className="text-ink underline decoration-rule-2 underline-offset-4 transition-colors duration-150 hover:decoration-ink">Share on X</a>
            </nav>
          </div>
          <ul className="grid grid-cols-1 gap-x-10 gap-y-5 text-[13px] sm:grid-cols-2">
            {CONTRACTS.map((c) => (
              <li key={c.name} className="min-w-0">
                <p className="flex items-center gap-3 text-ink-2"><span className="font-medium text-ink">{c.name}</span><ChainChip chainId={c.chainId} className="text-[12px] text-muted" /></p>
                <CopyLink value={c.address} href={EXPLORERS[c.chainId]!.address(c.address)} label={`${c.name} contract`} className="mt-1" />
              </li>
            ))}
          </ul>
        </div>
      </div>
    </footer>
  );
}
