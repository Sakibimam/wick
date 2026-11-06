import { AQUA_ROUTER, EXPLORERS, BASE_CHAIN_ID, ZERO_G_CHAIN_ID } from "@/lib/config";
import { AGENT, BOARD, PAYMENT_LAYER } from "@/lib/evidence";
import { truncateHex } from "@/lib/amounts";

const CONTRACTS = [
  { name: "Aqua router", chainId: BASE_CHAIN_ID, address: AQUA_ROUTER },
  { name: "Quote board", chainId: BASE_CHAIN_ID, address: BOARD },
  { name: "Agent", chainId: BASE_CHAIN_ID, address: AGENT },
  { name: "Payment Layer", chainId: ZERO_G_CHAIN_ID, address: PAYMENT_LAYER },
] as const;

export function SiteFooter() {
  return (
    <footer className="bg-lane">
      <div className="mx-auto max-w-[1312px] px-4 pb-10 pt-16 sm:px-6 lg:px-12">
        <p className="font-display text-[22vw] font-semibold uppercase leading-[0.8] tracking-[0.02em] text-ink lg:text-[220px]" aria-hidden>Upkeep</p>
        <div className="mt-10 flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <p className="max-w-[40ch] text-[15px] text-ink-2">A market maker that pays for its own AI from the fees it earns. Everything on this page is read from Base and the 0G chain.</p>
          <ul className="grid grid-cols-2 gap-x-8 gap-y-3 text-[13px] sm:grid-cols-4">
            {CONTRACTS.map((c) => (
              <li key={c.name}>
                <p className="text-muted">{c.name}</p>
                <a className="mono text-ink underline decoration-rule-2 underline-offset-4 hover:decoration-ink" href={EXPLORERS[c.chainId]!.address(c.address)} target="_blank" rel="noreferrer">{truncateHex(c.address, 6, 4)}</a>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </footer>
  );
}
