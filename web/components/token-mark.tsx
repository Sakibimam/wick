import type { TokenSymbol } from "@/lib/config";
import { cn } from "@/lib/utils";

const GLYPH: Record<TokenSymbol, string> = { W0G: "0G", USDC: "$" };

export function TokenMark({ symbol, className }: { symbol: TokenSymbol; className?: string }) {
  return (
    <span aria-hidden className={cn("num inline-grid size-6 place-items-center rounded-full border border-ink/70 text-[10px] font-medium leading-none text-ink", className)}>
      {GLYPH[symbol]}
    </span>
  );
}
