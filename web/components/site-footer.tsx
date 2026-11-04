import { AQUA_ROUTER, EXPLORERS, BASE_CHAIN_ID } from "@/lib/config";
import { truncateHex } from "@/lib/amounts";

export function SiteFooter() {
  return (
    <footer className="border-t border-rule">
      <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-5 text-[13px] text-muted sm:px-6">
        <p>Upkeep, a market maker that pays for its own AI.</p>
        <p>
          Swaps run through the AquaSwapVMRouter{" "}
          <a className="num text-ink underline underline-offset-4 hover:text-accent" href={EXPLORERS[BASE_CHAIN_ID]!.address(AQUA_ROUTER)} target="_blank" rel="noreferrer">{truncateHex(AQUA_ROUTER, 8, 6)}</a> on Base.
        </p>
      </div>
    </footer>
  );
}
