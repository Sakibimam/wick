import { TOKENS } from "./config";
import type { AgentQuote } from "./schema";

export type Direction = "sell-w0g" | "buy-w0g";

export type Priced = {
  quote: AgentQuote;
  direction: Direction;
  expiry: number;
  /** USDC per 1 W0G implied by the signed rate (contract semantics: output wei per 1e18 input wei). */
  priceUsdcPerW0g: number;
};

const lower = (a: string) => a.toLowerCase();
const W0G = lower(TOKENS.W0G.address);
const USDC = lower(TOKENS.USDC.address);

export function directionOf(q: Pick<AgentQuote, "tokenIn" | "tokenOut">): Direction | null {
  const i = lower(q.tokenIn);
  const o = lower(q.tokenOut);
  if (i === W0G && o === USDC) return "sell-w0g";
  if (i === USDC && o === W0G) return "buy-w0g";
  return null;
}

/** rateE18 is output wei per 1e18 input wei. W0G has 18 decimals, USDC 6. */
export function impliedPrice(direction: Direction, rateE18: bigint): number {
  if (rateE18 <= 0n) return Number.NaN;
  if (direction === "sell-w0g") return Number(rateE18) / 1e6;
  return 1e30 / Number(rateE18);
}

/** Latest signed quote per direction: the one with the greatest expiry. */
export function latestByDirection(quotes: AgentQuote[]): Record<Direction, Priced | null> {
  const out: Record<Direction, Priced | null> = { "sell-w0g": null, "buy-w0g": null };
  for (const quote of quotes) {
    const direction = directionOf(quote);
    if (!direction) continue;
    const expiry = Number(quote.expiry);
    const current = out[direction];
    if (current && current.expiry >= expiry) continue;
    out[direction] = { quote, direction, expiry, priceUsdcPerW0g: impliedPrice(direction, BigInt(quote.rateE18)) };
  }
  return out;
}

export type Freshness = "fresh" | "closing" | "expired";
export const CLOSING_SECONDS = 60;
export const URGENT_SECONDS = 15;

export function secondsLeft(expiry: number, nowSeconds: number): number {
  return Math.max(0, Math.floor(expiry - nowSeconds));
}

export function freshness(expiry: number, nowSeconds: number): Freshness {
  const left = expiry - nowSeconds;
  if (left <= 0) return "expired";
  return left <= CLOSING_SECONDS ? "closing" : "fresh";
}

export function clock(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
}

/** Signed difference between the two prices, as a fraction of their midpoint. Positive when buying costs more than selling pays. */
export function spreadPct(sell: Priced | null, buy: Priced | null): number | null {
  if (!sell || !buy || !Number.isFinite(sell.priceUsdcPerW0g) || !Number.isFinite(buy.priceUsdcPerW0g)) return null;
  const mid = (sell.priceUsdcPerW0g + buy.priceUsdcPerW0g) / 2;
  return ((buy.priceUsdcPerW0g - sell.priceUsdcPerW0g) / mid) * 100;
}

/** How far a signed price sits from the pool mid, percent. Takers compare the signed rate to their own reference before filling. */
export function offMidPct(price: number, mid: number | null): number | null {
  if (mid === null || !Number.isFinite(price)) return null;
  return ((price - mid) / mid) * 100;
}
