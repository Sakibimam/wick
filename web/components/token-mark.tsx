import { Fragment, type ReactNode } from "react";
import { CHAIN_ICON, CHAIN_NAMES, PROTOCOL_ICON, TOKEN_ICON, type Protocol, type TokenSymbol } from "@/lib/config";
import { cn } from "@/lib/utils";

type Size = 14 | 16 | 20 | 28;
const PX: Record<Size, string> = { 14: "size-3.5", 16: "size-4", 20: "size-5", 28: "size-7" };

/** Official token mark, round. Decorative: the symbol is always written next to it. */
export function TokenIcon({ symbol, size = 16, className }: { symbol: TokenSymbol | "0G"; size?: Size; className?: string }) {
  return <img src={TOKEN_ICON[symbol]} alt="" aria-hidden width={size} height={size} className={cn("inline-block shrink-0 rounded-full align-[-0.15em]", PX[size], className)} />;
}

export function ChainIcon({ chainId, size = 16, className }: { chainId: number; size?: Size; className?: string }) {
  const src = CHAIN_ICON[chainId];
  if (!src) return null;
  return <img src={src} alt="" aria-hidden width={size} height={size} className={cn("inline-block shrink-0 align-[-0.15em]", chainId === 16661 ? "rounded-full" : "rounded-[3px]", PX[size], className)} />;
}

export function ProtocolIcon({ protocol, size = 16, className }: { protocol: Protocol; size?: Size; className?: string }) {
  return <img src={PROTOCOL_ICON[protocol]} alt="" aria-hidden width={size} height={size} className={cn("inline-block shrink-0 rounded-full align-[-0.15em]", PX[size], className)} />;
}

/** Text with the zero inside a ticker slashed (W0G, 0G), so it never reads as WOG or OG. Barlow has no slashed-zero feature. Numbers are left alone. */
export function Tk({ children, className }: { children: string; className?: string }) {
  const parts = children.split(/(?<=[A-Za-z])0|0(?=[A-Za-z])/);
  return (
    <span className={className}>
      {parts.map((p, i) => (
        <Fragment key={i}>
          {p}
          {i < parts.length - 1 ? <span className="zero">0</span> : null}
        </Fragment>
      ))}
    </span>
  );
}

/** Amount with its token mark in front: the one way a token amount is written. */
export function Amount({ value, symbol, size = 16, className, unitClassName }: { value: ReactNode; symbol: TokenSymbol | "0G"; size?: Size; className?: string; unitClassName?: string }) {
  return (
    <span className={cn("num inline-flex items-baseline gap-1.5 whitespace-nowrap", className)}>
      <TokenIcon symbol={symbol} size={size} className="self-center" />
      <span>{value}</span>
      <Tk className={cn("text-[0.8em] text-muted", unitClassName)}>{symbol}</Tk>
    </span>
  );
}

/** Chain chip: logo and name. Every place a chain is named uses this. */
export function ChainChip({ chainId, className, size = 14 }: { chainId: number; className?: string; size?: Size }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 whitespace-nowrap text-[13px] font-medium text-ink-2", className)}>
      <ChainIcon chainId={chainId} size={size} />
      <Tk>{CHAIN_NAMES[chainId] ?? `Chain ${chainId}`}</Tk>
    </span>
  );
}

/** The brand mark: a wick and its flame. */
export function WickMark({ className, burning = false }: { className?: string; burning?: boolean }) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden className={cn("shrink-0", className)}>
      <path className={cn("fill-ink origin-[32px_58px]", burning && "motion-safe:animate-[flicker_1.4s_var(--ease-out)_infinite]")} d="M32 6c2.5 7.5 13 13.5 13 26.5a13 13 0 0 1-26 0c0-6.6 3.2-10.7 6.4-14.2.4 4 1.9 6.6 4.4 8.1-.9-7.3-.1-13.6 2.2-20.4z" />
      <path className="fill-warn" d="M32 30.5c2.6 3.3 4.6 5.6 4.6 9a4.6 4.6 0 0 1-9.2 0c0-3.4 2-5.7 4.6-9z" />
      <rect className="fill-ink" x="30.6" y="43" width="2.8" height="15" rx="1.4" />
    </svg>
  );
}
