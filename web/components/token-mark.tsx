import type { TokenSymbol } from "@/lib/config";
import { cn } from "@/lib/utils";

const GLYPH: Record<TokenSymbol, string> = { W0G: "0G", USDC: "$" };

export function TokenMark({ symbol, className }: { symbol: TokenSymbol; className?: string }) {
  return (
    <span aria-hidden className={cn("inline-grid size-7 place-items-center rounded-full bg-ink text-[11px] font-semibold leading-none text-on-accent", className)}>
      {GLYPH[symbol]}
    </span>
  );
}
